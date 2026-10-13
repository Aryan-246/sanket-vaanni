/**
 * Native Deep Link Handler for Supabase Auth.
 *
 * Handles redirect URLs for:
 * - Password recovery (sanketvaani://auth-callback#type=recovery&access_token=...)
 * - Email confirmation / OAuth callbacks
 */

import { Linking } from 'react-native';

import { getSupabaseClient } from './client';

export type AuthLinkEventType = 'recovery' | 'signup' | 'login' | 'unknown';

export interface AuthLinkEvent {
  readonly type: AuthLinkEventType;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly error?: string;
}

export function parseAuthUrl(url: string): AuthLinkEvent | null {
  if (!url || !url.startsWith('sanketvaani://')) return null;

  try {
    // Parameters can be in query (?foo=bar) or hash fragment (#foo=bar)
    const hashIndex = url.indexOf('#');
    const queryIndex = url.indexOf('?');

    let paramString = '';
    if (hashIndex !== -1) {
      paramString = url.substring(hashIndex + 1);
    } else if (queryIndex !== -1) {
      paramString = url.substring(queryIndex + 1);
    }

    if (!paramString) return null;

    const params = new URLSearchParams(paramString);
    const accessToken = params.get('access_token') || undefined;
    const refreshToken = params.get('refresh_token') || undefined;
    const typeStr = params.get('type') || '';
    const errorDescription = params.get('error_description') || undefined;

    let type: AuthLinkEventType = 'unknown';
    if (typeStr === 'recovery') type = 'recovery';
    else if (typeStr === 'signup') type = 'signup';
    else if (accessToken) type = 'login';

    return {
      type,
      accessToken,
      refreshToken,
      error: errorDescription,
    };
  } catch {
    return null;
  }
}

/**
 * Processes an incoming authentication deep link URL.
 */
export async function handleAuthUrl(
  url: string,
  onRecovery?: () => void,
): Promise<boolean> {
  const event = parseAuthUrl(url);
  if (!event) return false;

  const client = getSupabaseClient();
  if (!client) return false;

  if (event.accessToken && event.refreshToken) {
    try {
      await client.auth.setSession({
        access_token: event.accessToken,
        refresh_token: event.refreshToken,
      });

      if (event.type === 'recovery' && onRecovery) {
        onRecovery();
      }
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Initializes deep link listening on native platform.
 */
export function setupAuthDeepLinking(onRecovery?: () => void): () => void {
  // Check initial launch URL
  Linking.getInitialURL()
    .then((url) => {
      if (url) {
        handleAuthUrl(url, onRecovery).catch(() => undefined);
      }
    })
    .catch(() => undefined);

  // Listen for background-to-foreground URLs
  const subscription = Linking.addEventListener('url', (event) => {
    handleAuthUrl(event.url, onRecovery).catch(() => undefined);
  });

  return () => {
    subscription.remove();
  };
}
