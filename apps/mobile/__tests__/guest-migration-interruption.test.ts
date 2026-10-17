/**
 * An interrupted guest-data migration.
 *
 * The scenario: the user agreed to move this phone's records, some of them
 * reached the server, and the app stopped before the rest arrived — a dropped
 * connection, a killed process, a flat battery. What matters is what the *next*
 * run does.
 *
 * These tests therefore model the state an interruption leaves behind — a
 * partially populated server and a device that still holds everything — rather
 * than the interruption itself, which is not reproducible in a unit test and
 * would not change a single assertion here. The two things an interruption
 * cannot be allowed to lose are modelled separately and explicitly:
 *
 *   - the local records (they are the only copy)
 *   - the fact that consent was already given (or the user is asked twice)
 *
 * The rule this suite exists to enforce: the app may only claim the migration
 * finished when every consented record is actually on the server. A partial
 * upload must report as an error, and the count of rows must never grow on a
 * retry.
 */
import {
  resetSupabaseClient,
  setCustomSupabaseClient,
  setSupabaseDisabledForTesting,
} from '../src/supabase/client';
import { ALL_MIGRATABLE_SCOPES, SyncManager } from '../src/supabase/sync';
import { createDemoCalibration } from '../src/sensors/calibration';
import { defaultHandConfig, type OledProfile } from '../src/oled/profiles';
import { createInMemoryStorage, featureKeys, type Storage } from '../src/storage';
import { createFakeSupabase, type FakeSupabase, type FakeSupabaseOptions } from './fakeSupabase';

const USER = 'user-1';

/** What a complete migration of `seedGuestData` must leave on the server. */
const COMPLETE = {
  user_preferences: 1,
  calibration_profiles: 2,
  oled_profiles: 2,
  user_history: 1,
} as const;

function oledProfile(id: string, name: string, updatedAtMs: number): OledProfile {
  return {
    id,
    name,
    createdAtMs: 1_000,
    updatedAtMs,
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
    profiles: [oledProfile('p1', 'Morning', 2_000), oledProfile('p2', 'Evening', 3_000)],
    activeProfileId: 'p1',
  });
  await storage.addHistoryEntry({
    id: 'h-glove',
    text: 'measured',
    profileId: 'isl',
    source: 'glove',
    createdAtMs: 10,
  });
  await storage.addHistoryEntry({
    id: 'h-demo',
    text: 'simulated',
    profileId: 'isl',
    source: 'demo',
    createdAtMs: 20,
  });
}

/** Row counts per table, in the exact shape a complete migration produces. */
function counts(server: FakeSupabase): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of Object.keys(COMPLETE)) {
    out[table] = (server.rows[table] ?? []).length;
  }
  return out;
}

/**
 * Wraps the fake server so requests take a measurable time, and counts how many
 * are running at once.
 *
 * The counting is what makes the coordination guarantee testable. A test can
 * then ask the question that actually matters — "at the moment the status was
 * published, was anything from that attempt still running?" — rather than
 * asserting on a proxy for it. The delays are uneven on purpose, so a failure
 * in the quick step genuinely overlaps the slow ones.
 *
 * ## Why the delay is applied to `then` and not to `upsert`
 *
 * The sync engine chains `.abortSignal(signal)` after `.upsert(...)`, as it must
 * against the real builder. Wrapping `upsert` in an `async` function would make
 * it return a bare promise, and the chain would fail on a method that promises
 * do not have — a `TypeError` that looks like a sync bug rather than a test
 * double that stopped resembling the client. Delaying the *settle* leaves every
 * method returning the builder, so the timing model is unchanged while the
 * interface stays faithful. Reads are counted too, because a read-back is just
 * as much an outstanding request as a write.
 */
function instrumentedServer(options: FakeSupabaseOptions) {
  const base = createFakeSupabase(options);
  let inFlight = 0;
  let peak = 0;

  const delays: Record<string, number> = {
    user_preferences: 1,
    calibration_profiles: 5,
    oled_profiles: 10,
    user_history: 40,
  };

  const from = (table: string) => {
    const builder = base.from(table);
    const settle = builder.then;

    builder.then = (resolve: any, reject: any) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<void>((go) => {
        setTimeout(go, delays[table] ?? 1);
      })
        .then(() => settle(resolve, reject))
        .then(
          (value: unknown) => {
            inFlight -= 1;
            return value;
          },
          (error: unknown) => {
            inFlight -= 1;
            throw error;
          },
        );
    };

    return builder;
  };

  return {
    client: { ...base, from } as unknown as FakeSupabase,
    stats: () => ({ inFlight, peak }),
  };
}

describe('an interrupted guest-data migration', () => {
  let storage: Storage;
  let server: FakeSupabase;
  /** Mutable so one live server can be faulted, and the fault lifted, mid-test. */
  let faults: { onWrite?: FakeSupabaseOptions['onWrite'] };

  beforeEach(() => {
    storage = createInMemoryStorage();
    faults = {};
    server = createFakeSupabase(faults);
    setCustomSupabaseClient(server as any);
    setSupabaseDisabledForTesting(false);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  const runSync = (sync: SyncManager) =>
    sync.syncAll(USER, storage, {
      uploadLocalData: true,
      scopes: ALL_MIGRATABLE_SCOPES,
    });

  /** Everything that must survive an interruption, on the device. */
  async function expectDeviceIntact(): Promise<void> {
    expect(await storage.getPreferences()).not.toBeNull();
    expect(await storage.getThemeMode()).toBe('dark');
    expect(await storage.getCalibration('left')).not.toBeNull();
    expect(await storage.getCalibration('right')).not.toBeNull();

    const oled = await storage.getJson<{ profiles: OledProfile[] }>(featureKeys.oledProfiles);
    expect(oled?.profiles.map((p) => p.id)).toEqual(['p1', 'p2']);

    const history = await storage.getHistory();
    expect(history.map((h) => h.id).sort()).toEqual(['h-demo', 'h-glove']);
  }

  // ------------------------------------------------- the interrupted device

  it('leaves the whole device copy in place while the server is incomplete', async () => {
    await seedGuestData(storage);
    // The connection drops before the history write — the last step to run.
    faults.onWrite = (table) =>
      table === 'user_history' ? { message: 'Connection lost', code: '08006' } : null;

    const state = await runSync(new SyncManager());

    expect(state.status).toBe('error');
    // Partial: the earlier writes landed, the last one did not. The test says
    // so rather than pretending the interruption was a clean no-op.
    expect(counts(server)).toEqual({ ...COMPLETE, user_history: 0 });
    await expectDeviceIntact();
  });

  it('does not report the migration as complete when a consented record is missing', async () => {
    await seedGuestData(storage);
    faults.onWrite = (table) =>
      table === 'user_history' ? { message: 'Connection lost', code: '08006' } : null;

    const state = await runSync(new SyncManager());

    // The invariant: "synced" is only ever said when every consented record is
    // present. Anything less is an error, so the UI cannot claim success over a
    // half-finished migration.
    const missing = Object.entries(COMPLETE).some(
      ([table, expected]) => (server.rows[table] ?? []).length < expected,
    );
    expect(missing).toBe(true);
    expect(state.status).not.toBe('synced');
    expect(state.lastError).toContain('Connection lost');
  });

  // -------------------------------------------------------- resuming a run

  it('resumes after a restart and finishes without duplicating what landed', async () => {
    await seedGuestData(storage);
    faults.onWrite = (table) =>
      table === 'user_history' ? { message: 'Connection lost', code: '08006' } : null;

    await runSync(new SyncManager());
    const afterInterruption = counts(server);
    expect(afterInterruption['oled_profiles']).toBe(2); // land, ahead of the failure
    expect(afterInterruption['user_history']).toBe(0);

    // A new process: nothing in memory survives except the device and the
    // server, both of which persist exactly as they were.
    faults.onWrite = undefined;
    const state = await runSync(new SyncManager());

    expect(state.status).toBe('synced');
    // Complete, and — the point of the test — no row was added twice. The two
    // OLED profiles and two calibrations that already existed were updated in
    // place by their conflict targets, not appended beside themselves.
    expect(counts(server)).toEqual({ ...COMPLETE });
    await expectDeviceIntact();
  });

  it('can be resumed repeatedly without the row count drifting', async () => {
    await seedGuestData(storage);
    faults.onWrite = (table) =>
      table === 'user_history' ? { message: 'Connection lost', code: '08006' } : null;

    await runSync(new SyncManager());
    faults.onWrite = undefined;

    // Three further runs, as a user who keeps reopening the app would cause.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await runSync(new SyncManager());
      expect(state.status).toBe('synced');
      expect(counts(server)).toEqual({ ...COMPLETE });
    }

    await expectDeviceIntact();
  });

  it('recovers when the interruption happens before anything was written', async () => {
    await seedGuestData(storage);
    // Interrupted on the very first write, so the server is untouched.
    faults.onWrite = () => ({ message: 'Connection lost', code: '08006' });

    const interrupted = await runSync(new SyncManager());
    expect(interrupted.status).toBe('error');
    expect(counts(server)).toEqual({
      user_preferences: 0,
      calibration_profiles: 0,
      oled_profiles: 0,
      user_history: 0,
    });
    await expectDeviceIntact();

    faults.onWrite = undefined;
    const state = await runSync(new SyncManager());

    expect(state.status).toBe('synced');
    expect(counts(server)).toEqual({ ...COMPLETE });
    await expectDeviceIntact();
  });

  it('stays failed, and still reports failure, while the fault persists', async () => {
    await seedGuestData(storage);
    faults.onWrite = (table) =>
      table === 'user_history' ? { message: 'Connection lost', code: '08006' } : null;

    // Two runs with the fault still in place: the app must not drift into
    // claiming success just because it has tried more than once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await runSync(new SyncManager());
      expect(state.status).toBe('error');
      expect(state.status).not.toBe('synced');
      expect(counts(server)['user_history']).toBe(0);
    }

    await expectDeviceIntact();
  });

  it('reports offline, not completion, when the interruption is the network itself', async () => {
    await seedGuestData(storage);
    await runSync(new SyncManager()); // a first, successful run
    expect(counts(server)).toEqual({ ...COMPLETE });

    setSupabaseDisabledForTesting(true);
    const state = await runSync(new SyncManager());

    expect(state.status).toBe('offline');
    expect(state.status).not.toBe('synced');
    await expectDeviceIntact();
  });

  // ------------------------------------------- overlapping in-flight requests

  describe('a failure that overlaps requests still in flight', () => {
    it('publishes no status until every write from the attempt has stopped', async () => {
      await seedGuestData(storage);
      const { client, stats } = instrumentedServer({
        // The quickest step fails while the slowest is still running.
        onWrite: (table) =>
          table === 'user_preferences' ? { message: 'Connection lost', code: '08006' } : null,
      });
      setCustomSupabaseClient(client as any);

      const state = await runSync(new SyncManager());

      expect(state.status).toBe('error');
      // The whole point: nothing is still in the air when the report is made.
      expect(stats().inFlight).toBe(0);
      // ...and the writes really did overlap, so the assertion above has teeth.
      expect(stats().peak).toBeGreaterThan(1);
    });

    it('names how many parts failed rather than reporting a bare failure', async () => {
      await seedGuestData(storage);
      const { client } = instrumentedServer({
        onWrite: (table) =>
          table === 'oled_profiles' ? { message: 'Row rejected by policy', code: '42501' } : null,
      });
      setCustomSupabaseClient(client as any);

      const state = await runSync(new SyncManager());

      expect(state.status).toBe('error');
      expect(state.lastError).toContain('1 of 5 part');
      expect(state.lastError).toContain('your OLED profiles');
      expect(state.lastError).toContain('Row rejected by policy');
      // The parts that succeeded are not named as failures.
      expect(state.lastError).not.toContain('your saved settings');
      expect(state.lastError).not.toContain('glove history');
    });

    it('states a single reason once even when every part fails for it', async () => {
      await seedGuestData(storage);
      const { client } = instrumentedServer({
        onWrite: () => ({ message: 'Connection lost', code: '08006' }),
      });
      setCustomSupabaseClient(client as any);

      const state = await runSync(new SyncManager());

      expect(state.status).toBe('error');
      expect(state.lastError).toContain('5 of 5 parts');
      // One dropped connection is one fact, not five repetitions of it.
      expect(state.lastError?.split('Connection lost')).toHaveLength(2);
    });

    it('retries only after the previous attempt has fully stopped', async () => {
      await seedGuestData(storage);
      const { client, stats } = instrumentedServer({
        onWrite: (table) =>
          table === 'user_preferences' ? { message: 'Connection lost', code: '08006' } : null,
      });
      setCustomSupabaseClient(client as any);

      const sync = new SyncManager();
      await runSync(sync);
      expect(stats().inFlight).toBe(0);

      // The retry starts from a settled state, so it cannot race the attempt it
      // is retrying — and the deliberately-slow history write is now the only
      // one outstanding while the rest complete.
      const retried = await runSync(sync);

      expect(retried.status).toBe('error');
      expect(stats().inFlight).toBe(0);
      await expectDeviceIntact();
    });
  });
});
