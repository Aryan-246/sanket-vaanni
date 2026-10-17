/**
 * Maintenance mode, enforced on the server.
 *
 * ## Why this exists at all
 *
 * The setting was already stored, readable and administrable — and enforced
 * nowhere. Every client that respected it did so by hiding its own controls,
 * which is not a gate: it is a display choice. Anything holding a token, or the
 * internal secret, or simply a script, could reach every endpoint while the app
 * was supposedly closed. A maintenance mode that only exists in the UI is a
 * maintenance mode that is not on.
 *
 * ## What can and cannot be gated from here
 *
 * This service is not the only door into the system. The mobile app talks to
 * Supabase directly for its own data, and sign-in happens against **hosted
 * Supabase Auth** — `POST /auth/v1/token` on the project's own domain. A Fastify
 * hook cannot see those requests, and there is no supported way to make Fastify
 * intercept them. So this gate covers the endpoints this service owns
 * (transactional email and push dispatch) and nothing else.
 *
 * That limit is stated rather than papered over. Blocking sign-in during
 * maintenance is done on the client, against the same `app_settings` row, which
 * every client can read including signed-out ones — that is why the row is
 * world-readable while the table is not. The remaining gap is a caller who
 * bypasses the app entirely and talks to hosted Auth directly; the honest
 * description of that is "not gated", and inventing a second authentication
 * system to close it would break more than it fixes.
 *
 * ## Unreadable is not the same as closed
 *
 * If the setting cannot be read, this allows the request and logs loudly. The
 * alternative — answering 503 because the state of maintenance could not be
 * determined — would report an outage that has not been declared, which is
 * inventing operational status. During a real maintenance window a transient
 * read failure therefore lets a request through; that is the failure this
 * chooses, deliberately, because the opposite one is a self-inflicted outage
 * that also lies about why. The mobile client takes the same position, with an
 * explicit "unreadable" state rather than a guess.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config.js';

export interface MaintenanceSetting {
  readonly enabled: boolean;
  readonly message: string;
}

/** Returns the current setting, or null when it cannot be determined. */
export type MaintenanceReader = () => Promise<MaintenanceSetting | null>;

/**
 * The paths that keep working while the app is closed.
 *
 * Admin recovery comes first in importance: if maintenance mode could block the
 * administration API, turning it off would be impossible except by editing the
 * database by hand, which is exactly the situation the mode must not create.
 * The status endpoints stay open so that whoever is debugging a closed app can
 * ask whether the service is up without being answered by the maintenance
 * refusal itself.
 */
const EXEMPT_PATHS = new Set([
  '/',
  '/health',
  '/email/status',
  '/notifications/status',
]);

function isExempt(path: string): boolean {
  if (EXEMPT_PATHS.has(path)) return true;
  // Admin recovery, and nothing else, by subtree.
  return path === '/admin' || path.startsWith('/admin/');
}

/** The path, without the query string or a trailing slash. */
function pathOf(url: string): string {
  const withoutQuery = url.split('?')[0] ?? '/';
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) return withoutQuery.slice(0, -1);
  return withoutQuery;
}

/**
 * Turns the stored JSON into a setting, or null when it is not one.
 *
 * Split out from the reader and exported because it is the half that is easy to
 * get wrong and impossible to exercise through an injected reader: a test that
 * hands the gate `{enabled: false}` is stating a fact about its own object, not
 * about how a stored row becomes that object.
 */
export function parseMaintenanceRow(value: unknown): MaintenanceSetting | null {
  if (!value || typeof value !== 'object') return null;

  const row = value as Record<string, unknown>;

  /*
   * `enabled === true`, never a truthy coercion. A stored string "false" is
   * truthy in JavaScript, and reading it as "the app is closed" would take the
   * whole service down over a malformed row.
   */
  return {
    enabled: row.enabled === true,
    message: typeof row.message === 'string' ? row.message : '',
  };
}

/**
 * Reads the setting with the service-role key.
 *
 * The service key is used because this read must not depend on the caller's
 * session: maintenance has to be enforceable for a request that has not been
 * authenticated, or the request would be admitted before the check could run.
 */
export function createMaintenanceReader(config: AppConfig): MaintenanceReader {
  const client =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  return async () => {
    if (!client) return null;
    const { data, error } = await client
      .from('app_settings')
      .select('value')
      .eq('key', 'maintenance')
      .maybeSingle();

    if (error || !data) return null;

    return parseMaintenanceRow(data.value);
  };
}

export function createMaintenanceGate(read: MaintenanceReader) {
  return async function maintenanceGate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const path = pathOf(request.url);
    if (isExempt(path)) return;

    let setting: MaintenanceSetting | null;
    try {
      setting = await read();
    } catch (error) {
      request.log.error(
        { err: (error as Error).message, path },
        'Maintenance setting could not be read; allowing the request rather than reporting an undeclared outage',
      );
      return;
    }

    if (setting === null) {
      request.log.warn(
        { path },
        'Maintenance setting is unavailable; allowing the request because the app cannot be shown to be closed',
      );
      return;
    }

    if (!setting.enabled) return;

    reply.status(503).send({
      // The administrator's own words, so a client can show why without
      // inventing a reason of its own.
      error: setting.message.length > 0 ? setting.message : 'Sanket Vaanni is briefly unavailable.',
      maintenance: true,
    });
  };
}
