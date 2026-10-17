/**
 * Guest-data consent and migration — behavioural suite.
 *
 * Every assertion here is about *state*: what ended up in the fake server's
 * tables, and what is still on the device. None of them is about whether a mock
 * function was called, because a call-count assertion cannot distinguish "the
 * data was uploaded" from "an upload was attempted and silently discarded".
 *
 * The storage is the real `createInMemoryStorage`, so a test that says local
 * data survived is reading the same code path the app uses.
 */
import {
  resetSupabaseClient,
  setCustomSupabaseClient,
  setSupabaseDisabledForTesting,
} from '../src/supabase/client';
import {
  ALL_MIGRATABLE_SCOPES,
  SyncManager,
  type MigratableScope,
} from '../src/supabase/sync';
import {
  clearMigrationDecision,
  hasMigratableData,
  migrationConsentKey,
  migratableScopesFor,
  readMigrationDecision,
  recordMigrationDecision,
  summariseGuestData,
} from '../src/supabase/guestMigration';
import { createInMemoryStorage, featureKeys, type Storage } from '../src/storage';
import { createDemoCalibration } from '../src/sensors/calibration';
import { defaultHandConfig, type OledProfile } from '../src/oled/profiles';
import { createFakeSupabase, type FakeSupabase } from './fakeSupabase';

const USER = 'user-1';

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

/** Seeds the device with one of everything a guest could have accumulated. */
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

describe('guest-data consent and migration', () => {
  let storage: Storage;
  let fake: FakeSupabase;
  let sync: SyncManager;

  beforeEach(() => {
    storage = createInMemoryStorage();
    fake = createFakeSupabase();
    sync = new SyncManager();
    setCustomSupabaseClient(fake as any);
    setSupabaseDisabledForTesting(false);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  /** Everything that must still be on the device after any outcome. */
  async function expectLocalDataIntact(): Promise<void> {
    expect(await storage.getPreferences()).not.toBeNull();
    expect(await storage.getThemeMode()).toBe('dark');
    expect(await storage.getCalibration('left')).not.toBeNull();
    expect(await storage.getCalibration('right')).not.toBeNull();

    const oled = await storage.getJson<{ profiles: OledProfile[] }>(featureKeys.oledProfiles);
    expect(oled?.profiles.map((p) => p.id)).toEqual(['p1', 'p2']);

    const history = await storage.getHistory();
    expect(history.map((h) => h.id).sort()).toEqual(['h-demo', 'h-glove']);
  }

  // ---------------------------------------------------------------- defaults

  describe('nothing is uploaded without explicit permission', () => {
    it('uploads nothing when syncAll is called with no options', async () => {
      await seedGuestData(storage);

      const state = await sync.syncAll(USER, storage);

      expect(state.status).toBe('synced');
      // The exact defect being fixed: a plain sync used to push all of this.
      expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
      expect(fake.rows['calibration_profiles'] ?? []).toHaveLength(0);
      expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
      expect(fake.rows['user_history'] ?? []).toHaveLength(0);
      await expectLocalDataIntact();
    });

    it('uploads nothing when uploadLocalData is explicitly false', async () => {
      await seedGuestData(storage);

      await sync.syncAll(USER, storage, { uploadLocalData: false });

      expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
      expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
      await expectLocalDataIntact();
    });

    it('still reads an account’s existing data down to the device', async () => {
      // Download is not gated: it is what an account is for.
      fake.rows['user_preferences'] = [
        {
          user_id: USER,
          sign_profile_id: 'isl_advanced',
          target_language_code: 'en',
          voice_enabled: false,
          theme_mode: 'light',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ];

      await sync.syncAll(USER, storage, { uploadLocalData: false });

      expect((await storage.getPreferences())?.targetLanguageCode).toBe('en');
      expect(await storage.getThemeMode()).toBe('light');
    });
  });

  // -------------------------------------------------------------- acceptance

  describe('accepting the migration', () => {
    it('uploads every consented scope, and only the glove-recording history', async () => {
      await seedGuestData(storage);

      const state = await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ALL_MIGRATABLE_SCOPES,
      });

      expect(state.status).toBe('synced');

      expect(fake.rows['user_preferences']).toHaveLength(1);
      expect(fake.rows['user_preferences'][0].target_language_code).toBe('mr');

      expect(fake.rows['calibration_profiles']).toHaveLength(2);
      expect(fake.rows['calibration_profiles'].map((r) => r.side).sort()).toEqual([
        'left',
        'right',
      ]);

      expect(fake.rows['oled_profiles']).toHaveLength(2);

      // Simulated history stays behind; it is never uploadable.
      expect(fake.rows['user_history']).toHaveLength(1);
      expect(fake.rows['user_history'][0].entry_id).toBe('h-glove');
    });

    it('respects a narrowed scope list', async () => {
      await seedGuestData(storage);

      await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ['preferences'] satisfies MigratableScope[],
      });

      expect(fake.rows['user_preferences']).toHaveLength(1);
      expect(fake.rows['calibration_profiles'] ?? []).toHaveLength(0);
      expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
      expect(fake.rows['user_history'] ?? []).toHaveLength(0);
      await expectLocalDataIntact();
    });

    it('keeps every local record after a successful upload', async () => {
      await seedGuestData(storage);

      await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ALL_MIGRATABLE_SCOPES,
      });

      await expectLocalDataIntact();
    });
  });

  // ------------------------------------------------------------- idempotency

  describe('repeating an upload does not duplicate rows', () => {
    it('leaves exactly one row per record across three runs', async () => {
      await seedGuestData(storage);

      for (let run = 0; run < 3; run += 1) {
        await sync.syncAll(USER, storage, {
          uploadLocalData: true,
          scopes: ALL_MIGRATABLE_SCOPES,
        });
      }

      expect(fake.rows['user_preferences']).toHaveLength(1);
      expect(fake.rows['calibration_profiles']).toHaveLength(2);
      expect(fake.rows['oled_profiles']).toHaveLength(2);
      expect(fake.rows['user_history']).toHaveLength(1);
    });

    it('upserts rather than inserts when a profile is renamed', async () => {
      await seedGuestData(storage);
      await sync.syncAll(USER, storage, { uploadLocalData: true });

      // Same id, new name: must update the row, not add a second one beside it.
      await storage.setJson(featureKeys.oledProfiles, {
        profiles: [oledProfile('p1', 'Renamed', 4_000), oledProfile('p2', 'Evening', 3_000)],
        activeProfileId: 'p1',
      });
      await sync.syncAll(USER, storage, { uploadLocalData: true });

      expect(fake.rows['oled_profiles']).toHaveLength(2);
      const p1 = fake.rows['oled_profiles'].find((r) => r.profile_id === 'p1');
      expect(p1?.name).toBe('Renamed');
    });
  });

  // ---------------------------------------------------------------- failures

  describe('a failed upload', () => {
    it('preserves every local record and reports an error', async () => {
      await seedGuestData(storage);
      fake = createFakeSupabase({
        onWrite: (table) =>
          table === 'user_preferences'
            ? { message: 'Database connection failed', code: '08006' }
            : null,
      });
      setCustomSupabaseClient(fake as any);

      const state = await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ALL_MIGRATABLE_SCOPES,
      });

      expect(state.status).toBe('error');
      expect(state.lastError).toContain('Database connection failed');
      await expectLocalDataIntact();
    });

    it('stops part way without losing the device copy, then completes on retry', async () => {
      await seedGuestData(storage);

      // Fail the second OLED row, so the first one has already been written.
      const failSecond: FakeSupabase = createFakeSupabase({
        onWrite: (table, row) =>
          table === 'oled_profiles' && row.profile_id === 'p2'
            ? { message: 'row rejected by policy', code: '42501' }
            : null,
      });
      setCustomSupabaseClient(failSecond as any);

      const failed = await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ALL_MIGRATABLE_SCOPES,
      });

      expect(failed.status).toBe('error');
      expect(failed.lastError).toContain('row rejected by policy');
      // The first row landed, so the operation is genuinely partial — and the
      // test says so rather than pretending nothing happened.
      expect(failSecond.rows['oled_profiles']).toHaveLength(1);
      await expectLocalDataIntact();

      // Retry with the fault cleared: no duplicates, everything present.
      setCustomSupabaseClient(fake as any);
      const retried = await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ALL_MIGRATABLE_SCOPES,
      });

      expect(retried.status).toBe('synced');
      expect(fake.rows['oled_profiles']).toHaveLength(2);
      expect(fake.rows['user_preferences']).toHaveLength(1);
      await expectLocalDataIntact();
    });

    it('treats an expired session as a failure and keeps the device copy', async () => {
      await seedGuestData(storage);
      fake = createFakeSupabase({
        onWrite: () => ({ message: 'JWT expired', code: 'PGRST301', status: 401 }),
      });
      setCustomSupabaseClient(fake as any);

      const state = await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ALL_MIGRATABLE_SCOPES,
      });

      expect(state.status).toBe('error');
      expect(state.lastError).toContain('JWT expired');
      expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
      await expectLocalDataIntact();
    });

    it('reports offline and uploads nothing when there is no client', async () => {
      await seedGuestData(storage);
      setSupabaseDisabledForTesting(true);

      const state = await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ALL_MIGRATABLE_SCOPES,
      });

      expect(state.status).toBe('offline');
      expect(state.lastError).toBe('Supabase is not configured.');
      await expectLocalDataIntact();
    });
  });

  // ------------------------------------------------------------------ consent

  describe('the recorded decision', () => {
    it('is absent until the user answers', async () => {
      expect(await readMigrationDecision(storage, USER)).toBeNull();
    });

    it('remembers an acceptance together with the scopes agreed to', async () => {
      await recordMigrationDecision(storage, USER, true, ['preferences', 'oled_profiles']);

      const decision = await readMigrationDecision(storage, USER);
      expect(decision?.accepted).toBe(true);
      expect(decision?.scopes).toEqual(['preferences', 'oled_profiles']);
    });

    it('remembers a refusal, and records no scopes for it', async () => {
      await recordMigrationDecision(storage, USER, false, ALL_MIGRATABLE_SCOPES);

      const decision = await readMigrationDecision(storage, USER);
      expect(decision?.accepted).toBe(false);
      // A refusal must not carry permissions that a later reader could act on.
      expect(decision?.scopes).toEqual([]);
    });

    it('does not let one user’s answer speak for another', async () => {
      await recordMigrationDecision(storage, USER, false, []);

      expect(await readMigrationDecision(storage, 'user-2')).toBeNull();
    });

    it('treats an unreadable record as unasked rather than as consent', async () => {
      await storage.setJson(migrationConsentKey(USER), { scopes: ['preferences'] });

      expect(await readMigrationDecision(storage, USER)).toBeNull();
    });

    it('refuses an acceptance naming a scope this build does not implement', async () => {
      /*
       * A record written by some other version of the app, or corrupted. It is
       * discarded whole rather than partially honoured: keeping the recognised
       * half would let a later "synced" status stand for a migration that was
       * agreed to and did not fully happen. Discarding it sends the user back to
       * the question, which is the only outcome where nothing is uploaded that
       * was not explicitly agreed to.
       */
      await storage.setJson(migrationConsentKey(USER), {
        accepted: true,
        scopes: ['preferences', 'telepathy'],
        decidedAtMs: 1,
      });

      expect(await readMigrationDecision(storage, USER)).toBeNull();
    });

    it('never reads an acceptance that names no scopes as permission for everything', async () => {
      await storage.setJson(migrationConsentKey(USER), {
        accepted: true,
        scopes: [],
        decidedAtMs: 1,
      });

      // The one thing this must not become is "consent to all scopes".
      expect(await readMigrationDecision(storage, USER)).toBeNull();
    });

    it('never reads a malformed acceptance as permission for everything', async () => {
      for (const scopes of [null, 'preferences', 42, { 0: 'preferences' }, undefined]) {
        await storage.setJson(migrationConsentKey(USER), {
          accepted: true,
          scopes,
          decidedAtMs: 1,
        });

        expect(await readMigrationDecision(storage, USER)).toBeNull();
      }
    });

    it('ignores a repeated scope rather than acting on it twice', async () => {
      await storage.setJson(migrationConsentKey(USER), {
        accepted: true,
        scopes: ['preferences', 'preferences', 'oled_profiles'],
        decidedAtMs: 1,
      });

      expect((await readMigrationDecision(storage, USER))?.scopes).toEqual([
        'preferences',
        'oled_profiles',
      ]);
    });

    it('keeps a refusal readable even when its scopes are unreadable', async () => {
      // A "no" carries no permissions, so there is nothing in it to misinterpret.
      await storage.setJson(migrationConsentKey(USER), {
        accepted: false,
        scopes: ['telepathy'],
        decidedAtMs: 1,
      });

      const decision = await readMigrationDecision(storage, USER);
      expect(decision?.accepted).toBe(false);
      expect(decision?.scopes).toEqual([]);
    });

    it('can be cleared so the question is asked again', async () => {
      await recordMigrationDecision(storage, USER, true, ['preferences']);
      await clearMigrationDecision(storage, USER);

      expect(await readMigrationDecision(storage, USER)).toBeNull();
    });
  });

  // ------------------------------------------------------------------ summary

  describe('the summary shown to the user', () => {
    it('reports nothing for an empty device', async () => {
      const summary = await summariseGuestData(storage);

      expect(hasMigratableData(summary)).toBe(false);
      expect(migratableScopesFor(summary)).toEqual([]);
    });

    it('counts glove history as eligible and simulated history as not', async () => {
      await seedGuestData(storage);

      const summary = await summariseGuestData(storage);

      expect(summary.gloveHistoryCount).toBe(1);
      expect(summary.demoHistoryCount).toBe(1);
      expect(summary.calibrationSides).toEqual(['left', 'right']);
      expect(summary.oledProfileCount).toBe(2);
      expect(hasMigratableData(summary)).toBe(true);
    });

    it('does not prompt about a device holding only simulated history', async () => {
      await storage.addHistoryEntry({
        id: 'h-demo-only',
        text: 'simulated',
        profileId: 'isl',
        source: 'demo',
        createdAtMs: 1,
      });

      const summary = await summariseGuestData(storage);

      expect(summary.demoHistoryCount).toBe(1);
      // Nothing here would actually move, so there is nothing to ask about.
      expect(hasMigratableData(summary)).toBe(false);
    });

    it('lists only the scopes that have data behind them', async () => {
      await storage.setPreferences({
        signProfileId: 'isl',
        targetLanguageCode: 'mr',
        voiceEnabled: false,
      });

      const summary = await summariseGuestData(storage);

      expect(migratableScopesFor(summary)).toEqual(['preferences']);
    });
  });

  // ------------------------------------------- counting against what was agreed

  describe('how much failed is counted against what was agreed to', () => {
    it('reports one agreed part as one of one, not one of five', async () => {
      await seedGuestData(storage);
      fake = createFakeSupabase({
        onWrite: (table) =>
          table === 'oled_profiles'
            ? { message: 'Row rejected by policy', code: '42501' }
            : null,
      });
      setCustomSupabaseClient(fake as any);

      const state = await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ['oled_profiles'] satisfies MigratableScope[],
      });

      expect(state.status).toBe('error');
      // "1 of 5" would imply four further permissions and four further failures
      // that never existed. The user agreed to one kind of record.
      expect(state.lastError).toContain('1 of 1 part');
      expect(state.lastError).toContain('your OLED profiles');
      expect(state.lastError).not.toContain('of 5');

      // And the narrowed consent was honoured: nothing else was sent.
      expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
      expect(fake.rows['calibration_profiles'] ?? []).toHaveLength(0);
      expect(fake.rows['user_history'] ?? []).toHaveLength(0);
      await expectLocalDataIntact();
    });

    it('counts both glove sides when the agreement covered calibrations', async () => {
      await seedGuestData(storage);
      // One glove's calibration is refused; the other is accepted.
      fake = createFakeSupabase({
        onWrite: (table, row) =>
          table === 'calibration_profiles' && row.side === 'right'
            ? { message: 'Row rejected by policy', code: '42501' }
            : null,
      });
      setCustomSupabaseClient(fake as any);

      const state = await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        scopes: ['calibration'] satisfies MigratableScope[],
      });

      expect(state.status).toBe('error');
      // Two parts were agreed to — a left calibration and a right one — so one
      // of them failing is "1 of 2", not "1 of 1".
      expect(state.lastError).toContain('1 of 2 parts');
      expect(state.lastError).toContain('the right glove calibration');
      // The part that arrived is not reported as a failure.
      expect(state.lastError).not.toContain('the left glove calibration');

      expect(fake.rows['calibration_profiles']).toHaveLength(1);
      expect(fake.rows['calibration_profiles'][0].side).toBe('left');
      await expectLocalDataIntact();
    });

    it('reports no ratio at all when only non-agreed steps failed', async () => {
      await seedGuestData(storage);
      /*
       * A download-only sync whose read fails. No upload was agreed to, so there
       * is no meaningful "x of y agreed parts" — claiming "1 of 0" or "1 of 5"
       * would both be wrong. The failure is still reported, and still named.
       */
      fake = createFakeSupabase({
        onRead: (table) =>
          table === 'calibration_profiles'
            ? { message: 'Connection lost', code: '08006' }
            : null,
      });
      setCustomSupabaseClient(fake as any);

      const state = await sync.syncAll(USER, storage, { uploadLocalData: false });

      expect(state.status).toBe('error');
      expect(state.lastError).toContain('The sync did not finish');
      expect(state.lastError).toContain('the left glove calibration');
      expect(state.lastError).toContain('Connection lost');
      expect(state.lastError).not.toContain('of 0');
      expect(state.lastError).not.toContain('of 5');
      await expectLocalDataIntact();
    });

    it('treats a scope name this build does not know as no permission at all', async () => {
      await seedGuestData(storage);

      const state = await sync.syncAll(USER, storage, {
        uploadLocalData: true,
        // The shape a persisted record from another app version could take.
        scopes: ['telepathy'] as unknown as MigratableScope[],
      });

      // An unrecognised name must narrow to nothing rather than be read as
      // "the caller meant everything".
      expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
      expect(fake.rows['calibration_profiles'] ?? []).toHaveLength(0);
      expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
      expect(fake.rows['user_history'] ?? []).toHaveLength(0);
      // Nothing to upload is not a failure: the download half did run.
      expect(state.status).toBe('synced');
      await expectLocalDataIntact();
    });
  });
});
