/**
 * Team / About content as HTTP routes.
 *
 * ## What is worth pinning down
 *
 * The public read must never become a way to see a draft, and the admin writes
 * must never happen without an audited reason. Both are asserted at the
 * boundary, together with the two failure directions that are easy to get
 * backwards: a photo is removed only after the row stops referencing it, and a
 * failed update leaves the old photo alone.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createTeamRoutes, type TeamRouteDeps } from '../src/routes/team.js';
import type { AppConfig } from '../src/config.js';

/* --------------------------------------------------------------- fake db */

interface Reply {
  data?: unknown;
  error?: { message: string } | null;
}

interface Call {
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
  order = this.step('order');
  maybeSingle = this.step('maybeSingle');

  then<TResult1 = Reply, TResult2 = never>(
    onfulfilled?: ((value: Reply) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.queue.shift() ?? { data: null, error: null }).then(
      onfulfilled,
      onrejected,
    );
  }
}

interface FakeDb {
  client: SupabaseClient;
  calls: Call[];
  removed: string[][];
}

function fakeDatabase(seed: {
  team?: Reply[];
  audit?: Reply[];
  removeError?: { message: string } | null;
}): FakeDb {
  const queues: Record<string, Reply[]> = {
    team_members: [...(seed.team ?? [])],
    admin_audit_log: [...(seed.audit ?? [])],
  };
  const builders: FakeBuilder[] = [];
  const removed: string[][] = [];

  const client = {
    from: (table: string) => {
      const builder = new FakeBuilder(table, (queues[table] ??= []));
      builders.push(builder);
      return builder;
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { data: null, error: seed.removeError ?? null };
        },
      }),
    },
  } as unknown as SupabaseClient;

  return {
    client,
    removed,
    get calls() {
      return builders.flatMap((builder) =>
        builder.recorded.map((call) => ({ table: builder.table, ...call })),
      );
    },
  };
}

/* -------------------------------------------------------------- harness */

const CONFIG: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  smtp: { host: 'smtp.invalid', port: 465, secure: true, from: 'Sanket Vaanni <auth@example.com>' },
};

const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER = {
  id: MEMBER_ID,
  name: 'A. Sharma',
  role: 'Founder',
  bio: 'Works on the glove.',
  photo_path: 'team-media/old.jpg',
  sort_order: 1,
  published: true,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

function harness(
  seed: Parameters<typeof fakeDatabase>[0] & {
    role?: string;
    tokenValid?: boolean;
    reason?: string;
  } = {},
): { app: FastifyInstance; db: FakeDb } {
  const db = fakeDatabase(seed);

  const deps: TeamRouteDeps = {
    serviceClient: db.client,
    verifyToken: async () =>
      seed.tokenValid === false ? null : { id: ACTOR_ID, email: 'admin@example.com' },
    readRole: async () => ({ role: seed.role ?? 'admin', status: 'active' }),
  };

  const app = Fastify({ logger: false });
  app.register(createTeamRoutes(CONFIG, deps));
  return { app, db };
}

function authHeader(): Record<string, string> {
  return { authorization: 'Bearer test-token' };
}

/* -------------------------------------------------------------- tests */

describe('the public team read', () => {
  it('asks the database for published rows only, in order', async () => {
    const { app, db } = harness({ team: [{ data: [MEMBER], error: null }] });

    const response = await app.inject({ method: 'GET', url: '/team' });

    expect(response.statusCode).toBe(200);
    expect(response.json().members).toHaveLength(1);

    const filters = db.calls.filter((call) => call.table === 'team_members');
    expect(filters.some((call) => call.method === 'eq' && call.args[0] === 'published')).toBe(true);
    expect(filters.some((call) => call.method === 'order' && call.args[0] === 'sort_order')).toBe(true);
  });

  it('says the API is unavailable rather than returning an empty team', async () => {
    const app = Fastify({ logger: false });
    app.register(createTeamRoutes(CONFIG, {}));

    const response = await app.inject({ method: 'GET', url: '/team' });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/SUPABASE_URL/);
  });
});

describe('the administrator team list', () => {
  it('answers 401 without a token', async () => {
    const { app } = harness();
    const response = await app.inject({ method: 'GET', url: '/admin/team' });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 for a signed-in non-administrator', async () => {
    const { app } = harness({ role: 'user' });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/team',
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns unpublished drafts to an administrator', async () => {
    const draft = { ...MEMBER, published: false };
    const { app } = harness({ team: [{ data: [draft], error: null }] });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/team',
      headers: authHeader(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().members[0].published).toBe(false);
  });
});

describe('creating a team member', () => {
  it('refuses without a reason and writes nothing', async () => {
    const { app, db } = harness();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/team',
      headers: authHeader(),
      payload: { name: 'New Person', role: 'Engineer' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/reason is required/i);
    expect(db.calls.some((call) => call.method === 'insert')).toBe(false);
  });

  it('refuses a photo outside the team-media bucket', async () => {
    const { app } = harness();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/team',
      headers: authHeader(),
      payload: {
        reason: 'Add the new engineer',
        name: 'New Person',
        role: 'Engineer',
        photoPath: 'avatars/elsewhere.jpg',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/team-media/);
  });

  it('writes the row and an audit pair', async () => {
    const { app, db } = harness({
      team: [{ data: MEMBER, error: null }],
      audit: [{ error: null }, { error: null }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/team',
      headers: authHeader(),
      payload: {
        reason: 'Add the new engineer',
        name: 'A. Sharma',
        role: 'Founder',
        bio: 'Works on the glove.',
        photoPath: 'team-media/old.jpg',
        published: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().member.id).toBe(MEMBER_ID);

    const inserts = db.calls.filter(
      (call) => call.table === 'admin_audit_log' && call.method === 'insert',
    );
    expect(inserts).toHaveLength(2);
    expect(JSON.stringify(inserts[1]!.args[0])).toContain('succeeded');
  });
});

describe('changing a team member', () => {
  it('answers 404 when the row does not exist', async () => {
    const { app } = harness({ team: [{ data: null, error: null }] });

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/team/${MEMBER_ID}`,
      headers: authHeader(),
      payload: { reason: 'Fix a typo', name: 'New Name' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects an id that is not a uuid before querying', async () => {
    const { app, db } = harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/team/not-a-uuid',
      headers: authHeader(),
      payload: { reason: 'Fix a typo', name: 'New Name' },
    });

    expect(response.statusCode).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  it('removes the previous photo only after the row points elsewhere', async () => {
    const updated = { ...MEMBER, photo_path: 'team-media/new.jpg' };
    const { app, db } = harness({
      team: [{ data: MEMBER, error: null }, { data: updated, error: null }],
      audit: [{ error: null }, { error: null }],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/team/${MEMBER_ID}`,
      headers: authHeader(),
      payload: { reason: 'New portrait', photoPath: 'team-media/new.jpg' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.removed).toEqual([['team-media/old.jpg']]);
  });

  it('leaves the previous photo alone when the update fails', async () => {
    const { app, db } = harness({
      team: [
        { data: MEMBER, error: null },
        { data: null, error: { message: 'write failed' } },
      ],
      audit: [{ error: null }, { error: null }],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/team/${MEMBER_ID}`,
      headers: authHeader(),
      payload: { reason: 'New portrait', photoPath: 'team-media/new.jpg' },
    });

    expect(response.statusCode).toBe(502);
    expect(db.removed).toHaveLength(0);
  });

  it('records cleanup failure without pretending the edit failed', async () => {
    const updated = { ...MEMBER, photo_path: 'team-media/new.jpg' };
    const { app } = harness({
      team: [{ data: MEMBER, error: null }, { data: updated, error: null }],
      audit: [{ error: null }, { error: null }],
      removeError: { message: 'storage unavailable' },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/team/${MEMBER_ID}`,
      headers: authHeader(),
      payload: { reason: 'New portrait', photoPath: 'team-media/new.jpg' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().cleanup).toMatch(/photo cleanup failed/);
  });
});

describe('deleting a team member', () => {
  it('requires a reason', async () => {
    const { app, db } = harness({ team: [{ data: MEMBER, error: null }] });

    const response = await app.inject({
      method: 'DELETE',
      url: `/admin/team/${MEMBER_ID}`,
      headers: authHeader(),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(db.calls.some((call) => call.method === 'delete')).toBe(false);
  });

  it('deletes the row, audits it and removes its photo', async () => {
    const { app, db } = harness({
      team: [{ data: MEMBER, error: null }, { data: null, error: null }],
      audit: [{ error: null }, { error: null }],
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/admin/team/${MEMBER_ID}`,
      headers: authHeader(),
      payload: { reason: 'No longer on the team' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deleted: true });
    expect(db.removed).toEqual([['team-media/old.jpg']]);
  });
});
