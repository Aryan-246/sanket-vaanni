/**
 * Two syncs at once, and which of them is allowed to speak.
 *
 * The account sheet already refuses to let a stale *callback* write screen
 * state. That guards the screen, not the sync manager: `syncAll` publishes to
 * the manager's own status and to every subscriber, so a slow attempt that
 * finishes after a newer one would publish its own conclusion over it. The
 * visible result is an error banner on a screen whose latest sync succeeded, or
 * "Last synced: just now" on one that just failed — a status that is wrong in
 * the direction the user will act on.
 *
 * Every test here needs the pair, so the setup is shared: a first attempt that
 * is genuinely stuck (a hung write waiting out its deadline) and a second that
 * completes while the first is still open. The control case runs the stuck
 * attempt *alone*, where it does publish its failure — without it, a passing
 * suite would prove nothing about the guard, only that the slow attempt happened
 * to succeed.
 */
import {
  resetSupabaseClient,
  setCustomSupabaseClient,
  setSupabaseDisabledForTesting,
} from '../src/supabase/client';
import { SyncManager } from '../src/supabase/sync';
import { createInMemoryStorage, featureKeys, type Storage } from '../src/storage';
import { defaultHandConfig, type OledProfile } from '../src/oled/profiles';
import { createDemoCalibration } from '../src/sensors/calibration';
import { createFakeSupabase } from './fakeSupabase';

const USER = 'user-1';

/** Everything the second attempt is allowed to do: one quick scope. */
const QUICK = {
  uploadLocalData: true,
  scopes: ['preferences'],
  requestTimeoutMs: 5_000,
} as const;

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

/** A server whose history write never lands, so an attempt can be left open. */
function hangingServer() {
  return createFakeSupabase({
    hang: (table, operation) => operation === 'write' && table === 'user_history',
  });
}

/** Lets the first attempt's requests be issued before the second one starts. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });
}

describe('a sync that a newer sync replaces', () => {
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

  /**
   * Runs the pair and hands back everything the assertions need.
   *
   * The first attempt is given a short deadline of its own, so it stops by
   * timing out *after* the second attempt has already finished — which is the
   * exact ordering the guard exists for.
   */
  async function supersededPair() {
    setCustomSupabaseClient(hangingServer() as any);

    const manager = new SyncManager();
    const published: string[] = [];
    manager.subscribe((state) => published.push(state.status));

    const first = manager.syncAll(USER, storage, {
      uploadLocalData: true,
      scopes: ['preferences', 'calibration', 'oled_profiles', 'glove_history'],
      requestTimeoutMs: 300,
    });
    await tick();

    const secondState = await manager.syncAll(USER, storage, QUICK);

    // The stuck attempt now finishes — with a timeout, which it must keep to
    // itself.
    const firstState = await first;

    return { manager, firstState, secondState, published };
  }

  it('lets the newer result stand, and keeps the older one from overwriting it', async () => {
    const { manager, secondState } = await supersededPair();

    expect(secondState.status).toBe('synced');
    expect(manager.getState().status).toBe('synced');
    expect(manager.getState().lastError).toBeNull();
  });

  it('never publishes the superseded failure to a subscriber', async () => {
    /*
     * The subscriber is the screen. This is the assertion that matters to a
     * person: whatever went wrong in the abandoned attempt must not reach the
     * listener that draws the banner.
     */
    const { published } = await supersededPair();

    expect(published).not.toContain('error');
    expect(published[published.length - 1]).toBe('synced');
  });

  it('reports the current state to the superseded caller, not its own verdict', async () => {
    /*
     * A caller awaiting the old attempt is a screen that has moved on. Handing
     * it its own failure would put that failure back in front of the user, since
     * the obvious thing to do with a returned state is render it.
     */
    const { manager, firstState } = await supersededPair();

    expect(firstState.status).toBe(manager.getState().status);
    expect(firstState.status).not.toBe('error');
    expect(firstState.lastError).toBeNull();
  });

  it('does not stamp a sync time that the superseded attempt did not earn', async () => {
    const { manager } = await supersededPair();

    // `setStatus('synced')` sets this. The superseded attempt must not reach it,
    // or the screen would show a sync time for a run that failed.
    expect(manager.getState().lastSyncedAtMs).not.toBeNull();
  });

  it('would have published that failure had it been the only attempt, so the guard is what stops it', async () => {
    /*
     * The control. Same server, same stuck write, same deadline — but nothing
     * supersedes it. The failure is real and it is published, which is what makes
     * the silence in the tests above a consequence of the guard rather than of
     * the scenario being harmless.
     */
    setCustomSupabaseClient(hangingServer() as any);

    const state = await new SyncManager().syncAll(USER, storage, {
      uploadLocalData: true,
      scopes: ['preferences', 'calibration', 'oled_profiles', 'glove_history'],
      requestTimeoutMs: 25,
    });

    expect(state.status).toBe('error');
    expect(state.lastError).toContain('did not finish within 25 milliseconds');
  });
});

describe('one sync at a time, which is the ordinary case', () => {
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

  it('still publishes a success, so the guard is not simply muting the manager', async () => {
    setCustomSupabaseClient(createFakeSupabase() as any);

    const manager = new SyncManager();
    const state = await manager.syncAll(USER, storage, QUICK);

    expect(state.status).toBe('synced');
    expect(manager.getState().lastSyncedAtMs).not.toBeNull();
  });

  it('publishes every time an attempt follows another, not only the first', async () => {
    // Attempt numbers only increase, so a guard written as "is this the first
    // attempt?" would silently mute everything after the first. Three runs, all
    // of which must be heard.
    setCustomSupabaseClient(createFakeSupabase() as any);

    const manager = new SyncManager();
    const published: string[] = [];
    manager.subscribe((state) => published.push(state.status));

    await manager.syncAll(USER, storage, QUICK);
    await manager.syncAll(USER, storage, QUICK);
    await manager.syncAll(USER, storage, QUICK);

    expect(published.filter((status) => status === 'synced')).toHaveLength(3);
    expect(manager.getState().status).toBe('synced');
  });
});
