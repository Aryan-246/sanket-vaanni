/**
 * Who did it, why, and what actually happened.
 *
 * Three separate claims are tested here, and they fail independently:
 *
 *   1. The acting administrator is identified from the *verified token*, and
 *      nothing a client sends can change that. The email matters because an
 *      `actor_id` alone is a UUID that has to be looked up in a table that may
 *      since have changed — it was being discarded, leaving the column NULL.
 *   2. The record distinguishes "asked for" from "done". A request row written
 *      before the action cannot know the outcome, so the outcome is a second
 *      row. Without it, a failed suspension still reads in the log as a
 *      suspension, which is worse than no log because it is believed.
 *   3. The two failure modes are asymmetric on purpose: if the *request* row
 *      cannot be written the action must not happen at all, whereas a failure to
 *      write the *outcome* must not fail an action that already succeeded.
 *
 * The service client is a hand-built double rather than a mocked library: these
 * tests are about what this code chooses to write, so the double records the
 * rows and nothing else.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { loadConfig } from '../src/config.js';
import { beginAction } from '../src/audit/trail.js';
import { createRequireAdmin } from '../src/middleware/requireAdmin.js';

/**
 * A configuration that reports the admin API as available.
 *
 * The values are obvious placeholders, and no request is ever made with them:
 * both lookups the middleware performs are injected below, so the clients it
 * builds are never called. Real credentials in a test file would be a leak.
 */
function availableConfig() {
  return loadConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon-placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'service-placeholder',
  });
}

interface FakeRequest {
  id?: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
  query?: unknown;
  url?: string;
  log: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  adminActor?: { id: string; email: string | null };
  adminService?: unknown;
}

function fakeRequest(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    id: 'req-1',
    headers: {},
    url: '/admin/users/u2/suspend',
    log: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

/** A reply that records what was sent, so assertions are about the response. */
function fakeReply() {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  return { reply, sent };
}

/** A service double that records every insert and can be made to fail. */
function fakeService(options: { failOn?: number } = {}) {
  const rows: Record<string, unknown>[] = [];
  let call = 0;

  const service = {
    from() {
      return {
        insert: async (row: Record<string, unknown>) => {
          call += 1;
          if (options.failOn === call) return { error: { message: 'insert refused' } };
          rows.push(row);
          return { error: null };
        },
      };
    },
  };

  return { service, rows };
}

/**
 * The row at `index`, or a failure that says how many rows there really were.
 *
 * The project compiles with `noUncheckedIndexedAccess`, and asserting presence
 * here rather than silencing it with `!` means a wrong row count fails with the
 * count in the message instead of a TypeError about `undefined`.
 */
function rowAt(rows: Record<string, unknown>[], index: number): Record<string, unknown> {
  const row = rows[index];
  if (!row) {
    throw new Error(`Expected an audit row at index ${index}, but there were ${rows.length}.`);
  }
  return row;
}

/** The metadata of a row, which is where the outcome and request id live. */
function meta(row: Record<string, unknown>): Record<string, unknown> {
  return (row.metadata ?? {}) as Record<string, unknown>;
}

/* --------------------------------------------- who the administrator is */

describe('the acting administrator', () => {
  it('is identified with the email the Auth server verified, not a null', async () => {
    const hook = createRequireAdmin(availableConfig(), {
      verifyToken: async () => ({ id: 'admin-1', email: 'admin@example.com' }),
      readRole: async () => ({ role: 'admin', status: 'active' }),
    });

    const request = fakeRequest({ headers: { authorization: 'Bearer good-token' } });
    const { reply, sent } = fakeReply();

    await hook(request as unknown as FastifyRequest, reply as unknown as FastifyReply);

    expect(sent.status).toBeUndefined(); // not rejected
    expect(request.adminActor).toEqual({ id: 'admin-1', email: 'admin@example.com' });
  });

  it('records an anonymous administrator as having no email, rather than failing', async () => {
    // An anonymous Supabase user is a legitimate administrator identity. Absent
    // email is the true answer for it, not a missing one, so it must not be
    // turned into a rejection or into a placeholder string.
    const hook = createRequireAdmin(availableConfig(), {
      verifyToken: async () => ({ id: 'anon-1', email: null }),
      readRole: async () => ({ role: 'admin', status: 'active' }),
    });

    const request = fakeRequest({ headers: { authorization: 'Bearer anon-token' } });
    const { reply } = fakeReply();

    await hook(request as unknown as FastifyRequest, reply as unknown as FastifyReply);

    expect(request.adminActor).toEqual({ id: 'anon-1', email: null });
  });

  it('cannot be renamed by anything the client sends', async () => {
    /*
     * The attack this closes: an administrator attributes their own action to
     * someone else by naming them in a header or the body. The actor is the
     * token's subject and nothing else, so every one of these must be ignored.
     */
    const hook = createRequireAdmin(availableConfig(), {
      verifyToken: async () => ({ id: 'admin-1', email: 'admin@example.com' }),
      readRole: async () => ({ role: 'admin', status: 'active' }),
    });

    const request = fakeRequest({
      headers: {
        authorization: 'Bearer good-token',
        'x-admin-email': 'someone.else@example.com',
        'x-actor-id': 'victim-1',
      },
      body: { actorId: 'victim-1', actorEmail: 'someone.else@example.com', reason: 'a real reason' },
      query: { actorId: 'victim-1' },
    });
    const { reply } = fakeReply();

    await hook(request as unknown as FastifyRequest, reply as unknown as FastifyReply);

    expect(request.adminActor).toEqual({ id: 'admin-1', email: 'admin@example.com' });
  });
});

/* --------------------------------------------------- asked for vs done */

describe('the two halves of an audited action', () => {
  const action = {
    action: 'suspend_account',
    targetType: 'profile',
    targetId: 'u2',
    reason: 'Reported abuse in the community channel.',
  };

  function audience(rows: Record<string, unknown>[]) {
    return rows.map((row) => (row.metadata as Record<string, unknown>).outcome);
  }

  it('writes the request first, saying only that it was requested', async () => {
    const { service, rows } = fakeService();
    const request = fakeRequest({
      adminActor: { id: 'admin-1', email: 'admin@example.com' },
      adminService: service,
    });

    await beginAction(request as unknown as FastifyRequest, action);

    expect(rows).toHaveLength(1);
    const row = rowAt(rows, 0);
    expect(row.actor_id).toBe('admin-1');
    expect(row.actor_email).toBe('admin@example.com');
    expect(row.action).toBe('suspend_account');
    expect(row.target_id).toBe('u2');
    expect(row.reason).toBe(action.reason);
    // Not "succeeded": at this point nothing has been attempted.
    expect(meta(row).outcome).toBe('requested');
    expect(meta(row).requestId).toBe('req-1');
  });

  it('appends a second row when the action worked', async () => {
    const { service, rows } = fakeService();
    const request = fakeRequest({
      adminActor: { id: 'admin-1', email: 'admin@example.com' },
      adminService: service,
    });

    const trail = await beginAction(request as unknown as FastifyRequest, action);
    await trail.succeeded();

    expect(audience(rows)).toEqual(['requested', 'succeeded']);
    // Both halves are the same action by the same person, so the pair reads as
    // one event: asked for by admin-1, for this reason, and then done.
    const outcome = rowAt(rows, 1);
    expect(outcome.actor_id).toBe('admin-1');
    expect(outcome.action).toBe('suspend_account');
    expect(outcome.reason).toBe(action.reason);
    expect(meta(outcome).requestId).toBe('req-1');
  });

  it('appends a failure rather than leaving a failed action looking done', async () => {
    /*
     * The defect this exists for. The `UPDATE` fails, the caller is told it
     * failed — and before this change the log still said the account had been
     * suspended, because the request row was the only record and it is written
     * before the attempt. Anyone reading the log afterwards would conclude a
     * suspension happened that never did.
     */
    const { service, rows } = fakeService();
    const request = fakeRequest({
      adminActor: { id: 'admin-1', email: 'admin@example.com' },
      adminService: service,
    });

    const trail = await beginAction(request as unknown as FastifyRequest, action);
    await trail.failed('connection to the database was lost');

    expect(audience(rows)).toEqual(['requested', 'failed']);
    expect(meta(rowAt(rows, 1)).detail).toBe('connection to the database was lost');
    // Nothing anywhere says it succeeded.
    expect(audience(rows)).not.toContain('succeeded');
  });

  it('bounds the failure detail so the log cannot be used as storage', async () => {
    const { service, rows } = fakeService();
    const request = fakeRequest({
      adminActor: { id: 'admin-1', email: null },
      adminService: service,
    });

    const trail = await beginAction(request as unknown as FastifyRequest, action);
    await trail.failed('x'.repeat(5_000));

    const detail = meta(rowAt(rows, 1)).detail as string;
    expect(detail.length).toBe(500);
  });

  it('records the actor email on both halves', async () => {
    // A pair where only the first row names the person is not attribution.
    const { service, rows } = fakeService();
    const request = fakeRequest({
      adminActor: { id: 'admin-9', email: 'second@example.com' },
      adminService: service,
    });

    const trail = await beginAction(request as unknown as FastifyRequest, action);
    await trail.succeeded();

    expect(rows.map((row) => row.actor_email)).toEqual([
      'second@example.com',
      'second@example.com',
    ]);
  });
});

/* ------------------------------------------------ the deliberate asymmetry */

describe('what happens when the audit log cannot be written', () => {
  const action = {
    action: 'enable_maintenance',
    targetType: 'setting',
    targetId: 'maintenance',
    reason: 'Applying a schema change to the recognition store.',
  };

  it('refuses the action when the request row cannot be written', async () => {
    // Throwing is the point: the caller's 500 path runs and the action never
    // happens. An unlogged change is the one thing an audit log must not allow.
    const { service } = fakeService({ failOn: 1 });
    const request = fakeRequest({
      adminActor: { id: 'admin-1', email: 'admin@example.com' },
      adminService: service,
    });

    await expect(beginAction(request as unknown as FastifyRequest, action)).rejects.toThrow(
      /could not be written/,
    );
  });

  it('does not fail an action that already succeeded', async () => {
    /*
     * The other half of the asymmetry. By the time the outcome is recorded the
     * maintenance mode has already been turned on; throwing here could not undo
     * that, and would only turn a completed action into an error the caller
     * might retry. The row is left saying "requested" and never resolved, which
     * is true and reads as unresolved rather than as done.
     */
    const { service, rows } = fakeService({ failOn: 2 });
    const request = fakeRequest({
      adminActor: { id: 'admin-1', email: 'admin@example.com' },
      adminService: service,
    });

    const trail = await beginAction(request as unknown as FastifyRequest, action);

    await expect(trail.succeeded()).resolves.toBeUndefined();

    // The request row stands unresolved, and the failure was reported to a log
    // rather than swallowed.
    expect(rows).toHaveLength(1);
    expect(meta(rowAt(rows, 0)).outcome).toBe('requested');
    expect(request.log.error).toHaveBeenCalled();
    const logged = JSON.stringify(request.log.error.mock.calls);
    expect(logged).toContain('req-1');
    expect(logged).toContain('enable_maintenance');
  });

  it('refuses to attribute an action when there is no verified actor', async () => {
    // Reachable only by wiring a route outside the preHandler. Failing closed is
    // the only acceptable answer: an action attributed to nobody is unattributable.
    const { service } = fakeService();
    const request = fakeRequest({ adminService: service });

    await expect(beginAction(request as unknown as FastifyRequest, action)).rejects.toThrow(
      /without an authenticated actor/,
    );
  });

  it('refuses when there is no service client', async () => {
    const request = fakeRequest({ adminActor: { id: 'admin-1', email: null } });

    await expect(beginAction(request as unknown as FastifyRequest, action)).rejects.toThrow(
      /without a service client/,
    );
  });
});
