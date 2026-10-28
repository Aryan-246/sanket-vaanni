import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createModelRoutes, type ModelRouteDeps } from '../src/routes/models.js';
import type { AppConfig } from '../src/config.js';

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

describe('Shared Vocabulary & Consented Training Data Endpoints', () => {
  describe('GET /vocabulary/:languageProfile (Public Read)', () => {
    it('returns default canonical words when no stored vocabulary exists', async () => {
      const { app } = harness({
        settings: [{ data: null, error: null }],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/vocabulary/isl',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.languageProfile).toBe('isl');
      expect(body.words.length).toBeGreaterThanOrEqual(5);
      expect(body.words.some((w: any) => w.text.includes('HELLO') || w.text.includes('नमस्ते'))).toBe(true);
    });

    it('rejects unsupported language profile with 400', async () => {
      const { app } = harness();
      const res = await app.inject({
        method: 'GET',
        url: '/vocabulary/klingon',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Unsupported language profile');
    });
  });

  describe('GET /admin/vocabulary/:languageProfile (Admin-only)', () => {
    it('forbids normal users (403)', async () => {
      const { app } = harness({ role: 'user' });
      const res = await app.inject({
        method: 'GET',
        url: '/admin/vocabulary/isl',
        headers: { authorization: 'Bearer user-token' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns full vocabulary registry for admin', async () => {
      const { app } = harness({
        settings: [
          {
            data: {
              value: {
                languageProfile: 'isl',
                revision: 3,
                words: [
                  {
                    wordId: 'word-1',
                    text: 'WATER',
                    normalizedKey: 'water',
                    languageProfile: 'isl',
                    status: 'collecting',
                    sampleCount: 5,
                    modelVersions: [],
                    history: [],
                  },
                ],
              },
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/vocabulary/isl',
        headers: { authorization: 'Bearer admin-token' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.revision).toBe(3);
      expect(body.words[0].text).toBe('WATER');
    });
  });

  describe('POST /admin/vocabulary/:languageProfile/word (Admin-only)', () => {
    it('creates a word, bumps revision and writes audit log', async () => {
      const { app, db } = harness({
        settings: [
          // 1. read current
          {
            data: {
              value: {
                languageProfile: 'isl',
                revision: 1,
                words: [],
              },
            },
          },
          // 2. upsert new store
          { data: { key: 'shared_vocabulary_isl' } },
        ],
        audit: [
          // 1. beginAction insert
          { data: { id: 'audit-1' } },
          // 2. succeeded update
          { data: { id: 'audit-1' } },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/admin/vocabulary/isl/word',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          reason: 'Adding essential daily gesture for school vocabulary',
          text: 'TEACHER',
          definition: 'Open hand near temple nodding forward',
          spokenPhrase: 'Teacher',
          createdDeviceAlias: "Aryan's Phone",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.word.text).toBe('TEACHER');
      expect(body.word.normalizedKey).toBe('teacher');
      expect(body.word.createdDeviceAlias).toBe("Aryan's Phone");
      expect(body.revision).toBe(2);

      // Verify audit call recorded
      expect(db.calls.some((c) => c.table === 'admin_audit_log' && c.method === 'insert')).toBe(true);
    });

    it('rejects duplicate active words with 409 Conflict', async () => {
      const { app } = harness({
        settings: [
          {
            data: {
              value: {
                languageProfile: 'isl',
                revision: 1,
                words: [
                  {
                    wordId: 'word-1',
                    text: 'WATER',
                    normalizedKey: 'water',
                    status: 'published',
                  },
                ],
              },
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/admin/vocabulary/isl/word',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          reason: 'Attempt duplicate water',
          text: 'water',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('already exists');
    });
  });

  describe('PUT /admin/vocabulary/:languageProfile/word/:wordId (Admin-only)', () => {
    it('updates definition and spokenPhrase and appends to history', async () => {
      const { app } = harness({
        settings: [
          {
            data: {
              value: {
                languageProfile: 'isl',
                revision: 2,
                words: [
                  {
                    wordId: 'word-100',
                    text: 'HELP',
                    normalizedKey: 'help',
                    languageProfile: 'isl',
                    definition: 'Old definition',
                    spokenPhrase: 'Help',
                    revision: 1,
                    status: 'collecting',
                    modelVersions: [],
                    history: [],
                  },
                ],
              },
            },
          },
          { data: { key: 'shared_vocabulary_isl' } },
        ],
        audit: [{ data: { id: 'audit-2' } }, { data: { id: 'audit-2' } }],
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/admin/vocabulary/isl/word/word-100',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          reason: 'Correcting gesture reference definition',
          definition: 'Flat hand supporting upright fist with thumb up',
          spokenPhrase: 'Madad',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.word.definition).toBe('Flat hand supporting upright fist with thumb up');
      expect(body.word.spokenPhrase).toBe('Madad');
      expect(body.word.revision).toBe(2);
      expect(body.word.history.length).toBe(1);
    });
  });

  describe('DELETE /admin/vocabulary/:languageProfile/word/:wordId (Admin-only)', () => {
    it('archives word by default without destroying history', async () => {
      const { app } = harness({
        settings: [
          {
            data: {
              value: {
                languageProfile: 'isl',
                revision: 2,
                words: [
                  {
                    wordId: 'word-200',
                    text: 'OBSOLETE',
                    normalizedKey: 'obsolete',
                    status: 'collecting',
                    modelVersions: [],
                    history: [],
                  },
                ],
              },
            },
          },
          { data: { key: 'shared_vocabulary_isl' } },
        ],
        audit: [{ data: { id: 'audit-3' } }, { data: { id: 'audit-3' } }],
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/vocabulary/isl/word/word-200',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          reason: 'Retiring dialect variation from active recordings',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.archived).toBe(true);
      expect(body.deleted).toBe(false);
    });

    it('blocks permanent delete if word belongs to a published model', async () => {
      const { app } = harness({
        settings: [
          {
            data: {
              value: {
                languageProfile: 'isl',
                revision: 2,
                words: [
                  {
                    wordId: 'word-300',
                    text: 'YES',
                    status: 'published',
                    modelVersions: ['1.0.0'],
                    history: [],
                  },
                ],
              },
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/vocabulary/isl/word/word-300?permanent=true',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          reason: 'Attempt permanent delete of published word',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Cannot permanently delete');
      expect(res.json().error).toContain('published model version');
    });
  });

  describe('Shared Training Data Endpoints', () => {
    it('rejects samples without explicit consent (hasConsent: false)', async () => {
      const { app } = harness();
      const res = await app.inject({
        method: 'POST',
        url: '/admin/training-data/isl/samples',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          reason: 'Upload unconsented frames',
          samples: [
            {
              sampleId: 'sample-1',
              wordId: 'word-1',
              label: 'HELLO',
              hasConsent: false,
              frames: [],
            },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('explicit consent');
    });

    it('merges consented samples idempotently and updates vocabulary sample counts', async () => {
      const { app } = harness({
        settings: [
          // 1. read current dataset
          {
            data: {
              value: {
                languageProfile: 'isl',
                revision: 1,
                samples: [
                  {
                    sampleId: 'sample-existing',
                    wordId: 'word-1',
                    label: 'NAMASTE',
                    hasConsent: true,
                    frames: [],
                  },
                ],
              },
            },
          },
          // 2. upsert dataset
          { data: { key: 'training_dataset_isl' } },
          // 3. read vocabulary
          {
            data: {
              value: {
                languageProfile: 'isl',
                revision: 1,
                words: [
                  {
                    wordId: 'word-1',
                    text: 'NAMASTE',
                    normalizedKey: 'namaste',
                    status: 'collecting',
                    sampleCount: 1,
                    modelVersions: [],
                    history: [],
                  },
                ],
              },
            },
          },
          // 4. upsert vocabulary
          { data: { key: 'shared_vocabulary_isl' } },
        ],
        audit: [{ data: { id: 'audit-4' } }, { data: { id: 'audit-4' } }],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/admin/training-data/isl/samples',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          reason: 'Sync 4 new calibration-checked recordings from Aryan phone',
          deviceAlias: "Aryan's Phone",
          samples: [
            {
              sampleId: 'sample-new-1',
              wordId: 'word-1',
              label: 'NAMASTE',
              hasConsent: true,
              frames: [{ flex: [0.2, 0.3, 0.4, 0.5, 0.6] }],
            },
            {
              sampleId: 'sample-new-2',
              wordId: 'word-1',
              label: 'NAMASTE',
              hasConsent: true,
              frames: [{ flex: [0.2, 0.3, 0.4, 0.5, 0.6] }],
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.uploaded).toBe(2);
      expect(body.total).toBe(3);
    });
  });
});
