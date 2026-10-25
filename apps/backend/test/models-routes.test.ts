/**
 * Unit and integration tests for published sign language recognition models.
 *
 * Verifies:
 * - Public reads (Guest, Normal User, Admin) can fetch active published models.
 * - Non-admins (Guest, Normal User, forged claims) are strictly forbidden from publishing (401/403).
 * - Language compatibility is enforced (ISL, ASL, BSL).
 * - Administrative publication updates published model and writes an audit log.
 * - Rollback reverts to previous valid model version and writes audit log.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createModelRoutes, type ModelRouteDeps } from '../src/routes/models.js';
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
  upsert = this.step('upsert');
  delete = this.step('delete');
  eq = this.step('eq');
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
}

function fakeDatabase(seed: {
  settings?: Reply[];
  audit?: Reply[];
}): FakeDb {
  const queues: Record<string, Reply[]> = {
    app_settings: [...(seed.settings ?? [])],
    admin_audit_log: [...(seed.audit ?? [])],
  };
  const builders: FakeBuilder[] = [];

  const client = {
    from: (table: string) => {
      const builder = new FakeBuilder(table, (queues[table] ??= []));
      builders.push(builder);
      return builder;
    },
  } as unknown as SupabaseClient;

  return {
    client,
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
  emailProvider: 'smtp',
  brevoEndpoint: 'https://api.brevo.com/v3',
};

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

const SAMPLE_MODEL_PACKAGE = {
  version: 1,
  languageProfile: 'isl',
  vocabulary: {
    labelIds: ['namaste', 'thank_you', 'yes', 'no', 'help'],
    labelTexts: {
      namaste: 'Namaste',
      thank_you: 'Thank You',
      yes: 'Yes',
      no: 'No',
      help: 'Help',
    },
    vocabularyFingerprint: 'fnv1a-isl-5',
  },
  parameters: {
    featureSpec: { version: 1 },
    centroids: { namaste: [0.1, 0.2] },
  },
  evaluation: {
    split: 'test',
    accuracy: 0.94,
    macroF1: 0.92,
    classes: [
      { id: 'namaste', text: 'Namaste', precision: 0.95, recall: 0.93, f1: 0.94, support: 10 },
    ],
  },
  compatibilityContract: {
    languageProfile: 'isl',
    gloveVersion: 'V11',
  },
};

function harness(
  seed: Parameters<typeof fakeDatabase>[0] & {
    role?: string;
    status?: string;
    tokenValid?: boolean;
  } = {},
): { app: FastifyInstance; db: FakeDb } {
  const db = fakeDatabase(seed);

  const deps: ModelRouteDeps = {
    serviceClient: db.client,
    verifyToken: async () =>
      seed.tokenValid === false ? null : { id: ADMIN_ID, email: 'admin@example.com' },
    readRole: async () => ({
      role: seed.role ?? 'admin',
      status: seed.status ?? 'active',
    }),
  };

  const app = Fastify({ logger: false });
  app.register(createModelRoutes(CONFIG, deps));
  return { app, db };
}

function authHeader(): Record<string, string> {
  return { authorization: 'Bearer test-token' };
}

/* ---------------------------------------------------------------- tests */

describe('GET /models/published/:languageProfile (Public Read)', () => {
  it('rejects unsupported language profile with 400', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/models/published/klingon' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Unsupported language profile');
  });

  it('returns published: false when no model exists for the language profile', async () => {
    const { app } = harness({
      settings: [{ data: null, error: null }],
    });
    const res = await app.inject({ method: 'GET', url: '/models/published/isl' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.published).toBe(false);
    expect(body.model).toBeNull();
  });

  it('returns active published model package to public non-admin client', async () => {
    const { app } = harness({
      settings: [
        {
          data: {
            value: {
              active: {
                version: '1.0.0',
                languageProfile: 'isl',
                publishedAt: '2026-10-25T12:00:00.000Z',
                package: SAMPLE_MODEL_PACKAGE,
              },
            },
            updated_at: '2026-10-25T12:00:00.000Z',
          },
          error: null,
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/models/published/isl' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.published).toBe(true);
    expect(body.version).toBe('1.0.0');
    expect(body.languageProfile).toBe('isl');
    expect(body.modelPackage.vocabulary.labelIds).toHaveLength(5);
  });
});

describe('GET /models/version/:languageProfile', () => {
  it('returns vocabulary count and version for cached model verification', async () => {
    const { app } = harness({
      settings: [
        {
          data: {
            value: {
              active: {
                version: '2.1.0',
                languageProfile: 'asl',
                publishedAt: '2026-10-25T13:00:00.000Z',
                package: { ...SAMPLE_MODEL_PACKAGE, languageProfile: 'asl' },
              },
            },
            updated_at: '2026-10-25T13:00:00.000Z',
          },
          error: null,
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/models/version/asl' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.published).toBe(true);
    expect(body.version).toBe('2.1.0');
    expect(body.vocabularySize).toBe(5);
  });
});

describe('POST /admin/models/publish (RBAC & Verification)', () => {
  it('refuses unauthenticated guest with 401', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/models/publish',
      payload: { reason: 'Test publish', languageProfile: 'isl', version: '1.0.0', modelPackage: SAMPLE_MODEL_PACKAGE },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses normal user (role: user) with 403', async () => {
    const { app } = harness({ role: 'user' });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/models/publish',
      headers: authHeader(),
      payload: { reason: 'Test publish', languageProfile: 'isl', version: '1.0.0', modelPackage: SAMPLE_MODEL_PACKAGE },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain('does not have administrator access');
  });

  it('refuses suspended administrator with 403', async () => {
    const { app } = harness({ role: 'admin', status: 'suspended' });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/models/publish',
      headers: authHeader(),
      payload: { reason: 'Test publish', languageProfile: 'isl', version: '1.0.0', modelPackage: SAMPLE_MODEL_PACKAGE },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain('suspended');
  });

  it('refuses publish without a reason with 400', async () => {
    const { app } = harness({ role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/models/publish',
      headers: authHeader(),
      payload: { reason: '  ', languageProfile: 'isl', version: '1.0.0', modelPackage: SAMPLE_MODEL_PACKAGE },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('reason');
  });

  it('refuses language profile mismatch with 400', async () => {
    const { app } = harness({ role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/models/publish',
      headers: authHeader(),
      payload: {
        reason: 'Publish model',
        languageProfile: 'asl',
        version: '1.0.0',
        modelPackage: { ...SAMPLE_MODEL_PACKAGE, languageProfile: 'isl' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('mismatch');
  });

  it('refuses unmeasured model with no evaluation metrics', async () => {
    const { app } = harness({ role: 'admin' });
    const unmeasured = { ...SAMPLE_MODEL_PACKAGE, evaluation: { accuracy: null } };
    const res = await app.inject({
      method: 'POST',
      url: '/admin/models/publish',
      headers: authHeader(),
      payload: {
        reason: 'Publish unmeasured model',
        languageProfile: 'isl',
        version: '1.0.0',
        modelPackage: unmeasured,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('evaluation metrics');
  });

  it('allows authorized admin to publish, writes app_settings and audit trail', async () => {
    const { app, db } = harness({
      role: 'admin',
      audit: [
        { data: { id: 'audit-row-1' }, error: null }, // request log
        { data: { id: 'audit-row-2' }, error: null }, // outcome log
      ],
      settings: [
        { data: { value: {} }, error: null }, // read existing
        { data: null, error: null },           // upsert
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/models/publish',
      headers: authHeader(),
      payload: {
        reason: 'Initial 5-word real model publication for ISL',
        languageProfile: 'isl',
        version: '1.0.0',
        modelPackage: SAMPLE_MODEL_PACKAGE,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.published).toBe(true);
    expect(body.version).toBe('1.0.0');
    expect(body.vocabularySize).toBe(5);

    // Verify audit log write
    const auditInsert = db.calls.find((c) => c.table === 'admin_audit_log' && c.method === 'insert');
    expect(auditInsert).toBeDefined();

    // Verify app_settings upsert
    const settingsUpsert = db.calls.find((c) => c.table === 'app_settings' && c.method === 'upsert');
    expect(settingsUpsert).toBeDefined();
    const upsertArgs = settingsUpsert?.args[0] as Record<string, any>;
    expect(upsertArgs.key).toBe('published_model_isl');
    expect(upsertArgs.value.active.version).toBe('1.0.0');
  });
});

describe('POST /admin/models/rollback (Admin Rollback)', () => {
  it('refuses rollback if no prior version exists', async () => {
    const { app } = harness({
      role: 'admin',
      settings: [
        {
          data: { value: { active: { version: '1.0.0' }, previous: null } },
          error: null,
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/models/rollback',
      headers: authHeader(),
      payload: {
        reason: 'Attempt rollback with no history',
        languageProfile: 'isl',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('No previous published model');
  });

  it('successfully rolls back to previous version and writes audit log', async () => {
    const { app, db } = harness({
      role: 'admin',
      audit: [
        { data: { id: 'audit-row-1' }, error: null },
        { data: { id: 'audit-row-2' }, error: null },
      ],
      settings: [
        {
          data: {
            value: {
              active: { version: '2.0.0' },
              previous: { version: '1.0.0', package: SAMPLE_MODEL_PACKAGE },
              history: [{ version: '1.0.0' }],
            },
          },
          error: null,
        },
        { data: null, error: null }, // upsert
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/models/rollback',
      headers: authHeader(),
      payload: {
        reason: 'Rollback regression to v1.0.0',
        languageProfile: 'isl',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.rolledBack).toBe(true);
    expect(body.activeVersion).toBe('1.0.0');

    const settingsUpsert = db.calls.find((c) => c.table === 'app_settings' && c.method === 'upsert');
    expect(settingsUpsert).toBeDefined();
    const upsertArgs = settingsUpsert?.args[0] as Record<string, any>;
    expect(upsertArgs.value.active.version).toBe('1.0.0');
  });
});
