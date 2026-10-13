/**
 * The Firebase Cloud Messaging bridge.
 *
 * ## Why this file exists separately from the controller
 *
 * Every other hardware and platform capability in this app reaches JavaScript
 * through a small wrapper like this one — `src/native/SanketVaanniNative.ts` is
 * the same shape — and the reason is the same here: the controller that decides
 * what to *tell the user* should not also be the thing that touches a third
 * party's SDK. Keeping the SDK behind a module with a dozen functions means the
 * controller can be tested against a stand-in, and it means there is exactly one
 * place where a call that throws on a device without Google Play Services can
 * throw it.
 *
 * ## Why nothing here is called at import time
 *
 * `getMessaging()` throws when no default Firebase app exists, which is the
 * state on any build that did not have `google-services.json` applied. Calling
 * it at module scope would take the whole app down on such a build, at the
 * moment the module was first imported — which is app start. Every call is
 * therefore deferred behind a function, and every function is written to
 * report failure rather than throw past its caller.
 *
 * ## What this is not
 *
 * It is not a permission prompt. `requestPermission` is deliberately separate
 * from `getDeviceToken` so that the controller can ask for a token only after
 * the user has actually switched notifications on, and never merely because the
 * app started.
 */

import { getApps } from '@react-native-firebase/app';
import {
  AuthorizationStatus,
  deleteToken,
  getInitialNotification,
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  onNotificationOpenedApp,
  onTokenRefresh,
  requestPermission,
  type RemoteMessage,
} from '@react-native-firebase/messaging';

/** What the platform said when permission was asked for. */
export type NotificationPermissionResult = 'granted' | 'denied' | 'blocked';

/** A message, reduced to what this app has any use for. */
export interface PushMessage {
  readonly title: string | null;
  readonly body: string | null;
  /** The `data` payload, as strings. FCM gives every value as a string. */
  readonly data: Readonly<Record<string, string>>;
}

/**
 * Whether Firebase can be used at all in this build.
 *
 * `getApps()` is empty when `google-services.json` was never applied — the
 * Gradle plugin is what turns that file into the resources the SDK reads — and
 * also on a device where the SDK failed to initialise. Both are "no push here",
 * and the caller reports them with the reason below rather than as a crash.
 */
export function isMessagingAvailable(): boolean {
  try {
    return getApps().length > 0;
  } catch {
    return false;
  }
}

/** Why messaging is unavailable, in words that name the actual cause. */
export function messagingUnavailableReason(): string {
  try {
    if (getApps().length === 0) {
      return 'This build has no Firebase configuration, so push notifications cannot be delivered to it.';
    }
  } catch {
    return 'Firebase is not available in this build.';
  }
  return 'Firebase is not available in this build.';
}

/**
 * Whether this *device* can receive Firebase messages.
 *
 * A second question from the one above, and a different answer on different
 * phones. `isMessagingAvailable` asks whether the build was configured with a
 * Firebase project; this asks whether the phone has the Google Play services
 * that actually carry the messages. A phone without them has a perfectly
 * configured build and still cannot be sent anything, and telling that user
 * their settings are wrong would send them looking in the wrong place.
 *
 * Returns false rather than throwing when the SDK cannot be asked at all.
 */
export async function isDeviceSupported(): Promise<boolean> {
  try {
    return await isSupported(getMessaging());
  } catch {
    return false;
  }
}

/** Reduces an SDK message to the four fields this app displays or stores. */
function toPushMessage(message: RemoteMessage): PushMessage {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.data ?? {})) {
    if (typeof value === 'string') data[key] = value;
  }

  return {
    title: message.notification?.title ?? null,
    body: message.notification?.body ?? null,
    data,
  };
}

/**
 * Asks for notification permission.
 *
 * On Android 13 and above this is the `POST_NOTIFICATIONS` runtime permission.
 * Below that the platform has no such gate and answers `granted` immediately,
 * which is correct: the user turns notifications off in system settings there,
 * and the SDK reports the resulting state through the same call.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  const status = await requestPermission(getMessaging());

  if (status === AuthorizationStatus.AUTHORIZED || status === AuthorizationStatus.PROVISIONAL) {
    return 'granted';
  }
  if (status === AuthorizationStatus.DENIED) return 'denied';
  return 'blocked';
}

/**
 * The current registration token for this install.
 *
 * A token is a delivery address, not a credential: it identifies the app
 * install to FCM. It is useless to anyone without the project's server
 * credentials, which is why it may be displayed and copied.
 */
export async function getDeviceToken(): Promise<string> {
  return getToken(getMessaging());
}

/**
 * Drops this install's token.
 *
 * Called when the user turns notifications off, and on sign-out. Deleting is
 * what makes the stopping real: keeping the token would mean the previous
 * account's notifications kept arriving on a phone that had signed out of it.
 */
export async function deleteDeviceToken(): Promise<void> {
  await deleteToken(getMessaging());
}

/** Subscribes to messages that arrive while the app is in the foreground. */
export function subscribeToForegroundMessages(
  handler: (message: PushMessage) => void,
): () => void {
  return onMessage(getMessaging(), (message) => {
    handler(toPushMessage(message));
  });
}

/** Fires when FCM rotates the token; the new one has to replace the old. */
export function subscribeToTokenRefresh(handler: (token: string) => void): () => void {
  return onTokenRefresh(getMessaging(), handler);
}

/**
 * Subscribes to taps on a notification that arrived while the app was
 * backgrounded. The app is already running, so this is the only signal.
 */
export function subscribeToNotificationTaps(
  handler: (message: PushMessage) => void,
): () => void {
  return onNotificationOpenedApp(getMessaging(), (message) => {
    handler(toPushMessage(message));
  });
}

/**
 * The notification that launched the app from a cold start, if any.
 *
 * Distinct from a tap while running: the app was not alive when the user
 * tapped, so there is no event to subscribe to and the launch payload has to be
 * read once, after start.
 */
export async function getLaunchNotification(): Promise<PushMessage | null> {
  const message = await getInitialNotification(getMessaging());
  return message === null ? null : toPushMessage(message);
}
