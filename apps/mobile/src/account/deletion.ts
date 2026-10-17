/**
 * The mobile side of permanent account deletion.
 *
 * ## The two calls are deliberately separate
 *
 * Sending the code and using the code are different decisions. The first only
 * sends an email; the second destroys the account. Keeping them as two
 * functions means the warning dialog can finish, the screen can wait for the
 * user to fetch the code from their inbox, and a bug that wires the wrong button
 * cannot turn a stray press into a deletion — it can only ask for a code.
 *
 * ## What the client never sends
 *
 * Not an account id and not the user's email. The backend derives both from the
 * bearer token, so this object has nothing to get wrong and nothing that could
 * be pointed at somebody else.
 */
import { config } from '../config/env';
import { getSupabaseClient } from '../supabase/client';

export interface DeletionAccepted {
  /** ISO timestamp: when the emailed code stops working. */
  readonly expiresAt: string;
}

export type DeletionCall<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: string;
      readonly status?: number;
      readonly retryAfterSeconds?: number;
    };

async function callDeletion<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<DeletionCall<T>> {
  const base = config.apiBaseUrl;
  if (base === null) {
    return {
      ok: false,
      error:
        'This build has no backend address, so account deletion cannot be confirmed. ' +
        'Set API_BASE_URL and try again.',
    };
  }

  const client = getSupabaseClient();
  if (!client) {
    return { ok: false, error: 'Cloud authentication is not configured in this build.' };
  }

  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  const token = sessionData.session?.access_token ?? null;
  if (sessionError || token === null) {
    return {
      ok: false,
      error: 'You are not signed in, so there is no session to delete. Sign in and try again.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);

  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const record =
        payload !== null && typeof payload === 'object'
          ? (payload as Record<string, unknown>)
          : {};

      const message =
        typeof record.error === 'string'
          ? record.error
          : `The account service returned ${response.status}.`;

      const retryAfterSeconds =
        typeof record.retryAfterSeconds === 'number' ? record.retryAfterSeconds : undefined;

      return {
        ok: false,
        error: message,
        status: response.status,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }

    if (payload === null || typeof payload !== 'object') {
      return { ok: false, error: 'The account service returned an empty response.' };
    }

    return { ok: true, data: payload as T };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        ok: false,
        error:
          'The request timed out. The code may still be valid — check your email before retrying.',
      };
    }
    return {
      ok: false,
      error:
        'The backend could not be reached, so nothing was deleted. Check the connection and try again.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Sends a single-use code to the signed-in account's verified address. */
export function requestDeletionCode(): Promise<DeletionCall<DeletionAccepted>> {
  return callDeletion<DeletionAccepted>('/account/deletion/request');
}

/** Uses the code. On success the account no longer exists at the provider. */
export function confirmDeletion(code: string): Promise<DeletionCall<{ status: 'deleted' }>> {
  return callDeletion<{ status: 'deleted' }>('/account/deletion/confirm', { code });
}
