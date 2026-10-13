/**
 * Push notifications: what the controller claims, and when it claims it.
 *
 * The controller's job is mostly about *not* doing things, so that is most of
 * what is tested here:
 *
 *  - it asks the platform for nothing until the user turns notifications on;
 *  - a refused permission is reported as refused, and a permanent refusal is
 *    distinguished from a retryable one because the two need different words;
 *  - a phone that cannot receive Firebase messages says so, rather than
 *    offering a switch that would do nothing;
 *  - a token that could not be recorded against an account is reported as that
 *    specific failure, not as "push is broken" — the phone still receives;
 *  - the token follows the account, and is released before the session ends.
 *
 * The Firebase SDK is not touched anywhere in this file. The controller takes
 * its bridge by injection precisely so that these are tests of the controller's
 * decisions rather than of a third-party SDK's behaviour.
 */
import {
  PushController,
  PUSH_STORAGE_KEY,
  type PushBridge,
  type PushMessage,
  type PushRegistrar,
  type PushState,
} from '../src/notifications';
import { createInMemoryStorage } from '../src/storage';

interface FakeBridge extends PushBridge {
  emitForeground(message: PushMessage): void;
  emitTap(message: PushMessage): void;
  emitTokenRefresh(token: string): void;
}

interface Harness {
  readonly controller: PushController;
  readonly bridge: FakeBridge;
  readonly registrar: {
    register: jest.Mock;
    unregister: jest.Mock;
  };
  snapshot(): PushState;
}

const MESSAGE: PushMessage = { title: 'Announcement', body: 'Scheduled work', data: {} };

function makeBridge(overrides: Partial<PushBridge> = {}): FakeBridge {
  const foreground = new Set<(m: PushMessage) => void>();
  const taps = new Set<(m: PushMessage) => void>();
  const refreshes = new Set<(t: string) => void>();

  return {
    isAvailable: () => true,
    unavailableReason: () => 'This build has no Firebase configuration, so push notifications cannot be delivered to it.',
    isDeviceSupported: async () => true,
    requestPermission: async () => 'granted',
    getToken: async () => 'tok-1',
    deleteToken: async () => undefined,
    onForegroundMessage: (handler) => {
      foreground.add(handler);
      return () => foreground.delete(handler);
    },
    onNotificationTap: (handler) => {
      taps.add(handler);
      return () => taps.delete(handler);
    },
    onTokenRefresh: (handler) => {
      refreshes.add(handler);
      return () => refreshes.delete(handler);
    },
    getLaunchNotification: async () => null,
    emitForeground: (message) => foreground.forEach((h) => h(message)),
    emitTap: (message) => taps.forEach((h) => h(message)),
    emitTokenRefresh: (token) => refreshes.forEach((h) => h(token)),
    ...overrides,
  };
}

function makeHarness(bridge: PushBridge = makeBridge()): Harness {
  const registrar = {
    register: jest.fn(async () => undefined),
    unregister: jest.fn(async () => undefined),
  };
  const controller = new PushController({
    storage: createInMemoryStorage(),
    bridge,
    registrar: registrar as unknown as PushRegistrar,
  });

  return {
    controller,
    bridge: bridge as FakeBridge,
    registrar,
    snapshot: () => controller.getSnapshot(),
  };
}

/** Lets the constructor's async probe settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('when this install cannot receive push at all', () => {
  it('says the build has no Firebase rather than offering a switch', async () => {
    const harness = makeHarness(
      makeBridge({ isAvailable: () => false, unavailableReason: () => 'This build has no Firebase configuration.' }),
    );
    await settle();

    expect(harness.snapshot().available).toBe(false);
    expect(harness.snapshot().unavailableReason).toContain('no Firebase configuration');

    // And asking anyway must not reach the platform for a token.
    await harness.controller.enable();
    expect(harness.snapshot().token).toBeNull();
  });

  it('blames the phone, not the build, when there are no Play services', async () => {
    const harness = makeHarness(makeBridge({ isDeviceSupported: async () => false }));
    await settle();

    const state = harness.snapshot();
    expect(state.available).toBe(false);
    // A configured build on a phone that cannot carry the messages is a
    // different problem with a different fix, so it must not say "no Firebase".
    expect(state.unavailableReason).toContain('Google Play services');
  });
});

describe('asking for permission', () => {
  it('asks for nothing at construction', async () => {
    const requestPermission = jest.fn(async () => 'granted' as const);
    const harness = makeHarness(makeBridge({ requestPermission }));
    await settle();

    // A prompt at launch is a prompt the user has no context to answer.
    expect(requestPermission).not.toHaveBeenCalled();
    expect(harness.snapshot().permission).toBe('unknown');
    expect(harness.snapshot().enabled).toBe(false);
  });

  it('stops at a refusal, and does not fetch a token for it', async () => {
    const getToken = jest.fn(async () => 'tok-1');
    const harness = makeHarness(makeBridge({ requestPermission: async () => 'denied', getToken }));
    await settle();

    await harness.controller.enable();

    expect(harness.snapshot().enabled).toBe(false);
    expect(harness.snapshot().permission).toBe('denied');
    // A token fetched without permission is an address for notifications the
    // system will throw away.
    expect(getToken).not.toHaveBeenCalled();
  });

  it('does not tell a permanently refused user to try again', async () => {
    const harness = makeHarness(makeBridge({ requestPermission: async () => 'blocked' }));
    await settle();

    await harness.controller.enable();

    expect(harness.snapshot().permission).toBe('blocked');
    expect(harness.snapshot().error).toContain('settings');
    // Nothing the user can do in the app will change this.
    expect(harness.snapshot().error).not.toMatch(/try again/i);
  });
});

describe('turning it on', () => {
  it('holds the token, and says where it is registered', async () => {
    const harness = makeHarness();
    await settle();

    await harness.controller.enable();

    expect(harness.snapshot().enabled).toBe(true);
    expect(harness.snapshot().token).toBe('tok-1');
    // Guest: no account, so nothing is registered anywhere yet — and the screen
    // can say exactly that rather than implying delivery is set up.
    expect(harness.snapshot().registeredAccountId).toBeNull();
    expect(harness.registrar.register).not.toHaveBeenCalled();
  });

  it('records the token against the signed-in account', async () => {
    const harness = makeHarness();
    await settle();

    await harness.controller.setAccount('user-a');
    await harness.controller.enable();

    expect(harness.registrar.register).toHaveBeenCalledWith('tok-1');
    expect(harness.snapshot().registeredAccountId).toBe('user-a');
    expect(harness.snapshot().registrationError).toBeNull();
  });

  it('separates "no token" from "token not recorded"', async () => {
    const harness = makeHarness();
    harness.registrar.register.mockRejectedValue(new Error('row level security'));
    await settle();

    await harness.controller.setAccount('user-a');
    await harness.controller.enable();

    const state = harness.snapshot();
    // The phone can still be sent to; it is the account link that failed. A
    // flat "push failed" would send the user looking at the wrong thing.
    expect(state.token).toBe('tok-1');
    expect(state.enabled).toBe(true);
    expect(state.registeredAccountId).toBeNull();
    expect(state.registrationError).toContain('recorded against your account');
    expect(state.registrationError).toContain('row level security');
  });
});

describe('the token follows the account', () => {
  it('releases the registration when the account goes away', async () => {
    const harness = makeHarness();
    await settle();

    await harness.controller.setAccount('user-a');
    await harness.controller.enable();
    harness.registrar.unregister.mockClear();

    await harness.controller.setAccount(null);

    // Signing out must stop delivery: the next person to use this phone is not
    // the person those notifications were for.
    expect(harness.registrar.unregister).toHaveBeenCalledWith('tok-1');
    expect(harness.snapshot().registeredAccountId).toBeNull();
  });

  it('does nothing when the account has not actually changed', async () => {
    const harness = makeHarness();
    await settle();

    await harness.controller.setAccount('user-a');
    await harness.controller.enable();
    harness.registrar.register.mockClear();

    await harness.controller.setAccount('user-a');

    expect(harness.registrar.register).not.toHaveBeenCalled();
  });

  it('replaces the old registration when a rotated token arrives', async () => {
    const harness = makeHarness();
    await settle();

    await harness.controller.setAccount('user-a');
    await harness.controller.enable();
    harness.registrar.register.mockClear();

    harness.bridge.emitTokenRefresh('tok-2');
    await settle();

    // Google has retired the old address. If the account is not told the new
    // one, delivery stops silently the next time it rotates.
    expect(harness.registrar.register).toHaveBeenCalledWith('tok-2');
    expect(harness.snapshot().token).toBe('tok-2');
  });
});

describe('turning it off', () => {
  it('releases the token at the platform as well as locally', async () => {
    const deleteToken = jest.fn(async () => undefined);
    const harness = makeHarness(makeBridge({ deleteToken }));
    await settle();

    await harness.controller.setAccount('user-a');
    await harness.controller.enable();
    await harness.controller.disable();

    // Doing only the local half is the classic version of this bug: the switch
    // reads "off" while Google keeps delivering to an address it still holds.
    expect(deleteToken).toHaveBeenCalled();
    expect(harness.registrar.unregister).toHaveBeenCalledWith('tok-1');
    expect(harness.snapshot().enabled).toBe(false);
    expect(harness.snapshot().token).toBeNull();
  });

  it('still switches off when the platform refuses to release the token', async () => {
    const harness = makeHarness(
      makeBridge({ deleteToken: async () => { throw new Error('boom'); } }),
    );
    await settle();

    await harness.controller.enable();
    await harness.controller.disable();

    expect(harness.snapshot().enabled).toBe(false);
    // Said out loud rather than hidden: the token may still exist server-side.
    expect(harness.snapshot().error).toContain('could not be released');
  });
});

describe('messages arriving', () => {
  it('surfaces a foreground message without claiming it was shown', async () => {
    const harness = makeHarness();
    await settle();

    harness.bridge.emitForeground(MESSAGE);
    await settle();

    expect(harness.snapshot().lastForegroundMessage).toEqual(MESSAGE);
  });

  it('records a notification the user tapped', async () => {
    const harness = makeHarness();
    await settle();

    harness.bridge.emitTap(MESSAGE);
    await settle();

    expect(harness.snapshot().lastOpenedMessage).toEqual(MESSAGE);
  });

  it('reads the notification that launched a cold start', async () => {
    const harness = makeHarness(makeBridge({ getLaunchNotification: async () => MESSAGE }));
    await settle();

    // The app was not running when the user tapped, so there is no event to
    // subscribe to and the launch payload is the only trace.
    expect(harness.snapshot().lastOpenedMessage).toEqual(MESSAGE);
  });
});

describe('what survives a restart', () => {
  it('remembers that notifications are on, and which token was held', async () => {
    const storage = createInMemoryStorage();
    const first = new PushController({ storage, bridge: makeBridge() });
    await settle();
    await first.setAccount('user-a');
    await first.enable();
    await settle();
    first.dispose();

    const restored = new PushController({ storage, bridge: makeBridge() });
    await settle();

    expect(restored.getSnapshot().enabled).toBe(true);
    expect(restored.getSnapshot().token).toBe('tok-1');
  });

  it('persists under a versioned key', async () => {
    const storage = createInMemoryStorage();
    const controller = new PushController({ storage, bridge: makeBridge() });
    await settle();
    await controller.enable();
    await settle();

    const stored = await storage.getJson<{ enabled: boolean }>(PUSH_STORAGE_KEY);
    expect(stored?.enabled).toBe(true);
  });
});
