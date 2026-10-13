/**
 * The administration API client.
 *
 * ## Why this is a separate client from `api/client.ts`
 *
 * That client is deliberately anonymous — it exists for vocabulary distribution
 * and model updates, which need no identity. Every call here must carry the
 * signed-in administrator's Supabase access token, because the backend derives
 * *who* is acting from that token and refuses to take an actor id from the
 * request. Putting a bearer path in the shared client would invite other callers
 * to use it, so the two are kept apart.
 *
 * ## Why the server's own message is surfaced
 *
 * `api/client.ts` discards a failed response body and reports `Backend returned
 * 400`. That is fine for a liveness check and not fine here: the backend's 400s
 * carry the actual instruction ("A reason is required…"), and its 503 carries
 * the names of the environment variables it needs. Replacing either with a
 * status code would take a message written to be read and turn it back into a
 * puzzle. So this client reads the body and prefers its `error` field.
 */
import { config } from '../config/env';
import { getSupabaseClient } from '../supabase/client';
import type {
  AdminAuditRow,
  AnnouncementRow,
  AnnouncementSeverity,
  MaintenanceSetting,
  ProfileRow,
} from '../supabase/types';

/**
 * The shape of every answer from this API.
 *
 * A discriminated union rather than a thrown error, matching the rest of the
 * codebase: the caller has to decide what to show, and `ok: false` carries the
 * message to show it with.
 */
export type AdminResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

/** How many rows the list endpoints return per page. */
export const ADMIN_PAGE_SIZE = 25;

export interface AdminUserSummary {
  readonly id: string;
  readonly email: string | null;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
  readonly role: 'user' | 'admin';
  readonly status: 'active' | 'suspended';
  readonly created_at: string;
}

export interface AdminUserPage {
  readonly users: readonly AdminUserSummary[];
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
}

/* ------------------------------------------------------------------ request */

/**
 * Reads the current access token.
 *
 * Deliberately not cached. Supabase rotates an access token automatically and
 * the client is the only thing that knows the current one; holding a copy here
 * would mean sending an expired token after a refresh the client cannot see.
 */
async function accessToken(): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AdminResult<T>> {
  const base = config.apiBaseUrl;
  if (base === null) {
    return {
      ok: false,
      error:
        'No backend URL is configured, so the administration API cannot be reached. ' +
        'Set API_BASE_URL in apps/mobile/.env (see .env.example).',
    };
  }

  const token = await accessToken();
  if (token === null) {
    return {
      ok: false,
      error:
        'You are not signed in, so there is no access token to present. Sign in as an administrator to use this screen.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    /*
     * Parsed before the status is checked, because the error cases are exactly
     * the ones whose body matters. A `catch` here rather than a throw: a
     * response that is not JSON is a real possibility (a proxy error page), and
     * it should degrade to the status code rather than crash the screen.
     */
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message =
        payload !== null &&
        typeof payload === 'object' &&
        'error' in payload &&
        typeof (payload as { error: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : `The administration API returned ${response.status}.`;

      return { ok: false, error: message, status: response.status };
    }

    if (payload === null) {
      return { ok: false, error: 'The administration API returned an empty response.' };
    }

    return { ok: true, data: payload as T };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // A caller-initiated abort is not a failure to report — the screen was
      // left, or the request was superseded. Reported as such so the caller can
      // ignore it without pattern-matching on a string.
      return { ok: false, error: 'cancelled' };
    }
    return {
      ok: false,
      error:
        'The backend could not be reached. Check that it is running and that this ' +
        'device can see it.',
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/* -------------------------------------------------------------------- reads */

export function listUsers(params: {
  page?: number;
  q?: string;
  status?: 'active' | 'suspended';
  signal?: AbortSignal;
}): Promise<AdminResult<AdminUserPage>> {
  const query = new URLSearchParams();
  query.set('page', String(params.page ?? 1));
  query.set('perPage', String(ADMIN_PAGE_SIZE));
  if (params.q && params.q.trim().length > 0) query.set('q', params.q.trim());
  if (params.status) query.set('status', params.status);
  return call<AdminUserPage>('GET', `/admin/users?${query.toString()}`, undefined, params.signal);
}

export function readUser(
  id: string,
  signal?: AbortSignal,
): Promise<AdminResult<{ user: ProfileRow }>> {
  return call<{ user: ProfileRow }>(
    'GET',
    `/admin/users/${encodeURIComponent(id)}`,
    undefined,
    signal,
  );
}

export function listAudit(
  page: number,
  signal?: AbortSignal,
): Promise<AdminResult<{ entries: readonly AdminAuditRow[]; total: number; page: number }>> {
  return call('GET', `/admin/audit?page=${page}&perPage=50`, undefined, signal);
}

export function listAnnouncements(
  signal?: AbortSignal,
): Promise<AdminResult<{ announcements: readonly AnnouncementRow[] }>> {
  return call('GET', '/admin/announcements', undefined, signal);
}

export function readMaintenance(
  signal?: AbortSignal,
): Promise<AdminResult<{ maintenance: MaintenanceSetting | null; updatedAt: string | null }>> {
  return call('GET', '/admin/maintenance', undefined, signal);
}

/* ------------------------------------------------------------------- writes */

/**
 * Every write below requires a `reason`.
 *
 * The parameter is not optional and is not defaulted. The backend rejects a
 * missing one, and making it a required argument means the compiler asks the
 * question at the point the action is written rather than the server asking it
 * at the point the action is attempted.
 */
export function setSuspension(params: {
  userId: string;
  suspended: boolean;
  reason: string;
}): Promise<AdminResult<{ user: { id: string; status: string } }>> {
  return call('POST', `/admin/users/${encodeURIComponent(params.userId)}/suspend`, {
    suspended: params.suspended,
    reason: params.reason,
  });
}

export function setRole(params: {
  userId: string;
  role: 'user' | 'admin';
  reason: string;
}): Promise<AdminResult<{ user: { id: string; role: string } }>> {
  return call('POST', `/admin/users/${encodeURIComponent(params.userId)}/role`, {
    role: params.role,
    reason: params.reason,
  });
}

/**
 * Asks the backend to have the account's own password reset email sent.
 *
 * The result says `requested`, and the screen must say the same. Whether the
 * message arrives is decided by the mail provider and is not observable from
 * here, so nothing may report it as delivered.
 */
export function requestPasswordReset(params: {
  userId: string;
  reason: string;
}): Promise<AdminResult<{ status: 'requested'; message: string }>> {
  return call('POST', `/admin/users/${encodeURIComponent(params.userId)}/reset-password`, {
    reason: params.reason,
  });
}

export function createAnnouncement(params: {
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  published: boolean;
  reason: string;
}): Promise<AdminResult<{ announcement: AnnouncementRow }>> {
  return call('POST', '/admin/announcements', {
    title: params.title,
    body: params.body,
    severity: params.severity,
    published: params.published,
    reason: params.reason,
  });
}

export function updateAnnouncement(params: {
  id: string;
  patch: { published?: boolean; title?: string; body?: string };
  reason: string;
}): Promise<AdminResult<{ announcement: AnnouncementRow }>> {
  return call('POST', `/admin/announcements/${encodeURIComponent(params.id)}`, {
    ...params.patch,
    reason: params.reason,
  });
}

export function setMaintenance(params: {
  enabled: boolean;
  message: string;
  reason: string;
  expectedEndAt?: string | null;
}): Promise<AdminResult<{ maintenance: MaintenanceSetting; updatedAt: string | null }>> {
  return call('POST', '/admin/maintenance', {
    enabled: params.enabled,
    message: params.message,
    reason: params.reason,
    expectedEndAt: params.expectedEndAt ?? null,
  });
}
