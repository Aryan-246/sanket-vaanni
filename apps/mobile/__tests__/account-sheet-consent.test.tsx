/**
 * The guest-data consent step, driven through the real `AccountSheet`.
 *
 * Only two hooks are replaced — `useAccount` (the network identity boundary) and
 * `useAppState` (the storage plumbing) — because neither can be reached without
 * a live Supabase project or the full app tree. Everything under test is real:
 * the sheet's own state machine, the local storage, and the sync engine writing
 * into the in-memory server, so the assertions are about data that moved rather
 * than about mocks that were called.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { AccountSheet } from '../src/components/AccountSheet';
import { createDemoCalibration } from '../src/sensors/calibration';
import { resetSupabaseClient, setCustomSupabaseClient } from '../src/supabase/client';
import { migrationConsentKey, readMigrationDecision } from '../src/supabase/guestMigration';
import { defaultHandConfig, type OledProfile } from '../src/oled/profiles';
import { createInMemoryStorage, featureKeys, type Storage } from '../src/storage';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { createFakeSupabase, type FakeSupabase, type FakeSupabaseOptions } from './fakeSupabase';

jest.mock('../src/app/AppState', () => {
  const holder: { storage: unknown } = { storage: null };
  return { useAppState: () => ({ storage: holder.storage }), __stateHolder: holder };
});

jest.mock('../src/account/AccountProvider', () => {
  const holder: { value: unknown } = { value: {} };
  return { useAccount: () => holder.value, __accountHolder: holder };
});

const { __stateHolder } = jest.requireMock('../src/app/AppState') as {
  __stateHolder: { storage: Storage };
};
const { __accountHolder } = jest.requireMock('../src/account/AccountProvider') as {
  __accountHolder: { value: Record<string, unknown> };
};

const SIGNED_IN_ID = 'user-1';

/** Every text node in the tree, joined, so a split sentence can be found. */
function visibleText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') walk((node as { children?: unknown }).children);
  };
  walk(renderer.toJSON());
  return parts.join('');
}

/**
 * Lets queued promise callbacks run.
 *
 * Sign-in deliberately does not await the sync it triggers — the sheet closes
 * first — so a test that asserted immediately would be checking the server
 * before the upload had a chance to reach it, and would pass for the wrong
 * reason.
 */
async function flush(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
    });
  }
}

async function typeInto(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
  value: string,
): Promise<void> {
  const target = renderer.root
    .findAllByProps({ accessibilityLabel: label })
    .find((node) => typeof node.props.onChangeText === 'function');
  if (target === undefined) throw new Error(`No text field labelled "${label}".`);
  await ReactTestRenderer.act(async () => {
    target.props.onChangeText(value);
  });
  await flush(1);
}

async function press(
  renderer: ReactTestRenderer.ReactTestRenderer,
  props: Record<string, unknown>,
  description: string,
): Promise<void> {
  const target = renderer.root
    .findAllByProps(props)
    .find((node) => typeof node.props.onPress === 'function');
  if (target === undefined) throw new Error(`No pressable node for ${description}.`);
  await ReactTestRenderer.act(async () => {
    await target.props.onPress();
  });
  await flush();
}

/**
 * Starts a press without waiting for its handler to finish.
 *
 * `press` awaits the handler, which for sign-in means awaiting the whole upload
 * — leaving no moment at which a test could act *during* the request. This
 * returns as soon as the handler suspends, which is the state a user who is
 * still watching a spinner is actually in.
 */
async function pressWithoutAwaiting(
  renderer: ReactTestRenderer.ReactTestRenderer,
  props: Record<string, unknown>,
  description: string,
): Promise<void> {
  const target = renderer.root
    .findAllByProps(props)
    .find((node) => typeof node.props.onPress === 'function');
  if (target === undefined) throw new Error(`No pressable node for ${description}.`);
  await ReactTestRenderer.act(async () => {
    void target.props.onPress();
  });
}

/**
 * A server whose writes are held open until the test lets them go.
 *
 * The counter stops the tests that use it from being vacuous: a dismissal test
 * that passed because no request ever ran would prove nothing about dismissals.
 *
 * ## Why a gate rather than a delay
 *
 * This used to hold each write for a fixed 30 ms. That is long enough on an idle
 * machine and not long enough on a loaded one — a `flush` round wraps React's
 * async `act`, which yields to the event loop, so twelve of them can outlast
 * 30 ms when the rest of this suite is running beside it. The test that asserts
 * what is on screen *while* a request is in flight then observes the request
 * after it has failed, and fails on its own premise rather than on the code:
 * the retry panel it demands be absent is drawn, correctly, because the upload
 * really did fail by then.
 *
 * A delay makes "in flight" a guess about the scheduler. A gate makes it a fact
 * about the test, and the failure lands exactly where the test wants it — after
 * the sheet has been dismissed.
 */
function gatedFake(options: FakeSupabaseOptions) {
  const base = createFakeSupabase(options);
  let writes = 0;
  let openGate: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  /*
   * The gate is applied to the settle, not to `upsert`.
   *
   * The sync engine chains `.abortSignal(signal)` after `.upsert(...)` — the only
   * order the real `postgrest-js` builder accepts — so a double whose `upsert`
   * returned a bare promise would break the chain and fail with a `TypeError`
   * that reads like a sync bug. Holding the settle instead keeps every method
   * returning the builder, keeps the write open for as long as the test needs,
   * and lets the counter stay about writes: a read-back is not a write and must
   * not inflate the figure these tests assert on.
   */
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
      writes += 1;
      return gate.then(() => settle(resolve, reject));
    };

    return builder;
  };

  return {
    client: { ...base, from } as unknown as FakeSupabase,
    writes: () => writes,
    /** Lets every held write settle, from now on. */
    release: () => openGate?.(),
  };
}

/**
 * A device whose chosen storage operations reject.
 *
 * Stands in for a full disk or a corrupted store. Reads are left working so the
 * failure lands on the write under test rather than preventing the sheet from
 * rendering at all.
 */
function storageWithFailingCalls(base: Storage, methods: readonly string[]): Storage {
  const failing = new Set(methods);
  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && failing.has(property)) {
        return async () => {
          throw new Error('Disk is full');
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Storage;
}

describe('AccountSheet guest-data consent', () => {
  /*
   * Whichever test runs first pays the one-time cost of loading and mounting a
   * full component tree here — around six seconds cold, against a 5s default.
   * The budget is raised rather than the work moved around, so the rest of the
   * suite is not slowed to hide it. Same reasoning as `performance.test.tsx`.
   */
  jest.setTimeout(30_000);

  let storage: Storage;
  let fake: FakeSupabase;
  let onClose: jest.Mock;
  let baseAccount: Record<string, unknown>;

  beforeEach(() => {
    storage = createInMemoryStorage();
    fake = createFakeSupabase();
    onClose = jest.fn();

    baseAccount = {
      user: null,
      displayName: null,
      isGuest: true,
      isReady: true,
      isAdmin: false,
      cloudAvailable: true,
      signIn: async () => ({
        success: true,
        data: { user: { id: SIGNED_IN_ID, email: 'a@b.test' } },
      }),
      signUp: async () => ({ success: false, error: 'not used' }),
      signOut: async () => undefined,
      completeAccountDeletion: () => undefined,
      requestPasswordReset: async () => ({ success: true }),
      updatePassword: async () => ({ success: true }),
      updateProfile: async () => ({ success: true }),
    };

    __stateHolder.storage = storage;
    __accountHolder.value = baseAccount;

    setCustomSupabaseClient(fake as any);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  async function seed(storageToSeed: Storage): Promise<void> {
    await storageToSeed.setPreferences({
      signProfileId: 'isl',
      targetLanguageCode: 'mr',
      voiceEnabled: true,
    });
    await storageToSeed.setCalibration({
      ...createDemoCalibration('left'),
      capturedAtMs: 5_000,
    });
    const profile: OledProfile = {
      id: 'p1',
      name: 'Morning',
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      left: defaultHandConfig(),
      right: defaultHandConfig(),
    };
    await storageToSeed.setJson(featureKeys.oledProfiles, {
      profiles: [profile],
      activeProfileId: 'p1',
    });
    await storageToSeed.addHistoryEntry({
      id: 'h-glove',
      text: 'measured',
      profileId: 'isl',
      source: 'glove',
      createdAtMs: 10,
    });
  }

  async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <ThemeProvider storage={storage} initialMode="dark">
          <AccountSheet visible onClose={onClose} />
        </ThemeProvider>,
      );
    });
    return renderer;
  }

  /** Types credentials and signs in through the real handler. */
  async function signIn(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    await typeInto(renderer, 'Email address', 'a@b.test');
    await typeInto(renderer, 'Password', 'secret123');
    await press(renderer, { accessibilityLabel: 'Sign In' }, 'the Sign In button');
  }

  it('asks before uploading anything, and uploads nothing until answered', async () => {
    await seed(storage);
    const renderer = await render();

    await signIn(renderer);

    expect(visibleText(renderer)).toContain('Nothing has been uploaded yet.');
    // The sheet stays open, and the server is still untouched.
    expect(onClose).not.toHaveBeenCalled();
    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
    expect(await readMigrationDecision(storage, SIGNED_IN_ID)).toBeNull();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('does not ask at all when the device holds nothing to move', async () => {
    const renderer = await render();

    await signIn(renderer);

    expect(visibleText(renderer)).not.toContain('Nothing has been uploaded yet.');
    expect(onClose).toHaveBeenCalled();
    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('uploads the consented records when accepted, keeping the device copy', async () => {
    await seed(storage);
    const renderer = await render();
    await signIn(renderer);

    await press(renderer, { testID: 'guest-migration-accept' }, 'the accept button');

    expect(fake.rows['user_preferences']).toHaveLength(1);
    expect(fake.rows['calibration_profiles']).toHaveLength(1);
    expect(fake.rows['oled_profiles']).toHaveLength(1);
    expect(fake.rows['user_history']).toHaveLength(1);

    // Nothing was deleted from the phone.
    expect(await storage.getPreferences()).not.toBeNull();
    expect(await storage.getCalibration('left')).not.toBeNull();
    const oled = await storage.getJson<{ profiles: OledProfile[] }>(featureKeys.oledProfiles);
    expect(oled?.profiles).toHaveLength(1);

    const decision = await readMigrationDecision(storage, SIGNED_IN_ID);
    expect(decision?.accepted).toBe(true);
    expect(onClose).toHaveBeenCalled();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('uploads nothing when declined, and records the refusal', async () => {
    await seed(storage);
    const renderer = await render();
    await signIn(renderer);

    await press(renderer, { testID: 'guest-migration-decline' }, 'the decline button');

    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(fake.rows['calibration_profiles'] ?? []).toHaveLength(0);
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
    expect(fake.rows['user_history'] ?? []).toHaveLength(0);

    const decision = await readMigrationDecision(storage, SIGNED_IN_ID);
    expect(decision?.accepted).toBe(false);

    // Still all there.
    expect(await storage.getPreferences()).not.toBeNull();
    expect(await storage.getCalibration('left')).not.toBeNull();
    expect(onClose).toHaveBeenCalled();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('records nothing when the question is dismissed instead of answered', async () => {
    await seed(storage);
    const renderer = await render();
    await signIn(renderer);

    // The footer's "Not now" is a dismissal, not an answer.
    await press(renderer, { accessibilityLabel: 'Not now' }, 'the Not now button');

    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    // No decision stored, so the offer is made again rather than counted as a no.
    expect(await readMigrationDecision(storage, SIGNED_IN_ID)).toBeNull();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('does not ask again after a refusal, and does not upload on that sign-in', async () => {
    await seed(storage);
    await storage.setJson(migrationConsentKey(SIGNED_IN_ID), {
      accepted: false,
      scopes: [],
      decidedAtMs: 1,
    });

    const renderer = await render();
    await signIn(renderer);

    expect(visibleText(renderer)).not.toContain('Nothing has been uploaded yet.');
    expect(onClose).toHaveBeenCalled();
    // A recorded "no" is honoured rather than silently reversed.
    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('does not ask again after an acceptance, and uploads on that sign-in', async () => {
    await seed(storage);
    await storage.setJson(migrationConsentKey(SIGNED_IN_ID), {
      accepted: true,
      scopes: ['preferences', 'calibration', 'oled_profiles', 'glove_history'],
      decidedAtMs: 1,
    });

    const renderer = await render();
    await signIn(renderer);

    expect(onClose).toHaveBeenCalled();
    expect(fake.rows['user_preferences']).toHaveLength(1);
    expect(fake.rows['oled_profiles']).toHaveLength(1);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('keeps the device copy and offers a retry when the upload fails', async () => {
    await seed(storage);
    setCustomSupabaseClient(
      createFakeSupabase({
        onWrite: () => ({ message: 'JWT expired', code: 'PGRST301' }),
      }) as any,
    );

    const renderer = await render();
    await signIn(renderer);
    await press(renderer, { testID: 'guest-migration-accept' }, 'the accept button');

    // The failure is explained, the question is still on screen, and the offer
    // to try again is available.
    expect(visibleText(renderer)).toContain('The upload did not finish');
    expect(visibleText(renderer)).toContain('JWT expired');
    expect(visibleText(renderer)).toContain('Try Again');

    // Local data survived the failure in full.
    expect(await storage.getPreferences()).not.toBeNull();
    expect(await storage.getCalibration('left')).not.toBeNull();
    const oled = await storage.getJson<{ profiles: OledProfile[] }>(featureKeys.oledProfiles);
    expect(oled?.profiles).toHaveLength(1);
    expect(await storage.getHistory()).toHaveLength(1);

    // Retry with the fault cleared.
    setCustomSupabaseClient(fake as any);
    await press(renderer, { testID: 'guest-migration-accept' }, 'the Try Again button');

    expect(fake.rows['user_preferences']).toHaveLength(1);
    expect(fake.rows['oled_profiles']).toHaveLength(1);
    expect(fake.rows['user_history']).toHaveLength(1);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('no longer claims that signing in never uploads', async () => {
    const renderer = await render();

    const text = visibleText(renderer);
    // The sentence that contradicted the sync engine is gone.
    expect(text).not.toContain('signing in later does not upload it');
    // And is replaced by an accurate description of what happens.
    expect(text).toContain('the app asks whether to move this phone');
    expect(text).toContain('Nothing is uploaded unless you agree');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  // -------------------------------------------- what a refusal leaves behind

  /** Renders the sheet as an already signed-in user with a recorded refusal. */
  async function renderSignedInAfterDecline(): Promise<ReactTestRenderer.ReactTestRenderer> {
    await seed(storage);
    await storage.setJson(migrationConsentKey(SIGNED_IN_ID), {
      accepted: false,
      scopes: [],
      decidedAtMs: 1,
    });
    __accountHolder.value = {
      ...baseAccount,
      user: { id: SIGNED_IN_ID, email: 'a@b.test' },
      isGuest: false,
    };
    return render();
  }

  it('tells a signed-in decliner that their records are still local', async () => {
    const renderer = await renderSignedInAfterDecline();

    expect(renderer.root.findAllByProps({ testID: 'migration-declined-notice' }).length)
      .toBeGreaterThan(0);
    expect(visibleText(renderer)).toContain('not uploaded by it');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('does not upload when a decliner presses Sync Now', async () => {
    const renderer = await renderSignedInAfterDecline();

    await press(renderer, { accessibilityLabel: 'Sync Now' }, 'the Sync Now button');

    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(fake.rows['calibration_profiles'] ?? []).toHaveLength(0);
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
    expect(fake.rows['user_history'] ?? []).toHaveLength(0);

    // The button still downloads, which is the part an account is for.
    expect(await storage.getPreferences()).not.toBeNull();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('lets a refusal be withdrawn, and uploads only once the user agrees', async () => {
    const renderer = await renderSignedInAfterDecline();

    await press(renderer, { testID: 'migration-reconsider' }, 'the Ask me again button');

    // Back at the question, with the refusal cleared and nothing sent.
    expect(visibleText(renderer)).toContain('Nothing has been uploaded yet.');
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
    expect(await readMigrationDecision(storage, SIGNED_IN_ID)).toBeNull();

    await press(renderer, { testID: 'guest-migration-accept' }, 'the accept button');

    expect(fake.rows['oled_profiles']).toHaveLength(1);
    expect(fake.rows['user_preferences']).toHaveLength(1);
    expect((await readMigrationDecision(storage, SIGNED_IN_ID))?.accepted).toBe(true);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('does not warn about local-only records once the data has been uploaded', async () => {
    await seed(storage);
    await storage.setJson(migrationConsentKey(SIGNED_IN_ID), {
      accepted: true,
      scopes: ['preferences', 'calibration', 'oled_profiles', 'glove_history'],
      decidedAtMs: 1,
    });
    __accountHolder.value = {
      ...baseAccount,
      user: { id: SIGNED_IN_ID, email: 'a@b.test' },
      isGuest: false,
    };

    const renderer = await render();
    await flush();

    expect(renderer.root.findAllByProps({ testID: 'migration-declined-notice' })).toHaveLength(0);
    expect(visibleText(renderer)).not.toContain('not uploaded by it');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  // -------------------------------------- picking up an interrupted migration

  it('finishes an interrupted migration on the next sign-in without asking again', async () => {
    await seed(storage);
    // Consent was given before the interruption, so it must not be sought again.
    await storage.setJson(migrationConsentKey(SIGNED_IN_ID), {
      accepted: true,
      scopes: ['preferences', 'calibration', 'oled_profiles', 'glove_history'],
      decidedAtMs: 1,
    });

    // The state an interruption leaves: preferences and one OLED profile made
    // it to the server, the rest did not.
    fake.rows['user_preferences'] = [
      {
        user_id: SIGNED_IN_ID,
        sign_profile_id: 'isl',
        target_language_code: 'mr',
        voice_enabled: true,
        theme_mode: 'dark',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    fake.rows['oled_profiles'] = [
      {
        user_id: SIGNED_IN_ID,
        profile_id: 'p1',
        name: 'Morning',
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
        left_config: defaultHandConfig(),
        right_config: defaultHandConfig(),
      },
    ];

    const renderer = await render();
    await signIn(renderer);

    // Not asked again: the earlier agreement stands.
    expect(visibleText(renderer)).not.toContain('Nothing has been uploaded yet.');
    expect(onClose).toHaveBeenCalled();

    // And the run finished what the interruption left undone.
    expect(fake.rows['user_preferences']).toHaveLength(1);
    expect(fake.rows['calibration_profiles']).toHaveLength(1);
    expect(fake.rows['oled_profiles']).toHaveLength(1);
    expect(fake.rows['user_history']).toHaveLength(1);

    // Resuming was safe: nothing was lost from the device, and the profile that
    // had already been uploaded was updated rather than added a second time.
    expect(await storage.getPreferences()).not.toBeNull();
    expect(await storage.getCalibration('left')).not.toBeNull();
    const oled = await storage.getJson<{ profiles: OledProfile[] }>(featureKeys.oledProfiles);
    expect(oled?.profiles).toHaveLength(1);
    expect(fake.rows['oled_profiles'][0].name).toBe('Morning');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  // ------------------------------- a migration that fails to resume, later on

  /** Seeds an accepted migration whose uploads all fail. */
  async function arrangeFailedResume(): Promise<ReactTestRenderer.ReactTestRenderer> {
    await seed(storage);
    await storage.setJson(migrationConsentKey(SIGNED_IN_ID), {
      accepted: true,
      scopes: ['preferences', 'calibration', 'oled_profiles', 'glove_history'],
      decidedAtMs: 1,
    });
    setCustomSupabaseClient(
      createFakeSupabase({
        onWrite: () => ({ message: 'JWT expired', code: 'PGRST301', status: 401 }),
      }) as any,
    );

    const renderer = await render();
    await signIn(renderer);
    return renderer;
  }

  it('tells the user, and offers a retry, when an agreed migration fails to resume', async () => {
    const renderer = await arrangeFailedResume();

    // The sheet stays open. Closing it silently is what hid the failure.
    expect(onClose).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'guest-migration-resume' }).length)
      .toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'guest-migration-resume-retry' }).length)
      .toBeGreaterThan(0);

    const text = visibleText(renderer);
    expect(text).toContain('Your agreed upload has not finished.');
    expect(text).toContain('JWT expired');
    expect(text).toContain('Every record is still on this phone.');
    expect(text).toContain('Try Again');

    // Consent was already given, so the question is not put again.
    expect(text).not.toContain('Nothing has been uploaded yet.');

    // Nothing reached the server, and the device is untouched.
    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
    expect(await storage.getPreferences()).not.toBeNull();
    expect(await storage.getCalibration('left')).not.toBeNull();
    expect((await readMigrationDecision(storage, SIGNED_IN_ID))?.accepted).toBe(true);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('finishes the migration when the retry succeeds, without asking again', async () => {
    const renderer = await arrangeFailedResume();

    // The connection comes back.
    setCustomSupabaseClient(fake as any);
    await press(
      renderer,
      { testID: 'guest-migration-resume-retry' },
      'the resume retry button',
    );

    expect(fake.rows['user_preferences']).toHaveLength(1);
    expect(fake.rows['calibration_profiles']).toHaveLength(1);
    expect(fake.rows['oled_profiles']).toHaveLength(1);
    expect(fake.rows['user_history']).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
    // The retry repeated work; it did not renegotiate permission.
    expect((await readMigrationDecision(storage, SIGNED_IN_ID))?.accepted).toBe(true);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('keeps the failure visible in the account view after the user dismisses it', async () => {
    const renderer = await arrangeFailedResume();

    await press(
      renderer,
      { testID: 'guest-migration-resume-dismiss' },
      'the dismiss button',
    );
    expect(onClose).toHaveBeenCalled();

    // Dismissal is not a fix. Reopening the account view still shows why the
    // upload has not happened, so the error cannot be lost by closing a sheet.
    __accountHolder.value = {
      ...baseAccount,
      user: { id: SIGNED_IN_ID, email: 'a@b.test' },
      isGuest: false,
    };
    await ReactTestRenderer.act(async () => renderer.unmount());

    const reopened = await render();
    await flush();

    expect(visibleText(reopened)).toContain('JWT expired');

    await ReactTestRenderer.act(async () => reopened.unmount());
  });

  // ----------------------------- a decision that cannot be read as a decision

  /** Seeds an acceptance by hand, exactly as it would sit in storage. */
  async function seedStoredDecision(scopes: unknown): Promise<void> {
    await seed(storage);
    await storage.setJson(migrationConsentKey(SIGNED_IN_ID), {
      accepted: true,
      scopes,
      decidedAtMs: 1,
    });
  }

  it('asks again, and uploads nothing, when the stored consent names an unknown scope', async () => {
    // A record from a version of the app that had different scopes in it.
    await seedStoredDecision(['preferences', 'telepathy']);

    const renderer = await render();
    await signIn(renderer);

    // It cannot be read as a decision, so it is not acted on as one.
    expect(visibleText(renderer)).toContain('Nothing has been uploaded yet.');
    expect(onClose).not.toHaveBeenCalled();
    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
    expect(await storage.getPreferences()).not.toBeNull();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('never reads an empty consent as permission to upload everything', async () => {
    await seedStoredDecision([]);

    const renderer = await render();
    await signIn(renderer);

    // This is the fail-open case: an empty scope list must not widen to all of
    // them. Nothing may reach the server, and the question is asked again.
    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(fake.rows['calibration_profiles'] ?? []).toHaveLength(0);
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
    expect(fake.rows['user_history'] ?? []).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(visibleText(renderer)).toContain('Nothing has been uploaded yet.');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('still honours a valid narrowed consent, without asking again', async () => {
    // The counterpart to the two tests above: validation must reject the
    // unreadable, not the merely-restrictive.
    await seedStoredDecision(['preferences']);

    const renderer = await render();
    await signIn(renderer);

    expect(visibleText(renderer)).not.toContain('Nothing has been uploaded yet.');
    expect(onClose).toHaveBeenCalled();

    // Exactly the scope agreed to, and nothing beside it.
    expect(fake.rows['user_preferences']).toHaveLength(1);
    expect(fake.rows['calibration_profiles'] ?? []).toHaveLength(0);
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
    expect(fake.rows['user_history'] ?? []).toHaveLength(0);
    // Nothing was deleted from the device by the narrower upload.
    expect(await storage.getPreferences()).not.toBeNull();
    expect(await storage.getCalibration('left')).not.toBeNull();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  // --------------------------------- dismissing a request that is still running

  it('does not reopen the failure when the user dismisses a request still in flight', async () => {
    await seed(storage);
    await storage.setJson(migrationConsentKey(SIGNED_IN_ID), {
      accepted: true,
      scopes: ['preferences', 'calibration', 'oled_profiles', 'glove_history'],
      decidedAtMs: 1,
    });

    // A server that refuses every write, and holds each one open until this
    // test releases it — so the upload fails *after* the moment of dismissal
    // rather than before it, on a loaded machine as well as an idle one.
    const slow = gatedFake({
      onWrite: () => ({ message: 'JWT expired', code: 'PGRST301', status: 401 }),
    });
    setCustomSupabaseClient(slow.client as any);

    const renderer = await render();
    await typeInto(renderer, 'Email address', 'a@b.test');
    await typeInto(renderer, 'Password', 'secret123');

    // Start the sign-in without waiting for it, so the upload is still in
    // flight — the state a user staring at a spinner is actually in.
    await pressWithoutAwaiting(
      renderer,
      { accessibilityLabel: 'Sign In' },
      'the Sign In button',
    );
    await flush(12);

    // The request really is running, so the dismissal below is not a dismissal
    // of nothing.
    expect(slow.writes()).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'guest-migration-resume' })).toHaveLength(0);

    // The user gives up waiting and closes the sheet.
    await press(renderer, { accessibilityLabel: 'Close' }, 'the footer close button');
    expect(onClose).toHaveBeenCalled();

    // The upload lands after the dismissal, because the test lets it land here.
    await ReactTestRenderer.act(async () => {
      slow.release();
      await Promise.resolve();
    });
    await flush();

    /*
     * ...and must not resurrect the panel that was just closed. This is the
     * defect: the sheet closed, the request failed a moment later, and its
     * handler set the failure state that reopened the very step the user had
     * dismissed.
     */
    expect(renderer.root.findAllByProps({ testID: 'guest-migration-resume' })).toHaveLength(0);
    expect(visibleText(renderer)).not.toContain('Your agreed upload has not finished.');
    expect(visibleText(renderer)).not.toContain('JWT expired');

    // A dismissal is not an answer: the agreement is left exactly as it was, so
    // the next sign-in tries again rather than counting this as a refusal.
    const decision = await readMigrationDecision(storage, SIGNED_IN_ID);
    expect(decision?.accepted).toBe(true);
    expect(await storage.getPreferences()).not.toBeNull();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('keeps the question open when the answer cannot be saved on this phone', async () => {
    await seed(storage);
    __stateHolder.storage = storageWithFailingCalls(storage, ['setJson']);

    const renderer = await render();
    await signIn(renderer);
    await press(renderer, { testID: 'guest-migration-accept' }, 'the accept button');

    // An upload that outran its own record of permission is precisely what this
    // screen exists to prevent, so nothing may have been sent.
    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(fake.rows['oled_profiles'] ?? []).toHaveLength(0);
    expect(fake.rows['calibration_profiles'] ?? []).toHaveLength(0);

    // Explained, not silently closed on an answer that does not exist.
    expect(visibleText(renderer)).toContain('Disk is full');
    expect(onClose).not.toHaveBeenCalled();

    // And recoverable: the buttons are back rather than a spinner that never
    // stops, so the user can retry once the device can write again.
    expect(
      renderer.root.findAllByProps({ testID: 'guest-migration-accept' }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({ testID: 'guest-migration-decline' }).length,
    ).toBeGreaterThan(0);

    // Nothing was recorded, so the question is still unanswered.
    expect(await readMigrationDecision(storage, SIGNED_IN_ID)).toBeNull();
    // The real device data is untouched.
    expect(await storage.getPreferences()).not.toBeNull();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('does not close on a refusal it could not record', async () => {
    await seed(storage);
    __stateHolder.storage = storageWithFailingCalls(storage, ['setJson']);

    const renderer = await render();
    await signIn(renderer);
    await press(renderer, { testID: 'guest-migration-decline' }, 'the decline button');

    // Closing here would discard an answer the user did give, and the next
    // sign-in would ask again as though they had said nothing.
    expect(onClose).not.toHaveBeenCalled();
    expect(visibleText(renderer)).toContain('Disk is full');
    expect(await readMigrationDecision(storage, SIGNED_IN_ID)).toBeNull();
    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ testID: 'guest-migration-decline' }).length,
    ).toBeGreaterThan(0);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('recovers from a failed local read during sign-in instead of staying busy', async () => {
    await seed(storage);
    // A read the consent path depends on, failing.
    __stateHolder.storage = storageWithFailingCalls(storage, ['getHistory']);

    const renderer = await render();
    await signIn(renderer);

    expect(onClose).not.toHaveBeenCalled();
    expect(visibleText(renderer)).toContain('Sign-in could not be completed');
    // The form is usable again rather than stuck behind a spinner that will
    // never clear.
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Sign In' }).length,
    ).toBeGreaterThan(0);
    expect(fake.rows['user_preferences'] ?? []).toHaveLength(0);
    // The real device data is untouched.
    expect(await storage.getPreferences()).not.toBeNull();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });
});
