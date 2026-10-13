/**
 * Push notifications.
 *
 * ## What this module is responsible for
 *
 * Getting a Firebase Cloud Messaging registration token for this install,
 * keeping it current, recording it against whoever is signed in, and giving it
 * up when it is no longer that person's. That is the whole job. It is worth
 * stating what it is *not*: this module never sends a notification and cannot.
 * Dispatching is a server operation — the backend's `/notifications/send`
 * requires the service account credentials and the internal API secret, neither
 * of which exists on a phone. A client that could send a push is a client that
 * could send one to somebody else's device.
 *
 * ## Why a token is treated as a delivery address, not a secret
 *
 * An FCM token identifies an app install to Google's service. On its own it
 * grants nothing: sending to it requires the project's credentials. It is
 * therefore safe to show the user and to copy — which is deliberate, because
 * when push does not arrive the token is the first thing anyone needs.
 *
 * ## Why the permission is asked for on a press
 *
 * Same rule as the microphone in `../captions`. A notification permission
 * prompt that appears at launch, before the user has any idea what the app
 * would notify them about, is a prompt that gets refused — and on Android a
 * refusal is not always recoverable by asking again. So nothing is requested
 * until the user turns notifications on, and the state before that is `unknown`
 * rather than a guess.
 *
 * ## Why every failure has words
 *
 * A phone with no Google Play Services cannot receive Firebase messages at all,
 * and a build without `google-services.json` has no Firebase project to receive
 * them from. Both are ordinary, both are permanent for that install, and
 * neither is fixed by trying again — so both are reported as a reason rather
 * than as an error the user might retry forever.
 */

import type { Storage } from '../storage';
import {
  deleteDeviceToken,
  getDeviceToken,
  getLaunchNotification,
  isDeviceSupported,
  isMessagingAvailable,
  messagingUnavailableReason,
  requestNotificationPermission,
  subscribeToForegroundMessages,
  subscribeToNotificationTaps,
  subscribeToTokenRefresh,
  type NotificationPermissionResult,
  type PushMessage,
} from './messaging';
import { createSupabasePushRegistrar, type PushRegistrar } from './register';

/** Where the token for this install is stored between launches. */
export const PUSH_STORAGE_KEY = 'sv/v1/push-registration';

export type PushPermission = 'unknown' | 'granted' | 'denied' | 'blocked';

export type PushStatus = 'off' | 'enabling' | 'on' | 'error';

export interface PushState {
  /** Whether Firebase exists in this build and on this device. */
  readonly available: boolean;
  /** Why it does not, when it does not. Null when it does. */
  readonly unavailableReason: string | null;
  /** The user has turned notifications on. */
  readonly enabled: boolean;
  readonly status: PushStatus;
  readonly permission: PushPermission;
  /** This install's registration token, once one has been obtained. */
  readonly token: string | null;
  /**
   * The account the token is currently recorded against, or null.
   *
   * Null with a token present means the token is held on this phone but is not
   * registered to anybody — which is the correct state for a guest, and is
   * reported rather than hidden, because a token nobody can look up is a token
   * nothing will ever be delivered to.
   */
  readonly registeredAccountId: string | null;
  /** Why registration with the account failed, when it did. */
  readonly registrationError: string | null;
  /** The most recent message that arrived while the app was open. */
  readonly lastForegroundMessage: PushMessage | null;
  /** The most recent notification the user opened, whether tap or cold start. */
  readonly lastOpenedMessage: PushMessage | null;
  /** A message for the user about the last failure, or null. */
  readonly error: string | null;
}

/** The bridge, narrowed to what the controller uses. Injectable for tests. */
export interface PushBridge {
  isAvailable(): boolean;
  unavailableReason(): string;
  /** Whether this device can receive messages at all, asynchronously. */
  isDeviceSupported(): Promise<boolean>;
  requestPermission(): Promise<NotificationPermissionResult>;
  getToken(): Promise<string>;
  deleteToken(): Promise<void>;
  onForegroundMessage(handler: (message: PushMessage) => void): () => void;
  onTokenRefresh(handler: (token: string) => void): () => void;
  onNotificationTap(handler: (message: PushMessage) => void): () => void;
  getLaunchNotification(): Promise<PushMessage | null>;
}

/** The real bridge. See `./messaging.ts` for why each call is wrapped. */
const DEFAULT_BRIDGE: PushBridge = {
  isAvailable: isMessagingAvailable,
  unavailableReason: messagingUnavailableReason,
  isDeviceSupported,
  requestPermission: requestNotificationPermission,
  getToken: getDeviceToken,
  deleteToken: deleteDeviceToken,
  onForegroundMessage: subscribeToForegroundMessages,
  onTokenRefresh: subscribeToTokenRefresh,
  onNotificationTap: subscribeToNotificationTaps,
  getLaunchNotification,
};

export interface PushControllerDeps {
  readonly storage: Storage;
  readonly bridge?: PushBridge;
  /** Where tokens are recorded. Defaults to the Supabase-backed registrar. */
  readonly registrar?: PushRegistrar;
}

interface PersistedPush {
  readonly enabled: boolean;
  readonly token: string | null;
}

const INITIAL: PushState = {
  available: false,
  unavailableReason: null,
  enabled: false,
  status: 'off',
  permission: 'unknown',
  token: null,
  registeredAccountId: null,
  registrationError: null,
  lastForegroundMessage: null,
  lastOpenedMessage: null,
  error: null,
};

export class PushController {
  private readonly storage: Storage;
  private readonly bridge: PushBridge;
  private readonly registrar: PushRegistrar;
  private readonly listeners = new Set<() => void>();
  private readonly teardown: Array<() => void> = [];

  private state: PushState = INITIAL;
  private accountId: string | null = null;
  private disposed = false;

  constructor(deps: PushControllerDeps) {
    this.storage = deps.storage;
    this.bridge = deps.bridge ?? DEFAULT_BRIDGE;
    this.registrar = deps.registrar ?? createSupabasePushRegistrar();

    const available = this.bridge.isAvailable();
    this.state = {
      ...INITIAL,
      available,
      unavailableReason: available ? null : this.bridge.unavailableReason(),
    };

    void this.start();
  }

  /**
   * Establishes whether this install can receive anything, then listens.
   *
   * Two questions in order, because they have different answers and need
   * different words:
   *
   *   1. Was this build configured with a Firebase project? Answered
   *      synchronously by looking for an initialised app.
   *   2. Can this *phone* receive? Answered by the SDK, and false on a handset
   *      with no Google Play services. Such a phone has a perfectly correct
   *      build and still cannot be sent a thing.
   *
   * The listeners are attached only after the second answer, because they are
   * what would throw on a phone that cannot support them.
   */
  private async start(): Promise<void> {
    if (this.state.available) {
      let supported = false;
      try {
        supported = await this.bridge.isDeviceSupported();
      } catch {
        supported = false;
      }

      if (this.disposed) return;

      if (supported) {
        this.attach();
      } else {
        this.patch({
          available: false,
          unavailableReason:
            'This phone has no Google Play services, so Firebase messages cannot be delivered to it.',
        });
      }
    }

    await this.restore();
  }

  /**
   * Attaches the three listeners.
   *
   * Attached whether or not the user has switched notifications on, which is
   * deliberate. Turning notifications off stops *this install* being a delivery
   * target; it does not stop Google delivering a message already queued, and it
   * must not stop the app noticing one. A message that arrives while the app is
   * open is shown in the app and one the user taps is followed, and neither is
   * a thing to gate on a setting.
   */
  private attach(): void {
    this.teardown.push(
      this.bridge.onForegroundMessage((message) => {
        if (this.disposed) return;
        this.patch({ lastForegroundMessage: message });
      }),
      this.bridge.onNotificationTap((message) => {
        if (this.disposed) return;
        this.patch({ lastOpenedMessage: message });
      }),
      this.bridge.onTokenRefresh((token) => {
        if (this.disposed) return;
        /*
         * A rotated token is the same install with a new address. The old one
         * is already dead as far as FCM is concerned, so there is nothing to
         * unregister — but the account must learn the new address, or delivery
         * stops silently the next time Google rotates.
         */
        void this.storeToken(token, this.accountId);
      }),
    );
  }

  /**
   * Reads what was persisted, and reconciles it with the account.
   *
   * A cold start from a tapped notification is read here too: the app was not
   * running when the user tapped, so there is no event to have subscribed to
   * and the launch payload is the only trace of what they opened.
   */
  private async restore(): Promise<void> {
    const stored = await this.storage.getJson<PersistedPush>(PUSH_STORAGE_KEY);

    if (this.disposed) return;

    if (stored !== null && typeof stored.enabled === 'boolean') {
      this.patch({
        enabled: stored.enabled,
        token: typeof stored.token === 'string' ? stored.token : null,
        status: stored.enabled ? 'on' : 'off',
        // A token that survived a restart was granted permission at some point;
        // the platform is the only authority on whether it still holds, and it
        // is re-read the next time the user acts.
        permission: stored.enabled ? 'granted' : 'unknown',
      });
    }

    if (this.state.available) {
      try {
        const launch = await this.bridge.getLaunchNotification();
        if (!this.disposed && launch !== null) {
          this.patch({ lastOpenedMessage: launch });
        }
      } catch {
        // A launch payload that cannot be read is not a reason to fail the
        // launch. Nothing is claimed about it either.
      }
    }
  }

  /**
   * Turns notifications on.
   *
   * Asks the platform for permission first and stops there if it is refused.
   * A token is only fetched once permission is held, because a token fetched
   * without it is a delivery address for notifications the system will discard.
   */
  async enable(): Promise<void> {
    if (!this.state.available) return;

    this.patch({ status: 'enabling', error: null, registrationError: null });

    let permission: NotificationPermissionResult;
    try {
      permission = await this.bridge.requestPermission();
    } catch (err) {
      this.patch({
        status: 'error',
        permission: 'unknown',
        error: `The notification permission could not be requested: ${describe(err)}`,
      });
      return;
    }

    if (this.disposed) return;

    this.patch({ permission });

    if (permission !== 'granted') {
      this.patch({
        enabled: false,
        status: 'off',
        error:
          permission === 'blocked'
            ? 'Notifications are turned off for Sanket Vaanni. They can only be turned back on in your phone’s app settings.'
            : 'Notifications were declined, so nothing will be delivered to this phone.',
      });
      await this.persist(false, null);
      return;
    }

    let token: string;
    try {
      token = await this.bridge.getToken();
    } catch (err) {
      this.patch({
        status: 'error',
        error: `A notification token could not be obtained: ${describe(err)}`,
      });
      return;
    }

    if (this.disposed) return;
    await this.storeToken(token, this.accountId);
    await this.persist(true, token);
  }

  /**
   * Turns notifications off.
   *
   * The token is deleted at the platform as well as locally. Doing only the
   * local half is the classic version of this bug: the phone shows notifications
   * switched off while Google keeps delivering to an address it still holds.
   */
  async disable(): Promise<void> {
    const previous = this.state.token;

    if (previous !== null) {
      await this.registrar.unregister(previous);
    }

    try {
      if (this.state.available) await this.bridge.deleteToken();
    } catch {
      /*
       * Failing to delete at the platform is not a reason to leave the switch
       * on, and not a state the user can act on. The local record is cleared
       * and the token is unregistered, which stops this app using it; the
       * sentence below says what could not be done.
       */
      this.patch({
        error:
          'Notifications are off. The registration token could not be released by the phone, so it may still be recorded against this account.',
      });
    }

    this.patch({
      enabled: false,
      status: 'off',
      token: null,
      registeredAccountId: null,
      registrationError: null,
    });
    await this.persist(false, null);
  }

  /**
   * Tells the controller who is signed in now.
   *
   * Called on every session change. The token follows the account: signed in,
   * it is recorded against that user so the server can find it; signed out, the
   * record is removed, because a token left against an account that has signed
   * out is a push the next person to use the phone would receive.
   */
  async setAccount(nextAccountId: string | null): Promise<void> {
    const previous = this.accountId;
    if (previous === nextAccountId) return;

    this.accountId = nextAccountId;

    const token = this.state.token;
    if (token === null) {
      this.patch({ registeredAccountId: null });
      return;
    }

    if (nextAccountId === null) {
      await this.registrar.unregister(token);
      this.patch({ registeredAccountId: null, registrationError: null });
      return;
    }

    await this.registerWithAccount(token, nextAccountId);
  }

  /** Records a token against the current account and mirrors it into state. */
  private async storeToken(token: string, accountId: string | null): Promise<void> {
    this.patch({ token, status: 'on', enabled: true, error: null });

    if (accountId === null) {
      this.patch({ registeredAccountId: null, registrationError: null });
      return;
    }

    await this.registerWithAccount(token, accountId);
  }

  private async registerWithAccount(token: string, accountId: string): Promise<void> {
    try {
      await this.registrar.register(token);
      if (this.disposed) return;
      this.patch({ registeredAccountId: accountId, registrationError: null });
    } catch (err) {
      if (this.disposed) return;
      /*
       * The token is still held and still works for this install — it is only
       * the account record that failed. The two are reported separately so the
       * screen can say "this phone can receive them, your account cannot reach
       * it" rather than a flat "failed".
       */
      this.patch({
        registeredAccountId: null,
        registrationError: `This phone can receive notifications, but the token could not be recorded against your account: ${describe(err)}`,
      });
    }
  }

  private async persist(enabled: boolean, token: string | null): Promise<void> {
    const payload: PersistedPush = { enabled, token };
    await this.storage.setJson(PUSH_STORAGE_KEY, payload);
  }

  private patch(next: Partial<PushState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PushState => this.state;

  dispose(): void {
    this.disposed = true;
    for (const off of this.teardown) off();
    this.teardown.length = 0;
    this.listeners.clear();
  }
}

/** An error message without leaking whatever the SDK put in it. */
function describe(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  return 'the platform gave no reason';
}
