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
import type { BulkRowResult } from './bulkEntry';
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

/** How many audit rows a page holds. Larger, because the log is read in bulk. */
export const AUDIT_PAGE_SIZE = 50;

/**
 * Which audit rows to ask for.
 *
 * Every field is optional and an absent one means "do not filter". They are
 * named the way the API names them rather than the way a screen labels them, so
 * the mapping from a control to a query parameter stays visible in one place.
 */
export interface AdminAuditFilters {
  readonly action?: string;
  readonly outcome?: 'requested' | 'succeeded' | 'failed';
  readonly actor?: string;
  readonly targetType?: string;
  /** One account's history: every action taken against it. */
  readonly targetId?: string;
  readonly from?: string;
  readonly to?: string;
}

/** Who last changed the maintenance setting, if anyone is recorded. */
export interface MaintenanceChangedBy {
  readonly id: string;
  /**
   * Null when the address could not be read, which covers two cases the payload
   * does not separate: a profile with no email, and a lookup that failed. The
   * server resolves the recorded id against `profiles` on every read and reports
   * a failure as unresolved rather than failing the whole read, so the screen
   * must not phrase this as a deletion — see `actorLine` in `./auditEntry`.
   */
  readonly email: string | null;
}

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

/**
 * What a bulk action answers with.
 *
 * `results` is the part the screen must read: one entry per account the service
 * reported on, in the order they were submitted. `succeeded` and `failed` are
 * the service's own tally and are not trusted here — `bulkEntry.ts` counts the
 * rows instead, so the sentence and the list can never disagree.
 */
export interface AdminBulkResult {
  readonly results: readonly BulkRowResult[];
  readonly succeeded: number;
  readonly failed: number;
  /** The state that was applied, echoed back so the caller cannot mislabel it. */
  readonly suspended: boolean;
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

/**
 * The query string for an audit read.
 *
 * Exported and pure so the mapping from a filter to a parameter can be tested
 * without a network, a session, or a configured backend URL. That last part
 * matters more than it looks: `config.apiBaseUrl` comes from a gitignored
 * `.env`, so a test that went through `call` would pass on a developer's machine
 * and fail on a fresh clone — and it would be asserting an environment fact
 * rather than this mapping.
 *
 * Only the filters that are set are sent, so the URL says what was actually
 * asked for. An empty string is indistinguishable from "no filter" on the server
 * — where it is deliberately ignored — but a request carrying `action=` would
 * suggest otherwise to anyone reading a log.
 */
export function auditQueryString(page: number, filters: AdminAuditFilters = {}): string {
  const query = new URLSearchParams();
  query.set('page', String(page));
  query.set('perPage', String(AUDIT_PAGE_SIZE));

  if (filters.action) query.set('action', filters.action);
  if (filters.outcome) query.set('outcome', filters.outcome);
  if (filters.actor?.trim()) query.set('actor', filters.actor.trim());
  if (filters.targetType) query.set('targetType', filters.targetType);
  if (filters.targetId) query.set('targetId', filters.targetId);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);

  return query.toString();
}

export function listAudit(
  page: number,
  filters: AdminAuditFilters = {},
  signal?: AbortSignal,
): Promise<AdminResult<{ entries: readonly AdminAuditRow[]; total: number; page: number }>> {
  return call('GET', `/admin/audit?${auditQueryString(page, filters)}`, undefined, signal);
}

export function listAnnouncements(
  signal?: AbortSignal,
): Promise<AdminResult<{ announcements: readonly AnnouncementRow[] }>> {
  return call('GET', '/admin/announcements', undefined, signal);
}

/**
 * The counts and recent activity behind the overview.
 *
 * The payload is deliberately not typed as `OverviewFigures` here. This function
 * returns what the service said; `parseOverview` decides whether that is
 * anything this screen can stand behind, and a type assertion at this point
 * would move the question to a place that cannot answer it.
 */
export function readOverview(
  signal?: AbortSignal,
): Promise<AdminResult<unknown>> {
  return call<unknown>('GET', '/admin/overview', undefined, signal);
}

/** Whether each component is configured, and whether it has ever worked. */
export function readHealth(signal?: AbortSignal): Promise<AdminResult<unknown>> {
  return call<unknown>('GET', '/admin/health', undefined, signal);
}

export function readMaintenance(signal?: AbortSignal): Promise<
  AdminResult<{
    maintenance: MaintenanceSetting | null;
    updatedAt: string | null;
    /**
     * Who last changed it. Null means no administrator is recorded — the seeded
     * row, or one whose administrator has since been deleted. It does not mean
     * "unchanged": `updatedAt` answers that, and the screen must not collapse
     * the two into one statement.
     */
    updatedBy: MaintenanceChangedBy | null;
  }>
> {
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
 * Applies one status change to several accounts at once.
 *
 * The selection is sent as it stands and the answer is read per account, because
 * the backend reports a partial result rather than rolling one back: an account
 * can be refused by the database's own constraints while its neighbours are not.
 * Reading only `succeeded` here would throw away the half of the answer that
 * says which accounts are still unchanged — see `bulkEntry.ts`, which is where
 * that decision is made and tested.
 *
 * No `actorId` is sent. The actor is the token's subject, and offering a field
 * for it would invite a client that sets it.
 */
export function setBulkSuspension(params: {
  userIds: readonly string[];
  suspended: boolean;
  reason: string;
}): Promise<AdminResult<AdminBulkResult>> {
  return call('POST', '/admin/users/bulk', {
    userIds: [...params.userIds],
    suspended: params.suspended,
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
  /**
   * When it stops being shown, or null for "never".
   *
   * Sent as the string the administrator typed, because the server is what
   * decides whether a date is readable and whether it has already passed — the
   * same rule applied to every client, rather than one this screen would have to
   * re-implement and keep in step.
   */
  expiresAt?: string | null;
}): Promise<AdminResult<{ announcement: AnnouncementRow; dispatch?: unknown }>> {
  return call('POST', '/admin/announcements', {
    title: params.title,
    body: params.body,
    severity: params.severity,
    published: params.published,
    reason: params.reason,
    expiresAt: params.expiresAt ?? null,
  });
}

export function updateAnnouncement(params: {
  id: string;
  patch: { published?: boolean; title?: string; body?: string; expiresAt?: string | null };
  reason: string;
}): Promise<AdminResult<{ announcement: AnnouncementRow; dispatch?: unknown }>> {
  return call('POST', `/admin/announcements/${encodeURIComponent(params.id)}`, {
    ...params.patch,
    reason: params.reason,
  });
}

/**
 * Asks the service to send a published announcement to the registered devices
 * again.
 *
 * The automatic send happens once, on the transition into published. This is the
 * deliberate second attempt for the case where that one could not run — and it
 * is deliberate rather than automatic on purpose: a retry that runs on a timer
 * sends a real notification to real people, and a notice that keeps arriving
 * because a background job is unhappy is worse than one that arrived once and
 * was never confirmed.
 *
 * `dispatch` is left untyped for the same reason the overview's payload is: the
 * decision about whether it is a report this screen can stand behind belongs to
 * `dispatchReport.ts`, and a type assertion here would move that question to a
 * place that cannot answer it.
 */
export function redispatchAnnouncement(params: {
  id: string;
  reason: string;
}): Promise<AdminResult<{ announcement: unknown; dispatch?: unknown }>> {
  return call('POST', `/admin/announcements/${encodeURIComponent(params.id)}/dispatch`, {
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

/* ------------------------------------------------------------- team content */

/**
 * A team row as the service returns it.
 *
 * Kept in the service's own snake_case rather than remapped. The mobile editor
 * displays exactly the fields the database holds, and a second naming layer
 * here would be one more place for `photo_path` and `photoPath` to be confused
 * — the mismatch that puts the wrong portrait on a person.
 */
export interface AdminTeamMember {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly bio: string;
  readonly photo_path: string | null;
  readonly sort_order: number;
  readonly published: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TeamMemberInput {
  name: string;
  role: string;
  bio?: string;
  photoPath?: string | null;
  sortOrder?: number;
  published?: boolean;
}

export function listTeam(signal?: AbortSignal): Promise<AdminResult<{ members: AdminTeamMember[] }>> {
  return call('GET', '/admin/team', undefined, signal);
}

export function createTeamMember(
  input: TeamMemberInput & { reason: string },
): Promise<AdminResult<{ member: AdminTeamMember }>> {
  return call('POST', '/admin/team', { ...input });
}

export function updateTeamMember(params: {
  id: string;
  patch: Omit<TeamMemberInput, 'name' | 'role'> & { name?: string; role?: string };
  reason: string;
}): Promise<AdminResult<{ member: AdminTeamMember; cleanup: string | null }>> {
  return call('PATCH', `/admin/team/${encodeURIComponent(params.id)}`, {
    ...params.patch,
    reason: params.reason,
  });
}

export function deleteTeamMember(params: {
  id: string;
  reason: string;
}): Promise<AdminResult<{ deleted: true; cleanup: string | null }>> {
  return call('DELETE', `/admin/team/${encodeURIComponent(params.id)}`, {
    reason: params.reason,
  });
}
