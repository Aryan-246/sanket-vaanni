/**
 * Team and About content.
 *
 * ## Why writes live in a new module
 *
 * The administration routes are one large plugin and the database policy work
 * is owned elsewhere. Team content is a small, self-contained capability — a
 * public read, and four administrator writes — so it is registered as its own
 * plugin with its own tests. That keeps it out of the file another workstream
 * is actively editing without weakening anything: it uses the same
 * `requireAdmin` guard, the same audit pair, and the same service client.
 *
 * ## Public read, administrator write, no client write at all
 *
 * `GET /team` returns published rows only. The table has an RLS policy for
 * `anon`/`authenticated` that says the same thing, but the backend reads with
 * the service role and therefore does not rely on that policy — the filter is
 * written here explicitly, so "published" cannot become an accident of which
 * key a deployment happens to hold.
 *
 * ## Photos
 *
 * A photo is stored in the public `team-media` bucket and referenced by path.
 * The path is validated against the bucket's folder. When a row is updated or
 * deleted, the previous object is removed; a failure to remove it is recorded
 * in the audit row rather than turned into an HTTP failure, because the row is
 * the source of truth and an orphaned object is a cleanup problem, not a
 * failed edit.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config.js';
import { beginAction, type AuditTrail } from '../audit/trail.js';
import {
  createRequireAdmin,
  type AdminAuthDeps,
} from '../middleware/requireAdmin.js';

const MAX_REASON_LENGTH = 500;
const MAX_NAME = 120;
const MAX_ROLE = 120;
const MAX_BIO = 2000;

/** The same shape the database CHECK enforces. */
const PHOTO_PATH = /^team-media\/[A-Za-z0-9._/-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ReasonBody {
  reason?: unknown;
}

interface TeamBody extends ReasonBody {
  name?: unknown;
  role?: unknown;
  bio?: unknown;
  photoPath?: unknown;
  sortOrder?: unknown;
  published?: unknown;
}

export interface TeamRouteDeps extends AdminAuthDeps {
  /**
   * Used by the public read. In production this is built from configuration;
   * tests inject it so no credentials are needed.
   */
  serviceClient?: SupabaseClient;
}

interface MemberRow {
  id: string;
  name: string;
  role: string;
  bio: string;
  photo_path: string | null;
  sort_order: number;
  published: boolean;
  created_at: string;
  updated_at: string;
}

function memberOf(row: Record<string, unknown>): MemberRow {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role),
    bio: typeof row.bio === 'string' ? row.bio : '',
    photo_path: typeof row.photo_path === 'string' ? row.photo_path : null,
    sort_order: Number(row.sort_order ?? 0),
    published: row.published === true,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

function requireReason(body: ReasonBody | undefined, reply: FastifyReply): string | null {
  const raw = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (raw.length < 3) {
    reply.status(400).send({
      error:
        'A reason is required for every administrative action. Write at least a few words explaining why.',
    });
    return null;
  }
  if (raw.length > MAX_REASON_LENGTH) {
    reply.status(400).send({ error: `A reason cannot be longer than ${MAX_REASON_LENGTH} characters.` });
    return null;
  }
  return raw;
}

function serviceOf(request: { adminService?: SupabaseClient }): SupabaseClient {
  if (!request.adminService) throw new Error('Team route reached without a service client.');
  return request.adminService;
}

type FieldResult = { ok: true; value: string | null } | { ok: false; message: string };

/** Trims a required text field and enforces its length. */
function requiredText(raw: unknown, label: string, max: number): FieldResult {
  if (typeof raw !== 'string') return { ok: false, message: `${label} is required.` };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, message: `${label} is required.` };
  if (value.length > max) {
    return { ok: false, message: `${label} cannot be longer than ${max} characters.` };
  }
  return { ok: true, value };
}

function optionalBio(raw: unknown): FieldResult {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, message: 'The bio must be text.' };
  const value = raw.trim();
  if (value.length > MAX_BIO) {
    return { ok: false, message: `A bio cannot be longer than ${MAX_BIO} characters.` };
  }
  return { ok: true, value };
}

function optionalPhoto(raw: unknown): FieldResult {
  if (raw === undefined) return { ok: true, value: null };
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, message: 'The photo path must be text.' };
  }
  const value = raw.trim();
  if (!PHOTO_PATH.test(value)) {
    return {
      ok: false,
      message: 'A team photo must be stored in the team-media bucket.',
    };
  }
  return { ok: true, value };
}

/**
 * Removes a team photo that no row references any more.
 *
 * Exported for its own tests: the decision "which paths need removing" is the
 * part that can be wrong, and it is easier to prove without a storage server.
 */
export async function removeTeamPhotos(
  service: SupabaseClient,
  request: { log: { error: (obj: object, msg: string) => void } },
  paths: (string | null | undefined)[],
): Promise<string | null> {
  const unique = [...new Set(paths.filter((p): p is string => typeof p === 'string' && p.length > 0))];
  if (unique.length === 0) return null;

  try {
    const { error } = await service.storage.from('team-media').remove(unique);
    if (error) throw new Error(error.message);
    return null;
  } catch (error) {
    request.log.error(
      { err: (error as Error).message, count: unique.length },
      'Team media cleanup failed; the row changed but its old photo remains',
    );
    return `photo cleanup failed: ${(error as Error).message}`.slice(0, 500);
  }
}

export function createTeamRoutes(config: AppConfig, deps: TeamRouteDeps = {}) {
  const requireAdmin = createRequireAdmin(config, deps);

  /*
   * The public read does not need a caller, only a database. This client is
   * built once, and is null when the project is not configured — in which case
   * the route says so instead of answering with an empty list, because "no team
   * members" and "the backend cannot reach its database" are different facts.
   */
  const publicService =
    deps.serviceClient ??
    (config.supabaseUrl && config.supabaseServiceRoleKey
      ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null);

  return async function teamRoutes(app: FastifyInstance): Promise<void> {
    /* ------------------------------------------------------------ public */

    app.get('/team', async (_request, reply) => {
      if (!publicService) {
        return reply.status(503).send({
          error:
            'The team content API needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be configured.',
        });
      }

      const { data, error } = await publicService
        .from('team_members')
        .select('id,name,role,bio,photo_path,sort_order,published,created_at,updated_at')
        .eq('published', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });

      if (error) {
        return reply.status(502).send({ error: 'The team content could not be read.' });
      }

      return reply.send({ members: (data ?? []).map(memberOf) });
    });

    /* ------------------------------------------------------------- admin */

    app.get('/admin/team', { preHandler: requireAdmin }, async (request, reply) => {
      const { data, error } = await serviceOf(request)
        .from('team_members')
        .select('id,name,role,bio,photo_path,sort_order,published,created_at,updated_at')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });

      if (error) {
        request.log.error({ err: error.message }, 'Team list read failed');
        return reply.status(502).send({ error: 'The team content could not be read.' });
      }

      return reply.send({ members: (data ?? []).map(memberOf) });
    });

    app.post<{ Body: TeamBody }>('/admin/team', { preHandler: requireAdmin }, async (request, reply) => {
      const reason = requireReason(request.body, reply);
      if (reason === null) return reply;

      const name = requiredText(request.body?.name, 'A name', MAX_NAME);
      const role = requiredText(request.body?.role, 'A role', MAX_ROLE);
      const bio = optionalBio(request.body?.bio);
      const photo = optionalPhoto(request.body?.photoPath);

      if (!name.ok) return reply.status(400).send({ error: name.message });
      if (!role.ok) return reply.status(400).send({ error: role.message });
      if (!bio.ok) return reply.status(400).send({ error: bio.message });
      if (!photo.ok) return reply.status(400).send({ error: photo.message });

      const sortOrder =
        typeof request.body?.sortOrder === 'number' && Number.isInteger(request.body.sortOrder)
          ? request.body.sortOrder
          : 0;

      let trail: AuditTrail;
      try {
        trail = await beginAction(request, {
          action: 'create_team_member',
          targetType: 'team_member',
          targetId: null,
          reason,
          metadata: { name: name.value },
        });
      } catch (error) {
        request.log.error({ err: (error as Error).message }, 'Audit write failed');
        return reply.status(500).send({
          error: 'The team member was not created, because it could not be recorded.',
        });
      }

      const { data, error } = await serviceOf(request)
        .from('team_members')
        .insert({
          name: name.value,
          role: role.value,
          bio: bio.value,
          photo_path: photo.value,
          sort_order: sortOrder,
          published: request.body?.published === true,
        })
        .select('*')
        .maybeSingle();

      if (error || !data) {
        request.log.error({ err: error?.message }, 'Team member insert failed');
        await trail.failed(error?.message ?? 'no row returned');
        return reply.status(502).send({ error: 'The team member could not be created.' });
      }

      await trail.succeeded();
      return reply.status(201).send({ member: memberOf(data) });
    });

    app.patch<{ Params: { id: string }; Body: TeamBody }>(
      '/admin/team/:id',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        if (!UUID.test(request.params.id)) {
          return reply.status(400).send({ error: 'That is not a valid team member id.' });
        }

        const service = serviceOf(request);

        const { data: existing, error: readError } = await service
          .from('team_members')
          .select('*')
          .eq('id', request.params.id)
          .maybeSingle();

        if (readError) {
          return reply.status(502).send({ error: 'The team member could not be read.' });
        }
        if (!existing) {
          return reply.status(404).send({ error: 'That team member does not exist.' });
        }

        /* Only fields present in the request are written. An omitted field is
           "leave it alone", which is not the same as "set it to empty". */
        const patch: Record<string, unknown> = {};

        if (request.body?.name !== undefined) {
          const name = requiredText(request.body.name, 'A name', MAX_NAME);
          if (!name.ok) return reply.status(400).send({ error: name.message });
          patch.name = name.value;
        }
        if (request.body?.role !== undefined) {
          const role = requiredText(request.body.role, 'A role', MAX_ROLE);
          if (!role.ok) return reply.status(400).send({ error: role.message });
          patch.role = role.value;
        }
        if (request.body?.bio !== undefined) {
          const bio = optionalBio(request.body.bio);
          if (!bio.ok) return reply.status(400).send({ error: bio.message });
          patch.bio = bio.value;
        }
        if (request.body?.photoPath !== undefined) {
          const photo = optionalPhoto(request.body.photoPath);
          if (!photo.ok) return reply.status(400).send({ error: photo.message });
          patch.photo_path = photo.value;
        }
        if (request.body?.sortOrder !== undefined) {
          if (
            typeof request.body.sortOrder !== 'number' ||
            !Number.isInteger(request.body.sortOrder)
          ) {
            return reply.status(400).send({ error: 'The order must be a whole number.' });
          }
          patch.sort_order = request.body.sortOrder;
        }
        if (request.body?.published !== undefined) {
          if (typeof request.body.published !== 'boolean') {
            return reply.status(400).send({ error: 'Published must be true or false.' });
          }
          patch.published = request.body.published;
        }

        if (Object.keys(patch).length === 0) {
          return reply.status(400).send({ error: 'There is nothing to change.' });
        }

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'update_team_member',
            targetType: 'team_member',
            targetId: request.params.id,
            reason,
            metadata: { fields: Object.keys(patch) },
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'The team member was not changed, because it could not be recorded.',
          });
        }

        const { data, error } = await service
          .from('team_members')
          .update(patch)
          .eq('id', request.params.id)
          .select('*')
          .maybeSingle();

        if (error || !data) {
          request.log.error({ err: error?.message }, 'Team member update failed');
          await trail.failed(error?.message ?? 'no row returned');
          return reply.status(502).send({ error: 'The team member could not be changed.' });
        }

        /*
         * Cleanup only after the row points somewhere else. If the new update
         * had failed, the old photo would still be in use and removing it here
         * would leave a broken portrait on the About screen.
         */
        let cleanupDetail: string | null = null;
        if (patch.photo_path !== undefined && existing.photo_path !== data.photo_path) {
          cleanupDetail = await removeTeamPhotos(service, request, [existing.photo_path as string | null]);
        }

        await trail.succeeded(cleanupDetail ?? undefined);
        return reply.send({ member: memberOf(data), cleanup: cleanupDetail });
      },
    );

    app.delete<{ Params: { id: string }; Body: ReasonBody }>(
      '/admin/team/:id',
      { preHandler: requireAdmin },
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        if (!UUID.test(request.params.id)) {
          return reply.status(400).send({ error: 'That is not a valid team member id.' });
        }

        const service = serviceOf(request);

        const { data: existing, error: readError } = await service
          .from('team_members')
          .select('id,name,photo_path')
          .eq('id', request.params.id)
          .maybeSingle();

        if (readError) {
          return reply.status(502).send({ error: 'The team member could not be read.' });
        }
        if (!existing) {
          return reply.status(404).send({ error: 'That team member does not exist.' });
        }

        let trail: AuditTrail;
        try {
          trail = await beginAction(request, {
            action: 'delete_team_member',
            targetType: 'team_member',
            targetId: request.params.id,
            reason,
            metadata: { name: existing.name },
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'The team member was not deleted, because it could not be recorded.',
          });
        }

        const { error } = await service
          .from('team_members')
          .delete()
          .eq('id', request.params.id);

        if (error) {
          request.log.error({ err: error.message }, 'Team member delete failed');
          await trail.failed(error.message);
          return reply.status(502).send({ error: 'The team member could not be deleted.' });
        }

        const cleanupDetail = await removeTeamPhotos(service, request, [
          existing.photo_path as string | null,
        ]);

        await trail.succeeded(cleanupDetail ?? undefined);
        return reply.send({ deleted: true, cleanup: cleanupDetail });
      },
    );
  };
}
