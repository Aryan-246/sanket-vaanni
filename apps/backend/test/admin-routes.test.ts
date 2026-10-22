/**
 * The administration API, exercised as HTTP routes.
 *
 * ## Why these are route tests and not unit tests
 *
 * The properties worth protecting in this file are not functions' return values.
 * They are:
 *
 *   * **who gets in** — the authorization matrix, including the case where a
 *     profile row is missing entirely;
 *   * **what reaches the database** — that a filter value is validated before it
 *     becomes part of a query, and that a malformed one widens the result rather
 *     than narrowing it to nothing;
 *   * **what is refused** — the self-protection rules, which are the difference
 *     between a mistake and an unrecoverable one.
 *
 * None of those is observable by calling a function directly. They only exist at
 * the boundary, so they are tested at the boundary.
 *
 * ## The database is a queue, not a mock with expectations
 *
 * `fakeDatabase` hands back prepared replies in the order the handler asks for
 * them, and records every method and argument on the way. A test therefore states
 * what the database would answer and then reads back what was asked — which is
 * the direction that catches a filter which was silently dropped, something a
 * mock pre-programmed with expected calls cannot do.
 *
 * The service-role client is injected, so no credentials exist anywhere in this
 * file. See `AdminAuthDeps.serviceClient`.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminRoutes, type AdminHealthDeps } from '../src/routes/admin.js';
import type { DispatchDeps } from '../src/announcements/dispatch.js';
import type { AppConfig } from '../src/config.js';

/* -------------------------------------------------------------- the fake db */

/** One answer the fake database will give, in the order the handler asks. */
interface Reply {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

/**
 * A query builder that records and answers.
 *
 * Every method returns the builder itself, because that is what PostgREST's
 * client does, and the builder is thenable so `await` anywhere in a chain
 * consumes one prepared reply.
 */
class FakeBuilder implements PromiseLike<Reply> {
  readonly recorded: { method: string; args: unknown[] }[] = [];

  constructor(
    readonly table: string,
    private readonly queue: Reply[],
  ) {}

  private step(method: string) {
    return (...args: unknown[]): FakeBuilder => {
      this.recorded.push({ method, args });
      return this;
    };
  }

  select = this.step('select');
  insert = this.step('insert');
  update = this.step('update');
  eq = this.step('eq');
  in = this.step('in');
  or = this.step('or');
  ilike = this.step('ilike');
  gte = this.step('gte');
  lte = this.step('lte');
  not = this.step('not');
  limit = this.step('limit');
  order = this.step('order');
  range = this.step('range');
  maybeSingle = this.step('maybeSingle');

  then<TResult1 = Reply, TResult2 = never>(
    onfulfilled?: ((value: Reply) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    /*
     * An exhausted queue answers an empty success rather than throwing. A test
     * that queues too few replies should fail on its assertions — which name the
     * behaviour — rather than on a stack trace from the harness.
     */
    const next: Reply = this.queue.shift() ?? { data: null, error: null, count: 0 };
    return Promise.resolve(next).then(onfulfilled, onrejected);
  }
}

function fakeDatabase(replies: Reply[]) {
  const queue = [...replies];
  const builders: FakeBuilder[] = [];

  const client = {
    from: (table: string) => {
      const builder = new FakeBuilder(table, queue);
      builders.push(builder);
      return builder;
    },
  } as unknown as SupabaseClient;

  const calls = (): Call[] =>
    builders.flatMap((builder) => builder.recorded.map((r) => ({ table: builder.table, ...r })));

  const methodCalls = (method: string): Call[] => calls().filter((call) => call.method === method);

  return {
    client,
    calls,
    methodCalls,
    /** The first argument of the last call to `method`, as text. */
    lastArg: (method: string): string => {
      const found = methodCalls(method);
      const call = found[found.length - 1];
      if (!call) return '';
      return typeof call.args[0] === 'string' ? call.args[0] : JSON.stringify(call.args[0]);
    },
    /** Every row inserted into a table, in order. */
    inserts: (table: string): Record<string, unknown>[] =>
      calls()
        .filter((call) => call.table === table && call.method === 'insert')
        .map((call) => (call.args[0] ?? {}) as Record<string, unknown>),
  };
}

/* ------------------------------------------------------------------ the app */

const TEST_CONFIG: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  // A complete and useless SMTP block: `AppConfig` requires it, and `buildApp`
  // skips mail initialisation under `nodeEnv: 'test'`. Nothing here connects.
  smtp: { host: 'smtp.invalid', port: 465, secure: true, from: 'test@invalid' },
  emailProvider: 'smtp',
  brevoEndpoint: 'https://api.brevo.com/v3',
};

const ADMIN = { id: 'admin-1', email: 'admin@example.test' };
const GOOD_TOKEN = 'admin-token';

interface BuildOptions {
  replies?: Reply[];
  /** The authenticated subject, or null for a token that verifies to nobody. */
  actor?: { id: string; email?: string | null } | null;
  /** The `profiles` row the middleware reads back. Null means no row exists. */
  role?: string | null;
  status?: string;
  /** False builds the app the way production does: with no injected anything. */
  configured?: boolean;
  /** Capability probes for `GET /admin/health`, so its states are reachable. */
  health?: AdminHealthDeps;
  /**
   * The push transport, injected.
   *
   * A test cannot own a Firebase project or a device, so the interesting
   * behaviour of a dispatch — that it runs on publish and not on an edit, what
   * is recorded, what an administrator is told when it cannot run — is only
   * reachable if the transport is a seam. Left uninjected, the real client is
   * used and finds no service account, which is itself one of the states under
   * test.
   */
  dispatch?: DispatchDeps;
}

function build(options: BuildOptions = {}) {
  const db = fakeDatabase(options.replies ?? []);
  const actor = options.actor === undefined ? ADMIN : options.actor;

  const app = Fastify({ logger: false });

  const deps =
    options.configured === false
      ? undefined
      : {
          verifyToken: async (token: string) =>
            token === GOOD_TOKEN && actor !== null
              ? { id: actor.id, email: actor.email ?? null }
              : null,
          readRole: async () =>
            options.role === null ? null : { role: options.role ?? 'admin', status: options.status ?? 'active' },
          serviceClient: db.client,
        };

  app.register(createAdminRoutes(TEST_CONFIG, deps, options.health ?? {}, options.dispatch ?? {}));

  return { app, db };
}

/**
 * A request carrying the signed-in administrator's token.
 *
 * The return type is written out rather than inferred because `inject` takes a
 * union, and an inferred `payload?: {} | null | undefined` does not narrow into
 * it. `payload` is left off entirely rather than set to `undefined` so a GET
 * carries no body at all.
 */
function authorized(
  url: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: Record<string, unknown>,
): { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; payload?: Record<string, unknown> } {
  const base = { method, url, headers: { authorization: `Bearer ${GOOD_TOKEN}` } };
  return payload === undefined ? base : { ...base, payload };
}

async function ready(app: FastifyInstance): Promise<void> {
  await app.ready();
}

/* -------------------------------------------------------- authorization matrix */

describe('who may call the administration API', () => {
  it('refuses a request with no bearer token', async () => {
    const { app } = build();
    await ready(app);

    const response = await app.inject({ method: 'GET', url: '/admin/users' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatch(/token is required/i);

    await app.close();
  });

  it('refuses a token the auth server does not recognise', async () => {
    const { app } = build();
    await ready(app);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: 'Bearer a-token-nobody-issued' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatch(/not valid or has expired/i);

    await app.close();
  });

  it('refuses an ordinary signed-in user', async () => {
    const { app, db } = build({ role: 'user' });
    await ready(app);

    const response = await app.inject(authorized('/admin/users'));

    expect(response.statusCode).toBe(403);
    // Nothing was read: the refusal happens before any query is issued.
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('gives an account with no profile row the same answer as an ordinary user', async () => {
    /*
     * The same status *and* the same words. Distinguishing "you exist but are
     * not an administrator" from "no such account" would confirm the existence
     * of an account to whoever holds a token for it.
     */
    const { app } = build({ role: null });
    await ready(app);

    const noRow = await app.inject(authorized('/admin/users'));
    const ordinary = await app.inject(authorized('/admin/users'));

    expect(noRow.statusCode).toBe(403);
    expect(noRow.json().error).toBe(ordinary.json().error);

    await app.close();
  });

  it('refuses an administrator whose account is suspended', async () => {
    const { app } = build({ status: 'suspended' });
    await ready(app);

    const response = await app.inject(authorized('/admin/users'));

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/suspended/i);

    await app.close();
  });

  it('allows an active administrator, and attaches the verified actor', async () => {
    const { app, db } = build({
      replies: [{ data: [{ id: 'user-1' }], error: null, count: 1 }],
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/users'));

    expect(response.statusCode).toBe(200);
    expect(db.calls().some((call) => call.table === 'profiles')).toBe(true);

    await app.close();
  });

  it('answers 503, naming the missing variables and no values, when unconfigured', async () => {
    const { app } = build({ configured: false });
    await ready(app);

    const response = await app.inject(authorized('/admin/users'));
    const body = response.json();

    expect(response.statusCode).toBe(503);
    expect(body.error).toMatch(/SUPABASE_URL/);
    expect(body.error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    // A key must never appear in an error message, and none can: the error is
    // built from a list of variable names.
    expect(body.error).not.toMatch(/eyJ/);

    await app.close();
  });
});

/* ------------------------------------------------------- what reaches the db */

describe('the search term', () => {
  it('cannot add a condition of its own to the filter expression', async () => {
    /*
     * The term is interpolated into `email.ilike.%<q>%,display_name.ilike.%<q>%`,
     * so a comma in it would start a third condition and a parenthesis would end
     * the group. The severity is low — the caller is already an administrator —
     * but the shape of the bug is the one that matters elsewhere, so it is
     * closed here.
     */
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    await app.inject(authorized('/admin/users?q=x,role.eq.admin'));

    const expression = db.lastArg('or');
    /*
     * Exactly two conditions, separated by exactly one comma. An injected comma
     * would make three, which is what this counts.
     */
    expect(expression.split(',')).toHaveLength(2);
    expect(expression).toContain('email.ilike.');
    expect(expression).toContain('display_name.ilike.');
    expect(expression).not.toContain('role.eq.admin,');

    await app.close();
  });

  it('cannot close the filter group', async () => {
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    await app.inject(authorized('/admin/users?q=a) or (role.eq.admin'));

    const expression = db.lastArg('or');
    expect(expression).not.toContain('(');
    expect(expression).not.toContain(')');

    await app.close();
  });

  it('is capped, so a pasted document cannot become a query', async () => {
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    await app.inject(authorized(`/admin/users?q=${'a'.repeat(500)}`));

    const expression = db.lastArg('or');
    // Two conditions each carrying at most the cap, plus the literal around them.
    expect(expression.length).toBeLessThan(300);

    await app.close();
  });

  it('is not sent at all when it is blank', async () => {
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    await app.inject(authorized('/admin/users?q=%20%20'));

    expect(db.methodCalls('or')).toHaveLength(0);

    await app.close();
  });

  it('only filters by status for a status the schema allows', async () => {
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    await app.inject(authorized('/admin/users?status=deleted'));

    const statusFilters = db.methodCalls('eq').filter((call) => call.args[0] === 'status');
    expect(statusFilters).toHaveLength(0);

    await app.close();
  });
});

describe('the audit filters', () => {
  it('passes each recognised filter through, with the value validated', async () => {
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    await app.inject(
      authorized(
        '/admin/audit?action=suspend_account&outcome=failed&actor=admin%40example.test' +
          '&targetType=profile&targetId=user-9&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z',
      ),
    );

    expect(db.lastArg('eq')).toBeTruthy();
    const eqArgs = db.methodCalls('eq').map((call) => call.args);
    expect(eqArgs).toContainEqual(['action', 'suspend_account']);
    expect(eqArgs).toContainEqual(['target_type', 'profile']);
    expect(eqArgs).toContainEqual(['target_id', 'user-9']);
    expect(eqArgs).toContainEqual(['metadata->>outcome', 'failed']);
    expect(db.methodCalls('ilike').map((call) => call.args)).toContainEqual([
      'actor_email',
      '%admin@example.test%',
    ]);
    expect(db.methodCalls('gte')).toHaveLength(1);
    expect(db.methodCalls('lte')).toHaveLength(1);

    await app.close();
  });

  it('ignores an outcome that is not one this service writes', async () => {
    /*
     * Dropped rather than rejected, and that is the deliberate choice: this
     * value becomes a *JSON path* filter, and a caller-supplied path is a query
     * shaped by the caller. An unrecognised one widens the result back to the
     * whole log, which is what an administrator with a typo should see.
     */
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    await app.inject(authorized('/admin/audit?outcome=something-else'));

    const jsonFilters = db
      .methodCalls('eq')
      .filter((call) => String(call.args[0]).includes('metadata'));
    expect(jsonFilters).toHaveLength(0);

    await app.close();
  });

  it('ignores an action name that is not shaped like one', async () => {
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    await app.inject(authorized('/admin/audit?action=suspend_account%20or%20true'));

    const actionFilters = db.methodCalls('eq').filter((call) => call.args[0] === 'action');
    expect(actionFilters).toHaveLength(0);

    await app.close();
  });

  it('ignores a timestamp it cannot parse, rather than returning an empty page', async () => {
    /*
     * An administrator who mistypes a date should see the log, not a screen
     * implying the log is empty. A date filter that is not understood is
     * therefore dropped — the wider answer, not the narrower one.
     */
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    const response = await app.inject(authorized('/admin/audit?from=last-tuesday'));

    expect(db.methodCalls('gte')).toHaveLength(0);
    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it('normalises an accepted timestamp to ISO-8601', async () => {
    const { app, db } = build({ replies: [{ data: [], error: null, count: 0 }] });
    await ready(app);

    await app.inject(authorized('/admin/audit?from=2026-01-01'));

    const call = db.methodCalls('gte')[0];
    expect(call?.args).toEqual(['created_at', '2026-01-01T00:00:00.000Z']);

    await app.close();
  });
});

/* ------------------------------------------------------------------ refusals */

describe('what the API refuses to do', () => {
  it('will not let an administrator suspend their own account', async () => {
    /*
     * Not paternalism. A self-suspended administrator cannot undo it through
     * this API, because the middleware refuses a suspended administrator — so
     * the recovery would be a manual database edit.
     */
    const { app, db } = build();
    await ready(app);

    const response = await app.inject(
      authorized(`/admin/users/${ADMIN.id}/suspend`, 'POST', {
        suspended: true,
        reason: 'testing the guard',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/cannot suspend your own account/i);
    // Refused before anything was written: no count, no update, no audit row.
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('will not let an administrator change their own role', async () => {
    const { app, db } = build();
    await ready(app);

    const response = await app.inject(
      authorized(`/admin/users/${ADMIN.id}/role`, 'POST', { role: 'user', reason: 'testing' }),
    );

    expect(response.statusCode).toBe(400);
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('will not suspend the last active administrator', async () => {
    const { app, db } = build({
      replies: [
        { data: null, error: null, count: 1 },
        { data: { role: 'admin', status: 'active' }, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/users/admin-2/suspend', 'POST', {
        suspended: true,
        reason: 'they are leaving',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/only active administrator/i);
    // Counted first, then refused: the update never ran, so no audit row exists
    // for a change that did not happen.
    expect(db.inserts('admin_audit_log')).toHaveLength(0);

    await app.close();
  });

  it('will not demote the last active administrator', async () => {
    const { app, db } = build({ replies: [{ data: null, error: null, count: 1 }] });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/users/admin-2/role', 'POST', { role: 'user', reason: 'cleanup' }),
    );

    expect(response.statusCode).toBe(400);
    expect(db.inserts('admin_audit_log')).toHaveLength(0);

    await app.close();
  });

  it('requires a reason on every consequential action', async () => {
    const { app, db } = build();
    await ready(app);

    for (const body of [{ suspended: true }, { suspended: true, reason: '' }, { suspended: true, reason: 'x' }]) {
      const response = await app.inject(authorized('/admin/users/user-9/suspend', 'POST', body));
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/reason is required/i);
    }

    expect(db.inserts('admin_audit_log')).toHaveLength(0);

    await app.close();
  });

  it('records both halves of a suspension that worked, under one request id', async () => {
    /*
     * The property that makes the log trustworthy: the row saying an action was
     * *asked for* and the row saying what happened are separate, and both carry
     * the same request id so they read as one action.
     */
    const { app, db } = build({
      replies: [
        { data: null, error: null, count: 3 },
        { data: { role: 'user', status: 'active' }, error: null },
        { error: null },
        { data: { id: 'user-9', status: 'suspended' }, error: null },
        { error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/users/user-9/suspend', 'POST', {
        suspended: true,
        reason: 'reported by another user',
      }),
    );

    expect(response.statusCode).toBe(200);

    const rows = db.inserts('admin_audit_log');
    expect(rows).toHaveLength(2);

    const requested = rows[0]?.metadata as Record<string, unknown>;
    const outcome = rows[1]?.metadata as Record<string, unknown>;

    expect(requested.outcome).toBe('requested');
    expect(outcome.outcome).toBe('succeeded');
    expect(String(requested.requestId ?? '')).toBeTruthy();
    expect(outcome.requestId).toBe(requested.requestId);

    // The actor is the verified token's subject, never anything from the body.
    expect(rows[0]?.actor_id).toBe(ADMIN.id);
    expect(rows[0]?.actor_email).toBe(ADMIN.email);
    expect(rows[1]?.actor_email).toBe(ADMIN.email);

    await app.close();
  });

  it('says the suspension did not happen when the update fails, and logs the failure', async () => {
    const { app, db } = build({
      replies: [
        { data: null, error: null, count: 3 },
        { data: { role: 'user', status: 'active' }, error: null },
        { error: null },
        { data: null, error: { message: 'connection reset' } },
        { error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/users/user-9/suspend', 'POST', { suspended: true, reason: 'policy' }),
    );

    expect(response.statusCode).toBe(502);

    const rows = db.inserts('admin_audit_log');
    const outcome = rows[1]?.metadata as Record<string, unknown>;
    expect(outcome.outcome).toBe('failed');
    // The whole point: the log must not read as a suspension that never happened.
    expect(requestedOutcome(rows)).not.toBe('succeeded');

    await app.close();
  });
});

function requestedOutcome(rows: Record<string, unknown>[]): unknown {
  const first = rows[0]?.metadata as Record<string, unknown> | undefined;
  return first?.outcome;
}

/* ------------------------------------------------------- maintenance settings */

describe('reading the maintenance setting', () => {
  it('says who last changed it, not just that it changed', async () => {
    /*
     * The screen this feeds exists to answer three questions before an
     * administrator touches anything: is it on, when was it last changed, and
     * who changed it. `updated_by` is a foreign key, so a bare UUID would send
     * the reader to a table they cannot read.
     */
    const { app } = build({
      replies: [
        {
          data: {
            value: { enabled: true, message: 'Migration in progress.' },
            updated_at: '2026-03-01T10:00:00.000Z',
            updated_by: ADMIN.id,
          },
          error: null,
        },
        { data: { id: ADMIN.id, email: ADMIN.email }, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/maintenance'));
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.maintenance.enabled).toBe(true);
    expect(body.updatedAt).toBe('2026-03-01T10:00:00.000Z');
    expect(body.updatedBy).toEqual({ id: ADMIN.id, email: ADMIN.email });

    await app.close();
  });

  it('reports nobody when the row has never been changed by an administrator', async () => {
    // The seeded row. `updatedBy: null` means "no administrator is recorded",
    // and it does not mean "unchanged" — `updatedAt` is the separate fact.
    const { app } = build({
      replies: [
        {
          data: { value: { enabled: false, message: '' }, updated_at: null, updated_by: null },
          error: null,
        },
      ],
    });
    await ready(app);

    const body = (await app.inject(authorized('/admin/maintenance'))).json();

    expect(body.updatedBy).toBeNull();
    expect(body.maintenance.enabled).toBe(false);

    await app.close();
  });

  it('still reports the state and the id when the profile cannot be read', async () => {
    /*
     * Whether the app is closed matters more than the name attached to it.
     * Refusing to answer because a profile lookup failed would be the wrong
     * trade; reporting the id with no address is the honest middle.
     */
    const { app } = build({
      replies: [
        {
          data: { value: { enabled: true, message: 'Down.' }, updated_at: null, updated_by: 'admin-9' },
          error: null,
        },
        { data: null, error: { message: 'permission denied for table profiles' } },
      ],
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/maintenance'));
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.maintenance.enabled).toBe(true);
    expect(body.updatedBy).toEqual({ id: 'admin-9', email: null });

    await app.close();
  });
});

/* ------------------------------------------------------------ announcements */

/**
 * Publishing a notice, and the states that look like success but are not.
 *
 * Announcements had no coverage at all before this block. They are the one write
 * path whose whole purpose is to reach every user, which makes the failure mode
 * worth naming precisely: an announcement that is created "successfully" but can
 * never be seen. Nothing errors, the audit log records a publish, and every
 * screen stays empty — so the tests below spend most of their effort on the
 * refusals rather than the happy path.
 *
 * The database is a queue. For a create the handler asks in this order:
 * the audit request row, the announcement insert, the audit outcome row.
 */
const AUDIT = 'admin_audit_log';

/** The announcement row the handler asked the database to insert. */
function insertedAnnouncement(db: ReturnType<typeof fakeDatabase>): Record<string, unknown> {
  const row = db.inserts('announcements')[0];
  if (!row) throw new Error('No announcement was inserted.');
  return row;
}

/** The audit rows written for one request, oldest first. */
function auditRows(db: ReturnType<typeof fakeDatabase>): Record<string, unknown>[] {
  return db.inserts(AUDIT);
}

const PUBLISH_BODY = {
  title: 'Service window',
  body: 'Recognition pauses tonight from 22:00.',
  severity: 'warning',
  published: true,
  reason: 'Scheduled database upgrade.',
};

describe('creating an announcement', () => {
  it('publishes, stamps the time on the server and writes both audit rows', async () => {
    const { app, db } = build({
      replies: [
        { data: null, error: null },
        { data: { id: 'a-1', title: 'Service window' }, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const before = Date.now();
    const response = await app.inject(
      authorized('/admin/announcements', 'POST', PUBLISH_BODY),
    );
    const after = Date.now();

    expect(response.statusCode).toBe(201);

    const row = insertedAnnouncement(db);
    expect(row.title).toBe('Service window');
    expect(row.severity).toBe('warning');
    expect(row.published).toBe(true);
    expect(row.created_by).toBe(ADMIN.id);
    expect(row.expires_at).toBeNull();
    // Stamped here, not taken from the request: the instant a notice goes live is
    // the server's fact, and a client that could set it could postdate one.
    const stamped = Date.parse(String(row.published_at));
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(after + 1000);

    const rows = auditRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.action).toBe('publish_announcement');
    expect((rows[0]?.metadata as Record<string, unknown>).outcome).toBe('requested');
    expect((rows[1]?.metadata as Record<string, unknown>).outcome).toBe('succeeded');
    expect((rows[0]?.metadata as Record<string, unknown>).requestId).toBe(
      (rows[1]?.metadata as Record<string, unknown>).requestId,
    );
    // The actor comes from the verified token, never from the body.
    expect(rows[0]?.actor_id).toBe(ADMIN.id);
    expect(rows[0]?.actor_email).toBe(ADMIN.email);

    await app.close();
  });

  it('keeps a draft out of every user’s screen', async () => {
    const { app, db } = build({
      replies: [{ data: null, error: null }, { data: { id: 'a-2' }, error: null }, { data: null, error: null }],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements', 'POST', { ...PUBLISH_BODY, published: false }),
    );

    expect(response.statusCode).toBe(201);
    const row = insertedAnnouncement(db);
    expect(row.published).toBe(false);
    // No publication time at all, rather than one that would make it live: the
    // read policy requires `published = true`, so a draft with a timestamp is
    // still hidden — but a null says plainly that it has never been published.
    expect(row.published_at).toBeNull();
    expect(auditRows(db)[0]?.action).toBe('draft_announcement');

    await app.close();
  });

  it('refuses an expiry that has already passed, and writes nothing at all', async () => {
    /*
     * The failure this prevents is silent: the row is created, the audit log
     * records a successful publish, and the announcement is invisible from the
     * first instant because its window closed before it opened.
     */
    const { app, db } = build();
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements', 'POST', {
        ...PUBLISH_BODY,
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/already passed/i);
    // Not even an audit row: this is a refusal, not an attempted action.
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('accepts a past expiry on a draft, because a draft is not visible either way', async () => {
    const { app } = build({
      replies: [{ data: null, error: null }, { data: { id: 'a-3' }, error: null }, { data: null, error: null }],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements', 'POST', {
        ...PUBLISH_BODY,
        published: false,
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    );

    // The check belongs to publishing, not to typing. Publishing this later is
    // refused by the update route — see the test below.
    expect(response.statusCode).toBe(201);

    await app.close();
  });

  it('refuses an expiry it cannot read, and says what one looks like', async () => {
    const { app, db } = build();
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements', 'POST', { ...PUBLISH_BODY, expiresAt: 'next tuesday' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/2026-11-01T18:00:00Z/);
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('refuses a title that would push every user’s layout around', async () => {
    const { app, db } = build();
    await ready(app);

    const tooLong = await app.inject(
      authorized('/admin/announcements', 'POST', { ...PUBLISH_BODY, title: 'x'.repeat(201) }),
    );

    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toMatch(/200 characters/);
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('refuses an announcement with no title or no body', async () => {
    const { app, db } = build();
    await ready(app);

    const noTitle = await app.inject(
      authorized('/admin/announcements', 'POST', { ...PUBLISH_BODY, title: '   ' }),
    );
    const noBody = await app.inject(
      authorized('/admin/announcements', 'POST', { ...PUBLISH_BODY, body: '' }),
    );

    expect(noTitle.statusCode).toBe(400);
    expect(noTitle.json().error).toMatch(/needs a title/i);
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().error).toMatch(/needs a body/i);
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('does not report success when the insert failed', async () => {
    const { app, db } = build({
      replies: [
        { data: null, error: null },
        { data: null, error: { message: 'permission denied for table announcements' } },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements', 'POST', PUBLISH_BODY),
    );

    expect(response.statusCode).toBe(502);
    expect(response.json().announcement).toBeUndefined();

    const rows = auditRows(db);
    // The outcome row says what happened, and carries the database's own words.
    expect((rows[1]?.metadata as Record<string, unknown>).outcome).toBe('failed');
    expect((rows[1]?.metadata as Record<string, unknown>).detail).toMatch(/permission denied/);

    await app.close();
  });
});

describe('changing an announcement', () => {
  it('answers 404 for an id that does not exist, without logging an attempt', async () => {
    const { app, db } = build({ replies: [{ data: null, error: null }] });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-missing', 'POST', {
        published: true,
        reason: 'Trying an id that is not there.',
      }),
    );

    expect(response.statusCode).toBe(404);
    // One read, and nothing else: a target that does not exist is not an action
    // that was attempted, and the log's `requested` rows have to keep meaning
    // "something was tried here".
    expect(auditRows(db)).toHaveLength(0);
    expect(db.methodCalls('update')).toHaveLength(0);

    await app.close();
  });

  it('reports a failed read rather than treating it as a missing row', async () => {
    const { app, db } = build({
      replies: [{ data: null, error: { message: 'connection reset' } }],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-1', 'POST', { published: true, reason: 'Unpublish it.' }),
    );

    // 502, not 404: "I could not look" and "it is not there" are different
    // answers, and only one of them is worth retrying.
    expect(response.statusCode).toBe(502);
    expect(db.inserts(AUDIT)).toHaveLength(0);

    await app.close();
  });

  it('does not move the publication time of something already live', async () => {
    /*
     * `published_at` answers "when did this first go live". Stamping it on every
     * request that says `published: true` would turn it into "when was this last
     * touched", which is a different column the table already has.
     */
    const { app, db } = build({
      replies: [
        { data: { id: 'a-1', published: true, expires_at: null }, error: null },
        { data: null, error: null },
        { data: { id: 'a-1' }, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-1', 'POST', {
        title: 'Corrected title',
        published: true,
        reason: 'Fixing a typo in the title.',
      }),
    );

    expect(response.statusCode).toBe(200);
    const patch = db.methodCalls('update')[0]?.args[0] as Record<string, unknown>;
    expect(patch.title).toBe('Corrected title');
    expect(patch.published).toBe(true);
    expect('published_at' in patch).toBe(false);

    await app.close();
  });

  it('stamps the publication time when a draft goes live', async () => {
    const { app, db } = build({
      replies: [
        { data: { id: 'a-1', published: false, expires_at: null }, error: null },
        { data: null, error: null },
        { data: { id: 'a-1' }, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-1', 'POST', {
        published: true,
        reason: 'Ready to show this to everyone.',
      }),
    );

    expect(response.statusCode).toBe(200);
    const patch = db.methodCalls('update')[0]?.args[0] as Record<string, unknown>;
    expect(patch.published).toBe(true);
    expect(typeof patch.published_at).toBe('string');

    await app.close();
  });

  it('unpublishes without inventing a new publication time', async () => {
    const { app, db } = build({
      replies: [
        { data: { id: 'a-1', published: true, expires_at: null }, error: null },
        { data: null, error: null },
        { data: { id: 'a-1' }, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-1', 'POST', {
        published: false,
        reason: 'The upgrade finished early.',
      }),
    );

    expect(response.statusCode).toBe(200);
    const patch = db.methodCalls('update')[0]?.args[0] as Record<string, unknown>;
    expect(patch.published).toBe(false);
    expect('published_at' in patch).toBe(false);

    await app.close();
  });

  it('refuses to publish a draft whose expiry has already gone', async () => {
    /*
     * The same silent-invisibility bug as on create, reached the other way round:
     * an announcement drafted with an expiry, published after it passed.
     */
    const { app, db } = build({
      replies: [{ data: { id: 'a-1', published: false, expires_at: '2020-01-01T00:00:00.000Z' }, error: null }],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-1', 'POST', {
        published: true,
        reason: 'Time to show everyone.',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/already passed/i);
    // The read happened; nothing was written.
    expect(auditRows(db)).toHaveLength(0);
    expect(db.methodCalls('update')).toHaveLength(0);

    await app.close();
  });

  it('lets an already-live announcement be given an expiry in the future', async () => {
    const { app, db } = build({
      replies: [
        { data: { id: 'a-1', published: true, expires_at: null }, error: null },
        { data: null, error: null },
        { data: { id: 'a-1' }, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-1', 'POST', {
        expiresAt: '2999-01-01T00:00:00.000Z',
        reason: 'This one should not stay up forever.',
      }),
    );

    expect(response.statusCode).toBe(200);
    const patch = db.methodCalls('update')[0]?.args[0] as Record<string, unknown>;
    expect(patch.expires_at).toBe('2999-01-01T00:00:00.000Z');

    await app.close();
  });

  it('clears an expiry when asked, and leaves it alone when not mentioned', async () => {
    const withExpiry = build({
      replies: [
        { data: { id: 'a-1', published: true, expires_at: '2999-01-01T00:00:00.000Z' }, error: null },
        { data: null, error: null },
        { data: { id: 'a-1' }, error: null },
        { data: null, error: null },
      ],
    });
    await ready(withExpiry.app);

    await withExpiry.app.inject(
      authorized('/admin/announcements/a-1', 'POST', {
        expiresAt: null,
        reason: 'This one should stay up.',
      }),
    );

    const cleared = withExpiry.db.methodCalls('update')[0]?.args[0] as Record<string, unknown>;
    // Explicitly clearing is a different request from saying nothing: `null`
    // means "no expiry", and an omitted field means "unchanged".
    expect(cleared.expires_at).toBeNull();

    const untouched = build({
      replies: [
        { data: { id: 'a-1', published: true, expires_at: '2999-01-01T00:00:00.000Z' }, error: null },
        { data: null, error: null },
        { data: { id: 'a-1' }, error: null },
        { data: null, error: null },
      ],
    });
    await ready(untouched.app);

    await untouched.app.inject(
      authorized('/admin/announcements/a-1', 'POST', {
        title: 'Corrected title',
        reason: 'Fixing a typo in the title.',
      }),
    );

    const patch = untouched.db.methodCalls('update')[0]?.args[0] as Record<string, unknown>;
    expect('expires_at' in patch).toBe(false);

    await withExpiry.app.close();
    await untouched.app.close();
  });

  it('refuses an edit that would blank the title, before writing anything', async () => {
    /*
     * The columns carry CHECK constraints that would reject an empty title, so the
     * database would refuse this either way — but as a 502 reading "could not be
     * changed", which tells an administrator nothing about their own input.
     */
    const { app, db } = build({
      replies: [{ data: { id: 'a-1', published: true, expires_at: null }, error: null }],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-1', 'POST', {
        title: '   ',
        reason: 'Clearing the title by mistake.',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/needs a title/i);
    expect(auditRows(db)).toHaveLength(0);

    await app.close();
  });

  it('refuses a request that names nothing to change', async () => {
    const { app, db } = build({
      replies: [{ data: { id: 'a-1', published: true, expires_at: null }, error: null }],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-1', 'POST', { reason: 'Nothing in particular.' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/nothing to change/i);
    expect(auditRows(db)).toHaveLength(0);

    await app.close();
  });
});

/* ------------------------------------------------- bulk account actions */

/**
 * Bulk actions are the one place a single click can change many accounts, so the
 * properties worth protecting are the ones that only exist across the whole
 * selection: the last-administrator rule, the acting administrator's own
 * account, the size ceiling, and the honesty of a partial result. None of the
 * four can be checked by looking at one target.
 */
describe('bulk account actions', () => {
  const BULK = '/admin/users/bulk';

  const TWO_ACTIVE: Reply[] = [
    { count: 5 }, // active administrators, read once for the whole selection
    {
      data: [
        { id: 'u1', role: 'user', status: 'active' },
        { id: 'u2', role: 'user', status: 'active' },
      ],
    },
  ];

  /** The replies one changed account consumes: request row, update, outcome row. */
  const oneChange = (id: string, status: string): Reply[] => [
    {},
    { data: { id, status } },
    {},
  ];

  it('applies the change to every selected account and reports each one', async () => {
    const { app, db } = build({
      replies: [
        ...TWO_ACTIVE,
        ...oneChange('u1', 'suspended'),
        ...oneChange('u2', 'suspended'),
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['u1', 'u2'],
        suspended: true,
        reason: 'Both accounts were reported for the same spam campaign.',
      }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      succeeded: number;
      failed: number;
      results: { id: string; ok: boolean; status?: string }[];
    };
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results).toEqual([
      { id: 'u1', ok: true, status: 'suspended' },
      { id: 'u2', ok: true, status: 'suspended' },
    ]);

    /*
     * Every affected account must be individually reconstructable from the log,
     * and the rows must belong to one request. A shared `requestId` is what lets
     * an investigator read the batch as one action rather than as unrelated edits
     * that happened to arrive together.
     */
    const rows = auditRows(db);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.target_id)).toEqual(['u1', 'u1', 'u2', 'u2']);
    expect(rows.map((row) => (row.metadata as { outcome: string }).outcome)).toEqual([
      'requested',
      'succeeded',
      'requested',
      'succeeded',
    ]);
    expect(rows.map((row) => (row.metadata as { bulk?: boolean }).bulk)).toEqual([
      true,
      undefined,
      true,
      undefined,
    ]);
    expect(
      new Set(rows.map((row) => (row.metadata as { requestId: string }).requestId)).size,
    ).toBe(1);

    await app.close();
  });

  it('refuses a selection containing the acting administrator own account', async () => {
    const { app, db } = build();
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['u1', ADMIN.id],
        suspended: true,
        reason: 'Cleaning up dormant accounts.',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/own account/i);
    // Refused before anything was read or written, so the selection cannot have
    // been partially applied on the way to the refusal.
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('refuses a selection that contains every active administrator', async () => {
    const { app, db } = build({
      replies: [
        { count: 2 },
        {
          data: [
            { id: 'a1', role: 'admin', status: 'active' },
            { id: 'a2', role: 'admin', status: 'active' },
          ],
        },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['a1', 'a2'],
        suspended: true,
        reason: 'Rotating the administrator accounts.',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/nobody able to administer/i);
    // The rule is about the batch: each target would pass a per-account check,
    // and the project would still be left with no administrator at all.
    expect(db.methodCalls('update')).toHaveLength(0);

    await app.close();
  });

  it('allows suspending administrators while an active one remains', async () => {
    const { app } = build({
      replies: [
        { count: 3 },
        {
          data: [
            { id: 'a1', role: 'admin', status: 'active' },
            { id: 'u1', role: 'user', status: 'active' },
          ],
        },
        ...oneChange('a1', 'suspended'),
        ...oneChange('u1', 'suspended'),
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['a1', 'u1'],
        suspended: true,
        reason: 'Both are leaving the project.',
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toBe(2);

    await app.close();
  });

  it('refuses a selection larger than the ceiling, without reading anything', async () => {
    const { app, db } = build();
    await ready(app);

    const tooMany = Array.from({ length: 51 }, (_value, index) => `u${index}`);
    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: tooMany,
        suspended: true,
        reason: 'Bulk cleanup of inactive accounts.',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/limited to 50/);
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('refuses an empty selection', async () => {
    const { app } = build();
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: [],
        suspended: true,
        reason: 'Nothing in particular.',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/at least one account/i);

    await app.close();
  });

  it('refuses a selection that is not a list of ids', async () => {
    const { app } = build();
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['u1', 42],
        suspended: true,
        reason: 'A mixed selection.',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/must be an account id/i);

    await app.close();
  });

  it('requires a reason before it touches anything', async () => {
    const { app, db } = build();
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', { userIds: ['u1'], suspended: true }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/reason is required/i);
    expect(db.calls()).toHaveLength(0);

    await app.close();
  });

  it('changes a repeated account once, not once per mention', async () => {
    const { app, db } = build({
      replies: [
        { count: 5 },
        { data: [{ id: 'u1', role: 'user', status: 'active' }] },
        ...oneChange('u1', 'suspended'),
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['u1', 'u1'],
        suspended: true,
        reason: 'A duplicated entry in the selection.',
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toHaveLength(1);
    // Two audit pairs for one account would claim two changes where one happened.
    expect(auditRows(db)).toHaveLength(2);

    await app.close();
  });

  it('reports the accounts that failed rather than the batch as done', async () => {
    const { app, db } = build({
      replies: [
        ...TWO_ACTIVE,
        {},
        { data: { id: 'u1', status: 'suspended' } },
        {},
        {},
        { error: { message: 'permission denied for table profiles' } },
        {},
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['u1', 'u2'],
        suspended: true,
        reason: 'Both were reported together.',
      }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      succeeded: number;
      failed: number;
      results: { id: string; ok: boolean; error?: string }[];
    };
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[0]).toEqual({ id: 'u1', ok: true, status: 'suspended' });
    expect(body.results[1]?.ok).toBe(false);
    expect(body.results[1]?.error).toMatch(/could not be changed/i);

    // The account that failed is recorded as failed, not left unresolved.
    expect(auditRows(db).map((row) => (row.metadata as { outcome: string }).outcome)).toEqual([
      'requested',
      'succeeded',
      'requested',
      'failed',
    ]);

    await app.close();
  });

  it('does not change an account whose action could not be recorded first', async () => {
    const { app, db } = build({
      replies: [
        ...TWO_ACTIVE,
        { error: { message: 'the audit table is unreachable' } },
        // u1 consumes nothing further: no update, no outcome row.
        {},
        { data: { id: 'u2', status: 'suspended' } },
        {},
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['u1', 'u2'],
        suspended: true,
        reason: 'Both accounts are dormant.',
      }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: { id: string; ok: boolean; error?: string }[] };
    expect(body.results[0]?.ok).toBe(false);
    expect(body.results[0]?.error).toMatch(/not attempted/i);
    expect(body.results[1]?.ok).toBe(true);
    /*
     * The invariant is per account and is the one the single-account route keeps:
     * no record, no change. A batch must not be a way around it.
     */
    expect(db.methodCalls('update')).toHaveLength(1);

    await app.close();
  });

  it('restores accounts without consulting the administrator count', async () => {
    const { app, db } = build({
      replies: [{}, { data: { id: 'u1', status: 'active' } }, {}],
    });
    await ready(app);

    const response = await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['u1'],
        suspended: false,
        reason: 'The report was withdrawn.',
      }),
    );

    expect(response.statusCode).toBe(200);
    // Restoring cannot remove the last administrator, so the count is not read —
    // the reply queue above would be consumed out of order if it were.
    expect(db.methodCalls('update')[0]?.args[0]).toEqual({ status: 'active' });
    expect(auditRows(db).map((row) => row.action)).toEqual([
      'restore_account',
      'restore_account',
    ]);

    await app.close();
  });

  it('reads the selection once rather than once per account', async () => {
    const { app, db } = build({
      replies: [
        ...TWO_ACTIVE,
        ...oneChange('u1', 'suspended'),
        ...oneChange('u2', 'suspended'),
      ],
    });
    await ready(app);

    await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['u1', 'u2'],
        suspended: true,
        reason: 'Both were reported together.',
      }),
    );

    expect(db.methodCalls('in')).toHaveLength(1);
    expect(db.methodCalls('in')[0]?.args).toEqual(['id', ['u1', 'u2']]);
    expect(db.methodCalls('update')).toHaveLength(2);

    await app.close();
  });

  it('attributes every row to the authenticated administrator, not the request', async () => {
    const { app, db } = build({
      replies: [{}, {}, { data: { id: 'u1', status: 'active' } }, {}],
    });
    await ready(app);

    await app.inject(
      authorized(BULK, 'POST', {
        userIds: ['u1'],
        suspended: false,
        reason: 'Restoring an account.',
        // A body field naming the actor is exactly what the middleware exists to
        // ignore: a log that could be written under someone else's name is not a
        // log anybody can rely on.
        actorId: 'someone-else',
        actor_id: 'someone-else',
      }),
    );

    const rows = auditRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.actor_id === ADMIN.id)).toBe(true);
    expect(rows.every((row) => row.actor_email === ADMIN.email)).toBe(true);

    await app.close();
  });
});

/* --------------------------------------------------------------- the overview */

describe('the overview', () => {
  /**
   * The eleven counts, in the order the handler asks for them.
   *
   * The order is the handler's, not a preference: the fake hands answers back in
   * sequence, so this list is also a statement about which queries run.
   */
  const COUNTS = [
    { count: 40 }, // profiles total
    { count: 33 }, // profiles active
    { count: 7 }, // profiles suspended
    { count: 3 }, // profiles admins
    { count: 2 }, // profiles active admins
    { count: 5 }, // notices live
    { count: 2 }, // notices drafts
    { count: 1 }, // notices expired
    { count: 9 }, // audit succeeded, 24h
    { count: 1 }, // audit failed, 24h
    { data: [] }, // recent activity
  ];

  const RECENT = {
    id: 'a1',
    actor_email: 'admin@example.test',
    action: 'suspend_account',
    target_type: 'profile',
    target_id: 'u1',
    reason: 'Repeated abuse.',
    metadata: { outcome: 'succeeded', requestId: 'r1' },
    created_at: '2026-10-15T00:00:00.000Z',
  };

  it('returns each figure the database reported', async () => {
    // The eleventh answer is the recent-activity read, so `COUNTS`' own
    // placeholder for it is replaced rather than left to be consumed first.
    const { app } = build({ replies: [...COUNTS.slice(0, 10), { data: [RECENT] }] });
    await ready(app);

    const response = await app.inject(authorized('/admin/overview'));

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.users).toEqual({
      total: 40,
      active: 33,
      suspended: 7,
      admins: 3,
      activeAdmins: 2,
    });
    expect(body.announcements).toEqual({ live: 5, drafts: 2, expired: 1 });
    expect(body.audit.succeeded24h).toBe(9);
    expect(body.audit.failed24h).toBe(1);
    expect(body.audit.recent).toHaveLength(1);

    await app.close();
  });

  it('applies the filters that make those figures true', async () => {
    /*
     * A count is only as good as its filter, and a dropped filter is invisible in
     * the response — it just makes the number bigger. So the assertions here are
     * about what was asked, not what came back.
     */
    const { app, db } = build({ replies: COUNTS });
    await ready(app);
    await app.inject(authorized('/admin/overview'));

    const eqArgs = db.methodCalls('eq').map((call) => call.args);
    // The three partitions of `profiles`.
    expect(eqArgs).toContainEqual(['status', 'active']);
    expect(eqArgs).toContainEqual(['status', 'suspended']);
    expect(eqArgs).toContainEqual(['role', 'admin']);
    // The two 24-hour counts select on the outcome, so one action is one outcome
    // rather than two rows counted as two events.
    expect(eqArgs).toContainEqual(['metadata->>outcome', 'succeeded']);
    expect(eqArgs).toContainEqual(['metadata->>outcome', 'failed']);

    // "Live" notices are the ones a user can actually see: published and not yet
    // expired. A live count that ignored `expires_at` would count notices that
    // every reader is already unable to see.
    const ors = db.methodCalls('or').map((call) => String(call.args[0]));
    expect(ors.some((value) => /expires_at\.is\.null/.test(value))).toBe(true);
    expect(ors.some((value) => /expires_at\.gt\./.test(value))).toBe(true);

    // Expired notices are counted separately, never folded into `live`.
    expect(db.methodCalls('not').map((call) => call.args)).toContainEqual([
      'expires_at',
      'is',
      null,
    ]);

    // Recent activity is the newest few, not the whole table.
    expect(db.lastArg('order')).toBe('created_at');
    expect(db.methodCalls('limit').map((call) => call.args[0])).toEqual([5]);

    await app.close();
  });

  it('fails the whole overview rather than reporting the tiles that worked', async () => {
    /*
     * The failure this prevents: one query fails, the endpoint returns the other
     * ten figures, and a missing tile reads as "zero of those" — a claim about the
     * database made from a query that never ran.
     */
    const { app } = build({
      replies: [{ count: 40 }, { error: { message: 'connection reset' } }],
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/overview'));

    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.error).toMatch(/could not be read/i);
    // No partial tile set.
    expect(body.users).toBeUndefined();
    expect(body.announcements).toBeUndefined();

    await app.close();
  });

  it('writes no audit row, because reading is not an action', async () => {
    const { app, db } = build({ replies: COUNTS });
    await ready(app);
    await app.inject(authorized('/admin/overview'));

    expect(db.methodCalls('insert')).toHaveLength(0);

    await app.close();
  });
});

/* ------------------------------------------------------------------- health */

describe('the health screen', () => {
  /** The probe set used by most tests: nothing configured, nothing claimed. */
  const NONE_CONFIGURED: AdminHealthDeps = {
    isEmailConfigured: () => false,
    firebaseStatus: () => ({ initialized: false, error: 'GOOGLE_APPLICATION_CREDENTIALS is not set.' }),
  };

  it('separates a component that works from one that merely has settings', async () => {
    const { app } = build({ replies: [{ count: 1 }], health: NONE_CONFIGURED });
    await ready(app);

    const response = await app.inject(authorized('/admin/health'));

    expect(response.statusCode).toBe(200);
    const checks = response.json().checks as { key: string; state: string }[];
    const stateOf = (key: string) => checks.find((check) => check.key === key)?.state;

    // The database did its real job, so it may say so.
    expect(stateOf('database')).toBe('verified');
    // Email and push have settings at most, and here not even that.
    expect(stateOf('email')).toBe('unconfigured');
    expect(stateOf('push')).toBe('unconfigured');

    await app.close();
  });

  it('never reports delivery as tested when only configuration was proved', async () => {
    /*
     * The whole point of the endpoint. A key file that loads, and an SMTP server
     * that accepts a connection, prove that a message *could* be attempted —
     * never that one arrived. Both must stop at `untested`, and `deliveryTested`
     * must stay false until a message is genuinely delivered and confirmed.
     */
    const { app } = build({
      replies: [{ count: 1 }],
      health: {
        isEmailConfigured: () => true,
        verifySmtpConnection: async () => ({ connected: true }),
        firebaseStatus: () => ({ initialized: true }),
      },
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/health'));
    const checks = response.json().checks as { key: string; state: string; deliveryTested: boolean }[];

    for (const key of ['email', 'push']) {
      const check = checks.find((entry) => entry.key === key);
      expect(check?.state).toBe('untested');
      expect(check?.state).not.toBe('verified');
      expect(check?.deliveryTested).toBe(false);
    }

    // And every check disclaims delivery, not just the two that could deliver.
    expect(checks.every((check) => check.deliveryTested === false)).toBe(true);

    await app.close();
  });

  it('reports a refused connection as failed, with the reason the probe gave', async () => {
    const { app } = build({
      replies: [{ count: 1 }],
      health: {
        isEmailConfigured: () => true,
        verifySmtpConnection: async () => ({ connected: false, error: 'Invalid login' }),
        firebaseStatus: () => ({ initialized: false, error: 'not set' }),
      },
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/health'));
    const email = (response.json().checks as { key: string; state: string; detail: string }[]).find(
      (check) => check.key === 'email',
    );

    expect(email?.state).toBe('failed');
    expect(email?.detail).toContain('Invalid login');

    await app.close();
  });

  it('reports the database as failed when the probe cannot read', async () => {
    const { app } = build({
      replies: [{ error: { message: 'permission denied' } }],
      health: NONE_CONFIGURED,
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/health'));
    const database = (response.json().checks as { key: string; state: string; detail: string }[]).find(
      (check) => check.key === 'database',
    );

    expect(database?.state).toBe('failed');
    expect(database?.detail).toContain('permission denied');

    await app.close();
  });

  it('does not forward a credential path the probe happened to report', async () => {
    /*
     * `initFirebaseAdmin` returns the path it loaded the service account from.
     * Forwarding it would disclose this server's filesystem layout to a client,
     * and the console has no use for it — so the route reads only the two fields
     * it needs, and a probe returning more cannot smuggle a path through.
     */
    const leaky = {
      initialized: true,
      credentialsPath: 'C:\\secrets\\sanket-service-account.json',
    } as unknown as { initialized: boolean; error?: string };

    const { app } = build({
      replies: [{ count: 1 }],
      health: { ...NONE_CONFIGURED, firebaseStatus: () => leaky },
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/health'));
    const serialised = JSON.stringify(response.json());

    expect(serialised).not.toContain('service-account.json');
    expect(serialised).not.toContain('credentialsPath');
    expect(serialised).not.toContain('secrets');

    await app.close();
  });
});

describe('who may read the overview and the health screen', () => {
  it('refuses an ordinary account on both', async () => {
    for (const url of ['/admin/overview', '/admin/health']) {
      const { app } = build({ role: 'user', replies: [] });
      await ready(app);

      const response = await app.inject(authorized(url));

      expect(response.statusCode).toBe(403);
      await app.close();
    }
  });

  it('refuses a suspended administrator on both', async () => {
    for (const url of ['/admin/overview', '/admin/health']) {
      const { app } = build({ status: 'suspended', replies: [] });
      await ready(app);

      const response = await app.inject(authorized(url));

      expect(response.statusCode).toBe(403);
      await app.close();
    }
  });
});

/* ------------------------------------------------- announcement dispatch */

/**
 * What a published announcement's push looks like to an HTTP caller.
 *
 * The transport is a double supplied through `options.dispatch`: there is no
 * Firebase project here and no message leaves this process. The double is
 * labelled as one everywhere it appears, because the thing that must never be
 * inferred from these tests is that a real device received anything — what they
 * establish is the route's decisions: when a dispatch runs, what the caller is
 * told, what the audit log keeps, and how an unconfigured project is described.
 */
const TWO_DEVICES: DispatchDeps = {
  pushStatus: () => ({ initialized: true }),
  listTargets: async (limit) =>
    ({
      targets: [
        { token: 'tok-0', userId: 'u0' },
        { token: 'tok-1', userId: 'u1' },
      ].slice(0, limit),
      error: null,
    }),
  send: async () => ({ messageId: 'm-1' }),
  // Injected so a retry in a failing case does not really wait.
  sleep: async () => {},
};

/** Push as this project actually is: nothing configured, so nothing can send. */
const PUSH_OFF: DispatchDeps = {
  pushStatus: () => ({ initialized: false, error: 'GOOGLE_APPLICATION_CREDENTIALS is not set.' }),
};

const LIVE_ROW = {
  id: 'a-9',
  title: 'Service window',
  body: 'Recognition pauses tonight from 22:00.',
  severity: 'warning',
  published: true,
  published_at: '2026-10-15T09:00:00.000Z',
  expires_at: null,
};

describe('dispatching a published announcement', () => {
  it('sends it to the registered devices, and reports what the transport accepted', async () => {
    const { app } = build({
      dispatch: TWO_DEVICES,
      replies: [
        { data: null, error: null },
        { data: LIVE_ROW, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/announcements', 'POST', PUBLISH_BODY));

    expect(response.statusCode).toBe(201);
    const dispatch = response.json().dispatch as Record<string, unknown>;
    expect(dispatch.state).toBe('complete');
    expect(dispatch.targets).toBe(2);
    expect(dispatch.accepted).toBe(2);
    // The literal, so a screen can never read a dispatch as a delivery.
    expect(dispatch.deliveryConfirmed).toBe(false);

    await app.close();
  });

  it('sends nothing for a draft, and says nothing was sent', async () => {
    const send = vi.fn(async () => ({ messageId: 'm-1' }));
    const { app } = build({
      dispatch: { ...TWO_DEVICES, send },
      replies: [
        { data: null, error: null },
        { data: { ...LIVE_ROW, published: false }, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements', 'POST', { ...PUBLISH_BODY, published: false }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().dispatch).toBeNull();
    expect(send).not.toHaveBeenCalled();

    await app.close();
  });

  it('does not send again when an announcement that is already live is edited', async () => {
    /*
     * The duplicate guard. Without it, fixing a typo in a live notice would push
     * it to every registered device a second time, and people would receive the
     * same announcement twice for a reason nothing in the notice explains.
     */
    const send = vi.fn(async () => ({ messageId: 'm-1' }));
    const { app } = build({
      dispatch: { ...TWO_DEVICES, send },
      replies: [
        { data: { id: 'a-9', published: true, expires_at: null }, error: null },
        { data: null, error: null },
        { data: { ...LIVE_ROW, title: 'Service window (corrected)' }, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-9', 'POST', {
        title: 'Service window (corrected)',
        published: true,
        reason: 'Corrected the start time.',
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().dispatch).toBeNull();
    expect(send).not.toHaveBeenCalled();

    await app.close();
  });

  it('sends when a draft is published for the first time', async () => {
    const send = vi.fn(async () => ({ messageId: 'm-1' }));
    const { app } = build({
      dispatch: { ...TWO_DEVICES, send },
      replies: [
        { data: { id: 'a-9', published: false, expires_at: null }, error: null },
        { data: null, error: null },
        { data: LIVE_ROW, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-9', 'POST', {
        published: true,
        reason: 'The maintenance window is confirmed.',
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it('keeps the dispatch result in the audit log, where it outlives the screen', async () => {
    const { app, db } = build({
      dispatch: TWO_DEVICES,
      replies: [
        { data: null, error: null },
        { data: LIVE_ROW, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    await app.inject(authorized('/admin/announcements', 'POST', PUBLISH_BODY));

    const outcome = auditRows(db)[1] as { metadata: Record<string, unknown> } | undefined;
    expect(outcome?.metadata.outcome).toBe('succeeded');
    /*
     * The response is gone the moment the screen closes. This detail is the only
     * place a later reader can learn that the publish reached, or did not reach,
     * a phone — and the sentence it carries refuses to let acceptance read as
     * delivery.
     */
    expect(String(outcome?.metadata.detail)).toMatch(/not delivery/i);

    await app.close();
  });

  it('publishes the notice and reports truthfully that no push could be sent', async () => {
    /*
     * The state this project is in. The announcement really is published — it is
     * in the table, users can read it — and the push really did not happen. Both
     * facts are reported, and the action is still recorded as having succeeded
     * because publishing is what the administrator asked for and what occurred.
     */
    const { app, db } = build({
      dispatch: PUSH_OFF,
      replies: [
        { data: null, error: null },
        { data: LIVE_ROW, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(authorized('/admin/announcements', 'POST', PUBLISH_BODY));

    expect(response.statusCode).toBe(201);
    const dispatch = response.json().dispatch as Record<string, unknown>;
    expect(dispatch.state).toBe('unavailable');
    expect(String(dispatch.reason)).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(insertedAnnouncement(db).published).toBe(true);

    await app.close();
  });
});

describe('sending a published announcement again', () => {
  it('sends it, and records the action under its own name', async () => {
    const send = vi.fn(async () => ({ messageId: 'm-1' }));
    const { app, db } = build({
      dispatch: { ...TWO_DEVICES, send },
      replies: [
        { data: LIVE_ROW, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-9/dispatch', 'POST', {
        reason: 'Firebase was down during the first attempt.',
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(auditRows(db)[0]?.action).toBe('dispatch_announcement');
    expect(auditRows(db)[0]?.target_id).toBe('a-9');

    await app.close();
  });

  it('refuses a draft, because there is nothing on any phone to send', async () => {
    const send = vi.fn(async () => ({ messageId: 'm-1' }));
    const { app, db } = build({
      dispatch: { ...TWO_DEVICES, send },
      replies: [{ data: { ...LIVE_ROW, published: false }, error: null }],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-9/dispatch', 'POST', { reason: 'Try it anyway.' }),
    );

    expect(response.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    // Refused before the audit row, so the log does not record an attempt that
    // the service declined to make.
    expect(auditRows(db)).toHaveLength(0);

    await app.close();
  });

  it('answers an id that does not exist without writing an audit pair', async () => {
    const { app, db } = build({ replies: [{ data: null, error: null }] });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/missing/dispatch', 'POST', { reason: 'Send it again.' }),
    );

    expect(response.statusCode).toBe(404);
    expect(auditRows(db)).toHaveLength(0);

    await app.close();
  });

  it('requires a reason, like every other action on other people’s phones', async () => {
    const { app } = build();
    await ready(app);

    const response = await app.inject(authorized('/admin/announcements/a-9/dispatch', 'POST', {}));

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('records a dispatch that could not run as a failure, not a success', async () => {
    /*
     * Unlike publishing, this action *is* the delivery. When nothing could be
     * sent, a row saying "succeeded" would tell an investigator that people were
     * notified on a day when nothing left the building.
     */
    const { app, db } = build({
      dispatch: PUSH_OFF,
      replies: [
        { data: LIVE_ROW, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-9/dispatch', 'POST', { reason: 'Try sending it now.' }),
    );

    expect(response.statusCode).toBe(200);
    expect((response.json().dispatch as Record<string, unknown>).state).toBe('unavailable');

    const rows = auditRows(db) as { metadata: Record<string, unknown> }[];
    expect(rows[0]?.metadata.outcome).toBe('requested');
    expect(rows[1]?.metadata.outcome).toBe('failed');

    await app.close();
  });

  it('refuses an ordinary account', async () => {
    const send = vi.fn(async () => ({ messageId: 'm-1' }));
    const { app } = build({
      role: 'user',
      dispatch: { ...TWO_DEVICES, send },
      replies: [{ data: LIVE_ROW, error: null }],
    });
    await ready(app);

    const response = await app.inject(
      authorized('/admin/announcements/a-9/dispatch', 'POST', { reason: 'Send it again.' }),
    );

    expect(response.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();

    await app.close();
  });
});
