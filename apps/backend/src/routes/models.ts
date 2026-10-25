/**
 * Published sign language recognition models and vocabulary distribution.
 *
 * ## Architecture and Role-Based Access Control
 *
 * This module enforces strict privilege boundaries:
 *
 * 1. Public reads (`GET /models/published/:languageProfile`, `GET /models/version/:languageProfile`):
 *    - Open to any client (Guest, Normal User, Admin).
 *    - Serves ONLY verified, published model packages and public vocabularies.
 *    - Never exposes private training samples, unapproved candidates, or admin logs.
 *    - Validates language profile matching (ISL, ASL, BSL).
 *
 * 2. Administrative writes (`POST /admin/models/publish`, `POST /admin/models/rollback`):
 *    - Gated by `requireAdmin` (valid server-verified Supabase session with `role = 'admin'`).
 *    - Requires mandatory explanation reason (min 3 chars) recorded in `admin_audit_log`.
 *    - Validates model package compatibility contract and evaluation metrics before publication.
 *    - Preserves previous valid published version for rollback.
 *    - Atomically updates the active published model in `app_settings`.
 */
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

        const vocabSize = Array.isArray(active.package?.vocabulary?.labelIds)
          ? active.package.vocabulary.labelIds.length
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

    /* ---------------------------------------------------------- admin writes */

    /**
     * Admin-only model publication endpoint.
     * Atomically publishes a validated model package, archives previous version,
     * and writes a complete audit record.
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
        const labelIds = Array.isArray(pkg.vocabulary?.labelIds)
          ? pkg.vocabulary.labelIds
          : Array.isArray(pkg.labelIds)
            ? pkg.labelIds
            : [];

        if (labelIds.length === 0) {
          reply.status(400).send({ error: 'Model package vocabulary must contain at least one sign label.' });
          return;
        }

        const evaluation = pkg.evaluation;
        if (!evaluation || typeof evaluation !== 'object' || evaluation.accuracy === null || evaluation.accuracy === undefined) {
          reply.status(400).send({ error: 'Cannot publish a model without valid held-out evaluation metrics.' });
          return;
        }

        // Validate language profile compatibility
        const contractLanguage = pkg.compatibilityContract?.languageProfile || pkg.languageProfile;
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
              accuracy: evaluation.accuracy,
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

        await trail.succeeded(`Published version ${version} with ${labelIds.length} signs (accuracy ${(evaluation.accuracy * 100).toFixed(1)}%)`);

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
        // The current active becomes rolled back, previous becomes active
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
  };
}
