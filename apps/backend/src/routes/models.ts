/**
 * Published sign language recognition models, shared vocabulary, and consented training data distribution.
 *
 * ## Architecture and Role-Based Access Control
 *
 * This module enforces strict privilege boundaries:
 *
 * 1. Public reads (`GET /models/published/:languageProfile`, `GET /models/version/:languageProfile`, `GET /vocabulary/:languageProfile`):
 *    - Open to any client (Guest, Normal User, Admin).
 *    - Serves ONLY verified, published model packages and public active vocabularies.
 *    - Never exposes private training samples, unapproved candidates, or sensitive admin audit logs.
 *    - Validates language profile matching (ISL, ASL, BSL).
 *
 * 2. Administrative writes (`POST /admin/models/publish`, `POST /admin/models/rollback`,
 *    `POST /admin/vocabulary/:languageProfile/word`, `PUT /admin/vocabulary/:languageProfile/word/:wordId`,
 *    `DELETE /admin/vocabulary/:languageProfile/word/:wordId`, `POST /admin/training-data/:languageProfile/samples`):
 *    - Gated by `requireAdmin` (valid server-verified Supabase session with `role = 'admin'`).
 *    - Requires mandatory explanation reason (min 3 chars) recorded in `admin_audit_log`.
 *    - Preserves previous valid published versions for rollback.
 *    - Manages authoritative multi-device synchronized vocabulary and consented training data in `app_settings`.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config.js';
import { beginAction, type AuditTrail } from '../audit/trail.js';
import {
  createRequireAdmin,
  type AdminAuthDeps,
} from '../middleware/requireAdmin.js';

export const SUPPORTED_LANGUAGE_PROFILES = ['isl', 'asl', 'bsl'] as const;
export type SupportedLanguageProfile = (typeof SUPPORTED_LANGUAGE_PROFILES)[number];

const MAX_REASON_LENGTH = 500;

interface ReasonBody {
  reason?: unknown;
}

export interface ModelPublishBody extends ReasonBody {
  languageProfile?: unknown;
  version?: unknown;
  modelPackage?: unknown;
}

export interface ModelRollbackBody extends ReasonBody {
  languageProfile?: unknown;
}

export interface SharedWordHistoryEntry {
  action: string;
  timestamp: string;
  actorEmail: string | null;
  details: string;
}

export interface SharedWord {
  wordId: string;
  text: string;
  normalizedKey: string;
  languageProfile: SupportedLanguageProfile;
  definition: string | null;
  usageNotes: string | null;
  spokenPhrase: string | null;
  createdBy: string;
  createdByEmail: string | null;
  createdDeviceAlias: string | null;
  createdAt: string;
  updatedBy: string;
  updatedByEmail: string | null;
  updatedAt: string;
  revision: number;
  sampleCount: number;
  status: 'draft' | 'collecting' | 'trained' | 'published' | 'archived';
  modelVersions: string[];
  history: SharedWordHistoryEntry[];
}

export interface SharedVocabularyStore {
  languageProfile: SupportedLanguageProfile;
  revision: number;
  updatedAt: string;
  updatedBy: string | null;
  words: SharedWord[];
}

export interface SharedTrainingSample {
  sampleId: string;
  wordId: string;
  label: string;
  languageProfile: SupportedLanguageProfile;
  capturedAt: string;
  contributorId: string;
  contributorEmail: string | null;
  deviceAlias: string | null;
  gloveSide: string;
  qualityState: string;
  hasConsent: boolean;
  frames: unknown[];
  uploadedAt: string;
}

export interface SharedDatasetStore {
  languageProfile: SupportedLanguageProfile;
  revision: number;
  updatedAt: string;
  updatedBy: string | null;
  samples: SharedTrainingSample[];
}

export interface CreateWordBody extends ReasonBody {
  wordId?: unknown;
  text?: unknown;
  definition?: unknown;
  usageNotes?: unknown;
  spokenPhrase?: unknown;
  createdDeviceAlias?: unknown;
  status?: unknown;
}

export interface UpdateWordBody extends ReasonBody {
  text?: unknown;
  definition?: unknown;
  usageNotes?: unknown;
  spokenPhrase?: unknown;
  status?: unknown;
}

export interface UploadSamplesBody extends ReasonBody {
  deviceAlias?: unknown;
  samples?: unknown;
}

export interface ModelRouteDeps extends AdminAuthDeps {
  /** Injected by tests so that route behaviour can be verified without live Supabase. */
  serviceClient?: SupabaseClient;
}

function normalizeProfile(raw: unknown): SupportedLanguageProfile | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  return (SUPPORTED_LANGUAGE_PROFILES as readonly string[]).includes(lower)
    ? (lower as SupportedLanguageProfile)
    : null;
}

function requireReason(body: ReasonBody | undefined, reply: FastifyReply): string | null {
  const raw = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (raw.length < 3) {
    reply.status(400).send({
      error: 'A reason of at least 3 characters is required for administrative model management.',
    });
    return null;
  }
  if (raw.length > MAX_REASON_LENGTH) {
    reply.status(400).send({
      error: `A reason cannot be longer than ${MAX_REASON_LENGTH} characters.`,
    });
    return null;
  }
  return raw;
}

export function getDefaultVocabulary(profile: SupportedLanguageProfile): SharedWord[] {
  const defaults: Record<SupportedLanguageProfile, Array<{ text: string; note: string; spoken: string }>> = {
    isl: [
      { text: 'नमस्ते / HELLO', note: 'Standard ISL greeting: folded hands or open wave', spoken: 'Namaste' },
      { text: 'BYE', note: 'Standard ISL farewell: wave', spoken: 'Bye' },
      { text: 'THANK YOU', note: 'Standard ISL: flat hand touches chin then moves outward', spoken: 'Dhanyavaad' },
      { text: 'YES', note: 'Standard ISL: fist nodding up and down', spoken: 'Haan' },
      { text: 'NO', note: 'Standard ISL: index and middle finger snap down against thumb', spoken: 'Nahi' },
      { text: 'विश्राम / REST', note: 'Neutral baseline: relaxed resting hands on lap or table', spoken: 'Vishram' },
    ],
    asl: [
      { text: 'HELLO', note: 'Standard ASL greeting: open hand at temple or wave', spoken: 'Hello' },
      { text: 'BYE', note: 'Standard ASL farewell: open palm waving', spoken: 'Goodbye' },
      { text: 'THANK YOU', note: 'Standard ASL: flat hand touches chin then moves outward', spoken: 'Thank you' },
      { text: 'YES', note: 'Standard ASL: fist nodding up and down like a head nod', spoken: 'Yes' },
      { text: 'NO', note: 'Standard ASL: index and middle finger snap down against thumb', spoken: 'No' },
      { text: 'REST', note: 'Neutral baseline: relaxed resting hands on lap or table', spoken: 'Rest' },
    ],
    bsl: [
      { text: 'HELLO', note: 'Standard BSL greeting: open hand wave', spoken: 'Hello' },
      { text: 'GOODBYE', note: 'Standard BSL farewell', spoken: 'Goodbye' },
      { text: 'THANK YOU', note: 'Standard BSL gratitude sign', spoken: 'Thank you' },
      { text: 'YES', note: 'Standard BSL affirmative', spoken: 'Yes' },
      { text: 'NO', note: 'Standard BSL negative', spoken: 'No' },
      { text: 'REST', note: 'Neutral baseline', spoken: 'Rest' },
    ],
  };

  const now = new Date().toISOString();
  return (defaults[profile] || []).map((w, index) => ({
    wordId: `word-${profile}-${index + 1}`,
    text: w.text,
    normalizedKey: w.text.trim().toLowerCase(),
    languageProfile: profile,
    definition: w.note,
    usageNotes: null,
    spokenPhrase: w.spoken,
    createdBy: 'system',
    createdByEmail: 'admin@sanketvaanni.org',
    createdDeviceAlias: 'System Starter',
    createdAt: now,
    updatedBy: 'system',
    updatedByEmail: 'admin@sanketvaanni.org',
    updatedAt: now,
    revision: 1,
    sampleCount: 15,
    status: 'published',
    modelVersions: ['1.0.0'],
    history: [
      {
        action: 'created',
        timestamp: now,
        actorEmail: 'admin@sanketvaanni.org',
        details: 'Initial system starter vocabulary',
      },
    ],
  }));
}

export function createModelRoutes(config: AppConfig, deps: ModelRouteDeps = {}) {
  const requireAdmin = createRequireAdmin(config, deps);

  return async function modelRoutes(app: FastifyInstance): Promise<void> {
    const serviceClient =
      deps.serviceClient ??
      (config.supabaseUrl && config.supabaseServiceRoleKey
        ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : null);

    const getService = (req: FastifyRequest): SupabaseClient => {
      if (req.adminService) return req.adminService;
      if (serviceClient) return serviceClient;
      throw new Error('Database service client is not configured.');
    };

    /* ---------------------------------------------------------------- public reads */

    /**
     * Public read for active published model.
     * Accessible by Guest, Normal User, and Admin.
     */
    app.get<{ Params: { languageProfile: string } }>(
      '/models/published/:languageProfile',
      async (request, reply) => {
        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile '${request.params.languageProfile}'. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        if (!serviceClient) {
          reply.status(503).send({ error: 'Model distribution service is currently unavailable.' });
          return;
        }

        const settingKey = `published_model_${profile}`;
        const { data, error } = await serviceClient
          .from('app_settings')
          .select('value, updated_at')
          .eq('key', settingKey)
          .maybeSingle();

        if (error) {
          request.log.error({ error, profile }, 'Failed to query published model');
          reply.status(500).send({ error: 'Failed to query published model.' });
          return;
        }

        const value = data?.value as Record<string, any> | undefined;
        const active = value?.active;

        if (!active || typeof active !== 'object') {
          reply.send({
            ok: true,
            published: false,
            model: null,
            languageProfile: profile,
            message: `No published model is available for ${profile.toUpperCase()} yet.`,
          });
          return;
        }

        reply.send({
          ok: true,
          published: true,
          languageProfile: profile,
          version: String(active.version ?? '1.0.0'),
          publishedAt: active.publishedAt ?? data?.updated_at,
          publishedBy: active.publishedBy ?? null,
          modelPackage: active.package ?? null,
        });
      },
    );

    /**
     * Fast version-check endpoint.
     * Allows clients to verify if their cached model is current.
     */
    app.get<{ Params: { languageProfile: string } }>(
      '/models/version/:languageProfile',
      async (request, reply) => {
        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile '${request.params.languageProfile}'. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        if (!serviceClient) {
          reply.status(503).send({ error: 'Model distribution service is currently unavailable.' });
          return;
        }

        const settingKey = `published_model_${profile}`;
        const { data, error } = await serviceClient
          .from('app_settings')
          .select('value, updated_at')
          .eq('key', settingKey)
          .maybeSingle();

        if (error) {
          reply.status(500).send({ error: 'Failed to query model version.' });
          return;
        }

        const value = data?.value as Record<string, any> | undefined;
        const active = value?.active;

        if (!active || typeof active !== 'object') {
          reply.send({
            ok: true,
            published: false,
            languageProfile: profile,
            version: null,
            publishedAt: null,
            vocabularySize: 0,
          });
          return;
        }

        const contract = (active.package?.contract ?? active.package?.compatibilityContract ?? active.package ?? {}) as Record<string, any>;
        const vocabulary = (contract.vocabulary ?? active.package?.vocabulary ?? {}) as Record<string, any>;
        const vocabSize = Array.isArray(vocabulary.labelIds)
          ? vocabulary.labelIds.length
          : Array.isArray(active.package?.labelIds)
            ? active.package.labelIds.length
            : 0;

        reply.send({
          ok: true,
          published: true,
          languageProfile: profile,
          version: String(active.version ?? '1.0.0'),
          publishedAt: active.publishedAt ?? data?.updated_at,
          vocabularySize: vocabSize,
        });
      },
    );

    /**
     * Public read for active shared vocabulary.
     * Accessible by Guest, Normal User, and Admin across all client devices.
     */
    app.get<{ Params: { languageProfile: string } }>(
      '/vocabulary/:languageProfile',
      async (request, reply) => {
        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile '${request.params.languageProfile}'. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        if (!serviceClient) {
          reply.status(503).send({ error: 'Vocabulary service is currently unavailable.' });
          return;
        }

        const settingKey = `shared_vocabulary_${profile}`;
        const { data, error } = await serviceClient
          .from('app_settings')
          .select('value, updated_at')
          .eq('key', settingKey)
          .maybeSingle();

        if (error) {
          request.log.error({ error, profile }, 'Failed to query shared vocabulary');
          reply.status(500).send({ error: 'Failed to query shared vocabulary.' });
          return;
        }

        const value = data?.value as SharedVocabularyStore | undefined;
        const words: SharedWord[] = Array.isArray(value?.words) && value.words.length > 0
          ? value.words
          : getDefaultVocabulary(profile);

        // Filter out archived words for public users and return active public summary
        const activeWords = words
          .filter((w) => w.status !== 'archived')
          .map((w) => ({
            wordId: w.wordId,
            text: w.text,
            normalizedKey: w.normalizedKey,
            languageProfile: w.languageProfile,
            definition: w.definition,
            usageNotes: w.usageNotes,
            spokenPhrase: w.spokenPhrase,
            status: w.status,
            sampleCount: w.sampleCount,
            modelVersions: w.modelVersions,
            revision: w.revision,
            updatedAt: w.updatedAt,
          }));

        reply.send({
          ok: true,
          languageProfile: profile,
          revision: value?.revision ?? 1,
          updatedAt: value?.updatedAt ?? data?.updated_at ?? new Date().toISOString(),
          words: activeWords,
        });
      },
    );

    /* ---------------------------------------------------------- admin writes */

    /**
     * Admin-only model publication endpoint.
     * Atomically publishes a validated model package, archives previous version,
     * updates shared vocabulary word statuses, and writes an audit record.
     */
    app.post<{ Body: ModelPublishBody }>(
      '/admin/models/publish',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return;

        const body = request.body;
        const profile = normalizeProfile(body.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `A valid supported language profile is required (got '${String(body.languageProfile)}'). Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        const version = typeof body.version === 'string' ? body.version.trim() : '';
        if (version.length === 0) {
          reply.status(400).send({ error: 'A model version string is required.' });
          return;
        }

        const pkg = body.modelPackage as Record<string, any> | undefined;
        if (!pkg || typeof pkg !== 'object') {
          reply.status(400).send({ error: 'A valid model package object is required.' });
          return;
        }

        // Validate compatibility contract and evaluation
        const contract = (pkg.contract ?? pkg.compatibilityContract ?? pkg) as Record<string, any>;
        const vocabulary = (contract.vocabulary ?? pkg.vocabulary ?? {}) as Record<string, any>;
        const labelIds: string[] = Array.isArray(vocabulary.labelIds)
          ? vocabulary.labelIds
          : Array.isArray(pkg.labelIds)
            ? pkg.labelIds
            : [];

        if (labelIds.length === 0) {
          reply.status(400).send({ error: 'Model package vocabulary must contain at least one sign label.' });
          return;
        }

        const evaluation = contract.evaluation ?? pkg.evaluation;
        if (!evaluation || typeof evaluation !== 'object') {
          reply.status(400).send({ error: 'Cannot publish a model without valid held-out evaluation metrics.' });
          return;
        }

        // For raw packages without an in-app contract, held-out accuracy must be explicitly measured
        if (!pkg.contract && (evaluation.accuracy === null || evaluation.accuracy === undefined)) {
          reply.status(400).send({ error: 'Cannot publish a model without valid held-out evaluation metrics.' });
          return;
        }

        const accuracy = typeof evaluation.accuracy === 'number' ? evaluation.accuracy : null;

        // Validate language profile compatibility
        const contractLanguage = contract.languageId || contract.languageProfile || pkg.languageProfile;
        if (contractLanguage && String(contractLanguage).toLowerCase() !== profile) {
          reply.status(400).send({
            error: `Language profile mismatch: package specifies '${String(contractLanguage)}' but publishing target is '${profile}'.`,
          });
          return;
        }

        const targetId = `${profile}:${version}`;
        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'publish_model',
            targetType: 'ml_model',
            targetId,
            reason,
            metadata: {
              version,
              languageProfile: profile,
              vocabularySize: labelIds.length,
              accuracy,
            },
          });
        } catch (error) {
          request.log.error({ error }, 'Failed to record model publish audit request');
          reply.status(500).send({ error: 'Audit log could not be written.' });
          return;
        }

        const service = getService(request);
        const settingKey = `published_model_${profile}`;

        // Read current state to preserve previous version for rollback
        const { data: existingData, error: readError } = await service
          .from('app_settings')
          .select('value')
          .eq('key', settingKey)
          .maybeSingle();

        if (readError) {
          await trail.failed(readError.message);
          reply.status(500).send({ error: 'Failed to inspect current published model state.' });
          return;
        }

        const existingValue = (existingData?.value as Record<string, any>) ?? {};
        const prevActive = existingValue.active ?? null;
        const history = Array.isArray(existingValue.history) ? [...existingValue.history] : [];
        if (prevActive) {
          history.unshift(prevActive);
        }

        const publishedAt = new Date().toISOString();
        const newActive = {
          version,
          languageProfile: profile,
          publishedAt,
          publishedBy: request.adminActor?.id ?? null,
          publishedByEmail: request.adminActor?.email ?? null,
          package: pkg,
        };

        const updatedSettingValue = {
          active: newActive,
          previous: prevActive,
          history: history.slice(0, 10), // preserve last 10 versions for rollback
        };

        const { error: writeError } = await service.from('app_settings').upsert({
          key: settingKey,
          value: updatedSettingValue,
          updated_at: publishedAt,
          updated_by: request.adminActor?.id ?? null,
        });

        if (writeError) {
          await trail.failed(writeError.message);
          reply.status(500).send({ error: 'Failed to write published model to app_settings.' });
          return;
        }

        // Additive synchronization: mark included vocabulary words as 'published' and add version
        try {
          const vocabSettingKey = `shared_vocabulary_${profile}`;
          const { data: vocabData } = await service
            .from('app_settings')
            .select('value')
            .eq('key', vocabSettingKey)
            .maybeSingle();

          const currentVocab = (vocabData?.value as SharedVocabularyStore) ?? {
            languageProfile: profile,
            revision: 1,
            updatedAt: publishedAt,
            updatedBy: request.adminActor?.id ?? null,
            words: getDefaultVocabulary(profile),
          };

          const labelTexts = (vocabulary.labelTexts ?? pkg.vocabulary?.labelTexts ?? {}) as Record<string, string>;
          const includedTexts = new Set(
            Object.values(labelTexts).map((t) => String(t).trim().toLowerCase()),
          );
          for (const id of labelIds) {
            includedTexts.add(String(id).trim().toLowerCase());
          }

          let vocabUpdated = false;
          const updatedWords = currentVocab.words.map((word) => {
            const matches =
              includedTexts.has(word.text.trim().toLowerCase()) ||
              includedTexts.has(word.wordId.trim().toLowerCase());

            if (matches) {
              vocabUpdated = true;
              const versions = word.modelVersions.includes(version)
                ? word.modelVersions
                : [...word.modelVersions, version];
              return {
                ...word,
                status: 'published' as const,
                modelVersions: versions,
                updatedAt: publishedAt,
                updatedBy: request.adminActor?.id ?? word.updatedBy,
                updatedByEmail: request.adminActor?.email ?? word.updatedByEmail,
                history: [
                  ...word.history,
                  {
                    action: 'published_in_model',
                    timestamp: publishedAt,
                    actorEmail: request.adminActor?.email ?? null,
                    details: `Included in published model version ${version}`,
                  },
                ],
              };
            }
            return word;
          });

          if (vocabUpdated) {
            await service.from('app_settings').upsert({
              key: vocabSettingKey,
              value: {
                ...currentVocab,
                revision: currentVocab.revision + 1,
                updatedAt: publishedAt,
                updatedBy: request.adminActor?.id ?? null,
                words: updatedWords,
              },
              updated_at: publishedAt,
              updated_by: request.adminActor?.id ?? null,
            });
          }
        } catch (vocabSyncErr) {
          request.log.warn({ vocabSyncErr }, 'Non-fatal: failed to update vocabulary model references');
        }

        const accuracyDisplay =
          typeof evaluation?.accuracy === 'number'
            ? `${(evaluation.accuracy * 100).toFixed(1)}%`
            : 'unmeasured';
        await trail.succeeded(`Published version ${version} with ${labelIds.length} signs (accuracy ${accuracyDisplay})`);

        reply.send({
          ok: true,
          published: true,
          languageProfile: profile,
          version,
          publishedAt,
          vocabularySize: labelIds.length,
        });
      },
    );

    /**
     * Admin-only model rollback endpoint.
     * Reverts to the previous valid published version.
     */
    app.post<{ Body: ModelRollbackBody }>(
      '/admin/models/rollback',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return;

        const body = request.body;
        const profile = normalizeProfile(body.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `A valid supported language profile is required. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        const service = getService(request);
        const settingKey = `published_model_${profile}`;

        const { data, error } = await service
          .from('app_settings')
          .select('value')
          .eq('key', settingKey)
          .maybeSingle();

        if (error) {
          reply.status(500).send({ error: 'Failed to inspect published model setting.' });
          return;
        }

        const value = (data?.value as Record<string, any>) ?? {};
        const previous = value.previous;
        if (!previous || typeof previous !== 'object' || !previous.version) {
          reply.status(400).send({
            error: `No previous published model version is available for rollback in ${profile.toUpperCase()}.`,
          });
          return;
        }

        const history = Array.isArray(value.history) ? [...value.history] : [];
        const rolledBackFromVersion = value.active?.version ?? 'unknown';
        const targetVersion = previous.version;

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'rollback_model',
            targetType: 'ml_model',
            targetId: `${profile}:${targetVersion}`,
            reason,
            metadata: {
              languageProfile: profile,
              fromVersion: rolledBackFromVersion,
              toVersion: targetVersion,
            },
          });
        } catch (error) {
          reply.status(500).send({ error: 'Audit log could not be written.' });
          return;
        }

        const nextPrevious = history.length > 1 ? history[1] : null;
        const updatedSettingValue = {
          active: previous,
          previous: nextPrevious,
          history: history.slice(1),
        };

        const now = new Date().toISOString();
        const { error: writeError } = await service.from('app_settings').upsert({
          key: settingKey,
          value: updatedSettingValue,
          updated_at: now,
          updated_by: request.adminActor?.id ?? null,
        });

        if (writeError) {
          await trail.failed(writeError.message);
          reply.status(500).send({ error: 'Failed to update rollback state.' });
          return;
        }

        await trail.succeeded(`Rolled back ${profile.toUpperCase()} model from ${rolledBackFromVersion} to ${targetVersion}`);

        reply.send({
          ok: true,
          rolledBack: true,
          languageProfile: profile,
          activeVersion: targetVersion,
          previousVersion: nextPrevious?.version ?? null,
        });
      },
    );

    /**
     * Admin-only model history and version management list.
     */
    app.get<{ Params: { languageProfile: string } }>(
      '/admin/models/history/:languageProfile',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        const service = getService(request);
        const settingKey = `published_model_${profile}`;

        const { data, error } = await service
          .from('app_settings')
          .select('value, updated_at')
          .eq('key', settingKey)
          .maybeSingle();

        if (error) {
          reply.status(500).send({ error: 'Failed to query model history.' });
          return;
        }

        const value = (data?.value as Record<string, any>) ?? {};
        reply.send({
          ok: true,
          languageProfile: profile,
          active: value.active ?? null,
          previous: value.previous ?? null,
          history: value.history ?? [],
        });
      },
    );

    /* ------------------------------------------------- shared vocabulary endpoints */

    /**
     * Admin-only: Fetch full shared vocabulary registry including drafts, archived words,
     * sample counts, creator metadata, and audit histories.
     */
    app.get<{ Params: { languageProfile: string } }>(
      '/admin/vocabulary/:languageProfile',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        const service = getService(request);
        const settingKey = `shared_vocabulary_${profile}`;

        const { data, error } = await service
          .from('app_settings')
          .select('value, updated_at')
          .eq('key', settingKey)
          .maybeSingle();

        if (error) {
          reply.status(500).send({ error: 'Failed to query vocabulary registry.' });
          return;
        }

        const value = data?.value as SharedVocabularyStore | undefined;
        const words: SharedWord[] = Array.isArray(value?.words) && value.words.length > 0
          ? value.words
          : getDefaultVocabulary(profile);

        reply.send({
          ok: true,
          languageProfile: profile,
          revision: value?.revision ?? 1,
          updatedAt: value?.updatedAt ?? data?.updated_at ?? new Date().toISOString(),
          updatedBy: value?.updatedBy ?? null,
          words,
        });
      },
    );

    /**
     * Admin-only: Create a new shared word definition.
     * Prevents duplicate active words in the same language profile, assigns a stable UUID,
     * updates the vocabulary registry, and writes an audit log.
     */
    app.post<{ Params: { languageProfile: string }; Body: CreateWordBody }>(
      '/admin/vocabulary/:languageProfile/word',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return;

        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        const rawText = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
        if (rawText.length === 0) {
          reply.status(400).send({ error: 'A word name is required before it can be added to the shared vocabulary.' });
          return;
        }
        if (rawText.length > 60) {
          reply.status(400).send({ error: 'Keep the word name under 60 characters.' });
          return;
        }

        const service = getService(request);
        const settingKey = `shared_vocabulary_${profile}`;

        const { data, error: readError } = await service
          .from('app_settings')
          .select('value')
          .eq('key', settingKey)
          .maybeSingle();

        if (readError) {
          reply.status(500).send({ error: 'Failed to inspect vocabulary registry.' });
          return;
        }

        const currentStore = (data?.value as SharedVocabularyStore) ?? {
          languageProfile: profile,
          revision: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: request.adminActor?.id ?? null,
          words: getDefaultVocabulary(profile),
        };

        const words = [...currentStore.words];
        const normalized = rawText.toLowerCase();

        // Check for duplicates among active words
        const existing = words.find((w) => w.status !== 'archived' && w.normalizedKey === normalized);
        if (existing) {
          reply.status(409).send({
            error: `Word "${existing.text}" already exists in the active ${profile.toUpperCase()} vocabulary.`,
          });
          return;
        }

        const wordId =
          typeof request.body.wordId === 'string' && request.body.wordId.trim().length > 0
            ? request.body.wordId.trim()
            : randomUUID();

        const now = new Date().toISOString();
        const definition = typeof request.body.definition === 'string' ? request.body.definition.trim() : null;
        const usageNotes = typeof request.body.usageNotes === 'string' ? request.body.usageNotes.trim() : null;
        const spokenPhrase = typeof request.body.spokenPhrase === 'string' ? request.body.spokenPhrase.trim() : null;
        const deviceAlias = typeof request.body.createdDeviceAlias === 'string' ? request.body.createdDeviceAlias.trim() : null;
        const status = (request.body.status === 'draft' || request.body.status === 'collecting' || request.body.status === 'trained' || request.body.status === 'published')
          ? request.body.status
          : 'collecting';

        const newWord: SharedWord = {
          wordId,
          text: rawText,
          normalizedKey: normalized,
          languageProfile: profile,
          definition,
          usageNotes,
          spokenPhrase,
          createdBy: request.adminActor?.id ?? 'admin',
          createdByEmail: request.adminActor?.email ?? null,
          createdDeviceAlias: deviceAlias,
          createdAt: now,
          updatedBy: request.adminActor?.id ?? 'admin',
          updatedByEmail: request.adminActor?.email ?? null,
          updatedAt: now,
          revision: 1,
          sampleCount: 0,
          status,
          modelVersions: [],
          history: [
            {
              action: 'created',
              timestamp: now,
              actorEmail: request.adminActor?.email ?? null,
              details: reason,
            },
          ],
        };

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'create_shared_word',
            targetType: 'vocabulary_word',
            targetId: `${profile}:${wordId}`,
            reason,
            metadata: {
              wordId,
              text: rawText,
              languageProfile: profile,
              createdDeviceAlias: deviceAlias,
            },
          });
        } catch (error) {
          reply.status(500).send({ error: 'Audit log could not be written.' });
          return;
        }

        words.push(newWord);
        const nextRevision = (currentStore.revision ?? 1) + 1;
        const updatedStore: SharedVocabularyStore = {
          languageProfile: profile,
          revision: nextRevision,
          updatedAt: now,
          updatedBy: request.adminActor?.id ?? null,
          words,
        };

        const { error: writeError } = await service.from('app_settings').upsert({
          key: settingKey,
          value: updatedStore,
          updated_at: now,
          updated_by: request.adminActor?.id ?? null,
        });

        if (writeError) {
          await trail.failed(writeError.message);
          reply.status(500).send({ error: 'Failed to save new word to shared vocabulary.' });
          return;
        }

        await trail.succeeded(`Created shared word "${rawText}" (${wordId}) in ${profile.toUpperCase()}`);

        reply.send({
          ok: true,
          word: newWord,
          revision: nextRevision,
        });
      },
    );

    /**
     * Admin-only: Update a shared word definition.
     */
    app.put<{ Params: { languageProfile: string; wordId: string }; Body: UpdateWordBody }>(
      '/admin/vocabulary/:languageProfile/word/:wordId',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return;

        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        const wordId = request.params.wordId;
        const service = getService(request);
        const settingKey = `shared_vocabulary_${profile}`;

        const { data, error: readError } = await service
          .from('app_settings')
          .select('value')
          .eq('key', settingKey)
          .maybeSingle();

        if (readError) {
          reply.status(500).send({ error: 'Failed to inspect vocabulary registry.' });
          return;
        }

        const currentStore = (data?.value as SharedVocabularyStore) ?? {
          languageProfile: profile,
          revision: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: request.adminActor?.id ?? null,
          words: getDefaultVocabulary(profile),
        };

        const words = [...currentStore.words];
        const index = words.findIndex((w) => w.wordId === wordId);
        if (index === -1) {
          reply.status(404).send({ error: `Word with id '${wordId}' not found in ${profile.toUpperCase()} vocabulary.` });
          return;
        }

        const existingWord = words[index]!;
        const newText = typeof request.body?.text === 'string' && request.body.text.trim().length > 0
          ? request.body.text.trim()
          : existingWord.text;

        // Duplicate check if renaming
        if (newText.toLowerCase() !== existingWord.normalizedKey) {
          const duplicate = words.find(
            (w) => w.wordId !== wordId && w.status !== 'archived' && w.normalizedKey === newText.toLowerCase(),
          );
          if (duplicate) {
            reply.status(409).send({ error: `Another active word named "${newText}" already exists.` });
            return;
          }
        }

        const now = new Date().toISOString();
        const definition = request.body?.definition !== undefined
          ? (typeof request.body.definition === 'string' ? request.body.definition.trim() : null)
          : existingWord.definition;
        const usageNotes = request.body?.usageNotes !== undefined
          ? (typeof request.body.usageNotes === 'string' ? request.body.usageNotes.trim() : null)
          : existingWord.usageNotes;
        const spokenPhrase = request.body?.spokenPhrase !== undefined
          ? (typeof request.body.spokenPhrase === 'string' ? request.body.spokenPhrase.trim() : null)
          : existingWord.spokenPhrase;
        const status = (request.body?.status === 'draft' || request.body?.status === 'collecting' || request.body?.status === 'trained' || request.body?.status === 'published' || request.body?.status === 'archived')
          ? request.body.status
          : existingWord.status;

        const updatedWord: SharedWord = {
          ...existingWord,
          text: newText,
          normalizedKey: newText.toLowerCase(),
          definition,
          usageNotes,
          spokenPhrase,
          status,
          revision: existingWord.revision + 1,
          updatedAt: now,
          updatedBy: request.adminActor?.id ?? 'admin',
          updatedByEmail: request.adminActor?.email ?? null,
          history: [
            ...existingWord.history,
            {
              action: 'updated',
              timestamp: now,
              actorEmail: request.adminActor?.email ?? null,
              details: reason,
            },
          ],
        };

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'update_shared_word',
            targetType: 'vocabulary_word',
            targetId: `${profile}:${wordId}`,
            reason,
            metadata: {
              wordId,
              previousText: existingWord.text,
              newText,
              languageProfile: profile,
            },
          });
        } catch (error) {
          reply.status(500).send({ error: 'Audit log could not be written.' });
          return;
        }

        words[index] = updatedWord;
        const nextRevision = (currentStore.revision ?? 1) + 1;
        const updatedStore: SharedVocabularyStore = {
          ...currentStore,
          revision: nextRevision,
          updatedAt: now,
          updatedBy: request.adminActor?.id ?? null,
          words,
        };

        const { error: writeError } = await service.from('app_settings').upsert({
          key: settingKey,
          value: updatedStore,
          updated_at: now,
          updated_by: request.adminActor?.id ?? null,
        });

        if (writeError) {
          await trail.failed(writeError.message);
          reply.status(500).send({ error: 'Failed to update shared word.' });
          return;
        }

        await trail.succeeded(`Updated word "${updatedWord.text}" (${wordId}) in ${profile.toUpperCase()}`);

        reply.send({
          ok: true,
          word: updatedWord,
          revision: nextRevision,
        });
      },
    );

    /**
     * Admin-only: Remove a word from the active vocabulary.
     * Default: Archive/retire (safe, non-destructive, preserves historical models/samples).
     * Permanent delete (`?permanent=true`): Explicitly confirmed removal; rejected if word is part of published model.
     */
    app.delete<{
      Params: { languageProfile: string; wordId: string };
      Querystring: { permanent?: string };
      Body: ReasonBody;
    }>(
      '/admin/vocabulary/:languageProfile/word/:wordId',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return;

        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        const wordId = request.params.wordId;
        const isPermanent = request.query?.permanent === 'true';
        const service = getService(request);
        const settingKey = `shared_vocabulary_${profile}`;

        const { data, error: readError } = await service
          .from('app_settings')
          .select('value')
          .eq('key', settingKey)
          .maybeSingle();

        if (readError) {
          reply.status(500).send({ error: 'Failed to inspect vocabulary registry.' });
          return;
        }

        const currentStore = (data?.value as SharedVocabularyStore) ?? {
          languageProfile: profile,
          revision: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: request.adminActor?.id ?? null,
          words: getDefaultVocabulary(profile),
        };

        const words = [...currentStore.words];
        const index = words.findIndex((w) => w.wordId === wordId);
        if (index === -1) {
          reply.status(404).send({ error: `Word with id '${wordId}' not found in ${profile.toUpperCase()} vocabulary.` });
          return;
        }

        const existingWord = words[index]!;

        // Referential integrity check for permanent deletion
        if (isPermanent && existingWord.modelVersions && existingWord.modelVersions.length > 0) {
          reply.status(400).send({
            error: `Cannot permanently delete word "${existingWord.text}" because it is part of published model version(s) [${existingWord.modelVersions.join(', ')}]. Archive the word instead to preserve historical integrity.`,
          });
          return;
        }

        const now = new Date().toISOString();
        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: isPermanent ? 'permanent_delete_shared_word' : 'archive_shared_word',
            targetType: 'vocabulary_word',
            targetId: `${profile}:${wordId}`,
            reason,
            metadata: {
              wordId,
              text: existingWord.text,
              languageProfile: profile,
              isPermanent,
            },
          });
        } catch (error) {
          reply.status(500).send({ error: 'Audit log could not be written.' });
          return;
        }

        let updatedWords: SharedWord[];
        if (isPermanent) {
          updatedWords = words.filter((w) => w.wordId !== wordId);
        } else {
          updatedWords = words.map((w) =>
            w.wordId === wordId
              ? {
                  ...w,
                  status: 'archived' as const,
                  updatedAt: now,
                  updatedBy: request.adminActor?.id ?? 'admin',
                  updatedByEmail: request.adminActor?.email ?? null,
                  history: [
                    ...w.history,
                    {
                      action: 'archived',
                      timestamp: now,
                      actorEmail: request.adminActor?.email ?? null,
                      details: reason,
                    },
                  ],
                }
              : w,
          );
        }

        const nextRevision = (currentStore.revision ?? 1) + 1;
        const updatedStore: SharedVocabularyStore = {
          ...currentStore,
          revision: nextRevision,
          updatedAt: now,
          updatedBy: request.adminActor?.id ?? null,
          words: updatedWords,
        };

        const { error: writeError } = await service.from('app_settings').upsert({
          key: settingKey,
          value: updatedStore,
          updated_at: now,
          updated_by: request.adminActor?.id ?? null,
        });

        if (writeError) {
          await trail.failed(writeError.message);
          reply.status(500).send({ error: 'Failed to update vocabulary record.' });
          return;
        }

        await trail.succeeded(`${isPermanent ? 'Permanently deleted' : 'Archived'} word "${existingWord.text}" (${wordId})`);

        reply.send({
          ok: true,
          wordId,
          archived: !isPermanent,
          deleted: isPermanent,
          revision: nextRevision,
        });
      },
    );

    /* ------------------------------------------- shared consented training data endpoints */

    /**
     * Admin-only: Fetch consented shared training samples for a sign language profile.
     */
    app.get<{ Params: { languageProfile: string } }>(
      '/admin/training-data/:languageProfile',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        const service = getService(request);
        const settingKey = `training_dataset_${profile}`;

        const { data, error } = await service
          .from('app_settings')
          .select('value, updated_at')
          .eq('key', settingKey)
          .maybeSingle();

        if (error) {
          reply.status(500).send({ error: 'Failed to query shared training dataset.' });
          return;
        }

        const value = data?.value as SharedDatasetStore | undefined;
        const samples = Array.isArray(value?.samples) ? value.samples : [];

        reply.send({
          ok: true,
          languageProfile: profile,
          revision: value?.revision ?? 1,
          updatedAt: value?.updatedAt ?? data?.updated_at ?? new Date().toISOString(),
          count: samples.length,
          samples,
        });
      },
    );

    /**
     * Admin-only: Upload and merge consented training samples into the cloud dataset.
     * Enforces explicit user consent (`hasConsent: true`), idempotent deduplication by `sampleId`,
     * and updates word `sampleCount` in the shared vocabulary.
     */
    app.post<{ Params: { languageProfile: string }; Body: UploadSamplesBody }>(
      '/admin/training-data/:languageProfile/samples',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return;

        const profile = normalizeProfile(request.params.languageProfile);
        if (!profile) {
          reply.status(400).send({
            error: `Unsupported language profile. Supported: ${SUPPORTED_LANGUAGE_PROFILES.join(', ')}.`,
          });
          return;
        }

        const incoming = request.body?.samples;
        if (!Array.isArray(incoming) || incoming.length === 0) {
          reply.status(400).send({ error: 'An array of at least one training sample is required.' });
          return;
        }

        const now = new Date().toISOString();
        const deviceAlias = typeof request.body?.deviceAlias === 'string' ? request.body.deviceAlias.trim() : null;

        // Validate consent and structural fields
        const validSamples: SharedTrainingSample[] = [];
        for (const raw of incoming) {
          if (!raw || typeof raw !== 'object') continue;
          if (raw.hasConsent !== true) {
            reply.status(400).send({ error: 'All uploaded samples must carry explicit consent (hasConsent: true) for shared training.' });
            return;
          }
          if (!raw.sampleId || !raw.wordId || !raw.label) continue;

          validSamples.push({
            sampleId: String(raw.sampleId),
            wordId: String(raw.wordId),
            label: String(raw.label),
            languageProfile: profile,
            capturedAt: raw.capturedAt ? String(raw.capturedAt) : now,
            contributorId: request.adminActor?.id ?? 'admin',
            contributorEmail: request.adminActor?.email ?? null,
            deviceAlias: deviceAlias || (raw.deviceAlias ? String(raw.deviceAlias) : null),
            gloveSide: raw.gloveSide ? String(raw.gloveSide) : 'both',
            qualityState: raw.qualityState ? String(raw.qualityState) : 'valid',
            hasConsent: true,
            frames: Array.isArray(raw.frames) ? raw.frames : [],
            uploadedAt: now,
          });
        }

        if (validSamples.length === 0) {
          reply.status(400).send({ error: 'No valid structured samples were found in the upload payload.' });
          return;
        }

        const service = getService(request);
        const datasetKey = `training_dataset_${profile}`;

        const { data: existingDataset, error: readDatasetErr } = await service
          .from('app_settings')
          .select('value')
          .eq('key', datasetKey)
          .maybeSingle();

        if (readDatasetErr) {
          reply.status(500).send({ error: 'Failed to inspect training dataset.' });
          return;
        }

        const currentDataset = (existingDataset?.value as SharedDatasetStore) ?? {
          languageProfile: profile,
          revision: 1,
          updatedAt: now,
          updatedBy: request.adminActor?.id ?? null,
          samples: [],
        };

        const existingSamples = Array.isArray(currentDataset.samples) ? currentDataset.samples : [];
        const sampleMap = new Map<string, SharedTrainingSample>();
        for (const sample of existingSamples) {
          sampleMap.set(sample.sampleId, sample);
        }
        for (const sample of validSamples) {
          sampleMap.set(sample.sampleId, sample);
        }

        const mergedSamples = Array.from(sampleMap.values());
        const nextRevision = (currentDataset.revision ?? 1) + 1;

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'upload_training_samples',
            targetType: 'training_dataset',
            targetId: `${profile}:${nextRevision}`,
            reason,
            metadata: {
              languageProfile: profile,
              incomingCount: validSamples.length,
              totalCount: mergedSamples.length,
              deviceAlias,
            },
          });
        } catch (error) {
          reply.status(500).send({ error: 'Audit log could not be written.' });
          return;
        }

        const { error: writeDatasetErr } = await service.from('app_settings').upsert({
          key: datasetKey,
          value: {
            languageProfile: profile,
            revision: nextRevision,
            updatedAt: now,
            updatedBy: request.adminActor?.id ?? null,
            samples: mergedSamples,
          },
          updated_at: now,
          updated_by: request.adminActor?.id ?? null,
        });

        if (writeDatasetErr) {
          await trail.failed(writeDatasetErr.message);
          reply.status(500).send({ error: 'Failed to persist shared training samples.' });
          return;
        }

        // Update sample counts in shared vocabulary
        try {
          const vocabKey = `shared_vocabulary_${profile}`;
          const { data: vocabData } = await service
            .from('app_settings')
            .select('value')
            .eq('key', vocabKey)
            .maybeSingle();

          const currentVocab = (vocabData?.value as SharedVocabularyStore) ?? {
            languageProfile: profile,
            revision: 1,
            updatedAt: now,
            updatedBy: request.adminActor?.id ?? null,
            words: getDefaultVocabulary(profile),
          };

          // Count samples per wordId / label
          const countByWordId = new Map<string, number>();
          const countByLabel = new Map<string, number>();
          for (const s of mergedSamples) {
            countByWordId.set(s.wordId, (countByWordId.get(s.wordId) ?? 0) + 1);
            const lowerLabel = s.label.trim().toLowerCase();
            countByLabel.set(lowerLabel, (countByLabel.get(lowerLabel) ?? 0) + 1);
          }

          const updatedWords = currentVocab.words.map((w) => {
            const count = countByWordId.get(w.wordId) ?? countByLabel.get(w.normalizedKey) ?? w.sampleCount;
            return {
              ...w,
              sampleCount: count,
              status: count >= 5 && w.status === 'collecting' ? ('trained' as const) : w.status,
            };
          });

          await service.from('app_settings').upsert({
            key: vocabKey,
            value: {
              ...currentVocab,
              revision: currentVocab.revision + 1,
              updatedAt: now,
              updatedBy: request.adminActor?.id ?? null,
              words: updatedWords,
            },
            updated_at: now,
            updated_by: request.adminActor?.id ?? null,
          });
        } catch (vocabCountErr) {
          request.log.warn({ vocabCountErr }, 'Non-fatal: failed to update vocabulary sample counts');
        }

        await trail.succeeded(`Uploaded ${validSamples.length} consented samples for ${profile.toUpperCase()} (total: ${mergedSamples.length})`);

        reply.send({
          ok: true,
          uploaded: validSamples.length,
          total: mergedSamples.length,
          revision: nextRevision,
        });
      },
    );
  };
}
