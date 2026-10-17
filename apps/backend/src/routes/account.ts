/**
 * Ordinary-account API.
 *
 * ## The one route that deletes an account
 *
 * Account deletion is not a client-side confirmation dialog. It is:
 *
 *   1. a request from the authenticated account's own token (the body cannot
 *      name a different account),
 *   2. a single-use, ten-minute code sent to the address the provider says is
 *      verified,
 *   3. an atomic claim of that code (expiry, attempt count and replay are
 *      decided in one transaction in `claim_deletion_challenge`),
 *   4. a re-read of the owner and last-administrator guards,
 *   5. removal of the account's own storage objects,
 *   6. deletion of the Auth identity, whose cascade removes the profile and all
 *      user rows, with the database trigger as a second owner guard,
 *   7. an audit pair recording that the account asked to be deleted and that it
 *      was.
 *
 * `delete_user_account()` in SQL no longer deletes anything. An older client
 * that still calls it receives an explanation instead of a silent deletion.
 *
 * ## What this route refuses to pretend
 *
 * `sendTransactionalEmail` reporting `accepted: true` means the SMTP server
 * accepted the message, not that it reached an inbox. The response says the
 * code was sent; the audit records the attempt; no part of this code claims
 * delivery was confirmed.
 */
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config.js';
import { createRequireUser, type UserAuthDeps } from '../middleware/requireUser.js';
import {
  isEmailConfigured,
  sendTransactionalEmail,
  type EmailDeliveryResult,
  type SendEmailOptions,
} from '../services/email.js';

/** How long a code remains usable. */
const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * The shortest gap between two code requests for one account.
 *
 * The five-attempt ceiling is not duplicated here: `claim_deletion_challenge`
 * counts attempts inside the same transaction that compares the hash, so a
 * concurrent burst cannot slip past a check made in application code.
 */
const RESEND_COOLDOWN_MS = 60 * 1000;

export interface AccountRouteDeps extends UserAuthDeps {
  /** Injected by tests so no real email leaves the process. */
  sendEmail?: (options: SendEmailOptions) => Promise<EmailDeliveryResult>;
  emailConfigured?: () => boolean;
  /** Injected by tests so a code can be known without reading a mailbox. */
  generateCode?: () => string;
  /** Injected by tests for deterministic expiry decisions. */
  now?: () => number;
  /** Overrides the HMAC key. Tests use a fixed value; production uses config. */
  codePepper?: string;
}

interface ConfirmBody {
  code?: unknown;
}

function codeOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return /^\d{6}$/.test(trimmed) ? trimmed : null;
}

function hashCode(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code).digest('hex');
}

/**
 * Whether the account is protected from its own deletion.
 *
 * Returns the sentence to send, or null when deletion may proceed. The
 * database repeats both checks — the profile trigger and the redefined RPC —
 * so this is the readable refusal, not the only barrier.
 */
async function deletionBlock(
  service: SupabaseClient,
  userId: string,
): Promise<{ status: number; message: string } | null> {
  const { data: profile, error } = await service
    .from('profiles')
    .select('is_owner, role, status')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    return {
      status: 502,
      message: 'The account record could not be read, so nothing was deleted.',
    };
  }

  if (profile?.is_owner === true) {
    return {
      status: 409,
      message:
        'This is the permanent owner account. It cannot be deleted; transfer ownership deliberately first if that is really intended.',
    };
  }

  if (profile?.role === 'admin' && profile?.status === 'active') {
    const { count, error: countError } = await service
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('status', 'active');

    if (countError) {
      return {
        status: 502,
        message: 'The administrator count could not be read, so nothing was deleted.',
      };
    }
    if ((count ?? 0) <= 1) {
      return {
        status: 409,
        message:
          'This is the only active administrator. Deleting it would leave nobody able to administer the project.',
      };
    }
  }

  return null;
}

async function writeDeletionAudit(
  service: SupabaseClient,
  userId: string,
  requestId: string,
  outcome: 'requested' | 'succeeded' | 'failed',
  detail?: string,
): Promise<void> {
  const { error } = await service.from('admin_audit_log').insert({
    // The account being deleted is the actor. When the deletion succeeds the
    // FK sets this to NULL, which is the honest record: the person no longer
    // has a profile. No email is retained.
    actor_id: outcome === 'succeeded' ? null : userId,
    actor_email: null,
    action: 'self_delete_account',
    target_type: 'profile',
    target_id: userId,
    reason: 'User confirmed permanent account deletion with a single-use emailed code',
    metadata: {
      outcome,
      requestId,
      channel: 'email_otp',
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
    },
  });

  /*
   * A failed insert is surfaced rather than ignored: the caller decides whether
   * that aborts the deletion (before it) or is only logged (after it).
   */
  if (error) throw new Error(error.message);
}

export function createAccountRoutes(config: AppConfig, deps: AccountRouteDeps = {}) {
  const requireUser = createRequireUser(config, deps);
  const sendEmail = deps.sendEmail ?? sendTransactionalEmail;
  const emailConfigured = deps.emailConfigured ?? isEmailConfigured;
  const generateCode = deps.generateCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'));
  const now = deps.now ?? (() => Date.now());

  /*
   * The pepper is what stops a six-digit code from being recoverable by hashing
   * all one million candidates if the challenge table were ever read. In
   * production it must come from configuration; a missing secret disables the
   * route rather than falling back to an unkeyed hash. In development a
   * per-process random value is used, which is enough for a local stack and is
   * never stable across restarts — a restart therefore invalidates old codes,
   * which is the safe direction.
   */
  const pepper = deps.codePepper ?? config.apiInternalSecret ?? randomBytes(32).toString('hex');

  return async function accountRoutes(app: FastifyInstance): Promise<void> {
    /**
     * Step 1: send a code to the account's verified address.
     *
     * The response never contains the code. The challenge row is removed if the
     * mail cannot be handed to SMTP, so a "sent" response is never given for a
     * code the user could not have received.
     */
    app.post('/account/deletion/request', { preHandler: requireUser }, async (request, reply) => {
      const user = request.authUser!;
      const service = request.authService!;

      if (user.email === null || user.emailConfirmedAt === null) {
        return reply.status(403).send({
          error:
            'This account has no verified email address. Verify it before requesting deletion.',
        });
      }

      if (config.nodeEnv === 'production' && !config.apiInternalSecret && !deps.codePepper) {
        return reply.status(503).send({
          error:
            'Account deletion is disabled until API_INTERNAL_SECRET is configured, because the confirmation code cannot be keyed securely without it.',
        });
      }

      const block = await deletionBlock(service, user.id);
      if (block) return reply.status(block.status).send({ error: block.message });

      if (!emailConfigured()) {
        return reply.status(503).send({
          error:
            'Email is not configured on this server, so a confirmation code cannot be sent. Nothing was deleted.',
        });
      }

      const { data: latest, error: latestError } = await service
        .from('account_deletion_challenges')
        .select('created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestError) {
        return reply.status(502).send({
          error: 'The previous code could not be checked, so no new code was sent.',
        });
      }

      if (latest?.created_at) {
        const elapsed = now() - Date.parse(String(latest.created_at));
        if (elapsed >= 0 && elapsed < RESEND_COOLDOWN_MS) {
          const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
          return reply.status(429).send({
            error: `A code was sent moments ago. Wait ${retryAfter} seconds before asking for another.`,
            retryAfterSeconds: retryAfter,
          });
        }
      }

      const code = generateCode();
      const expiresAt = new Date(now() + CODE_TTL_MS).toISOString();

      const { error: insertError } = await service
        .from('account_deletion_challenges')
        .insert({ user_id: user.id, code_hash: hashCode(code, pepper), expires_at: expiresAt });

      if (insertError) {
        return reply.status(502).send({
          error: 'The confirmation code could not be recorded, so nothing was sent.',
        });
      }

      const result = await sendEmail({
        to: user.email,
        subject: 'Confirm deletion of your Sanket Vaanni account',
        text:
          `Your Sanket Vaanni confirmation code is: ${code}\n\n` +
          `It expires in 10 minutes and can be used once.\n\n` +
          `Enter it in the app to delete this account permanently. If you did not ask to delete ` +
          `your account, ignore this message: nothing has been changed and the code will expire.\n\n` +
          `Do not share this code with anyone.\n`,
        html:
          `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px">` +
          `<h2 style="color:#0f172a;margin:0 0 12px">Confirm account deletion</h2>` +
          `<p style="color:#334155;line-height:1.5">Enter this code in the Sanket Vaanni app to delete your account permanently.</p>` +
          `<p style="font-size:32px;letter-spacing:8px;font-weight:700;color:#0f172a;background:#f1f5f9;padding:16px 20px;border-radius:8px;text-align:center">${code}</p>` +
          `<p style="color:#64748b;font-size:13px;line-height:1.5">The code expires in 10 minutes and can be used once. If you did not ask to delete your account, ignore this message — nothing has been changed and the code will expire. Do not share this code with anyone.</p>` +
          `</div>`,
      });

      if (!result.accepted) {
        // No usable code may outlive the failure. Deleting the row keeps a
        // retry from hitting the resend cooldown for a message that never left.
        await service.from('account_deletion_challenges').delete().eq('user_id', user.id);
        return reply.status(502).send({
          error:
            'The confirmation email could not be handed to the mail server. Nothing was deleted; try again shortly.',
        });
      }

      return reply.status(202).send({ status: 'sent', expiresAt });
    });

    /**
     * Step 2: verify the code and delete the account.
     *
     * The code is claimed atomically before any deletion starts. If a later
     * step fails, the claim is released so the same code can be retried inside
     * its window; that is what makes a partial failure safe to repeat.
     */
    app.post('/account/deletion/confirm', { preHandler: requireUser }, async (request, reply) => {
      const user = request.authUser!;
      const service = request.authService!;

      const code = codeOf((request.body as ConfirmBody | undefined)?.code);
      if (code === null) {
        return reply.status(400).send({ error: 'Enter the six-digit code from the email.' });
      }

      const block = await deletionBlock(service, user.id);
      if (block) return reply.status(block.status).send({ error: block.message });

      const { data: claimed, error: claimError } = await service.rpc('claim_deletion_challenge', {
        p_user_id: user.id,
        p_code_hash: hashCode(code, pepper),
      });

      if (claimError) {
        return reply.status(502).send({
          error: 'The code could not be checked, so nothing was deleted.',
        });
      }

      switch (claimed) {
        case 'ok':
          break;
        case 'missing':
          return reply.status(400).send({
            error: 'No deletion request is waiting. Ask for a new code first.',
          });
        case 'expired':
          return reply.status(400).send({
            error: 'That code has expired. Ask for a new one.',
          });
        case 'too_many':
          return reply.status(429).send({
            error: 'Too many incorrect attempts. Ask for a new code.',
          });
        case 'mismatch':
        default:
          return reply.status(400).send({
            error: 'That code is not correct. Check the email and try again.',
          });
      }

      /*
       * Releasing a claim is target-specific. PostgREST cannot combine UPDATE
       * with ORDER BY/LIMIT, and clearing every row would re-open codes that
       * were correctly rejected earlier, so the id of the most recently
       * consumed challenge is looked up first. That is exactly the row this
       * request claimed: the claim function consumes the newest unconsumed one,
       * and consumption is serialised by `FOR UPDATE`.
       */
      const releaseClaim = async (): Promise<void> => {
        const { data: consumed } = await service
          .from('account_deletion_challenges')
          .select('id')
          .eq('user_id', user.id)
          .not('consumed_at', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (consumed?.id) {
          await service
            .from('account_deletion_challenges')
            .update({ consumed_at: null })
            .eq('id', consumed.id);
        }
      };

      /*
       * Storage first. If it fails, the account still exists and the code can
       * be retried. Doing it after the Auth deletion would leave files with no
       * owner and no way for the user to reach them.
       */
      try {
        const { data: files, error: listError } = await service.storage
          .from('avatars')
          .list(user.id, { limit: 1000 });
        if (listError) throw new Error(listError.message);

        const paths = (files ?? [])
          .map((file) => file.name)
          .filter((name): name is string => typeof name === 'string' && name.length > 0)
          .map((name) => `${user.id}/${name}`);

        if (paths.length > 0) {
          const { error: removeError } = await service.storage.from('avatars').remove(paths);
          if (removeError) throw new Error(removeError.message);
        }
      } catch (error) {
        await releaseClaim();
        request.log.error(
          { err: (error as Error).message },
          'Account deletion stopped: owned storage could not be removed',
        );
        return reply.status(502).send({
          error:
            'Your uploaded files could not be removed, so the account was not deleted. Nothing was lost; try again.',
        });
      }

      const requestId = randomUUID();
      try {
        await writeDeletionAudit(service, user.id, requestId, 'requested');
      } catch (error) {
        await releaseClaim();
        request.log.error(
          { err: (error as Error).message },
          'Account deletion stopped: audit request row could not be written',
        );
        return reply.status(500).send({
          error: 'The account was not deleted, because the attempt could not be recorded.',
        });
      }

      const { error: deleteError } = await service.auth.admin.deleteUser(user.id);
      if (deleteError) {
        await releaseClaim();
        try {
          await writeDeletionAudit(service, user.id, requestId, 'failed', deleteError.message);
        } catch (auditError) {
          request.log.error(
            { err: (auditError as Error).message },
            'Account deletion failed and the failure outcome could not be recorded',
          );
        }
        request.log.error({ err: deleteError.message }, 'Account deletion failed at the Auth provider');
        return reply.status(502).send({
          error:
            'The account could not be deleted at the authentication provider. Nothing was removed; try again.',
        });
      }

      // Best effort: the deletion has already happened, and the audit table is
      // append-only, so a failed outcome row must not turn a completed deletion
      // into a 500 that invites a retry.
      try {
        await writeDeletionAudit(service, user.id, requestId, 'succeeded');
      } catch (error) {
        request.log.error(
          { err: (error as Error).message },
          'Account was deleted but the audit outcome row could not be written',
        );
      }

      return reply.send({ status: 'deleted' });
    });
  };
}
