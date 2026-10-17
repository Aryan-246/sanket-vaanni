/**
 * Confirming an upload, rather than believing it.
 *
 * The whole suite rests on one distinction that the previous implementation
 * could not make: an upsert that answers without an error is not evidence that
 * anything was stored. Every failure modelled below produces exactly that —
 * a green write and no row, or a green write and a different row — and each one
 * must be reported as a failure rather than a completed migration.
 *
 * The cases are grouped by what they are evidence about:
 *
 *   - the comparison itself, as pure functions, without a client
 *   - an upload that the server silently dropped or altered
 *   - a read-back the account is not allowed to make
 *   - a request that never finishes, and an attempt the caller cancels
 *   - the storage key a profile merged from elsewhere is written under
 */
import {
  resetSupabaseClient,
  setCustomSupabaseClient,
  setSupabaseDisabledForTesting,
} from '../src/supabase/client';
import {
  ALL_MIGRATABLE_SCOPES,
  SyncManager,
  SYNC_REQUEST_TIMEOUT_MS,
} from '../src/supabase/sync';
import {
  canonical,
  verifyCalibration,
  verifyHistory,
  verifyOledProfiles,
  verifyPreferences,
} from '../src/supabase/readBack';
import { createInMemoryStorage, featureKeys, storageKeys, type Storage } from '../src/storage';
import { defaultHandConfig, type OledProfile } from '../src/oled/profiles';
import { createDemoCalibration } from '../src/sensors/calibration';
import { createFakeSupabase, type FakeSupabase, type FakeSupabaseOptions } from './fakeSupabase';

/*
 * Node's built-ins, reached without the type definitions for them: this project
 * type-checks against React Native's ambient types, which deliberately omit the
 * Node globals, and pulling `@types/node` into the app's compilation for one test
 * would be a larger change than the test is worth.
 */
const fs: any = require('fs');
const path: any = require('path');
declare const __dirname: string;

const USER = 'user-1';

/* --------------------------------------------------------------- fixtures */

function oledProfile(id: string, name: string): OledProfile {
  return {
    id,
    name,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    left: defaultHandConfig(),
    right: defaultHandConfig(),
  };
}

async function seedGuestData(storage: Storage): Promise<void> {
  await storage.setPreferences({
    signProfileId: 'isl',
    targetLanguageCode: 'mr',
    voiceEnabled: true,
  });
  await storage.setThemeMode('dark');
  await storage.setCalibration({ ...createDemoCalibration('left'), capturedAtMs: 5_000 });
  await storage.setCalibration({ ...createDemoCalibration('right'), capturedAtMs: 5_000 });
  await storage.setJson(featureKeys.oledProfiles, {
    profiles: [oledProfile('p1', 'Morning')],
    activeProfileId: 'p1',
  });
  await storage.addHistoryEntry({
    id: 'h-glove',
    text: 'measured',
    profileId: 'isl',
    source: 'glove',
    createdAtMs: 10,
  });
}

const EVERYTHING = {
  uploadLocalData: true,
  scopes: ALL_MIGRATABLE_SCOPES,
  requestTimeoutMs: 200,
} as const;

/* ----------------------------------------------------- the comparison itself */

describe('comparing a stored row with what was sent', () => {
  const prefs = {
    user_id: USER,
    sign_profile_id: 'isl',
    target_language_code: 'mr',
    voice_enabled: true,
    theme_mode: 'dark',
  };

  it('accepts a row that matches, and ignores key order', () => {
    // JSONB does not preserve the order keys were written in, so a row that came
    // back with its keys shuffled is the same row.
    const reordered = {
      theme_mode: 'dark',
      voice_enabled: true,
      target_language_code: 'mr',
      sign_profile_id: 'isl',
      user_id: USER,
    };
    expect(verifyPreferences(USER, prefs, [reordered])).toEqual({ ok: true });
  });

  it('does not require the server-owned timestamps to match anything', () => {
    /*
     * The row carries `created_at` and `updated_at`, which no client uploads.
     * The check passes on them being present and different from anything the
     * client holds — which is the point: comparing them would be comparing the
     * server's clock with the device's, and a wrong device clock would then read
     * as a failed upload.
     */
    const stored = {
      ...prefs,
      created_at: '1999-01-01T00:00:00Z',
      updated_at: '1999-01-01T00:00:00Z',
    };
    expect(verifyPreferences(USER, prefs, [stored])).toEqual({ ok: true });
  });

  it('reports a missing row rather than accepting the write', () => {
    const outcome = verifyPreferences(USER, prefs, []);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problem).toContain('is not in the database');
  });

  it('names the column that differs, and both values', () => {
    const stored = { ...prefs, target_language_code: 'en' };
    const outcome = verifyPreferences(USER, prefs, [stored]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problem).toContain('target_language_code');
      expect(outcome.problem).toContain('"mr"');
      expect(outcome.problem).toContain('"en"');
    }
  });

  it('refuses to choose between two rows where one is expected', () => {
    // Only reachable if the unique constraint is missing, which is exactly the
    // condition worth failing on rather than resolving arbitrarily.
    const outcome = verifyPreferences(USER, prefs, [prefs, { ...prefs, theme_mode: 'light' }]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problem).toContain('2 records');
  });

  it('refuses a row belonging to another account, for every record kind', () => {
    const foreign = { ...prefs, user_id: 'user-999' };
    const settings = verifyPreferences(USER, prefs, [foreign]);
    expect(settings.ok).toBe(false);
    if (!settings.ok) expect(settings.problem).toContain('another account');

    const calibration = verifyCalibration(
      USER,
      {
        user_id: USER,
        side: 'left',
        captured_at_ms: 5_000,
        sign_language_id: null,
        channels: [],
      },
      [{ user_id: 'user-999', side: 'left', captured_at_ms: 5_000, sign_language_id: null, channels: [] }],
    );
    expect(calibration.ok).toBe(false);

    const oled = verifyOledProfiles(USER, [], [{ user_id: 'user-999', profile_id: 'p1' }]);
    expect(oled.ok).toBe(false);

    const history = verifyHistory(USER, [], [{ user_id: 'user-999', entry_id: 'h' }]);
    expect(history.ok).toBe(false);
  });

  it('catches a JSONB value stored as a JSON string', () => {
    /*
     * The real defect this guards: a `JSON.stringify`ed object written into a
     * JSONB column is stored as a *string*, which satisfies every count-based
     * check while making the value unusable on another device.
     */
    const channels = [{ channel: 1, value: 0.5 }];
    const outcome = verifyCalibration(
      USER,
      {
        user_id: USER,
        side: 'left',
        captured_at_ms: 5_000,
        sign_language_id: 'isl',
        channels,
      },
      [
        {
          user_id: USER,
          side: 'left',
          captured_at_ms: 5_000,
          sign_language_id: 'isl',
          channels: JSON.stringify(channels),
        },
      ],
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problem).toContain('channels');
  });

  it('treats a value it cannot compare as a failure rather than a match', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(canonical(cyclic)).toBeUndefined();
  });
});

/* ------------------------------------------- a server that keeps nothing */

/**
 * A server whose writes are accepted and stored nowhere.
 *
 * Modelled by resolving the write successfully without running it. This is the
 * shape of the two silent failures read-back exists for: a policy that matched
 * no row and raised nothing, and an `ON CONFLICT` whose target matched no
 * constraint — both of which the app previously reported as a completed
 * migration.
 */
function serverThatStoresNothing(options: FakeSupabaseOptions = {}) {
  const base = createFakeSupabase(options);
  let accepted = 0;

  const from = (table: string) => {
    const builder = base.from(table);
    const settle = builder.then;
    const upsert = builder.upsert;
    let isWrite = false;

    builder.upsert = (row: Record<string, unknown>, opts?: { onConflict?: string }) => {
      isWrite = true;
      return upsert(row, opts);
    };
    builder.then = (resolve: any, reject: any) => {
      if (!isWrite) return settle(resolve, reject);
      accepted += 1;
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    };

    return builder;
  };

  return {
    client: { ...base, from } as unknown as FakeSupabase,
    accepted: () => accepted,
  };
}

describe('an upload the server accepted and did not store', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createInMemoryStorage();
    setSupabaseDisabledForTesting(false);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  it('is not reported as a completed migration', async () => {
    await seedGuestData(storage);
    const server = serverThatStoresNothing();
    setCustomSupabaseClient(server.client as any);

    const state = await new SyncManager().syncAll(USER, storage, EVERYTHING);

    // The writes were accepted — so "the request succeeded" was true, and
    // useless. The read-back is what makes the difference.
    expect(server.accepted()).toBeGreaterThan(0);
    expect(state.status).toBe('error');
    expect(state.status).not.toBe('synced');
    expect(state.lastError).toContain('is not in the database');
  });

  it('says which part is missing, not merely that something failed', async () => {
    await seedGuestData(storage);
    const server = serverThatStoresNothing();
    setCustomSupabaseClient(server.client as any);

    const state = await new SyncManager().syncAll(USER, storage, EVERYTHING);

    expect(state.lastError).toContain('your saved settings');
  });

  it('leaves every local record on the device', async () => {
    await seedGuestData(storage);
    const server = serverThatStoresNothing();
    setCustomSupabaseClient(server.client as any);

    await new SyncManager().syncAll(USER, storage, EVERYTHING);

    // A failed migration costs the user nothing: the device is the only copy and
    // nothing here deletes from it.
    expect(await storage.getPreferences()).not.toBeNull();
    expect(await storage.getThemeMode()).toBe('dark');
    expect(await storage.getCalibration('left')).not.toBeNull();
    expect(await storage.getCalibration('right')).not.toBeNull();
    expect(
      (await storage.getJson<{ profiles: OledProfile[] }>(featureKeys.oledProfiles))?.profiles.length,
    ).toBe(1);
    expect((await storage.getHistory()).map((h) => h.id)).toEqual(['h-glove']);
  });
});

/* ------------------------------------------------ a value the server altered */

describe('an upload the server stored differently', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createInMemoryStorage();
    setSupabaseDisabledForTesting(false);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  it('fails the step when the stored name is not the name that was sent', async () => {
    await seedGuestData(storage);

    /*
     * The write lands, with one field changed — the shape of a server that trims
     * or normalises a value. Rows present and count correct, so only a comparison
     * of the values themselves can notice.
     */
    const base = createFakeSupabase();
    const from = (table: string) => {
      const builder = base.from(table);
      const upsert = builder.upsert;
      builder.upsert = (row: Record<string, unknown>, opts?: { onConflict?: string }) =>
        upsert(
          typeof row.name === 'string' ? { ...row, name: row.name.toUpperCase() } : row,
          opts,
        );
      return builder;
    };
    setCustomSupabaseClient({ ...base, from } as any);

    const state = await new SyncManager().syncAll(USER, storage, EVERYTHING);

    // One row exists and it is the right row by every count — and it is wrong.
    expect(base.rows['oled_profiles']).toHaveLength(1);
    expect(state.status).toBe('error');
    expect(state.lastError).toContain('stored differently');
    expect(state.lastError).toContain('name');
    expect(state.lastError).toContain('MORNING');
  });
});

/* --------------------------------------------------- a read-back that is refused */

describe('a read-back the account is not permitted to make', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createInMemoryStorage();
    setSupabaseDisabledForTesting(false);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  it('names the permission problem and says it is not worth retrying', async () => {
    await seedGuestData(storage);

    /*
     * Only `user_history` is refused. It has no read before its upload, so this
     * fault reaches the read-back and nothing else — the account wrote its
     * history and then discovered it cannot read it back.
     */
    const server = createFakeSupabase({
      onRead: (table) =>
        table === 'user_history'
          ? { message: 'permission denied for table user_history', code: '42501' }
          : null,
    });
    setCustomSupabaseClient(server as any);

    const state = await new SyncManager().syncAll(USER, storage, EVERYTHING);

    expect(state.status).toBe('error');
    expect(state.lastError).toContain('not permitted to read back its own records');
    expect(state.lastError).toContain('permission denied');
    // The advice matters: this is not a connection problem and retrying will not
    // change it, so the message must not read like one.
    expect(state.lastError).toContain('retrying will not change it');
    // The write itself did land, which is exactly why the read-back is needed.
    expect(server.rows['user_history']).toHaveLength(1);
  });
});

/* --------------------------------------------- requests that never finish */

describe('a request that never finishes', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createInMemoryStorage();
    setSupabaseDisabledForTesting(false);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  it('stops the request at the deadline instead of waiting forever', async () => {
    await seedGuestData(storage);
    const aborted: string[] = [];
    const server = createFakeSupabase({
      hang: (table, operation) => operation === 'write' && table === 'user_history',
      onAbort: (table, operation) => aborted.push(`${table}:${operation}`),
    });
    setCustomSupabaseClient(server as any);

    const state = await new SyncManager().syncAll(USER, storage, {
      ...EVERYTHING,
      requestTimeoutMs: 25,
    });

    expect(state.status).toBe('error');
    expect(state.lastError).toContain('did not finish within 25 milliseconds');
    expect(state.lastError).toContain('your glove history');
    // The transport was actually cancelled, not merely abandoned: the deadline
    // aborted the request rather than walking away from it.
    expect(aborted).toContain('user_history:write');
  });

  it('leaves the other parts alone, so a retry has less to do', async () => {
    await seedGuestData(storage);
    const server = createFakeSupabase({
      hang: (table, operation) => operation === 'write' && table === 'user_history',
    });
    setCustomSupabaseClient(server as any);

    await new SyncManager().syncAll(USER, storage, { ...EVERYTHING, requestTimeoutMs: 25 });

    // A per-request deadline, not a per-migration one: the four steps that could
    // finish did finish.
    expect(server.rows['user_preferences']).toHaveLength(1);
    expect(server.rows['calibration_profiles']).toHaveLength(2);
    expect(server.rows['oled_profiles']).toHaveLength(1);
    expect(server.rows['user_history'] ?? []).toHaveLength(0);
  });

  it('carries a deadline by default, so no caller can accidentally wait forever', () => {
    expect(SYNC_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SYNC_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

/* ------------------------------------------------- a cancelled migration */

describe('a migration the caller cancels', () => {
  let storage: Storage;

  beforeEach(async () => {
    storage = createInMemoryStorage();
    setSupabaseDisabledForTesting(false);
    await seedGuestData(storage);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  it('aborts the requests in flight and publishes no status', async () => {
    const aborted: string[] = [];
    const server = createFakeSupabase({
      // Every write stays open, so the attempt is genuinely mid-flight when the
      // cancellation arrives.
      hang: (_table, operation) => operation === 'write',
      onAbort: (table, operation) => aborted.push(`${table}:${operation}`),
    });
    setCustomSupabaseClient(server as any);

    const sync = new SyncManager();
    const controller = new AbortController();
    const pending = sync.syncAll(USER, storage, {
      ...EVERYTHING,
      signal: controller.signal,
      requestTimeoutMs: 5_000,
    });

    /*
     * Yield once so the reads settle and the writes are actually outstanding.
     * Cancelling before they are issued would prove nothing about the transport —
     * `request` refuses an already-aborted signal outright, so no request is made
     * at all and there is nothing to abort. The case below covers that separately.
     */
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });
    controller.abort();
    const state = await pending;

    expect(aborted.length).toBeGreaterThan(0);
    // The writes really were outstanding, so the abort had something to stop.
    expect(aborted.every((entry) => entry.endsWith(':write'))).toBe(true);
    // Nothing landed, because nothing was allowed to land.
    expect(server.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(server.rows['user_history'] ?? []).toHaveLength(0);
    /*
     * The cancelled attempt reports nothing. A caller that cancelled has already
     * moved on, and an error banner appearing afterwards is the resurrection this
     * whole mechanism exists to prevent.
     */
    expect(state.status).not.toBe('error');
    expect(state.lastError).toBeNull();
  });

  it('sends nothing at all when the cancellation lands before the work starts', async () => {
    const aborted: string[] = [];
    const server = createFakeSupabase({
      onAbort: (table, operation) => aborted.push(`${table}:${operation}`),
    });
    setCustomSupabaseClient(server as any);

    const sync = new SyncManager();
    const controller = new AbortController();
    // Cancelled in the same tick that started it, so the steps resume to find the
    // signal already aborted.
    const pending = sync.syncAll(USER, storage, {
      ...EVERYTHING,
      signal: controller.signal,
    });
    controller.abort();
    const state = await pending;

    // A cancellation that beats the first request should issue no request, not
    // issue one and then abandon it.
    expect(aborted).toHaveLength(0);
    expect(Object.values(server.rows).every((rows) => (rows ?? []).length === 0)).toBe(true);
    expect(state.status).not.toBe('error');
    expect(state.lastError).toBeNull();
  });

  it('does not leave the status stuck reporting a sync that stopped', async () => {
    const server = createFakeSupabase({ hang: (_table, operation) => operation === 'write' });
    setCustomSupabaseClient(server as any);

    const sync = new SyncManager();
    const controller = new AbortController();
    const pending = sync.syncAll(USER, storage, {
      ...EVERYTHING,
      signal: controller.signal,
      requestTimeoutMs: 5_000,
    });
    controller.abort();
    const state = await pending;

    // The attempt set `syncing` on its way in. Cancelling has to undo that, or
    // the screen spins forever over work nobody is doing.
    expect(state.status).toBe('idle');
    expect(sync.getState().status).toBe('idle');
  });

  it('refuses to start at all when the signal is already aborted', async () => {
    const server = createFakeSupabase();
    setCustomSupabaseClient(server as any);

    const sync = new SyncManager();
    const controller = new AbortController();
    controller.abort();

    const state = await sync.syncAll(USER, storage, {
      ...EVERYTHING,
      signal: controller.signal,
    });

    expect(server.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(state.status).not.toBe('error');
  });
});

/* ------------------------------------------------------ the OLED storage key */

describe('the key an OLED profile is written under', () => {
  beforeEach(() => {
    setSupabaseDisabledForTesting(false);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  /** A storage that records every key read and written through it. */
  function watchedStorage(base: Storage) {
    const reads: string[] = [];
    const writes: string[] = [];
    const proxy = new Proxy(base, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        const bound = value.bind(target);
        if (property === 'getJson') {
          return async (key: string) => {
            reads.push(key);
            return bound(key);
          };
        }
        if (property === 'setJson') {
          return async (key: string, next: unknown) => {
            writes.push(key);
            return bound(key, next);
          };
        }
        return bound;
      },
    }) as Storage;
    return { storage: proxy, reads, writes };
  }

  it('is the same key it was read from', async () => {
    /*
     * What this can show, and what it cannot.
     *
     * The defect was a *drift*: the read used `featureKeys.oledProfiles` while
     * the write spelled the same string out again. Because both spellings were
     * equal, nothing failed — and no runtime assertion could have caught it,
     * since a duplicated literal and the constant produce the same value. What a
     * runtime test *can* show is that the merge path reads and writes the one
     * canonical key rather than some other key, which is what this asserts. The
     * duplication itself is guarded by the source check below, which is the only
     * kind of check that can see the difference.
     */
    const base = createInMemoryStorage();
    await base.setJson(featureKeys.oledProfiles, {
      profiles: [oledProfile('p1', 'Local')],
      activeProfileId: 'p1',
    });

    // A profile that exists only on the server, so the merge path runs and a
    // write to local storage actually happens.
    const server = createFakeSupabase();
    server.rows['oled_profiles'] = [
      {
        user_id: USER,
        profile_id: 'p2',
        name: 'From another device',
        created_at_ms: 1,
        updated_at_ms: 2,
        left_config: defaultHandConfig(),
        right_config: defaultHandConfig(),
      },
    ];
    setCustomSupabaseClient(server as any);

    const { storage, reads, writes } = watchedStorage(base);
    const state = await new SyncManager().syncAll(USER, storage, { requestTimeoutMs: 200 });

    expect(state.status).toBe('synced');

    const oledReads = reads.filter((key) => key.includes('oled-profiles'));
    const oledWrites = writes.filter((key) => key.includes('oled-profiles'));

    expect(oledReads.length).toBeGreaterThan(0);
    expect(oledWrites.length).toBeGreaterThan(0);
    // The canonical key exactly — not merely some key that looks like one. A
    // merge writing to a second, differently-named OLED key fails here.
    expect(new Set(oledReads)).toEqual(new Set([featureKeys.oledProfiles]));
    expect(new Set(oledWrites)).toEqual(new Set([featureKeys.oledProfiles]));

    const merged = await base.getJson<{ profiles: OledProfile[] }>(featureKeys.oledProfiles);
    expect(merged?.profiles.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  /**
   * Every file under `src`, so a key can be looked for where it would be written.
   *
   * Reading the source is deliberate and is the only way to make this particular
   * defect detectable: the drift was two spellings of one string, and two
   * spellings of one string are indistinguishable at runtime.
   */
  function sourceFiles(): { path: string; text: string }[] {
    const root = path.join(__dirname, '..', 'src');
    const found: { path: string; text: string }[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
          found.push({
            path: path.relative(path.join(__dirname, '..'), full).split(path.sep).join('/'),
            text: fs.readFileSync(full, 'utf8'),
          });
        }
      }
    };

    walk(root);
    return found;
  }

  it('is spelled in one place, so a rename cannot leave a write behind', () => {
    /*
     * The defect reported in the audit was a *duplicated* key literal: the read
     * used `featureKeys.oledProfiles` and the write spelled `'sv/v1/oled-profiles'`
     * out again. Equal today, so nothing failed — and the day the key is renamed
     * the read follows it while the write does not, leaving a profile merged in
     * from another device stored where the app never looks.
     *
     * Set equality on values cannot see this, so the check is on the source: each
     * key that `src/storage/index.ts` defines may appear as a literal *only*
     * there. Every other module must reach it through `storageKeys` (or the
     * `featureKeys` subset). This also answers the brief's wider question about
     * similar duplicated keys, because it covers the whole key set rather than
     * the OLED entry alone.
     *
     * Out of scope by construction: keys this module does not define. The push
     * registration key, the per-user consent key and the per-user cache prefix
     * are each a single constant or template in their own module, so there is no
     * second spelling of them to drift from.
     */
    const files = sourceFiles();
    // If the walk silently returned nothing the assertions below would pass
    // vacuously, which is the failure mode of every source-reading test.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.path === 'src/storage/index.ts')).toBe(true);

    const defined: { name: string; value: string }[] = [];
    for (const [name, value] of Object.entries(storageKeys)) {
      if (typeof value === 'string') defined.push({ name, value });
    }
    // `calibration` is deliberately excluded: it is a function building
    // `sv/v1/calibration/<side>`, so there is no single literal to duplicate.
    expect(defined.length).toBeGreaterThanOrEqual(8);

    const repeated: string[] = [];
    for (const { name, value } of defined) {
      for (const file of files) {
        if (file.path === 'src/storage/index.ts') continue;
        file.text.split('\n').forEach((line, index) => {
          // A key named in prose is documentation, not a second definition.
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;

          for (const quote of ["'", '"', '`']) {
            if (line.includes(`${quote}${value}${quote}`)) {
              repeated.push(`${file.path}:${index + 1} repeats the key for "${name}"`);
            }
          }
        });
      }
    }

    expect(repeated).toEqual([]);
  });
});
