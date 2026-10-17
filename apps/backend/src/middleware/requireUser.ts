/**
 * Authentication for ordinary account routes.
 *
 * This is deliberately separate from `requireAdmin` rather than a relaxed
 * version of it. The admin guard answers "is this person an active
 * administrator"; this one answers "is this a signed-in, active person". They
 * share the same provider validation and the same per-request database read,
 * but a route that needs the second question should not be able to acquire the
 * first answer by accident.
 *
 * ## What is never trusted from the client
 *
 * The bearer token is the only identity input. No body field, query parameter
 * or header may name the account being acted on. Every handler derives
 * `request.authUser.id` from the token the Auth server validated, and the
 * deletion route in particular never accepts a target id at all.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config.js';

export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
  /** Whether the provider has verified the address. Null when it does not say. */
  readonly emailConfirmedAt: string | null;
}

export interface UserAuthDeps {
  verifyToken?: (token: string) => Promise<AuthUser | null>;
  readProfile?: (userId: string) => Promise<{ status: string } | null>;
  /** Injected only by tests; production builds the client from configuration. */
  serviceClient?: SupabaseClient;
}

export interface UserApiAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

export function userApiAvailability(config: AppConfig): UserApiAvailability {
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length === 0) return { available: true, reason: null };
  return {
    available: false,
    // Names only. A service-role key must never appear in a response or a log.
    reason: `The account API needs ${missing.join(', ')} to be configured. It is disabled until then.`,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUser`; the authenticated caller. */
    authUser?: AuthUser;
    /** The service-role client for this request. */
    authService?: SupabaseClient;
  }
}

const BEARER_PREFIX = 'Bearer ';

function readBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function createRequireUser(config: AppConfig, deps: UserAuthDeps = {}) {
  const availability = userApiAvailability(config);

  const authClient =
    availability.available && config.supabaseUrl && config.supabaseAnonKey
      ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  const serviceClient =
    deps.serviceClient ??
    (availability.available && config.supabaseUrl && config.supabaseServiceRoleKey
      ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null);

  const usable = availability.available || deps.serviceClient !== undefined;

  const verifyToken =
    deps.verifyToken ??
    (async (token: string): Promise<AuthUser | null> => {
      if (!authClient) return null;
      const { data, error } = await authClient.auth.getUser(token);
      if (error || !data.user) return null;
      return {
        id: data.user.id,
        email: data.user.email ?? null,
        emailConfirmedAt: data.user.email_confirmed_at ?? null,
      };
    });

  const readProfile =
    deps.readProfile ??
    (async (userId: string) => {
      if (!serviceClient) return null;
      const { data, error } = await serviceClient
        .from('profiles')
        .select('status')
        .eq('id', userId)
        .maybeSingle();
      if (error || !data) return null;
      return { status: String(data.status ?? '') };
    });

  return async function requireUser(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!usable || !serviceClient) {
      reply.status(503).send({ error: availability.reason });
      return;
    }

    const token = readBearer(request.headers.authorization);
    if (token === null) {
      reply.status(401).send({ error: 'Sign in to use this endpoint.' });
      return;
    }

    const user = await verifyToken(token);
    if (user === null) {
      reply.status(401).send({ error: 'That session is not valid or has expired.' });
      return;
    }

    const profile = await readProfile(user.id);
    if (profile === null) {
      // A valid token with no profile means the signup trigger did not complete.
      // Treating it as authenticated would let the account API act on a row that
      // does not exist; refusing keeps the invariant that every route has one.
      reply.status(403).send({ error: 'This account has no profile yet.' });
      return;
    }

    if (profile.status !== 'active') {
      // The same rule the admin middleware applies: a suspension is a real
      // restriction, not a label. A suspended account may still sign in to see
      // the notice, but it may not use account APIs.
      reply.status(403).send({ error: 'This account is suspended.' });
      return;
    }

    request.authUser = user;
    request.authService = serviceClient;
  };
}
