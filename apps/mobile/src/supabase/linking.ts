/**
 * Native Deep Link Handler for Supabase Auth.
 *
 * Handles redirect URLs for:
 * - Password recovery (sanketvaani://auth-callback#type=recovery&access_token=...)
 * - Email confirmation (type=signup)
 * - Google sign-in (an access token with no type)
 *
 * ## Why the address is matched exactly
 *
 * Any application on the phone can launch a `sanketvaani://` URL. Accepting the
 * whole scheme means any such app can hand this one a token fragment to process.
 * Only the callback the project is configured to redirect to is accepted, and a
 * URL with any other host — `sanketvaani://anything-else` — is ignored.
 */

import { Linking } from 'react-native';

import { AUTH_CALLBACK_URL, formatAuthError } from './auth';
import { getSupabaseClient } from './client';

export type AuthLinkEventType = 'recovery' | 'signup' | 'email_change' | 'login' | 'unknown';

export interface AuthLinkEvent {
  readonly type: AuthLinkEventType;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /**
   * A one-time token from a `token_hash` email template.
   *
   * This is the shape newer Supabase email templates use: the link carries no
   * session, only a hash the provider exchanges. It is preferred over fragment
   * tokens when present because nothing reusable is in the URL.
   */
  readonly tokenHash?: string;
  readonly error?: string;
}

/**
 * What happened when a link was handed to the app.
 *
 * `ignored` means the URL was not this app's auth callback or carried no
 * parameters, so nothing should be shown; the other two are things the user
 * needs to be told about.
 */
export type AuthLinkOutcome =
  | { readonly status: 'ignored' }
  | { readonly status: 'signed-in'; readonly type: AuthLinkEventType }
  | { readonly status: 'error'; readonly message: string };

/** The callback with no trailing slash or parameters is also valid. */
const ACCEPTED_BASES = new Set([AUTH_CALLBACK_URL, `${AUTH_CALLBACK_URL}/`]);

export function parseAuthUrl(url: string): AuthLinkEvent | null {
  if (!url) return null;

  const base = url.split(/[?#]/, 1)[0] ?? '';
  if (!ACCEPTED_BASES.has(base)) return null;

  try {
    const hashIndex = url.indexOf('#');
    const queryIndex = url.indexOf('?');
    const queryEnd =
      hashIndex !== -1 && queryIndex !== -1 && queryIndex < hashIndex ? hashIndex : url.length;
    const queryPart = queryIndex !== -1 ? url.substring(queryIndex + 1, queryEnd) : '';
    const hashPart = hashIndex !== -1 ? url.substring(hashIndex + 1) : '';

    if (!queryPart && !hashPart) return null;

    /*
     * Some providers put the outcome in the query (`?error=...`) and the tokens
     * in the fragment (`#access_token=...`). Both are read; the fragment wins
     * for a repeated key, which is where Supabase puts the authoritative values.
     */
    const params = new URLSearchParams(queryPart);
    if (hashPart) {
      for (const [key, value] of new URLSearchParams(hashPart)) {
        params.set(key, value);
      }
    }

    const accessToken = params.get('access_token') || undefined;
    const refreshToken = params.get('refresh_token') || undefined;
    const tokenHash = params.get('token_hash') || undefined;
    const typeStr = params.get('type') || '';
    const errorDescription =
      params.get('error_description') || params.get('error') || undefined;

    let type: AuthLinkEventType = 'unknown';
    if (typeStr === 'recovery') type = 'recovery';
    else if (typeStr === 'signup') type = 'signup';
    else if (typeStr === 'email_change') type = 'email_change';
    else if (accessToken) type = 'login';

    return {
      type,
      accessToken,
      refreshToken,
      tokenHash,
      error: errorDescription,
    };
  } catch {
    return null;
  }
}

/** Turns the provider's error code into something a person can act on. */
function describeLinkError(raw: string): string {
  const text = raw.toLowerCase();
  if (text.includes('expired') || text.includes('invalid')) {
    return 'That link has expired or was already used. Request a new one and open the newest email.';
  }
  if (text.includes('access_denied') || text.includes('denied')) {
    return 'The sign-in was cancelled in the browser. Nothing on this phone has changed.';
  }
  return `The sign-in link was not completed: ${raw}`;
}

/**
 * Processes an incoming authentication deep link URL.
 *
 * A link with no tokens (for example, an OAuth refusal) is reported as an error
 * rather than quietly returning `false`: the person who tapped it is waiting for
 * something to happen and deserves to know that nothing did.
 */
export async function handleAuthUrl(
  url: string,
  onRecovery?: () => void,
): Promise<AuthLinkOutcome> {
  const event = parseAuthUrl(url);
  if (!event) return { status: 'ignored' };

  if (event.error) {
    return { status: 'error', message: describeLinkError(event.error) };
  }

  const client = getSupabaseClient();
  if (!client) {
    return {
      status: 'error',
      message: 'This build has no account service configured, so the link cannot be completed.',
    };
  }

  if (!event.accessToken || !event.refreshToken) {
    /*
     * `token_hash` templates carry no session. The provider exchanges the hash
     * for one, and refuses it if it has expired or already been spent — which is
     * where single-use and replay protection live.
     */
    if (event.tokenHash) {
      const otpType: 'recovery' | 'email_change' | 'email' | 'signup' =
        event.type === 'recovery'
          ? 'recovery'
          : event.type === 'email_change'
            ? 'email_change'
            : event.type === 'login'
              ? 'email'
              : 'signup';

      try {
        const { data, error } = await client.auth.verifyOtp({
          token_hash: event.tokenHash,
          type: otpType,
        });
        if (error) {
          return { status: 'error', message: formatAuthError(error) };
        }
        if (!data.session) {
          return {
            status: 'error',
            message: 'The link was accepted but no session was created. Open the newest email and try again.',
          };
        }
        if (event.type === 'recovery' && onRecovery) onRecovery();
        return { status: 'signed-in', type: event.type };
      } catch (err) {
        return { status: 'error', message: formatAuthError(err) };
      }
    }

    return {
      status: 'error',
      message: 'This link has no sign-in information. Open the newest email and try again.',
    };
  }

  try {
    const { data, error } = await client.auth.setSession({
      access_token: event.accessToken,
      refresh_token: event.refreshToken,
    });

    if (error) {
      return { status: 'error', message: formatAuthError(error) };
    }
    if (!data.session) {
      return {
        status: 'error',
        message: 'The link was accepted but no session was created. Open the newest email and try again.',
      };
    }

    if (event.type === 'recovery' && onRecovery) {
      onRecovery();
    }
    return { status: 'signed-in', type: event.type };
  } catch (err) {
    return { status: 'error', message: formatAuthError(err) };
  }
}

/**
 * Initializes deep link listening on native platform.
 */
export function setupAuthDeepLinking(
  onResult?: (outcome: AuthLinkOutcome) => void,
  onRecovery?: () => void,
): () => void {
  const deliver = (url: string): void => {
    handleAuthUrl(url, onRecovery)
      .then((outcome) => {
        // A URL that is not this app's callback is not news.
        if (outcome.status !== 'ignored') onResult?.(outcome);
      })
      .catch(() => undefined);
  };

  // Check initial launch URL
  Linking.getInitialURL()
    .then((url) => {
      if (url) deliver(url);
    })
    .catch(() => undefined);

  // Listen for background-to-foreground URLs
  const subscription = Linking.addEventListener('url', (event) => {
    deliver(event.url);
  });

  return () => {
    subscription.remove();
  };
}
