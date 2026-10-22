/**
 * OTP-confirmed account deletion, exercised as HTTP routes.
 *
 * ## What this file is actually protecting
 *
 * Account deletion is the one ordinary-user action that destroys data no backup
 * in this project restores. The tests below therefore do not stop at "the happy
 * path returns 200". Each refusal is asserted with the same weight as each
 * success, and the *absence* of a side effect is asserted rather than inferred:
 *
 *   * the permanent owner and the last active administrator are refused before
 *     a code is ever generated;
 *   * a request from an unverified address is refused, because the code would
 *     go somewhere the provider does not consider proven;
 *   * a wrong, expired or already-consumed code never reaches `deleteUser`;
 *   * the account is taken from the bearer token, never from the body — a body
 *     that names someone else changes nothing;
 *   * the code itself is never in a response, an audit row or a log argument,
 *     only its keyed hash is stored;
 *   * a partial failure releases the claim so the same code can be retried, and
 *     does not half-delete the account.
 *
 * ## The fake database
 *
 * It answers per table in the order the handler asks, and records every method
 * and argument. That direction — state what the database would say, then read
 * back what was asked — is what catches a filter silently dropped. The
 * service-role client is injected; no credentials exist in this file.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createAccountRoutes, type AccountRouteDeps } from '../src/routes/account.js';
import type { AppConfig } from '../src/config.js';
import type { AuthUser } from '../src/middleware/requireUser.js';
import type { SendEmailOptions } from '../src/services/email.js';

/* -------------------------------------------------------------- the fake db */

interface Reply {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

interface TableCall {
  table: string;
  method: string;
  args: unknown[];
}

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
  delete = this.step('delete');
  eq = this.step('eq');
  not = this.step('not');
  is = this.step('is');
  order = this.step('order');
  limit = this.step('limit');
  maybeSingle = this.step('maybeSingle');

  then<TResult1 = Reply, TResult2 = never>(
    onfulfilled?: ((value: Reply) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const next: Reply = this.queue.shift() ?? { data: null, error: null, count: 0 };
    return Promise.resolve(next).then(onfulfilled, onrejected);
  }
}

interface FakeOptions {
  profiles?: Reply[];
  challenges?: Reply[];
  audit?: Reply[];
  rpc?: Reply[];
  storageList?: Reply;
  storageRemove?: Reply;
  deleteUser?: Reply;
}

interface FakeDb {
  client: SupabaseClient;
  tables: TableCall[];
  rpcCalls: { name: string; args: unknown }[];
  storageRemoved: string[][];
  deletedUsers: string[];
}

function fakeDatabase(options: FakeOptions): FakeDb {
  const queues: Record<string, Reply[]> = {
    profiles: [...(options.profiles ?? [])],
    account_deletion_challenges: [...(options.challenges ?? [])],
    admin_audit_log: [...(options.audit ?? [])],
  };
  const rpcQueue = [...(options.rpc ?? [])];

  const tables: TableCall[] = [];
  const builders: FakeBuilder[] = [];
  let flushed = 0;
  const rpcCalls: { name: string; args: unknown }[] = [];
  const storageRemoved: string[][] = [];
  const deletedUsers: string[] = [];

  const client = {
    from: (table: string) => {
      const builder = new FakeBuilder(table, (queues[table] ??= []));
      builders.push(builder);
      return builder;
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      const reply = rpcQueue.shift() ?? { data: null, error: null };
      return Promise.resolve(reply);
    },
    storage: {
      from: () => ({
        list: async () => options.storageList ?? { data: [], error: null },
        remove: async (paths: string[]) => {
          storageRemoved.push(paths);
          return options.storageRemove ?? { data: null, error: null };
        },
      }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          deletedUsers.push(id);
          return options.deleteUser ?? { data: {}, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;

  const flush = () => {
    for (; flushed < builders.length; flushed += 1) {
      const builder = builders[flushed]!;
      for (const call of builder.recorded) {
        tables.push({ table: builder.table, ...call });
      }
    }
    return tables;
  };

  return {
    client,
    get tables() {
      return flush();
    },
    rpcCalls,
    storageRemoved,
    deletedUsers,
  };
}

/* ---------------------------------------------------------------- the harness */

const CONFIG: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  smtp: { host: 'smtp.invalid', port: 465, secure: true, from: 'Sanket Vaanni <auth@example.com>' },
  emailProvider: 'smtp',
  brevoEndpoint: 'https://api.brevo.com/v3',
};

const PEPPER = 'test-pepper';
const CODE = '246810';
const USER: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'person@example.com',
  emailConfirmedAt: '2026-10-01T00:00:00.000Z',
};
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

const OWNER_PROFILE = { is_owner: true, role: 'admin', status: 'active' };
const USER_PROFILE = { is_owner: false, role: 'user', status: 'active' };
const ADMIN_PROFILE = { is_owner: false, role: 'admin', status: 'active' };

interface Harness {
  app: FastifyInstance;
  db: FakeDb;
  sent: SendEmailOptions[];
  authHeader: string | undefined;
}

function harness(
  options: FakeOptions & {
    user?: AuthUser;
    emailConfigured?: boolean;
    sendFails?: boolean;
    tokenValid?: boolean;
  } = {},
): Harness {
  const db = fakeDatabase(options);
  const sent: SendEmailOptions[] = [];

  const deps: AccountRouteDeps = {
    serviceClient: db.client,
    verifyToken: async () => (options.tokenValid === false ? null : (options.user ?? USER)),
    readProfile: async () => ({ status: 'active' }),
    sendEmail: async (message) => {
      sent.push(message);
      if (options.sendFails) return { accepted: false, error: 'smtp refused' };
      return { accepted: true, messageId: 'test' };
    },
    emailConfigured: () => options.emailConfigured ?? true,
    generateCode: () => CODE,
    now: () => NOW,
    codePepper: PEPPER,
  };

  const app = Fastify({ logger: false });
  app.register(createAccountRoutes(CONFIG, deps));

  return {
    app,
    db,
    sent,
    authHeader: `Bearer test-token`,
  };
}

async function requestDeletion(h: Harness) {
  return h.app.inject({
    method: 'POST',
    url: '/account/deletion/request',
    headers: h.authHeader ? { authorization: h.authHeader } : {},
  });
}

async function confirmDeletion(h: Harness, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/account/deletion/confirm',
    headers: h.authHeader ? { authorization: h.authHeader } : {},
    payload: body,
  });
}

/* -------------------------------------------------------------- the refusals */

describe('requesting a deletion code', () => {
  it('refuses the permanent owner before generating or sending anything', async () => {
    const h = harness({ profiles: [{ data: OWNER_PROFILE, error: null }] });

    const response = await requestDeletion(h);

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/permanent owner/i);
    expect(h.sent).toHaveLength(0);
    expect(h.db.tables.some((call) => call.table === 'account_deletion_challenges')).toBe(false);
  });

  it('refuses the last active administrator', async () => {
    const h = harness({
      profiles: [
        { data: ADMIN_PROFILE, error: null },
        { count: 1, error: null },
      ],
    });

    const response = await requestDeletion(h);

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/only active administrator/i);
    expect(h.sent).toHaveLength(0);
  });

  it('allows an administrator when another active administrator remains', async () => {
    const h = harness({
      profiles: [
        { data: ADMIN_PROFILE, error: null },
        { count: 2, error: null },
      ],
      challenges: [{ data: null, error: null }],
      audit: [{ data: null, error: null }],
    });

    const response = await requestDeletion(h);

    expect(response.statusCode).toBe(202);
    expect(h.sent).toHaveLength(1);
  });

  it('refuses an account whose address the provider has not verified', async () => {
    const h = harness({ user: { ...USER, emailConfirmedAt: null } });

    const response = await requestDeletion(h);

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/verified email/i);
    expect(h.sent).toHaveLength(0);
  });

  it('refuses an account with no address at all', async () => {
    const h = harness({ user: { ...USER, email: null } });
    const response = await requestDeletion(h);
    expect(response.statusCode).toBe(403);
    expect(h.sent).toHaveLength(0);
  });

  it('answers 401 without a bearer token', async () => {
    const h = harness({ profiles: [{ data: USER_PROFILE, error: null }] });
    h.authHeader = undefined;

    const response = await requestDeletion(h);

    expect(response.statusCode).toBe(401);
    expect(h.sent).toHaveLength(0);
  });

  it('answers 401 for a token the provider rejects', async () => {
    const h = harness({ tokenValid: false });
    const response = await requestDeletion(h);
    expect(response.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------ request success */

describe('sending the code', () => {
  it('stores only a hash and returns no code', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      challenges: [{ data: null, error: null }],
    });

    const response = await requestDeletion(h);

    expect(response.statusCode).toBe(202);
    expect(h.sent).toHaveLength(1);

    const body = response.body;
    expect(body).not.toContain(CODE);

    const insert = h.db.tables.find(
      (call) => call.table === 'account_deletion_challenges' && call.method === 'insert',
    );
    expect(insert).toBeDefined();
    const inserted = insert!.args[0] as Record<string, unknown>;
    expect(inserted.code_hash).not.toBe(CODE);
    expect(String(inserted.code_hash)).toMatch(/^[0-9a-f]{64}$/);

    // The code is in the email — that is the only place it exists in clear.
    expect(h.sent[0]!.text).toContain(CODE);
  });

  it('reports a retry window instead of sending twice in a minute', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      challenges: [{ data: { created_at: new Date(NOW - 20_000).toISOString() }, error: null }],
    });

    const response = await requestDeletion(h);

    expect(response.statusCode).toBe(429);
    expect(response.json().retryAfterSeconds).toBe(40);
    expect(h.sent).toHaveLength(0);
  });

  it('removes the challenge when the mail server refuses the message', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      challenges: [{ data: null, error: null }],
      sendFails: true,
    });

    const response = await requestDeletion(h);

    expect(response.statusCode).toBe(502);
    expect(h.sent).toHaveLength(1);
    expect(
      h.db.tables.some(
        (call) => call.table === 'account_deletion_challenges' && call.method === 'delete',
      ),
    ).toBe(true);
  });

  it('refuses honestly when SMTP is not configured', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      emailConfigured: false,
    });

    const response = await requestDeletion(h);

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/Email is not configured/i);
    expect(h.sent).toHaveLength(0);
  });
});

/* -------------------------------------------------------------- confirmation */

describe('confirming deletion', () => {
  it('deletes the account named by the token, not by the body', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      rpc: [{ data: 'ok', error: null }],
      storageList: { data: [{ name: 'avatar-1.jpg' }], error: null },
      audit: [{ error: null }, { error: null }],
    });

    const response = await confirmDeletion(h, {
      code: CODE,
      userId: '99999999-9999-4999-8999-999999999999',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'deleted' });
    expect(h.db.deletedUsers).toEqual([USER.id]);
    expect(h.db.storageRemoved).toEqual([[`${USER.id}/avatar-1.jpg`]]);

    const claim = h.db.rpcCalls.find((call) => call.name === 'claim_deletion_challenge');
    expect(claim).toBeDefined();
    expect((claim!.args as { p_user_id: string }).p_user_id).toBe(USER.id);
  });

  it('never touches Auth for a wrong code', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      rpc: [{ data: 'mismatch', error: null }],
    });

    const response = await confirmDeletion(h, { code: '000000' });

    expect(response.statusCode).toBe(400);
    expect(h.db.deletedUsers).toHaveLength(0);
    expect(h.db.storageRemoved).toHaveLength(0);
  });

  it('never touches Auth for an expired code', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      rpc: [{ data: 'expired', error: null }],
    });

    const response = await confirmDeletion(h, { code: CODE });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/expired/i);
    expect(h.db.deletedUsers).toHaveLength(0);
  });

  it('treats an already-used code as missing, so a replay cannot delete twice', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      rpc: [{ data: 'ok', error: null }, { data: 'missing', error: null }],
      audit: [{ error: null }, { error: null }],
    });

    expect((await confirmDeletion(h, { code: CODE })).statusCode).toBe(200);
    const replay = await confirmDeletion(h, { code: CODE });

    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toMatch(/No deletion request/i);
    expect(h.db.deletedUsers).toHaveLength(1);
  });

  it('answers 429 once the attempt ceiling is reached', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      rpc: [{ data: 'too_many', error: null }],
    });

    const response = await confirmDeletion(h, { code: CODE });

    expect(response.statusCode).toBe(429);
    expect(h.db.deletedUsers).toHaveLength(0);
  });

  it('rejects a malformed code without consulting the database', async () => {
    const h = harness({ profiles: [{ data: USER_PROFILE, error: null }] });

    const response = await confirmDeletion(h, { code: '12ab56' });

    expect(response.statusCode).toBe(400);
    expect(h.db.rpcCalls).toHaveLength(0);
    expect(h.db.deletedUsers).toHaveLength(0);
  });

  it('refuses the permanent owner even with a valid code', async () => {
    const h = harness({ profiles: [{ data: OWNER_PROFILE, error: null }] });

    const response = await confirmDeletion(h, { code: CODE });

    expect(response.statusCode).toBe(409);
    expect(h.db.rpcCalls).toHaveLength(0);
    expect(h.db.deletedUsers).toHaveLength(0);
  });

  it('stops and releases the claim when owned files cannot be removed', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      rpc: [{ data: 'ok', error: null }],
      storageList: { data: [{ name: 'avatar-1.jpg' }], error: null },
      storageRemove: { data: null, error: { message: 'storage unavailable' } },
      challenges: [{ data: { id: 'challenge-1' }, error: null }],
      audit: [{ error: null }],
    });

    const response = await confirmDeletion(h, { code: CODE });

    expect(response.statusCode).toBe(502);
    expect(h.db.deletedUsers).toHaveLength(0);
    expect(
      h.db.tables.some(
        (call) =>
          call.table === 'account_deletion_challenges' &&
          call.method === 'update' &&
          JSON.stringify(call.args[0]) === JSON.stringify({ consumed_at: null }),
      ),
    ).toBe(true);
  });

  it('reports an Auth-provider failure and leaves the claim reusable', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      rpc: [{ data: 'ok', error: null }],
      audit: [{ error: null }, { error: null }],
      deleteUser: { data: null, error: { message: 'provider timeout' } },
      challenges: [{ data: { id: 'challenge-1' }, error: null }],
    });

    const response = await confirmDeletion(h, { code: CODE });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatch(/could not be deleted/i);
    expect(h.db.deletedUsers).toEqual([USER.id]);
    expect(
      h.db.tables.some(
        (call) =>
          call.table === 'account_deletion_challenges' &&
          call.method === 'update' &&
          JSON.stringify(call.args[0]) === JSON.stringify({ consumed_at: null }),
      ),
    ).toBe(true);
  });

  it('writes an audit pair and never records the code', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      rpc: [{ data: 'ok', error: null }],
      audit: [{ error: null }, { error: null }],
    });

    await confirmDeletion(h, { code: CODE });

    const inserts = h.db.tables.filter(
      (call) => call.table === 'admin_audit_log' && call.method === 'insert',
    );
    expect(inserts).toHaveLength(2);

    const metadata = inserts.map((call) => (call.args[0] as { metadata: unknown }).metadata);
    expect(metadata[0]).toMatchObject({ outcome: 'requested' });
    expect(metadata[1]).toMatchObject({ outcome: 'succeeded' });
    expect(JSON.stringify(metadata)).not.toContain(CODE);
  });

  it('does not delete when the audit request row cannot be written', async () => {
    const h = harness({
      profiles: [{ data: USER_PROFILE, error: null }],
      rpc: [{ data: 'ok', error: null }],
      audit: [{ error: { message: 'audit table unavailable' } }],
      challenges: [{ data: { id: 'challenge-1' }, error: null }],
    });

    const response = await confirmDeletion(h, { code: CODE });

    expect(response.statusCode).toBe(500);
    expect(h.db.deletedUsers).toHaveLength(0);
  });
});
