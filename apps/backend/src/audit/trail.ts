/**
 * An audited administrative action, in two halves.
 *
 * ## Why an action needs two rows
 *
 * `writeAudit` records that an action was *asked for*, before it is attempted,
 * because a consequential change that happens with no record of it is the one
 * thing an audit log must never permit. That ordering has an unavoidable
 * consequence: at the moment the row is written, whether the action will work is
 * not yet known.
 *
 * Recording the request as though it had succeeded closes that gap dishonestly.
 * An administrator suspends an account, the `UPDATE` fails on a connection
 * error, the caller is told it failed, and the log says the account was
 * suspended — a record that is not merely incomplete but wrong, and wrong in the
 * direction that matters, because the log is what someone trusts when they
 * cannot otherwise be sure what happened.
 *
 * So the outcome is appended as a second row under the same `requestId`, and the
 * pair reads as one action: asked for by this person, for this reason, and then
 * resolved either way. The table is append-only by design — no UPDATE grant
 * exists for any role — so appending is the only shape available, and it is the
 * right one: an audit entry that can be rewritten is not evidence.
 *
 * ## Why a failed *outcome* write does not fail the request
 *
 * By the time the outcome is recorded the action has already happened, or
 * already failed. Throwing here could not undo either; it would only turn a
 * completed action into a 500 and invite the caller to retry it. The worst case
 * is a row left saying `requested` and never resolved — which is true as far as
 * it goes, and is precisely the state an investigator should read as unresolved
 * rather than as done. So this is best-effort and logged.
 *
 * Note the asymmetry, which is deliberate: a failure to write the *request* row
 * aborts the action (the handler's existing 500), and a failure to write the
 * *outcome* row does not.
 */
import type { FastifyRequest } from 'fastify';

import { writeAudit, type AdminActor } from '../middleware/requireAdmin.js';

/** `requested` never appears here: it belongs to the request row. */
export type AuditOutcome = 'succeeded' | 'failed';

/** The identifying facts an action's two rows must agree on. */
export interface AuditedAction {
  action: string;
  targetType: string;
  targetId?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
}

/** The longest an error detail may be stored under, so it cannot be used as storage. */
const MAX_DETAIL_LENGTH = 500;

export interface AuditTrail {
  /** Fastify's request id, which pairs the two rows. */
  readonly requestId: string;
  /**
   * The action ran.
   *
   * `detail` is optional and is a *qualification of the success*, not a second
   * outcome. It exists for actions whose success has a limit worth recording:
   * publishing an announcement succeeds when the row is written, and whether any
   * device was reached is a separate fact that a later reader of this log has no
   * other way to recover — the HTTP response is gone the moment the screen
   * closes. Nothing here may use it to record a failure; that is what `failed`
   * is for, and an action that did not run must call it.
   */
  succeeded(detail?: string): Promise<void>;
  /** The action did not run, and `detail` says why, as far as the handler knows. */
  failed(detail?: string): Promise<void>;
}

/**
 * Records the request half, and returns the handle that records the outcome.
 *
 * Throws if the request row cannot be written, so the caller's existing error
 * path runs and the action is not attempted — the same guarantee as calling
 * `writeAudit` directly, which is what it does.
 */
export async function beginAction(
  request: FastifyRequest,
  entry: AuditedAction,
): Promise<AuditTrail> {
  // Both are set by the `requireAdmin` preHandler on every route in this plugin,
  // so neither can be absent. Throwing rather than defaulting, because a default
  // would mean an action attributed to the wrong person or to nobody.
  const actor: AdminActor | undefined = request.adminActor;
  const service = request.adminService;
  if (!actor) throw new Error('Admin route reached without an authenticated actor.');
  if (!service) throw new Error('Admin route reached without a service client.');

  const requestId = String(request.id);

  await writeAudit(service, actor, {
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    reason: entry.reason,
    metadata: entry.metadata,
    requestId,
  });

  const settle = async (outcome: AuditOutcome, detail?: string): Promise<void> => {
    const { error } = await service.from('admin_audit_log').insert({
      actor_id: actor.id,
      actor_email: actor.email,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      reason: entry.reason,
      metadata: {
        outcome,
        requestId,
        ...(detail ? { detail: detail.slice(0, MAX_DETAIL_LENGTH) } : {}),
      },
    });

    if (error) {
      request.log.error(
        { err: error.message, requestId, action: entry.action, outcome },
        'The audit outcome could not be recorded; the action is left unresolved in the log',
      );
    }
  };

  return {
    requestId,
    succeeded: (detail?: string) => settle('succeeded', detail),
    failed: (detail?: string) => settle('failed', detail),
  };
}
