/**
 * The administration API.
 *
 * ## Every consequential action has the same three parts
 *
 * A reason supplied by the caller, a confirmation that the client has to have
 * obtained from the user, and an audit record written *before* the action is
 * attempted. The order matters: the request row is written first and throws on
 * failure, so an action that cannot be recorded does not happen. Writing it
 * afterwards would mean a failure to log could leave an unlogged change behind,
 * which is the one outcome an audit log must not have.
 *
 * Because that row is written before the outcome exists, it cannot say whether
 * the action worked. Each handler therefore appends the outcome immediately
 * after — as a second row under the same request id, since the table is
 * append-only — so the log never claims a change that failed. See
 * `../audit/trail.ts`.
 *
 * ## What is deliberately not here
 *
 * There is no endpoint that returns or sets a password, and none that reads a
 * user's content. An administrator can see *that* an account exists, its role
 * and its status, and can suspend it — but not a user's recognitions, their
 * conversations, or their calibration. The brief for this project requires
 * administrative control over accounts, and control over accounts does not
 * require reading what people said.
 *
 * ## Passwords
 *
 * Password recovery is a provider action. `POST /admin/users/:id/reset-password`
 * asks Supabase to send the account its own reset email, and returns nothing
 * about the account's credential. No part of this service can read a password,
 * because no part of it ever receives one.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config.js';
import { beginAction, type AuditTrail } from '../audit/trail.js';
import {
  createRequireAdmin,
  type AdminActor,
  type AdminAuthDeps,
} from '../middleware/requireAdmin.js';
import { isEmailConfigured, verifySmtpConnection } from '../services/email.js';
import { initFirebaseAdmin, sendPushNotification } from '../services/firebase.js';
import {
  dispatchAnnouncement,
  pushUnavailableReason,
  type DispatchDeps,
  type PushDispatchReport,
  type PushTarget,
} from '../announcements/dispatch.js';

/** The longest a reason may be, so the audit table cannot be used as storage. */
const MAX_REASON_LENGTH = 500;

/** The longest an announcement may be. */
const MAX_ANNOUNCEMENT_BODY = 4000;

/**
 * The longest an announcement's title may be.
 *
 * The column is `TEXT`, so without this the only limit is how much a browser or
 * the API will send. A title is rendered above a notice on every user's settings
 * screen, which makes an unbounded one a way to push somebody else's layout
 * around.
 */
const MAX_ANNOUNCEMENT_TITLE = 200;

/** The longest a search term may be, so a pasted document cannot become a query. */
const MAX_SEARCH_LENGTH = 100;

/**
 * How many accounts one bulk action may change.
 *
 * A bulk action is one HTTP request that performs N writes and 2N audit rows.
 * Without a ceiling, the limit on how much work a single click can cause would
 * be how large a request body the client chose to send. Fifty is above any real
 * administrative selection and far below anything that would look like an
 * outage to the accounts involved.
 */
const MAX_BULK_TARGETS = 50;

/* ------------------------------------------------------- health reporting */

/**
 * How much has actually been proved about a component.
 *
 * The `untested` / `verified` boundary is the load-bearing one: `verified` is
 * reserved for a component that performed its real job during the check. See the
 * doc comment on `GET /admin/health`.
 */
type HealthState = 'unconfigured' | 'untested' | 'verified' | 'failed';

/** One component's row on the health screen. Carries no configuration value. */
interface HealthCheck {
  readonly key: 'api' | 'database' | 'email' | 'push';
  readonly label: string;
  readonly state: HealthState;
  readonly detail: string;
  /** True when this component's job is delivering a message to a person. */
  readonly delivers: boolean;
  /** A message was delivered and confirmed end to end. Never inferred. */
  readonly deliveryTested: boolean;
}

/**
 * The capability probes `GET /admin/health` reports on.
 *
 * Injectable for the same reason `AdminAuthDeps` is: the interesting behaviour is
 * the mapping from a probe's answer to a state, and a test cannot produce a
 * working SMTP server or a Firebase service account to observe that mapping
 * honestly. Injecting them means the *decision* is tested rather than the
 * environment, and the real implementations remain the default, so production
 * behaviour is unchanged by this seam existing.
 */
export interface AdminHealthDeps {
  readonly isEmailConfigured?: () => boolean;
  readonly verifySmtpConnection?: () => Promise<{ connected: boolean; error?: string }>;
  /** Returns whether the credentials loaded. Its `credentialsPath` is not used. */
  readonly firebaseStatus?: (config: AppConfig) => { initialized: boolean; error?: string };
}

/* ------------------------------------------------------ validated inputs */

/**
 * A timestamp supplied by an administrator.
 *
 * Returns the normalised instant, `null` for "none", or the sentence to send
 * back. Normalised because a client may send any format `Date.parse` accepts,
 * and the database should receive one shape.
 *
 * Deliberately *not* checked against the present here. Whether an expiry is in
 * the future depends on whether the announcement is published, and a draft may
 * legitimately carry an expiry that has not been reached yet — so the "is it
 * still visible" question is asked at the point the row is published, further
 * down, rather than at the point it is typed.
 */
type ExpiryResult = { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly message: string };

function readExpiry(raw: unknown, label: string): ExpiryResult {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, message: `${label} must be a date.` };

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return {
      ok: false,
      message: `${label} must be a date this server can read, such as 2026-11-01T18:00:00Z.`,
    };
  }
  return { ok: true, value: new Date(parsed).toISOString() };
}

/**
 * Why an announcement cannot be published, or null when it can.
 *
 * The failure this exists for: an expiry already in the past produces an
 * announcement that is invisible the moment it is created. Nothing errors, the
 * audit log records a successful publish, and every user sees nothing — which an
 * administrator would report as the app being broken.
 */
function publishingProblem(expiresAt: string | null, nowMs: number): string | null {
  if (expiresAt === null) return null;
  if (Date.parse(expiresAt) <= nowMs) {
    return 'That expiry has already passed, so the announcement would never be visible. Choose a future time, or leave it empty for one that does not expire.';
  }
  return null;
}

interface ReasonBody {
  reason?: unknown;
}

/**
 * The fields a dispatch needs, taken off a row the database just returned.
 *
 * Returns null rather than defaults when they are absent. A dispatch built from
 * blanks would send a notification with an empty title to every registered
 * device, and there is no error path here that could take it back — so a row
 * that cannot be read is one this does not send.
 */
function announcementOf(row: unknown): { id: string; title: string; body: string; severity: string } | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  const { id, title, body, severity } = record;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof body !== 'string') return null;
  if (id.length === 0) return null;
  return { id, title, body, severity: typeof severity === 'string' ? severity : 'info' };
}

interface SuspendBody extends ReasonBody {
  suspended?: unknown;
}

interface BulkBody extends ReasonBody {
  userIds?: unknown;
  suspended?: unknown;
}

/** What happened to one account in a bulk action. */
interface BulkResult {
  readonly id: string;
  readonly ok: boolean;
  /** The status after the change, present only when it succeeded. */
  readonly status?: string;
  /** Why this account was not changed, present only when it did not. */
  readonly error?: string;
}

interface RoleBody extends ReasonBody {
  role?: unknown;
}

interface AnnouncementBody extends ReasonBody {
  title?: unknown;
  body?: unknown;
  severity?: unknown;
  published?: unknown;
  expiresAt?: unknown;
}

interface MaintenanceBody extends ReasonBody {
  enabled?: unknown;
  message?: unknown;
  expectedEndAt?: unknown;
}

/**
 * Validates the mandatory reason.
 *
 * Returns the trimmed reason, or sends a 400 and returns null. A minimum of
 * three characters is not security — it is there to stop `"x"` and `""` being
 * accepted as a justification, which is what the database's own CHECK also
 * enforces. Both layers, because this one produces a useful message and the
 * database one cannot be bypassed.
 */
function requireReason(body: ReasonBody | undefined, reply: FastifyReply): string | null {
  const raw = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (raw.length < 3) {
    reply.status(400).send({
      error:
        'A reason is required for every administrative action. Write at least a few words explaining why.',
    });
    return null;
  }
  if (raw.length > MAX_REASON_LENGTH) {
    reply.status(400).send({ error: `A reason cannot be longer than ${MAX_REASON_LENGTH} characters.` });
    return null;
  }
  return raw;
}

function actorOf(request: { adminActor?: AdminActor }): AdminActor {
  // Set by the preHandler on every route in this plugin, so this cannot be
  // undefined. Throwing rather than defaulting, because a default would mean an
  // unattributable action.
  if (!request.adminActor) {
    throw new Error('Admin route reached without an authenticated actor.');
  }
  return request.adminActor;
}

/** The selected account ids, or the reason the selection was refused. */
type BulkTargets = { ok: true; ids: readonly string[] } | { ok: false; message: string };

/**
 * Reads the accounts a bulk action is aimed at.
 *
 * Duplicates are folded rather than refused. A selection is assembled by a
 * person ticking rows, and a repeated id would mean the same account is
 * suspended twice and audited twice — the second pair claiming a change that
 * had already happened. Folding makes the request say what it means.
 *
 * Both the empty and the oversized case are refused rather than clamped. An
 * action that silently changed a different set of accounts than the one
 * submitted would be worse than one that refused.
 */
function readBulkTargets(raw: unknown): BulkTargets {
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'A bulk action needs a list of account ids.' };
  }

  const ids: string[] = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry.trim() : '';
    if (id.length === 0) {
      return { ok: false, message: 'Every entry in a bulk action must be an account id.' };
    }
    if (!ids.includes(id)) ids.push(id);
  }

  if (ids.length === 0) {
    return { ok: false, message: 'Select at least one account before running a bulk action.' };
  }
  if (ids.length > MAX_BULK_TARGETS) {
    return {
      ok: false,
      message: `A bulk action is limited to ${MAX_BULK_TARGETS} accounts at a time. Narrow the selection and repeat.`,
    };
  }

  return { ok: true, ids };
}

/**
 * A search term stripped of the characters PostgREST gives meaning to.
 *
 * `q` is interpolated into a filter *expression* — `email.ilike.%q%,...` — not
 * bound as a value. A comma therefore starts another condition and a closing
 * parenthesis ends the group, so a search for `x,role.eq.admin` would add a
 * condition chosen by the caller.
 *
 * The severity here is low and worth being honest about: the caller is already
 * an administrator, and the only table they could widen their own access to is
 * one they may read in full anyway. It is fixed because of what it would become.
 * The next filter built by interpolation may guard something that matters, and a
 * helper that is already correct is one fewer thing to re-derive when that day
 * comes.
 *
 * Removed rather than escaped, because PostgREST has no escape syntax for these
 * in a filter expression, and because no search a person types into an
 * administrator's user list contains one deliberately. Capped so a pasted
 * document cannot become a query.
 */
function safeSearchTerm(raw: string): string {
  return raw
    .replace(/[,()*%\\'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);
}

/**
 * A value that must be one of the tokens this service writes.
 *
 * `action` and `target_type` are written by `beginAction` from a fixed set, so a
 * caller can only ever legitimately ask for one of those shapes. Anything else
 * is a malformed request rather than a search for something unusual, and is
 * dropped rather than passed to the database — where, being part of a JSON-path
 * or pattern filter, it would change the query's shape instead of its value.
 */
function readToken(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return /^[a-z][a-z0-9_]{0,40}$/.test(raw) ? raw : null;
}

/**
 * An id, as this service writes them: UUIDs, and the handful of fixed strings
 * like `maintenance` that a setting is targeted by.
 */
function readIdentifier(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return /^[A-Za-z0-9._:-]{1,64}$/.test(raw) ? raw : null;
}

/**
 * An instant, normalised to ISO-8601, or null.
 *
 * `Date.parse` rather than a regular expression, because the useful question is
 * whether the database will understand it. A value that does not parse is
 * dropped, which widens the result set back to unfiltered rather than returning
 * an empty page — an administrator who mistypes a date should see the log, not a
 * screen implying the log is empty.
 *
 * That is the opposite policy to `readExpiry` above, and deliberately so: a date
 * on an announcement decides what every user sees, so an unreadable one is
 * refused with a message. This one is a filter, where the worst case is a wider
 * page than was asked for. One normaliser, two policies — the alternative is two
 * date parsers that disagree.
 */
function readTimestamp(raw: string | undefined): string | null {
  const result = readExpiry(raw, 'A date');
  return result.ok ? result.value : null;
}

/**
 * The service-role client for this request.
 *
 * The middleware builds exactly one and attaches it, so every handler in this
 * plugin reaches the database through the same client that has already been
 * through the authorization check. Nothing here constructs its own client,
 * which is what makes "every privileged query in this file is gated" a
 * property you can see rather than one you have to trace.
 */
function serviceOf(request: { adminService?: SupabaseClient }): SupabaseClient {
  if (!request.adminService) {
    throw new Error('Admin route reached without a service client.');
  }
  return request.adminService;
}

/**
 * Reads registered device tokens, a page at a time.
 *
 * Bound to the request's own service client, so the read goes through the same
 * client that has already passed the authorization check rather than a second
 * one built here.
 *
 * Ordered by `token`, which is the primary key: paging by a value that is unique
 * cannot skip or repeat a row, whereas paging by a timestamp can when two
 * devices register in the same millisecond. A dispatch that silently missed a
 * device because of a tie would under-report coverage in the one place the
 * report exists to be exact.
 *
 * A row whose token is not a non-empty string is dropped rather than sent to, as
 * a last guard behind the column's own constraints — and dropping it is safe
 * here because the count of rows the dispatch reports is the count it actually
 * visited.
 */
function targetReader(service: SupabaseClient) {
  return async (
    limit: number,
    offset: number,
  ): Promise<{ targets: readonly PushTarget[]; error: string | null }> => {
    const { data, error } = await service
      .from('device_push_tokens')
      .select('token, user_id')
      .order('token', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) return { targets: [], error: error.message };

    const rows = (data ?? []) as readonly { token?: unknown; user_id?: unknown }[];
    const targets: PushTarget[] = [];
    for (const row of rows) {
      if (typeof row.token !== 'string' || row.token.length === 0) continue;
      targets.push({
        token: row.token,
        userId: typeof row.user_id === 'string' ? row.user_id : null,
      });
    }

    return { targets, error: null };
  };
}

export function createAdminRoutes(
  config: AppConfig,
  deps: AdminAuthDeps = {},
  healthDeps: AdminHealthDeps = {},
  dispatchDeps: DispatchDeps = {},
) {
  return async function adminRoutes(app: FastifyInstance): Promise<void> {
    const requireAdmin = createRequireAdmin(config, deps);

    /**
     * The dispatch dependencies for one request.
     *
     * Anything the caller injected wins, so a test can exercise the route's
     * decisions — when a dispatch happens, what is recorded, what is returned —
     * without a Firebase project or a token table. Everything not injected falls
     * back to the real implementation bound to this request's service client,
     * which is what every production call uses.
     */
    const dispatchFor = (request: { adminService?: SupabaseClient }) => ({
      ...dispatchDeps,
      listTargets: dispatchDeps.listTargets ?? targetReader(serviceOf(request)),
      send: dispatchDeps.send ?? ((token: string, payload: Parameters<typeof sendPushNotification>[1]) =>
        sendPushNotification(token, payload)),
      forgetToken:
        dispatchDeps.forgetToken ??
        (async (token: string) => {
          await serviceOf(request).from('device_push_tokens').delete().eq('token', token);
        }),
    });

    app.addHook('preHandler', requireAdmin);

    /* ---------------------------------------------------------------- reads */

    /**
     * The user list.
     *
     * Paginated, and searchable by the two fields an administrator actually
     * needs to find someone by. Deliberately not a full-text search over user
     * content — see the note at the top of this file.
     *
     * `profiles` holds one row per auth user, and `role` is constrained by the
     * database to exactly `'user'` or `'admin'` (`profiles_role_check`), with
     * `status` constrained to `'active'` or `'suspended'`. A `service_role` or
     * `postgres` row therefore cannot appear here to be filtered out: the CHECK
     * constraint does that, not this query.
     */
    app.get<{ Querystring: { page?: string; perPage?: string; q?: string; status?: string } }>(
      '/admin/users',
      async (request, reply) => {
        const page = Math.max(1, Number.parseInt(request.query.page ?? '1', 10) || 1);
        const perPage = Math.min(
          100,
          Math.max(1, Number.parseInt(request.query.perPage ?? '25', 10) || 25),
        );
        const from = (page - 1) * perPage;
        const to = from + perPage - 1;

        let query = serviceOf(request)
          .from('profiles')
          .select('id, email, display_name, avatar_url, role, status, is_owner, created_at', {
            count: 'exact',
          })
          .order('created_at', { ascending: false })
          .range(from, to);

        const q = safeSearchTerm(request.query.q ?? '');
        if (q.length > 0) {
          // `or` rather than a full-text index: the dataset is small, and a
          // substring match on an email is what an administrator searches for.
          query = query.or(`email.ilike.%${q}%,display_name.ilike.%${q}%`);
        }

        const status = request.query.status;
        if (status === 'active' || status === 'suspended') {
          query = query.eq('status', status);
        }

        const { data, error, count } = await query;

        if (error) {
          request.log.error({ err: error.message }, 'Admin user list failed');
          return reply.status(502).send({ error: 'The user list could not be read.' });
        }

        return reply.send({
          users: data ?? [],
          page,
          perPage,
          total: count ?? 0,
        });
      },
    );

    /** One user, for a detail view. */
    app.get<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
      const { data, error } = await serviceOf(request)
        .from('profiles')
        .select('id, email, display_name, avatar_url, role, status, is_owner, created_at, updated_at')
        .eq('id', request.params.id)
        .maybeSingle();

      if (error) {
        request.log.error({ err: error.message }, 'Admin user read failed');
        return reply.status(502).send({ error: 'That account could not be read.' });
      }
      if (!data) return reply.status(404).send({ error: 'No account has that id.' });

      return reply.send({ user: data });
    });

    /**
     * The audit log, newest first, filtered.
     *
     * ## Why the filters are validated rather than passed through
     *
     * Every value below is either allowlisted against a known set or reduced by
     * `safeSearchTerm`, instead of being interpolated as given. `.eq()` does bind
     * its value as a URL parameter, so this is belt-and-braces for the exact
     * match cases — but `metadata->>outcome` is a *JSON path* filter and `ilike`
     * takes a pattern, and both are places where an unvalidated string changes
     * the shape of the query rather than the value it matches.
     *
     * ## `outcome` and the rows written before it existed
     *
     * `outcome` lives in `metadata`, not in a column, because the table is
     * append-only and adding a column to it would have meant a migration for
     * what is a property of the entry rather than the record. Rows written before
     * outcomes were recorded have no such key, so filtering by outcome excludes
     * them. That is the honest behaviour — an old row genuinely has no recorded
     * outcome — and it is why the admin UI labels this filter as covering
     * recorded outcomes only.
     */
    app.get<{
      Querystring: {
        page?: string;
        perPage?: string;
        action?: string;
        outcome?: string;
        actor?: string;
        targetType?: string;
        targetId?: string;
        from?: string;
        to?: string;
      };
    }>('/admin/audit', async (request, reply) => {
      const page = Math.max(1, Number.parseInt(request.query.page ?? '1', 10) || 1);
      const perPage = Math.min(
        100,
        Math.max(1, Number.parseInt(request.query.perPage ?? '50', 10) || 50),
      );
      const from = (page - 1) * perPage;

      let query = serviceOf(request)
        .from('admin_audit_log')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + perPage - 1);

      const action = readToken(request.query.action);
      if (action !== null) query = query.eq('action', action);

      const targetType = readToken(request.query.targetType);
      if (targetType !== null) query = query.eq('target_type', targetType);

      // The per-user audit history: every action taken against one account.
      const targetId = readIdentifier(request.query.targetId);
      if (targetId !== null) query = query.eq('target_id', targetId);

      const actor = safeSearchTerm(request.query.actor ?? '');
      if (actor.length > 0) query = query.ilike('actor_email', `%${actor}%`);

      const outcome = request.query.outcome;
      if (outcome === 'requested' || outcome === 'succeeded' || outcome === 'failed') {
        query = query.eq('metadata->>outcome', outcome);
      }

      const since = readTimestamp(request.query.from);
      if (since !== null) query = query.gte('created_at', since);

      const until = readTimestamp(request.query.to);
      if (until !== null) query = query.lte('created_at', until);

      const { data, error, count } = await query;

      if (error) {
        request.log.error({ err: error.message }, 'Admin audit read failed');
        return reply.status(502).send({ error: 'The audit log could not be read.' });
      }

      return reply.send({ entries: data ?? [], page, perPage, total: count ?? 0 });
    });

    /** Every announcement, including drafts and expired ones. */
    app.get('/admin/announcements', async (request, reply) => {
      const { data, error } = await serviceOf(request)
        .from('announcements')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        request.log.error({ err: error.message }, 'Admin announcement list failed');
        return reply.status(502).send({ error: 'Announcements could not be read.' });
      }

      return reply.send({ announcements: data ?? [] });
    });

    /**
     * The current maintenance setting, as stored — including who last changed it.
     *
     * The screen this feeds exists to answer three questions before an
     * administrator touches anything: is it on, when was it last changed, and who
     * changed it. The first two come from the row; the third is `updated_by`,
     * which is a foreign key to `profiles` and would otherwise be a bare UUID.
     * Resolving it here rather than in the client keeps the lookup on this side
     * of the service-role boundary.
     */
    app.get('/admin/maintenance', async (request, reply) => {
      const service = serviceOf(request);
      const { data, error } = await service
        .from('app_settings')
        .select('value, updated_at, updated_by')
        .eq('key', 'maintenance')
        .maybeSingle();

      if (error) {
        request.log.error({ err: error.message }, 'Admin maintenance read failed');
        return reply.status(502).send({ error: 'The maintenance setting could not be read.' });
      }

      const changedBy = typeof data?.updated_by === 'string' ? data.updated_by : null;

      /*
       * `null` here means "no administrator is recorded against this row", which
       * is true of the seeded row and of one whose administrator has since been
       * deleted (`updated_by` is `ON DELETE SET NULL`). It deliberately does not
       * mean "unchanged" — `updatedAt` answers that, and the two are separate
       * facts that the client must not collapse into one.
       *
       * A lookup that fails is logged and reported as unresolved rather than
       * failing the whole read: the state of maintenance matters more than the
       * name attached to it, and refusing to say whether the app is closed
       * because a profile could not be read would be the wrong trade.
       */
      let updatedBy: { id: string; email: string | null } | null = null;
      if (changedBy !== null) {
        const { data: profile, error: profileError } = await service
          .from('profiles')
          .select('id, email')
          .eq('id', changedBy)
          .maybeSingle();

        if (profileError) {
          request.log.warn(
            { err: profileError.message, updatedBy: changedBy },
            'The administrator who last changed maintenance mode could not be resolved',
          );
        }

        updatedBy = { id: changedBy, email: typeof profile?.email === 'string' ? profile.email : null };
      }

      return reply.send({
        maintenance: data?.value ?? null,
        updatedAt: data?.updated_at ?? null,
        updatedBy,
      });
    });

    /* --------------------------------------------------------------- writes */

    /**
     * Suspends or restores an account.
     *
     * ## An administrator cannot suspend themselves
     *
     * Not paternalism — it is the difference between a recoverable mistake and
     * an unrecoverable one. An administrator who suspends their own account
     * loses the ability to undo it through this API, because the middleware
     * refuses a suspended administrator. There would be no way back in through
     * the application at all, and the recovery would be a manual database edit.
     * The same rule blocks suspending the last remaining administrator, which has
     * the same shape of consequence.
     */
    app.post<{ Params: { id: string }; Body: SuspendBody }>(
      '/admin/users/:id/suspend',
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        const actor = actorOf(request);
        const targetId = request.params.id;
        const suspended = request.body?.suspended === true;

        if (targetId === actor.id) {
          return reply.status(400).send({
            error:
              'You cannot suspend your own account. Ask another administrator to do it, so that the change can be undone.',
          });
        }

        if (suspended) {
          const { count, error: countError } = await serviceOf(request)
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'admin')
            .eq('status', 'active');

          if (countError) {
            return reply.status(502).send({ error: 'The administrator count could not be read.' });
          }

          const { data: target } = await serviceOf(request)
            .from('profiles')
            .select('role, status, is_owner')
            .eq('id', targetId)
            .maybeSingle();

          /*
           * The permanent owner is protected by the database itself (a
           * BEFORE UPDATE trigger), but the console should never present this
           * as a generic database failure. Refusing here gives the acting
           * administrator a sentence they can act on, and the trigger remains
           * the barrier if this route is ever changed or bypassed.
           */
          if (target?.is_owner === true) {
            return reply.status(400).send({
              error:
                'This is the permanent owner account. It cannot be suspended, because no administrator can restore it afterwards.',
            });
          }

          if (target?.role === 'admin' && (count ?? 0) <= 1) {
            return reply.status(400).send({
              error:
                'This is the only active administrator. Suspending it would leave nobody able to administer the project.',
            });
          }
        }

        /*
         * Audit before acting, and resolve the record afterwards.
         *
         * If the request row cannot be written this throws, the handler 500s,
         * and no suspension is applied. A consequential change with no record of
         * who made it or why must not be possible — so the record is the first
         * thing written, not the last. A request row cannot say whether the
         * change worked, though, so the outcome is appended either way; see
         * `../audit/trail.ts` for why that is two rows rather than one.
         */
        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: suspended ? 'suspend_account' : 'restore_account',
            targetType: 'profile',
            targetId,
            reason,
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'The change was not applied, because it could not be recorded in the audit log.',
          });
        }

        const { data, error } = await serviceOf(request)
          .from('profiles')
          .update({ status: suspended ? 'suspended' : 'active' })
          .eq('id', targetId)
          .select('id, status')
          .maybeSingle();

        if (error) {
          request.log.error({ err: error.message }, 'Suspend update failed');
          await trail.failed(error.message);
          return reply.status(502).send({
            error: 'The account status could not be changed. It may not exist.',
          });
        }
        if (!data) {
          await trail.failed('No account has that id.');
          return reply.status(404).send({ error: 'No account has that id.' });
        }

        await trail.succeeded();
        return reply.send({ user: data });
      },
    );

    /**
     * Applies one status change to a selected set of accounts.
     *
     * ## Why this is not a loop around the single-account route
     *
     * Three of that route's guarantees are properties of the *selection*, and
     * checking them one target at a time would pass while the batch still broke
     * them:
     *
     *   - The last active administrator. A selection holding the only two
     *     remaining administrators would satisfy a per-target check twice, and
     *     the project would be left with none.
     *   - The acting administrator's own account, which must not appear in a
     *     suspension. Suspending yourself through this API is unrecoverable,
     *     because the middleware refuses a suspended administrator.
     *   - The size of the request. One click must not be able to cause an
     *     unbounded number of writes and audit rows.
     *
     * ## Why a partial result is reported rather than rolled back
     *
     * A batch is not a transaction here. Each row is one REST update, and
     * `profiles` carries a column CHECK that can refuse one account without
     * refusing its neighbours. Aborting halfway would leave a state nobody could
     * reconstruct from the request, and reporting "done" would be a claim the
     * response cannot support. So every account gets its own audit pair and the
     * answer names exactly which ones changed: the screen renders it as "N of M"
     * and never as success.
     *
     * Each account's rows carry `metadata.bulk`, so an investigator reading one
     * account's history can tell a bulk change from a single one. The marker sits
     * on the request row only: `AuditTrail.succeeded()` writes its outcome row
     * from a fixed shape, and the two are paired by `requestId` — which is the
     * pairing the log is designed around, rather than a second place the fact
     * could disagree with itself.
     */
    app.post<{ Body: BulkBody }>('/admin/users/bulk', async (request, reply) => {
      const reason = requireReason(request.body, reply);
      if (reason === null) return reply;

      const actor = actorOf(request);
      const suspended = request.body?.suspended === true;

      const selection = readBulkTargets(request.body?.userIds);
      if (!selection.ok) {
        return reply.status(400).send({ error: selection.message });
      }
      const ids = selection.ids;

      if (suspended && ids.includes(actor.id)) {
        return reply.status(400).send({
          error:
            'A suspension cannot include your own account. Remove it from the selection and ask another administrator, so that the change can be undone.',
        });
      }

      if (suspended) {
        const service = serviceOf(request);

        const { count, error: countError } = await service
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin')
          .eq('status', 'active');

        if (countError) {
          return reply.status(502).send({ error: 'The administrator count could not be read.' });
        }

        const { data: selected, error: selectedError } = await service
          .from('profiles')
          .select('id, role, status, is_owner')
          .in('id', [...ids]);

        if (selectedError) {
          return reply.status(502).send({ error: 'The selected accounts could not be read.' });
        }

        /*
         * A batch must not be the way around the owner rule. The single-account
         * route refuses this with a sentence; a selection that contains the
         * owner is refused before any row is touched, so a partial result can
         * never include "owner suspended" among its successes.
         */
        if ((selected ?? []).some((row) => row.is_owner === true)) {
          return reply.status(400).send({
            error:
              'The selection includes the permanent owner account. Remove it from the selection; it cannot be suspended.',
          });
        }

        const adminsInSelection = (selected ?? []).filter(
          (row) => row.role === 'admin' && row.status === 'active',
        ).length;

        /*
         * `count === null` means the count could not be established, and the
         * comparison below would then read as "every administrator is selected"
         * and refuse a legitimate action. An unknown count is not a reason to
         * block a suspension, so the guard applies only to a known one.
         */
        if (count !== null && count > 0 && adminsInSelection >= count) {
          return reply.status(400).send({
            error:
              adminsInSelection === 1
                ? 'This is the only active administrator. Suspending it would leave nobody able to administer the project.'
                : `The selection contains all ${adminsInSelection} active administrators. Suspending them together would leave nobody able to administer the project.`,
          });
        }
      }

      const results: BulkResult[] = [];

      for (const id of ids) {
        /*
         * Per-account, the same rule as the single route: no record, no change.
         * A target whose request row cannot be written is skipped and reported,
         * rather than being changed without a trace of who did it or why.
         */
        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: suspended ? 'suspend_account' : 'restore_account',
            targetType: 'profile',
            targetId: id,
            reason,
            metadata: { bulk: true },
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          results.push({
            id,
            ok: false,
            error: 'Not attempted: it could not be recorded in the audit log.',
          });
          continue;
        }

        const { data, error } = await serviceOf(request)
          .from('profiles')
          .update({ status: suspended ? 'suspended' : 'active' })
          .eq('id', id)
          .select('id, status')
          .maybeSingle();

        if (error) {
          request.log.error({ err: error.message }, 'Bulk status update failed');
          await trail.failed(error.message);
          results.push({ id, ok: false, error: 'The account status could not be changed.' });
          continue;
        }
        if (!data) {
          await trail.failed('No account has that id.');
          results.push({ id, ok: false, error: 'No account has that id.' });
          continue;
        }

        await trail.succeeded();
        results.push({ id, ok: true, status: data.status });
      }

      const succeeded = results.filter((result) => result.ok).length;

      return reply.send({
        results,
        succeeded,
        failed: results.length - succeeded,
        suspended,
      });
    });

    /**
     * Grants or removes the administrator role.
     *
     * Same self-protection as suspension: an administrator cannot change their
     * own role, and the last administrator cannot be demoted. Both are the same
     * failure mode — a project with no way to administer it.
     */
    app.post<{ Params: { id: string }; Body: RoleBody }>(
      '/admin/users/:id/role',
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        const actor = actorOf(request);
        const targetId = request.params.id;
        const role = request.body?.role;

        if (role !== 'admin' && role !== 'user') {
          return reply.status(400).send({ error: 'A role must be either "admin" or "user".' });
        }

        if (targetId === actor.id) {
          return reply.status(400).send({
            error: 'You cannot change your own role. Ask another administrator to do it.',
          });
        }

        if (role === 'user') {
          const { data: target } = await serviceOf(request)
            .from('profiles')
            .select('is_owner')
            .eq('id', targetId)
            .maybeSingle();

          if (target?.is_owner === true) {
            return reply.status(400).send({
              error:
                'This is the permanent owner account. Its administrator role cannot be removed.',
            });
          }

          const { count, error: countError } = await serviceOf(request)
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'admin')
            .eq('status', 'active');

          if (countError) {
            return reply.status(502).send({ error: 'The administrator count could not be read.' });
          }
          if ((count ?? 0) <= 1) {
            return reply.status(400).send({
              error:
                'This is the only active administrator. Removing the role would leave nobody able to administer the project.',
            });
          }
        }

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: role === 'admin' ? 'grant_admin' : 'revoke_admin',
            targetType: 'profile',
            targetId,
            reason,
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'The change was not applied, because it could not be recorded in the audit log.',
          });
        }

        const { data, error } = await serviceOf(request)
          .from('profiles')
          .update({ role })
          .eq('id', targetId)
          .select('id, role')
          .maybeSingle();

        if (error) {
          request.log.error({ err: error.message }, 'Role update failed');
          await trail.failed(error.message);
          return reply
            .status(502)
            .send({ error: 'The role could not be changed. It may not exist.' });
        }
        if (!data) {
          await trail.failed('No account has that id.');
          return reply.status(404).send({ error: 'No account has that id.' });
        }

        await trail.succeeded();
        return reply.send({ user: data });
      },
    );

    /**
     * Asks the provider to send an account its own password reset email.
     *
     * The response says only that the request was accepted. It does not confirm
     * the address exists, does not reveal whether an email was sent, and returns
     * nothing about the credential — an administrator arranging a reset is not
     * an administrator learning anything about the password, and the two must
     * not be conflated.
     */
    app.post<{ Params: { id: string }; Body: ReasonBody }>(
      '/admin/users/:id/reset-password',
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        const actor = actorOf(request);
        const targetId = request.params.id;

        const { data: target, error: readError } = await serviceOf(request)
          .from('profiles')
          .select('email')
          .eq('id', targetId)
          .maybeSingle();

        if (readError) {
          return reply.status(502).send({ error: 'That account could not be read.' });
        }
        if (!target?.email) {
          return reply.status(404).send({ error: 'No account with an email address has that id.' });
        }

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'request_password_reset',
            targetType: 'profile',
            targetId,
            reason,
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'No reset was requested, because it could not be recorded in the audit log.',
          });
        }

        const client = serviceOf(request);
        const { error: mailError } = await client.auth.resetPasswordForEmail(target.email);

        if (mailError) {
          /*
           * The failure is reported and the record is kept, resolved as failed.
           * The request row alone would say a reset was asked for and leave it
           * ambiguous whether anything happened; appending the outcome makes it
           * say the administrator tried *and* that the provider refused, which is
           * the thing anyone investigating afterwards needs to know. Hidden would
           * be worse than recorded-and-failed.
           */
          request.log.error({ err: mailError.message }, 'Password reset send failed');
          await trail.failed(mailError.message);
          return reply.status(502).send({
            error:
              'The reset email could not be sent. The attempt and its failure have been recorded in the audit log.',
          });
        }

        await trail.succeeded();
        return reply.send({
          // Deliberately not "sent". The provider accepted the request; whether
          // the message arrives is not something this service can observe.
          status: 'requested',
          message: 'The reset email has been requested from the account provider.',
        });
      },
    );

    /* -------------------------------------------------------- announcements */

    app.post<{ Body: AnnouncementBody }>('/admin/announcements', async (request, reply) => {
      const reason = requireReason(request.body, reply);
      if (reason === null) return reply;

      const actor = actorOf(request);
      const title = typeof request.body?.title === 'string' ? request.body.title.trim() : '';
      const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
      const severity =
        request.body?.severity === 'warning' || request.body?.severity === 'critical'
          ? request.body.severity
          : 'info';
      const publish = request.body?.published === true;
      const expiry = readExpiry(request.body?.expiresAt, 'An expiry');

      if (title.length === 0) {
        return reply.status(400).send({ error: 'An announcement needs a title.' });
      }
      if (title.length > MAX_ANNOUNCEMENT_TITLE) {
        return reply.status(400).send({
          error: `An announcement title cannot be longer than ${MAX_ANNOUNCEMENT_TITLE} characters.`,
        });
      }
      if (body.length === 0) {
        return reply.status(400).send({ error: 'An announcement needs a body.' });
      }
      if (body.length > MAX_ANNOUNCEMENT_BODY) {
        return reply
          .status(400)
          .send({ error: `An announcement body cannot be longer than ${MAX_ANNOUNCEMENT_BODY} characters.` });
      }
      if (!expiry.ok) {
        return reply.status(400).send({ error: expiry.message });
      }
      if (publish) {
        const problem = publishingProblem(expiry.value, Date.now());
        if (problem !== null) return reply.status(400).send({ error: problem });
      }

      let trail: AuditTrail;
      try {
        trail = await beginAction(request, {
          action: publish ? 'publish_announcement' : 'draft_announcement',
          targetType: 'announcement',
          targetId: null,
          reason,
          metadata: { title, severity },
        });
      } catch (error) {
        request.log.error({ err: (error as Error).message }, 'Audit write failed');
        return reply.status(500).send({
          error: 'The announcement was not created, because it could not be recorded.',
        });
      }

      const { data, error } = await serviceOf(request)
        .from('announcements')
        .insert({
          title,
          body,
          severity,
          published: publish,
          // The moment it goes live is the moment it was published, recorded by
          // the server rather than supplied by the client.
          published_at: publish ? new Date().toISOString() : null,
          expires_at: expiry.value,
          created_by: actor.id,
        })
        .select('*')
        .maybeSingle();

      if (error) {
        request.log.error({ err: error.message }, 'Announcement insert failed');
        await trail.failed(error.message);
        return reply.status(502).send({ error: 'The announcement could not be created.' });
      }

      /*
       * A published announcement is sent to the registered devices; a draft is
       * not. The dispatch runs after the row exists, because the row is what
       * users read: a message that reached phones while the notice was missing
       * from the table would point at nothing.
       *
       * The report is returned rather than swallowed, so that "published" is
       * never the only thing the administrator is told. Whether any phone was
       * reached is a separate fact and is reported as one.
       */
      const notice = publish ? announcementOf(data) : null;
      const dispatch: PushDispatchReport | null = notice
        ? await dispatchAnnouncement(config, notice, dispatchFor(request))
        : null;

      /*
       * The dispatch result goes into the audit row's detail, because the audit
       * log is the only durable record of this publish that an investigator can
       * read later — the response is gone the moment the screen is closed.
       */
      await trail.succeeded(dispatch ? dispatch.summary : undefined);
      return reply.status(201).send({ announcement: data, dispatch });
    });

    app.post<{ Params: { id: string }; Body: AnnouncementBody }>(
      '/admin/announcements/:id',
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        const actor = actorOf(request);
        const service = serviceOf(request);

        /*
         * The current row is read first.
         *
         * Two things need it. `published_at` should only be stamped when an
         * announcement actually goes live, which is a transition and not a state
         * — without knowing what the row was, "publish an already-published
         * announcement" would silently move its publication date forward. And a
         * request naming an id that does not exist should be answered without
         * writing an audit pair for an action that was never attempted.
         */
        const existing = await service
          .from('announcements')
          .select('id, published, expires_at')
          .eq('id', request.params.id)
          .maybeSingle();

        if (existing.error) {
          request.log.error({ err: existing.error.message }, 'Announcement read failed');
          return reply.status(502).send({ error: 'The announcement could not be read.' });
        }
        if (!existing.data) {
          return reply.status(404).send({ error: 'No announcement has that id.' });
        }

        const current = existing.data as {
          published?: unknown;
          expires_at?: unknown;
        };
        const wasPublished = current.published === true;
        const currentExpiry = typeof current.expires_at === 'string' ? current.expires_at : null;

        const patch: Record<string, unknown> = {};

        if (typeof request.body?.title === 'string') {
          const title = request.body.title.trim();
          // The same rules as creation. The columns carry CHECK constraints that
          // would reject an empty one anyway, but a 502 saying "could not be
          // changed" is not an answer anyone can act on.
          if (title.length === 0) {
            return reply.status(400).send({ error: 'An announcement needs a title.' });
          }
          if (title.length > MAX_ANNOUNCEMENT_TITLE) {
            return reply.status(400).send({
              error: `An announcement title cannot be longer than ${MAX_ANNOUNCEMENT_TITLE} characters.`,
            });
          }
          patch.title = title;
        }

        if (typeof request.body?.body === 'string') {
          const body = request.body.body.trim();
          if (body.length === 0) {
            return reply.status(400).send({ error: 'An announcement needs a body.' });
          }
          if (body.length > MAX_ANNOUNCEMENT_BODY) {
            return reply.status(400).send({
              error: `An announcement body cannot be longer than ${MAX_ANNOUNCEMENT_BODY} characters.`,
            });
          }
          patch.body = body;
        }

        if (request.body?.severity === 'warning' || request.body?.severity === 'critical') {
          patch.severity = request.body.severity;
        }
        if (request.body?.severity === 'info') patch.severity = 'info';

        /*
         * An expiry can be set, moved, or cleared here.
         *
         * `null` clears it, which is a different request from omitting the field
         * — omitting one means "leave it alone", and an announcement that never
         * expires is a state an administrator has to be able to return to.
         */
        let nextExpiry = currentExpiry;
        if (request.body?.expiresAt !== undefined) {
          const expiry = readExpiry(request.body.expiresAt, 'An expiry');
          if (!expiry.ok) return reply.status(400).send({ error: expiry.message });
          patch.expires_at = expiry.value;
          nextExpiry = expiry.value;
        }

        if (typeof request.body?.published === 'boolean') {
          patch.published = request.body.published;
          /*
           * Stamped on the transition into published, not on every request that
           * says `published: true`. Re-publishing something already live is a
           * no-op, and moving its publication date would make the column mean
           * "when it was last touched" — which is what `updated_at` is for.
           */
          if (request.body.published && !wasPublished) {
            patch.published_at = new Date().toISOString();
          }
        }

        if (Object.keys(patch).length === 0) {
          return reply.status(400).send({ error: 'Nothing to change was supplied.' });
        }

        /*
         * The same visibility check creation makes, applied to the state the row
         * would end up in — because an announcement that is live and expiring
         * before now is exactly as invisible whether it got that way by being
         * created or by being edited.
         */
        const willBePublished =
          typeof patch.published === 'boolean' ? patch.published : wasPublished;
        if (willBePublished) {
          const problem = publishingProblem(nextExpiry, Date.now());
          if (problem !== null) return reply.status(400).send({ error: problem });
        }

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'update_announcement',
            targetType: 'announcement',
            targetId: request.params.id,
            reason,
            metadata: { fields: Object.keys(patch) },
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'The announcement was not changed, because it could not be recorded.',
          });
        }

        const { data, error } = await service
          .from('announcements')
          .update(patch)
          .eq('id', request.params.id)
          .select('*')
          .maybeSingle();

        if (error) {
          request.log.error({ err: error.message }, 'Announcement update failed');
          await trail.failed(error.message);
          return reply.status(502).send({ error: 'The announcement could not be changed.' });
        }
        if (!data) {
          await trail.failed('No announcement has that id.');
          return reply.status(404).send({ error: 'No announcement has that id.' });
        }

        /*
         * Only the transition into published dispatches.
         *
         * This is the duplicate guard. Re-publishing something already live, or
         * editing a live notice's wording, changes the row without sending
         * anything — otherwise "fix a typo" would push the notice to every
         * registered device a second time, and the log of a publish would become
         * a log of edits.
         */
        const becameLive = patch.published === true && !wasPublished;
        const notice = becameLive ? announcementOf(data) : null;
        const dispatch: PushDispatchReport | null = notice
          ? await dispatchAnnouncement(config, notice, dispatchFor(request))
          : null;

        await trail.succeeded(dispatch ? dispatch.summary : undefined);
        return reply.send({ announcement: data, dispatch });
      },
    );

    /**
     * Sends a published announcement to the registered devices again.
     *
     * ## Why this is a separate, deliberate action
     *
     * The automatic dispatch happens once, on the transition into published. If
     * it fails — Firebase was down, the credentials were being rotated, the list
     * of devices could not be read — there has to be a way to try again that is
     * not "unpublish and publish", which would move the notice's publication
     * time and make it look, to anyone reading the table, like a new notice.
     *
     * ## Why it is not automatic
     *
     * Nothing retries this on a timer, deliberately. A retry that runs on its own
     * sends a real notification to real people, and a notice that keeps arriving
     * because a background job is unhappy is worse than one that arrived once
     * and was not confirmed. The administrator decides, and a reason is required
     * for the same reason it is required everywhere else: this is an action
     * whose effect is on other people's phones.
     *
     * An *unpublished* announcement is refused. There is nothing to send: no
     * user can see it, and the message would point at a notice the app will not
     * display.
     */
    app.post<{ Params: { id: string }; Body: ReasonBody }>(
      '/admin/announcements/:id/dispatch',
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        const service = serviceOf(request);

        const existing = await service
          .from('announcements')
          .select('*')
          .eq('id', request.params.id)
          .maybeSingle();

        if (existing.error) {
          request.log.error({ err: existing.error.message }, 'Announcement read failed');
          return reply.status(502).send({ error: 'The announcement could not be read.' });
        }
        if (!existing.data) {
          return reply.status(404).send({ error: 'No announcement has that id.' });
        }

        const row = existing.data as Record<string, unknown>;
        if (row.published !== true) {
          return reply.status(400).send({
            error: 'That announcement is a draft, so there is nothing on any phone to send.',
          });
        }

        const notice = announcementOf(row);
        if (notice === null) {
          return reply.status(502).send({
            error: 'That announcement is missing a field a notification needs, so nothing was sent.',
          });
        }

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'dispatch_announcement',
            targetType: 'announcement',
            targetId: request.params.id,
            reason,
            metadata: { title: notice.title },
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'Nothing was sent, because the attempt could not be recorded.',
          });
        }

        const dispatch = await dispatchAnnouncement(config, notice, dispatchFor(request));

        /*
         * An unavailable dispatch is audited as a failed action, not a
         * successful one. The administrator asked for a delivery and the system
         * could not make one; recording that as success would put "succeeded" on
         * something that never left the building.
         */
        if (dispatch.state === 'unavailable') {
          await trail.failed(dispatch.reason ?? dispatch.summary);
        } else {
          await trail.succeeded(dispatch.summary);
        }

        /*
         * 200 rather than 502 even when nothing could be sent. The request was
         * understood and answered; the report says what happened, and the screen
         * renders it. A 502 here would invite a client to retry an action whose
         * outcome is already known and already stated.
         */
        return reply.send({ announcement: row, dispatch });
      },
    );

    /* ------------------------------------------------ overview and health */

    /**
     * The numbers on the overview.
     *
     * ## Why every figure here is a count query and nothing else
     *
     * A dashboard is the easiest place in a system to put a number that is not
     * true: an average of nothing, a total that silently excludes the rows the
     * query failed to fetch, a "growth" line drawn from a sample. So each figure
     * below is a `count: 'exact'` query against a table, with its filter written
     * out, and nothing is derived, estimated or extrapolated. If a count cannot
     * be read the whole endpoint fails rather than returning the figures that did
     * work — a dashboard missing a tile reads as "that is zero", which is a claim
     * about the database made from a failed query.
     *
     * The filters are worth reading, because they are where a dashboard usually
     * goes wrong:
     *
     * - `active` / `suspended` / `admins` partition `profiles`, and `role` and
     *   `status` are both CHECK-constrained in the database, so these are the
     *   only values that can exist. There is no "other" bucket being hidden.
     * - `live` notices are the ones a user can actually see — published, already
     *   live, and not yet expired. That is the same predicate as the RLS policy
     *   that serves them, so the count and the users' experience cannot disagree.
     *   `expired` notices are still `published = true` in the table and are
     *   invisible to every ordinary reader; counting them separately is what
     *   keeps them from being presented as live.
     * - The 24-hour activity counts select on `metadata->>outcome`, so the two
     *   rows written for one action are counted as one outcome rather than
     *   double-counted as two events.
     *
     * No audit row is written: this endpoint reads, and reads are not actions.
     */
    app.get('/admin/overview', async (request, reply) => {
      const service = serviceOf(request);

      const nowIso = new Date().toISOString();
      const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      /*
       * Written out as separate queries rather than a parameterised helper. The
       * filter is the thing being asserted here, so a reader should be able to
       * see it on the line that runs it.
       */
      const [
        profilesTotal,
        profilesActive,
        profilesSuspended,
        profilesAdmins,
        profilesActiveAdmins,
        noticesLive,
        noticesDrafts,
        noticesExpired,
        auditSucceeded,
        auditFailed,
        auditRecent,
      ] = await Promise.all([
        service.from('profiles').select('id', { count: 'exact', head: true }),
        service
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),
        service
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'suspended'),
        service.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin'),
        service
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin')
          .eq('status', 'active'),
        service
          .from('announcements')
          .select('id', { count: 'exact', head: true })
          .eq('published', true)
          .or(`expires_at.is.null,expires_at.gt.${nowIso}`),
        service
          .from('announcements')
          .select('id', { count: 'exact', head: true })
          .eq('published', false),
        service
          .from('announcements')
          .select('id', { count: 'exact', head: true })
          .eq('published', true)
          .not('expires_at', 'is', null)
          .lte('expires_at', nowIso),
        service
          .from('admin_audit_log')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', sinceIso)
          .eq('metadata->>outcome', 'succeeded'),
        service
          .from('admin_audit_log')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', sinceIso)
          .eq('metadata->>outcome', 'failed'),
        service
          .from('admin_audit_log')
          .select('id, actor_email, action, target_type, target_id, reason, metadata, created_at')
          .order('created_at', { ascending: false })
          .limit(5),
      ]);

      /*
       * A missing `error` field is not a failure. Supabase always sends
       * `error: null` on success, so the tempting `result.error !== null` reads
       * `undefined` as an error — and then selects the first result that never
       * reported one, whose own `.error` is undefined, so the guard below would
       * let every failed tile through. Truthiness, as elsewhere in this file,
       * is the check that means what it says.
       */
      const failed = [
        profilesTotal,
        profilesActive,
        profilesSuspended,
        profilesAdmins,
        profilesActiveAdmins,
        noticesLive,
        noticesDrafts,
        noticesExpired,
        auditSucceeded,
        auditFailed,
        auditRecent,
      ].find((result) => result.error);

      if (failed?.error) {
        request.log.error({ err: failed.error.message }, 'Admin overview read failed');
        // The whole tile set fails together, deliberately. See the doc comment.
        return reply.status(502).send({ error: 'The overview could not be read.' });
      }

      return reply.send({
        users: {
          total: profilesTotal.count ?? 0,
          active: profilesActive.count ?? 0,
          suspended: profilesSuspended.count ?? 0,
          admins: profilesAdmins.count ?? 0,
          activeAdmins: profilesActiveAdmins.count ?? 0,
        },
        announcements: {
          live: noticesLive.count ?? 0,
          drafts: noticesDrafts.count ?? 0,
          expired: noticesExpired.count ?? 0,
        },
        audit: {
          /** Completed actions in the last 24 hours. One per action, not per row. */
          succeeded24h: auditSucceeded.count ?? 0,
          failed24h: auditFailed.count ?? 0,
          recent: auditRecent.data ?? [],
        },
        generatedAt: nowIso,
      });
    });

    /**
     * Whether each configured component is actually working.
     *
     * ## What "state" means, and why it is not "OK"
     *
     * Four states, and the boundary between `untested` and `verified` is the
     * whole point of this endpoint:
     *
     * - `unconfigured` — the required configuration is absent.
     * - `untested` — configuration is present, but nothing has been proved. The
     *   component has not done its real job.
     * - `verified` — the component **did its real job** during this check.
     * - `failed` — a check ran and errored.
     *
     * For the database, the real job is answering a service-role query, so a
     * successful read *is* `verified`. For email and push the real job is a
     * message arriving somewhere, and **no HTTP request can establish that**.
     * Loading a service-account key proves a JSON file was parsed; opening an
     * SMTP connection proves a server accepted credentials. Neither proves a
     * person received anything. So both can reach only `untested`, and
     * `deliveryTested` stays false until a message is genuinely delivered and
     * confirmed by the other end — which this endpoint never assumes.
     *
     * That distinction is the reason this is not just a green tick. A console
     * that shows "Notifications: OK" because a key file exists is telling an
     * administrator something they would act on and that is not true.
     *
     * ## Nothing secret crosses this boundary
     *
     * Only booleans, states and human sentences are returned. No key, token,
     * password, connection string, credential path or server address is included
     * — not even in an error, which is why the Firebase credential *path* that
     * `initFirebaseAdmin` reports is dropped rather than forwarded, and why the
     * diagnostic text is the one the dependency produced rather than anything
     * this handler composes from configuration.
     */
    app.get('/admin/health', async (request, reply) => {
      const service = serviceOf(request);

      // The database, probed with the service-role key. A read that requires the
      // role is the real operation this component performs.
      let database: { state: HealthState; detail: string };
      try {
        const { error } = await service
          .from('app_settings')
          .select('key', { count: 'exact', head: true });

        database = error
          ? {
              state: 'failed',
              detail: `The database refused a service-role read: ${error.message}`,
            }
          : {
              state: 'verified',
              detail: 'A service-role read succeeded, so the administration database is reachable.',
            };
      } catch (error) {
        database = {
          state: 'failed',
          detail: `The database could not be reached: ${(error as Error).message}`,
        };
      }

      // Email. `isEmailConfigured` is a configuration fact; the SMTP handshake is
      // a connectivity fact. Neither is a delivery fact.
      const emailConfigured = healthDeps.isEmailConfigured ?? isEmailConfigured;
      const verifySmtp = healthDeps.verifySmtpConnection ?? verifySmtpConnection;

      let email: { state: HealthState; detail: string };
      if (!emailConfigured()) {
        email = {
          state: 'unconfigured',
          detail:
            'SMTP is not configured, so no email can be sent. Password-reset requests will be recorded as requested and no message will arrive.',
        };
      } else {
        const connection = await verifySmtp();
        email = connection.connected
          ? {
              state: 'untested',
              detail:
                'SMTP is configured and the server accepted a connection and the credentials. No message has been sent from here, so delivery to a person is unproven.',
            }
          : {
              state: 'failed',
              detail: `SMTP is configured but the server refused the connection: ${connection.error ?? 'no reason given'}`,
            };
      }

      /*
       * Firebase. The injected probe reports whether the credentials load and
       * which project they name. Its `credentialsPath` is deliberately **not**
       * returned: it is a server filesystem path, and the console has no use for
       * it that justifies disclosing the layout of this machine.
       *
       * Neither is its `error` returned, for the same reason and less obviously.
       * The initialisation error reads "Service account key file not found at:
       * <path>", so forwarding the field would disclose the very path the field
       * beside it withholds — the same fact by a different route, and one a test
       * asserting only on `credentialsPath` would not catch. The error is
       * classified into a sentence instead.
       */
      const readFirebase = healthDeps.firebaseStatus ?? initFirebaseAdmin;
      const firebase = readFirebase(config);
      const push: { state: HealthState; detail: string } = firebase.initialized
        ? {
            state: 'untested',
            detail:
              'Firebase credentials loaded and the messaging client was created. Nothing has been sent, so delivery to a device is unproven.',
          }
        : {
            state: 'unconfigured',
            detail: pushUnavailableReason(firebase),
          };

      const checks: readonly HealthCheck[] = [
        {
          key: 'api',
          label: 'Backend API',
          // This handler is running, which is the only thing it claims.
          state: 'verified',
          detail: 'This service answered this request.',
          delivers: false,
          deliveryTested: false,
        },
        {
          key: 'database',
          label: 'Administration database',
          state: database.state,
          detail: database.detail,
          delivers: false,
          deliveryTested: false,
        },
        {
          key: 'email',
          label: 'Email',
          state: email.state,
          detail: email.detail,
          delivers: true,
          // Never inferred from a configuration check. See the doc comment.
          deliveryTested: false,
        },
        {
          key: 'push',
          label: 'Push notifications',
          state: push.state,
          detail: push.detail,
          delivers: true,
          deliveryTested: false,
        },
      ];

      return reply.send({ checks, checkedAt: new Date().toISOString() });
    });

    /* ----------------------------------------------------- maintenance mode */

    /**
     * Turns maintenance mode on or off.
     *
     * The audit row is written first, and the reason is mandatory, because
     * closing the app to every user is the single most disruptive thing this
     * API can do and "why" is the first question anyone will ask afterwards.
     *
     * The setting is stored in `app_settings`, which every client can read,
     * including signed-out ones. That is the design: maintenance mode has to
     * block sign-in, and a check that runs after authentication cannot.
     */
    app.post<{ Body: MaintenanceBody }>('/admin/maintenance', async (request, reply) => {
      const reason = requireReason(request.body, reply);
      if (reason === null) return reply;

      const actor = actorOf(request);
      const enabled = request.body?.enabled === true;
      const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';

      if (enabled && message.length === 0) {
        return reply.status(400).send({
          error:
            'A message is required when turning maintenance mode on. Users locked out with no explanation will assume the app is broken.',
        });
      }

      let trail: AuditTrail;
      try {
        trail = await beginAction(request, {
          action: enabled ? 'enable_maintenance' : 'disable_maintenance',
          targetType: 'setting',
          targetId: 'maintenance',
          reason,
        });
      } catch (error) {
        request.log.error({ err: (error as Error).message }, 'Audit write failed');
        return reply.status(500).send({
          error: 'Maintenance mode was not changed, because it could not be recorded.',
        });
      }

      const now = new Date().toISOString();
      const value = {
        enabled,
        message: enabled ? message : '',
        // `enabledAt` is stamped by the server, never supplied by the client, so
        // the record of how long the app was closed does not depend on a
        // client's clock.
        enabledAt: enabled ? now : null,
        expectedEndAt:
          typeof request.body?.expectedEndAt === 'string' ? request.body.expectedEndAt : null,
      };

      const { data, error } = await serviceOf(request)
        .from('app_settings')
        .update({ value, updated_by: actor.id })
        .eq('key', 'maintenance')
        .select('value, updated_at')
        .maybeSingle();

      if (error) {
        request.log.error({ err: error.message }, 'Maintenance update failed');
        await trail.failed(error.message);
        return reply.status(502).send({ error: 'Maintenance mode could not be changed.' });
      }

      await trail.succeeded();
      return reply.send({ maintenance: data?.value ?? value, updatedAt: data?.updated_at ?? now });
    });
  };
}
