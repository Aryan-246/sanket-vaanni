import fs from 'node:fs';
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import type { AppConfig } from '../config.js';

let firebaseApp: App | null = null;
let messagingInstance: Messaging | null = null;

export interface FirebaseInitStatus {
  initialized: boolean;
  projectId?: string;
  credentialsPath?: string;
  error?: string;
}

/**
 * Initializes Firebase Admin SDK once using the provided application configuration.
 *
 * Safe for repeated calls (returns the existing initialized instance).
 * If credentials are not configured or the credential file does not exist,
 * it returns a structured status indicating why without crashing the process.
 */
export function initFirebaseAdmin(config?: AppConfig): FirebaseInitStatus {
  const existingApps = getApps();
  // Indexed into a named local rather than assigned from `existingApps[0]`
  // directly: `noUncheckedIndexedAccess` types an index read as possibly
  // undefined, and the guard below is what narrows it to a real app.
  const existingApp = existingApps[0];
  if (existingApp) {
    firebaseApp = existingApp;
    messagingInstance = getMessaging(existingApp);
    return {
      initialized: true,
      projectId: existingApp.options.projectId,
      credentialsPath: config?.googleApplicationCredentials,
    };
  }

  const credentialsPath =
    config?.googleApplicationCredentials ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!credentialsPath || credentialsPath.trim().length === 0) {
    return {
      initialized: false,
      error:
        'GOOGLE_APPLICATION_CREDENTIALS is not set. Configure the path to the service account JSON key in .env.',
    };
  }

  const resolvedPath = credentialsPath.trim();

  if (!fs.existsSync(resolvedPath)) {
    return {
      initialized: false,
      credentialsPath: resolvedPath,
      error: `Service account key file not found at: ${resolvedPath}`,
    };
  }

  try {
    firebaseApp = initializeApp({
      credential: cert(resolvedPath),
      projectId: 'sanket-vaanni',
    });
    messagingInstance = getMessaging(firebaseApp);

    return {
      initialized: true,
      projectId: 'sanket-vaanni',
      credentialsPath: resolvedPath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      initialized: false,
      credentialsPath: resolvedPath,
      error: `Failed to initialize Firebase Admin SDK: ${message}`,
    };
  }
}

/**
 * Retrieves the active Firebase Messaging instance.
 * Throws an Error if Firebase Admin SDK has not been initialized.
 */
export function getFirebaseMessagingService(): Messaging {
  if (!messagingInstance) {
    const status = initFirebaseAdmin();
    if (!status.initialized || !messagingInstance) {
      throw new Error(status.error ?? 'Firebase Admin SDK is not initialized.');
    }
  }
  return messagingInstance;
}

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Sends a real push notification to a specific device/FCM registration token.
 */
export async function sendPushNotification(
  token: string,
  payload: NotificationPayload,
): Promise<{ messageId: string }> {
  const messaging = getFirebaseMessagingService();

  const messageId = await messaging.send({
    token,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data,
  });

  return { messageId };
}

/**
 * Sends a push notification to a topic (e.g., 'announcements' or 'alerts').
 */
export async function sendTopicNotification(
  topic: string,
  payload: NotificationPayload,
): Promise<{ messageId: string }> {
  const messaging = getFirebaseMessagingService();

  const messageId = await messaging.send({
    topic,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data,
  });

  return { messageId };
}
