/**
 * Administrator authentication for privileged routes.
 *
 * ## Why this is not the existing shared-secret hook
 *
 * `createAuthHook` checks a bearer token against `API_INTERNAL_SECRET`. That is
 * the right shape for a machine-to-machine dispatch call, and the wrong shape
 * for an administrative API: it authenticates *an application*, so it cannot
 * answer "which administrator did this", and every administrative action in this
 * project has to be attributable to a person for the audit log to mean anything.
 *
 * This middleware authenticates a **person**:
 *
 *   1. The request carries a Supabase access token in `Authorization: Bearer`.
 *   2. The token is validated by the Supabase Auth server, through
 *      `auth.getUser(token)`. Validating server-side rather than decoding the
 *      JWT locally means the check follows the project's actual signing key,
 *      including the asymmetric keys newer projects use — a local HS256 check
 *      against a shared secret silently stops working the day the project
 *      rotates to ES256, and it stops working by rejecting everyone, which
 *      looks like an outage rather than a bug.
 *   3. The user id from that validated token is looked up in `profiles` with the
 *      service-role key, and the row must say `role = 'admin'` and
 *      `status = 'active'`.
 *
 * ## What is never trusted from the client
 *
 * No header, body field or query parameter may name the acting administrator.
 * The actor is always the authenticated token's subject. A route that accepted
 * an `actorId` would let any administrator attribute their actions to someone
 * else, which defeats the audit log it exists to write.
 *
 * ## Why step 3 re-reads the database instead of trusting a JWT claim
 *
 * Even if the token carries a `role: admin` claim — and Supabase's custom
 * claims can — a claim is a snapshot from when the token was issued. An account
 * demoted or suspended five minutes ago still holds a token asserting the old
 * role, and a suspension that does not take effect until the token expires is
 * not a suspension. The role is read from the row, every request.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config.js';

/** The authenticated caller, attached to the request for downstream handlers. */
export interface AdminActor {
  readonly id: string;
  readonly email: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAdmin`. Present on every route behind it. */
    adminActor?: AdminActor;
    /** The service-role client, so handlers do not each build one. */
    adminService?: SupabaseClient;
  }
}

export interface AdminAuthDeps {
  /** Verifies a token and returns the user, or null. Injected so tests can stub it. */
  verifyToken?: (token: string) => Promise<{ id: string } | null>;
  /** Reads the role and status for a user id. Injected so tests can stub it. */
  readRole?: (userId: string) => Promise<{ role: string; status: string } | null>;
}

const BEARER_PREFIX = 'Bearer ';

function readBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  if (!header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Whether the admin API can run at all.
 *
 * Three environment values are required and there is no degraded mode: an admin
 * API that cannot verify who is calling it must refuse every request rather
 * than fall back to something weaker. The route registration checks this and
 * says so in its response, so a misconfigured deployment reports a configuration
 * problem instead of a permissions problem.
 */
export interface AdminApiAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

export function adminApiAvailability(config: AppConfig): AdminApiAvailability {
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');

  if (missing.length === 0) return { available: true, reason: null };

  return {
    available: false,
    /*
     * The names of the variables, never their values. A service-role key is the
     * most dangerous secret in this system — it bypasses every row-level policy
     * — and it must not be echoed into a log, an error message or a response.
     */
    reason: `The administration API needs ${missing.join(', ')} to be configured. It is disabled until then.`,
  };
}

/**
 * Builds the `preHandler` that protects the admin routes.
 *
 * Returns a hook that always either sets `request.adminActor` or sends a
 * response. Handlers behind it may assume the actor exists.
 */
export function createRequireAdmin(config: AppConfig, deps: AdminAuthDeps = {}) {
  const availability = adminApiAvailability(config);

  /*
   * Two clients with different jobs.
   *
   * `authClient` uses the anon key and is only ever used to *validate* tokens —
   * it must not be able to read data, so that a bug in this file cannot use it
   * to. `serviceClient` holds the service-role key and therefore bypasses every
   * policy; it is created once and used only after the caller has been
   * authorized. Keeping the keys on separate clients is what makes "which
   * client did this read go through" answerable by looking at the variable name.
   */
  const authClient =
    availability.available && config.supabaseUrl && config.supabaseAnonKey
      ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  const serviceClient =
    availability.available && config.supabaseUrl && config.supabaseServiceRoleKey
      ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  const verifyToken =
    deps.verifyToken ??
    (async (token: string) => {
      if (!authClient) return null;
      const { data, error } = await authClient.auth.getUser(token);
      if (error || !data.user) return null;
      return { id: data.user.id };
    });

  const readRole =
    deps.readRole ??
    (async (userId: string) => {
      if (!serviceClient) return null;
      const { data, error } = await serviceClient
        .from('profiles')
        .select('role, status')
        .eq('id', userId)
        .maybeSingle();
      if (error || !data) return null;
      return { role: String(data.role ?? ''), status: String(data.status ?? '') };
    });

  return async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!availability.available || !serviceClient) {
      reply.status(503).send({ error: availability.reason });
      return;
    }

    const token = readBearer(request.headers.authorization);
    if (token === null) {
      reply.status(401).send({ error: 'A bearer access token is required.' });
      return;
    }

    const user = await verifyToken(token);
    if (user === null) {
      reply.status(401).send({ error: 'That access token is not valid or has expired.' });
      return;
    }

    const profile = await readRole(user.id);

    /*
     * A missing profile row and an ordinary user give the same answer, and the
     * message does not distinguish them. Telling a caller "you exist but you are
     * not an administrator" confirms the account's existence to anyone holding a
     * valid token for it, which is information they already have — so this is
     * about not leaking it to a caller whose token was for a *different* account
     * with no row at all.
     */
    if (profile === null || profile.role !== 'admin') {
      request.log.warn(
        { userId: user.id, route: request.url },
        'Administration API access denied: caller is not an active administrator',
      );
      reply.status(403).send({ error: 'This account does not have administrator access.' });
      return;
    }

    if (profile.status !== 'active') {
      request.log.warn({ userId: user.id }, 'Administration API access denied: suspended');
      reply.status(403).send({ error: 'This account is suspended.' });
      return;
    }

    request.adminActor = { id: user.id, email: null };
    request.adminService = serviceClient;
  };
}

/**
 * Writes an audit row.
 *
 * Every consequential administrative action calls this. It is deliberately not
 * optional and deliberately not fire-and-forget: if the audit write fails, the
 * action it describes must not be reported as having succeeded, because the
 * whole point of the log is that it is complete.
 *
 * Throws on failure so the caller's error path runs.
 */
export async function writeAudit(
  service: SupabaseClient,
  actor: AdminActor,
  entry: {
    action: string;
    targetType: string;
    targetId?: string | null;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await service.from('admin_audit_log').insert({
    actor_id: actor.id,
    actor_email: actor.email,
    action: entry.action,
    target_type: entry.targetType,
    target_id: entry.targetId ?? null,
    reason: entry.reason,
    metadata: entry.metadata ?? {},
  });

  if (error) {
    throw new Error(`The audit record could not be written: ${error.message}`);
  }
}
