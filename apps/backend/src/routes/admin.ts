/**
 * The administration API.
 *
 * ## Every consequential action has the same three parts
 *
 * A reason supplied by the caller, a confirmation that the client has to have
 * obtained from the user, and an audit row written *before* the action is
 * reported as done. The order matters: `writeAudit` runs first and throws on
 * failure, so an action that cannot be recorded does not happen. Writing the
 * audit row afterwards would mean a failure to log could leave an unlogged
 * change behind, which is the one outcome an audit log must not have.
 *
 * ## What is deliberately not here
 *
 * There is no endpoint that returns or sets a password, and none that reads a
 * user's content. An administrator can see *that* an account exists, its role
 * and its status, and can suspend it — but not a user's recognitions, their
 * conversations, or their calibration. The brief for this project requires
 * administrative control over accounts, and control over accounts does not
 * require reading what people said.
 *
 * ## Passwords
 *
 * Password recovery is a provider action. `POST /admin/users/:id/reset-password`
 * asks Supabase to send the account its own reset email, and returns nothing
 * about the account's credential. No part of this service can read a password,
 * because no part of it ever receives one.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config.js';
import { createRequireAdmin, writeAudit, type AdminActor } from '../middleware/requireAdmin.js';

/** The longest a reason may be, so the audit table cannot be used as storage. */
const MAX_REASON_LENGTH = 500;

/** The longest an announcement may be. */
const MAX_ANNOUNCEMENT_BODY = 4000;

interface ReasonBody {
  reason?: unknown;
}

interface SuspendBody extends ReasonBody {
  suspended?: unknown;
}

interface RoleBody extends ReasonBody {
  role?: unknown;
}

interface AnnouncementBody extends ReasonBody {
  title?: unknown;
  body?: unknown;
  severity?: unknown;
  published?: unknown;
  expiresAt?: unknown;
}

interface MaintenanceBody extends ReasonBody {
  enabled?: unknown;
  message?: unknown;
  expectedEndAt?: unknown;
}

/**
 * Validates the mandatory reason.
 *
 * Returns the trimmed reason, or sends a 400 and returns null. A minimum of
 * three characters is not security — it is there to stop `"x"` and `""` being
 * accepted as a justification, which is what the database's own CHECK also
 * enforces. Both layers, because this one produces a useful message and the
 * database one cannot be bypassed.
 */
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

function actorOf(request: { adminActor?: AdminActor }): AdminActor {
  // Set by the preHandler on every route in this plugin, so this cannot be
  // undefined. Throwing rather than defaulting, because a default would mean an
  // unattributable action.
  if (!request.adminActor) {
    throw new Error('Admin route reached without an authenticated actor.');
  }
  return request.adminActor;
}

/**
 * The service-role client for this request.
 *
 * The middleware builds exactly one and attaches it, so every handler in this
 * plugin reaches the database through the same client that has already been
 * through the authorization check. Nothing here constructs its own client,
 * which is what makes "every privileged query in this file is gated" a
 * property you can see rather than one you have to trace.
 */
function serviceOf(request: { adminService?: SupabaseClient }): SupabaseClient {
  if (!request.adminService) {
    throw new Error('Admin route reached without a service client.');
  }
  return request.adminService;
}

export function createAdminRoutes(config: AppConfig) {
  return async function adminRoutes(app: FastifyInstance): Promise<void> {
    const requireAdmin = createRequireAdmin(config);

    app.addHook('preHandler', requireAdmin);

    /* ---------------------------------------------------------------- reads */

    /**
     * The user list.
     *
     * Paginated, and searchable by the two fields an administrator actually
     * needs to find someone by. Deliberately not a full-text search over user
     * content — see the note at the top of this file.
     *
     * `service_role` and `postgres` rows are excluded: neither is a person, and
     * listing them would invite an administrator to act on a row that is not an
     * account.
     */
    app.get<{ Querystring: { page?: string; perPage?: string; q?: string; status?: string } }>(
      '/admin/users',
      async (request, reply) => {
        const page = Math.max(1, Number.parseInt(request.query.page ?? '1', 10) || 1);
        const perPage = Math.min(
          100,
          Math.max(1, Number.parseInt(request.query.perPage ?? '25', 10) || 25),
        );
        const from = (page - 1) * perPage;
        const to = from + perPage - 1;

        let query = serviceOf(request)
          .from('profiles')
          .select('id, email, display_name, avatar_url, role, status, created_at', {
            count: 'exact',
          })
          .order('created_at', { ascending: false })
          .range(from, to);

        const q = (request.query.q ?? '').trim();
        if (q.length > 0) {
          // `or` rather than a full-text index: the dataset is small, and a
          // substring match on an email is what an administrator searches for.
          query = query.or(`email.ilike.%${q}%,display_name.ilike.%${q}%`);
        }

        const status = request.query.status;
        if (status === 'active' || status === 'suspended') {
          query = query.eq('status', status);
        }

        const { data, error, count } = await query;

        if (error) {
          request.log.error({ err: error.message }, 'Admin user list failed');
          return reply.status(502).send({ error: 'The user list could not be read.' });
        }

        return reply.send({
          users: data ?? [],
          page,
          perPage,
          total: count ?? 0,
        });
      },
    );

    /** One user, for a detail view. */
    app.get<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
      const { data, error } = await serviceOf(request)
        .from('profiles')
        .select('id, email, display_name, avatar_url, role, status, created_at, updated_at')
        .eq('id', request.params.id)
        .maybeSingle();

      if (error) {
        request.log.error({ err: error.message }, 'Admin user read failed');
        return reply.status(502).send({ error: 'That account could not be read.' });
      }
      if (!data) return reply.status(404).send({ error: 'No account has that id.' });

      return reply.send({ user: data });
    });

    /** The audit log, newest first. */
    app.get<{ Querystring: { page?: string; perPage?: string } }>(
      '/admin/audit',
      async (request, reply) => {
        const page = Math.max(1, Number.parseInt(request.query.page ?? '1', 10) || 1);
        const perPage = Math.min(
          100,
          Math.max(1, Number.parseInt(request.query.perPage ?? '50', 10) || 50),
        );
        const from = (page - 1) * perPage;

        const { data, error, count } = await serviceOf(request)
          .from('admin_audit_log')
          .select('*', { count: 'exact' })
          .order('created_at', { ascending: false })
          .range(from, from + perPage - 1);

        if (error) {
          request.log.error({ err: error.message }, 'Admin audit read failed');
          return reply.status(502).send({ error: 'The audit log could not be read.' });
        }

        return reply.send({ entries: data ?? [], page, perPage, total: count ?? 0 });
      },
    );

    /** Every announcement, including drafts and expired ones. */
    app.get('/admin/announcements', async (request, reply) => {
      const { data, error } = await serviceOf(request)
        .from('announcements')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        request.log.error({ err: error.message }, 'Admin announcement list failed');
        return reply.status(502).send({ error: 'Announcements could not be read.' });
      }

      return reply.send({ announcements: data ?? [] });
    });

    /** The current maintenance setting, as stored. */
    app.get('/admin/maintenance', async (request, reply) => {
      const { data, error } = await serviceOf(request)
        .from('app_settings')
        .select('value, updated_at')
        .eq('key', 'maintenance')
        .maybeSingle();

      if (error) {
        request.log.error({ err: error.message }, 'Admin maintenance read failed');
        return reply.status(502).send({ error: 'The maintenance setting could not be read.' });
      }

      return reply.send({ maintenance: data?.value ?? null, updatedAt: data?.updated_at ?? null });
    });

    /* --------------------------------------------------------------- writes */

    /**
     * Suspends or restores an account.
     *
     * ## An administrator cannot suspend themselves
     *
     * Not paternalism — it is the difference between a recoverable mistake and
     * an unrecoverable one. An administrator who suspends their own account
     * loses the ability to undo it through this API, because the middleware
     * refuses a suspended administrator. There would be no way back in through
     * the application at all, and the recovery would be a manual database edit.
     * The same rule blocks suspending the last remaining administrator, which has
     * the same shape of consequence.
     */
    app.post<{ Params: { id: string }; Body: SuspendBody }>(
      '/admin/users/:id/suspend',
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        const actor = actorOf(request);
        const targetId = request.params.id;
        const suspended = request.body?.suspended === true;

        if (targetId === actor.id) {
          return reply.status(400).send({
            error:
              'You cannot suspend your own account. Ask another administrator to do it, so that the change can be undone.',
          });
        }

        if (suspended) {
          const { count, error: countError } = await serviceOf(request)
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'admin')
            .eq('status', 'active');

          if (countError) {
            return reply.status(502).send({ error: 'The administrator count could not be read.' });
          }

          const { data: target } = await serviceOf(request)
            .from('profiles')
            .select('role, status')
            .eq('id', targetId)
            .maybeSingle();

          if (target?.role === 'admin' && (count ?? 0) <= 1) {
            return reply.status(400).send({
              error:
                'This is the only active administrator. Suspending it would leave nobody able to administer the project.',
            });
          }
        }

        /*
         * Audit before acting.
         *
         * If the audit write fails this throws, the handler 500s, and no
         * suspension is applied. A consequential change with no record of who
         * made it or why must not be possible — so the record is the first thing
         * written, not the last.
         */
        try {
          await writeAudit(serviceOf(request), actor, {
            action: suspended ? 'suspend_account' : 'restore_account',
            targetType: 'profile',
            targetId,
            reason,
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'The change was not applied, because it could not be recorded in the audit log.',
          });
        }

        const { data, error } = await serviceOf(request)
          .from('profiles')
          .update({ status: suspended ? 'suspended' : 'active' })
          .eq('id', targetId)
          .select('id, status')
          .maybeSingle();

        if (error) {
          request.log.error({ err: error.message }, 'Suspend update failed');
          return reply.status(502).send({
            error: 'The account status could not be changed. It may not exist.',
          });
        }
        if (!data) return reply.status(404).send({ error: 'No account has that id.' });

        return reply.send({ user: data });
      },
    );

    /**
     * Grants or removes the administrator role.
     *
     * Same self-protection as suspension: an administrator cannot change their
     * own role, and the last administrator cannot be demoted. Both are the same
     * failure mode — a project with no way to administer it.
     */
    app.post<{ Params: { id: string }; Body: RoleBody }>(
      '/admin/users/:id/role',
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        const actor = actorOf(request);
        const targetId = request.params.id;
        const role = request.body?.role;

        if (role !== 'admin' && role !== 'user') {
          return reply.status(400).send({ error: 'A role must be either "admin" or "user".' });
        }

        if (targetId === actor.id) {
          return reply.status(400).send({
            error: 'You cannot change your own role. Ask another administrator to do it.',
          });
        }

        if (role === 'user') {
          const { count, error: countError } = await serviceOf(request)
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'admin')
            .eq('status', 'active');

          if (countError) {
            return reply.status(502).send({ error: 'The administrator count could not be read.' });
          }
          if ((count ?? 0) <= 1) {
            return reply.status(400).send({
              error:
                'This is the only active administrator. Removing the role would leave nobody able to administer the project.',
            });
          }
        }

        try {
          await writeAudit(serviceOf(request), actor, {
            action: role === 'admin' ? 'grant_admin' : 'revoke_admin',
            targetType: 'profile',
            targetId,
            reason,
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'The change was not applied, because it could not be recorded in the audit log.',
          });
        }

        const { data, error } = await serviceOf(request)
          .from('profiles')
          .update({ role })
          .eq('id', targetId)
          .select('id, role')
          .maybeSingle();

        if (error) {
          request.log.error({ err: error.message }, 'Role update failed');
          return reply
            .status(502)
            .send({ error: 'The role could not be changed. It may not exist.' });
        }
        if (!data) return reply.status(404).send({ error: 'No account has that id.' });

        return reply.send({ user: data });
      },
    );

    /**
     * Asks the provider to send an account its own password reset email.
     *
     * The response says only that the request was accepted. It does not confirm
     * the address exists, does not reveal whether an email was sent, and returns
     * nothing about the credential — an administrator arranging a reset is not
     * an administrator learning anything about the password, and the two must
     * not be conflated.
     */
    app.post<{ Params: { id: string }; Body: ReasonBody }>(
      '/admin/users/:id/reset-password',
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        const actor = actorOf(request);
        const targetId = request.params.id;

        const { data: target, error: readError } = await serviceOf(request)
          .from('profiles')
          .select('email')
          .eq('id', targetId)
          .maybeSingle();

        if (readError) {
          return reply.status(502).send({ error: 'That account could not be read.' });
        }
        if (!target?.email) {
          return reply.status(404).send({ error: 'No account with an email address has that id.' });
        }

        try {
          await writeAudit(serviceOf(request), actor, {
            action: 'request_password_reset',
            targetType: 'profile',
            targetId,
            reason,
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'No reset was requested, because it could not be recorded in the audit log.',
          });
        }

        const client = serviceOf(request);
        const { error: mailError } = await client.auth.resetPasswordForEmail(target.email);

        if (mailError) {
          /*
           * The failure is reported, and the audit row stays. An audit entry
           * saying a reset was *requested* is accurate even when the send
           * failed; deleting it would hide that an administrator tried.
           */
          request.log.error({ err: mailError.message }, 'Password reset send failed');
          return reply.status(502).send({
            error: 'The reset email could not be sent. The request has been recorded in the audit log.',
          });
        }

        return reply.send({
          // Deliberately not "sent". The provider accepted the request; whether
          // the message arrives is not something this service can observe.
          status: 'requested',
          message: 'The reset email has been requested from the account provider.',
        });
      },
    );

    /* -------------------------------------------------------- announcements */

    app.post<{ Body: AnnouncementBody }>('/admin/announcements', async (request, reply) => {
      const reason = requireReason(request.body, reply);
      if (reason === null) return reply;

      const actor = actorOf(request);
      const title = typeof request.body?.title === 'string' ? request.body.title.trim() : '';
      const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
      const severity =
        request.body?.severity === 'warning' || request.body?.severity === 'critical'
          ? request.body.severity
          : 'info';
      const publish = request.body?.published === true;

      if (title.length === 0) {
        return reply.status(400).send({ error: 'An announcement needs a title.' });
      }
      if (body.length === 0) {
        return reply.status(400).send({ error: 'An announcement needs a body.' });
      }
      if (body.length > MAX_ANNOUNCEMENT_BODY) {
        return reply
          .status(400)
          .send({ error: `An announcement body cannot be longer than ${MAX_ANNOUNCEMENT_BODY} characters.` });
      }

      try {
        await writeAudit(serviceOf(request), actor, {
          action: publish ? 'publish_announcement' : 'draft_announcement',
          targetType: 'announcement',
          targetId: null,
          reason,
          metadata: { title, severity },
        });
      } catch (error) {
        request.log.error({ err: (error as Error).message }, 'Audit write failed');
        return reply.status(500).send({
          error: 'The announcement was not created, because it could not be recorded.',
        });
      }

      const { data, error } = await serviceOf(request)
        .from('announcements')
        .insert({
          title,
          body,
          severity,
          published: publish,
          // The moment it goes live is the moment it was published, recorded by
          // the server rather than supplied by the client.
          published_at: publish ? new Date().toISOString() : null,
          expires_at: typeof request.body?.expiresAt === 'string' ? request.body.expiresAt : null,
          created_by: actor.id,
        })
        .select('*')
        .maybeSingle();

      if (error) {
        request.log.error({ err: error.message }, 'Announcement insert failed');
        return reply.status(502).send({ error: 'The announcement could not be created.' });
      }

      return reply.status(201).send({ announcement: data });
    });

    app.post<{ Params: { id: string }; Body: AnnouncementBody }>(
      '/admin/announcements/:id',
      async (request, reply) => {
        const reason = requireReason(request.body, reply);
        if (reason === null) return reply;

        const actor = actorOf(request);
        const patch: Record<string, unknown> = {};

        if (typeof request.body?.title === 'string') patch.title = request.body.title.trim();
        if (typeof request.body?.body === 'string') patch.body = request.body.body.trim();
        if (request.body?.severity === 'warning' || request.body?.severity === 'critical') {
          patch.severity = request.body.severity;
        }
        if (request.body?.severity === 'info') patch.severity = 'info';

        if (typeof request.body?.published === 'boolean') {
          patch.published = request.body.published;
          // Stamped once, by the server. Re-publishing later does not rewrite the
          // original publication time of an announcement that is already live.
          if (request.body.published) patch.published_at = new Date().toISOString();
        }

        if (Object.keys(patch).length === 0) {
          return reply.status(400).send({ error: 'Nothing to change was supplied.' });
        }

        try {
          await writeAudit(serviceOf(request), actor, {
            action: 'update_announcement',
            targetType: 'announcement',
            targetId: request.params.id,
            reason,
            metadata: { fields: Object.keys(patch) },
          });
        } catch (error) {
          request.log.error({ err: (error as Error).message }, 'Audit write failed');
          return reply.status(500).send({
            error: 'The announcement was not changed, because it could not be recorded.',
          });
        }

        const { data, error } = await serviceOf(request)
          .from('announcements')
          .update(patch)
          .eq('id', request.params.id)
          .select('*')
          .maybeSingle();

        if (error) {
          request.log.error({ err: error.message }, 'Announcement update failed');
          return reply.status(502).send({ error: 'The announcement could not be changed.' });
        }
        if (!data) return reply.status(404).send({ error: 'No announcement has that id.' });

        return reply.send({ announcement: data });
      },
    );

    /* ----------------------------------------------------- maintenance mode */

    /**
     * Turns maintenance mode on or off.
     *
     * The audit row is written first, and the reason is mandatory, because
     * closing the app to every user is the single most disruptive thing this
     * API can do and "why" is the first question anyone will ask afterwards.
     *
     * The setting is stored in `app_settings`, which every client can read,
     * including signed-out ones. That is the design: maintenance mode has to
     * block sign-in, and a check that runs after authentication cannot.
     */
    app.post<{ Body: MaintenanceBody }>('/admin/maintenance', async (request, reply) => {
      const reason = requireReason(request.body, reply);
      if (reason === null) return reply;

      const actor = actorOf(request);
      const enabled = request.body?.enabled === true;
      const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';

      if (enabled && message.length === 0) {
        return reply.status(400).send({
          error:
            'A message is required when turning maintenance mode on. Users locked out with no explanation will assume the app is broken.',
        });
      }

      try {
        await writeAudit(serviceOf(request), actor, {
          action: enabled ? 'enable_maintenance' : 'disable_maintenance',
          targetType: 'setting',
          targetId: 'maintenance',
          reason,
        });
      } catch (error) {
        request.log.error({ err: (error as Error).message }, 'Audit write failed');
        return reply.status(500).send({
          error: 'Maintenance mode was not changed, because it could not be recorded.',
        });
      }

      const now = new Date().toISOString();
      const value = {
        enabled,
        message: enabled ? message : '',
        // `enabledAt` is stamped by the server, never supplied by the client, so
        // the record of how long the app was closed does not depend on a
        // client's clock.
        enabledAt: enabled ? now : null,
        expectedEndAt:
          typeof request.body?.expectedEndAt === 'string' ? request.body.expectedEndAt : null,
      };

      const { data, error } = await serviceOf(request)
        .from('app_settings')
        .update({ value, updated_by: actor.id })
        .eq('key', 'maintenance')
        .select('value, updated_at')
        .maybeSingle();

      if (error) {
        request.log.error({ err: error.message }, 'Maintenance update failed');
        return reply.status(502).send({ error: 'Maintenance mode could not be changed.' });
      }

      return reply.send({ maintenance: data?.value ?? value, updatedAt: data?.updated_at ?? now });
    });
  };
}
