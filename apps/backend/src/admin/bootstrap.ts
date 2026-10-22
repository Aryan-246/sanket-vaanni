/**
 * Creating the first administrator.
 *
 * ## The problem this exists to solve
 *
 * The administration API can grant the administrator role, and it is careful
 * about it: the caller must already be an administrator, the change is audited,
 * and no client may write `profiles.role` at all. That is the right set of rules
 * and it has one hole — on a fresh project nobody is an administrator, so the
 * endpoint that grants the role cannot be reached by anyone. There was no first
 * administrator, and therefore no way to make one through the product.
 *
 * What fills that hole has to avoid the obvious traps:
 *
 *   * **No public route.** An unauthenticated "make me an admin" endpoint is a
 *     backdoor by construction, however it is guarded. This is a script an
 *     operator runs with the service-role key in their own environment.
 *   * **No invented account.** The script promotes an account that already
 *     exists in Supabase Auth. It never creates one, so there is no password for
 *     it to choose, hardcode, or print — see `docs/admin-bootstrap.md`.
 *   * **No permanent capability.** The script refuses to act while any active
 *     administrator exists. Once the project has one, this is inert: further
 *     administrators are added through the audited admin API, and `--recovery`
 *     cannot grant the role to anybody, only restore one already granted.
 *   * **No unlogged change.** Both halves of the action are written to
 *     `admin_audit_log`, under one request id, exactly as a route does.
 *   * **One permanent owner.** The first administrator created here is also
 *     marked as the permanent owner (`profiles.is_owner`). On a project that
 *     already has administrators but no owner — an older deployment — the
 *     operator can designate one explicitly with `--owner`. Only the service
 *     role can write that column; the database refuses it for a client token.
 *
 * ## Why the two modes are not one
 *
 * Promoting and restoring are different powers. Promotion grants the highest
 * privilege in the system; restore only undoes a suspension of a row that is
 * *already* `role = 'admin'`. Folding them into a single `--force` flag would
 * mean the flag that recovers a locked-out administrator is also the flag that
 * can mint a new one, and the second is the one worth being careful about.
 *
 * ## What the audit rows say about the actor
 *
 * `actor_id` and `actor_email` are null, because there is no authenticated actor
 * — this runs from a terminal, not from a session. Setting them to the *target*
 * would be a lie, and inventing an operator name would be a worse one. The row
 * records `actor: 'operator-cli'` in `metadata` instead, so the log says plainly
 * that the action came from outside the API and was authorized by possession of
 * the service-role key. That is the real trust boundary, and naming it is more
 * useful than disguising it.
 *
 * ## Testability
 *
 * Every database interaction is a function passed in. The decision — who may be
 * promoted, when the script refuses, what it writes — is therefore testable
 * without a database, and the tests exercise the refusals rather than the happy
 * path.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** What the script was asked to do. */
export type BootstrapMode = 'promote' | 'restore' | 'owner';

/** The account as it exists, before anything is changed. */
export interface ExistingAccount {
  readonly id: string;
  readonly email: string | null;
  readonly role: string;
  readonly status: string;
  readonly isOwner?: boolean;
}

export interface BootstrapAuditEntry {
  readonly action: string;
  readonly targetId: string;
  readonly reason: string;
  readonly requestId: string;
  readonly outcome: 'requested' | 'succeeded' | 'failed';
  readonly detail?: string;
}

/**
 * Everything this needs from the outside world.
 *
 * Passed in rather than reached for, so the rules below can be tested by
 * describing an account and reading back what the script decided.
 */
export interface BootstrapDeps {
  findByEmail(email: string): Promise<ExistingAccount | null>;
  countActiveAdmins(): Promise<number>;
  /** Whether any profile already carries `is_owner`. */
  hasOwner(): Promise<boolean>;
  promote(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  /** Marks an existing active administrator as the permanent owner. */
  designateOwner(id: string): Promise<void>;
  writeAudit(entry: BootstrapAuditEntry): Promise<void>;
  newRequestId(): string;
}

export interface BootstrapRequest {
  readonly email: string;
  readonly mode: BootstrapMode;
  readonly reason: string;
}

/**
 * The result, in the same discriminated shape the rest of the codebase uses.
 *
 * `changed: false` is a success, not a refusal: running the script twice must be
 * safe, and "there was nothing to do" is a different outcome from "this was not
 * allowed".
 */
export type BootstrapResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly action: 'bootstrap_admin' | 'restore_admin' | 'designate_owner' | 'none';
      readonly userId: string;
      readonly message: string;
      /** Set when the action happened but its outcome could not be recorded. */
      readonly warning?: string;
    }
  | { readonly ok: false; readonly message: string };

/** The shortest reason the audit table's own CHECK constraint will accept. */
const MIN_REASON_LENGTH = 3;

const ACTION_FOR: Record<BootstrapMode, string> = {
  promote: 'bootstrap_admin',
  restore: 'restore_admin',
  owner: 'designate_owner',
};

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Promotes an existing account to administrator, or restores a suspended one.
 *
 * Refusals are returned rather than thrown: every one of them is an expected
 * outcome of running this, and the operator needs the sentence, not a stack
 * trace.
 */
export async function runBootstrap(
  deps: BootstrapDeps,
  request: BootstrapRequest,
): Promise<BootstrapResult> {
  const email = normaliseEmail(request.email);
  if (email.length === 0 || !email.includes('@')) {
    return { ok: false, message: 'An email address is required, and it must look like one.' };
  }

  const reason = request.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      message: `A reason is required, and must be at least ${MIN_REASON_LENGTH} characters. It is stored in the audit log, which is the only record of who did this.`,
    };
  }

  const account = await deps.findByEmail(email);
  if (account === null) {
    return {
      ok: false,
      message:
        `No account exists with the address ${email}. This script promotes an account that is ` +
        'already there; it never creates one. Sign up through the app with that address, confirm ' +
        'it if confirmation is required, and run this again.',
    };
  }

  const decision = request.mode === 'owner'
    ? await decideOwner(deps, account)
    : decide(request.mode, account, await deps.countActiveAdmins());

  /*
   * A refusal writes nothing at all. It is not an attempted action that failed —
   * it is the script declining to act, and the log's `requested` rows are meant
   * to mean "a change was attempted here". Recording every refused invocation
   * would fill the log with rows that describe nothing that was tried, which is
   * how a log stops being read.
   */
  if (decision.kind === 'refuse') {
    return { ok: false, message: decision.message };
  }

  const action = decision.kind === 'change' ? ACTION_FOR[request.mode] : 'none';

  /*
   * The request half, and its failure aborts.
   *
   * Same ordering and same reason as every route in `../routes/admin.ts`: a
   * privilege change with no record of it is the one thing an audit log must not
   * permit. Unlike a route, there is no request to attribute it to, so the script
   * generates the id that pairs the two rows.
   */
  const requestId = deps.newRequestId();
  try {
    await deps.writeAudit({
      action,
      targetId: account.id,
      reason,
      requestId,
      outcome: 'requested',
    });
  } catch (error) {
    return {
      ok: false,
      message:
        `Nothing was changed: the audit record could not be written (${(error as Error).message}). ` +
        'A privilege change that cannot be recorded does not happen.',
    };
  }

  if (decision.kind === 'none') {
    await settle(deps, requestId, {
      action: 'none',
      targetId: account.id,
      reason,
      outcome: 'succeeded',
      detail: decision.message,
    });
    return {
      ok: true,
      changed: false,
      action: 'none',
      userId: account.id,
      message: decision.message,
    };
  }

  try {
    if (decision.action === 'bootstrap_admin') await deps.promote(account.id);
    else if (decision.action === 'designate_owner') await deps.designateOwner(account.id);
    else await deps.restore(account.id);
  } catch (error) {
    const detail = (error as Error).message;
    await settle(deps, requestId, {
      action,
      targetId: account.id,
      reason,
      outcome: 'failed',
      detail,
    });
    return { ok: false, message: `The change failed and was not applied: ${detail}` };
  }

  const warning = await settle(deps, requestId, {
    action,
    targetId: account.id,
    reason,
    outcome: 'succeeded',
  });

  return {
    ok: true,
    changed: true,
    action: decision.action,
    userId: account.id,
    message: decision.message,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Writes the outcome half, and reports rather than throws on failure.
 *
 * Deliberately the same asymmetry as `../audit/trail.ts`: by this point the
 * change has happened, so throwing could not undo it and would only invite the
 * operator to run the script a second time. A row left saying `requested` and
 * never resolved is true as far as it goes, and reads as unresolved — which is
 * what it is.
 */
async function settle(
  deps: BootstrapDeps,
  requestId: string,
  entry: Omit<BootstrapAuditEntry, 'requestId'>,
): Promise<string | undefined> {
  try {
    await deps.writeAudit({ ...entry, requestId });
    return undefined;
  } catch (error) {
    return (
      `The action itself completed, but its outcome could not be recorded ` +
      `(${(error as Error).message}). The log shows the attempt as unresolved.`
    );
  }
}

/**
 * What the rules decided, in three shapes.
 *
 * A tagged union rather than a thrown error or a boolean pair: "refused", "there
 * was nothing to do" and "change this" are three genuinely different outcomes,
 * and the caller must handle each — a boolean `changed` would collapse the first
 * two, which is exactly the distinction between a safe repeat and a rejected
 * attempt.
 */
type Decision =
  | { readonly kind: 'refuse'; readonly message: string }
  | { readonly kind: 'none'; readonly message: string }
  | {
      readonly kind: 'change';
      readonly action: 'bootstrap_admin' | 'restore_admin' | 'designate_owner';
      readonly message: string;
    };

/**
 * Whether this account may be changed, and why not if it may not.
 *
 * Separated from the writing so the rules are readable in one place, and so each
 * refusal below can be asserted on directly.
 */
function decide(mode: BootstrapMode, account: ExistingAccount, activeAdmins: number): Decision {
  const isAdmin = account.role === 'admin';
  const isActive = account.status === 'active';

  if (mode === 'restore') {
    /*
     * Restore cannot grant the role. That is the whole reason it is a separate
     * mode: the flag an operator reaches for when they have locked themselves out
     * must not also be the one that can create a new administrator.
     */
    if (!isAdmin) {
      return {
        kind: 'refuse',
        message:
          'That account is not an administrator, so there is nothing to restore. Restoring it ' +
          'would be a promotion, which this mode does not perform.',
      };
    }
    if (isActive) {
      return {
        kind: 'none',
        message: 'That account is already an active administrator. Nothing to do.',
      };
    }
    return {
      kind: 'change',
      action: 'restore_admin',
      message: 'Restored the administrator account to active.',
    };
  }

  // Promote.
  if (isAdmin && isActive) {
    return {
      kind: 'none',
      message: 'That account is already an active administrator. Nothing to do.',
    };
  }

  if (!isActive) {
    /*
     * A suspended account is not promoted. Making it an administrator would
     * grant a privilege that is simultaneously unusable, which reads as success
     * while delivering nothing — and if it is already an administrator, the
     * intent was a restore.
     */
    return {
      kind: 'refuse',
      message: isAdmin
        ? 'That account is a suspended administrator. Run again with --recovery to restore it.'
        : 'That account is suspended. Reactivate it before making it an administrator, so the ' +
          'privilege is actually usable.',
    };
  }

  if (activeAdmins > 0) {
    /*
     * The line that keeps this from being a permanent backdoor. From here on the
     * script is inert, and every further administrator is added through the
     * admin API, where the actor is a verified person and the change is audited
     * against them.
     */
    return {
      kind: 'refuse',
      message:
        `There ${activeAdmins === 1 ? 'is already 1 active administrator' : `are already ${activeAdmins} active administrators`} ` +
        'on this project. Additional administrators are added through the administration API, ' +
        'which records who did it and why. This script exists to create the first one, and to ' +
        'restore one with --recovery.',
    };
  }

  return {
    kind: 'change',
    action: 'bootstrap_admin',
    message: 'Promoted the account to administrator. It is the first one on this project.',
  };
}

/**
 * Whether this account may become the permanent owner.
 *
 * Separate from `decide` because it answers a different question and, crucially,
 * because it does **not** touch the administrator count. An owner only exists on
 * a project that already has an active administrator; refusing when one exists
 * would make the mode unusable, and allowing it to promote would make `--owner`
 * a second promotion path.
 *
 * The rule is therefore: the account must already be an active administrator,
 * and there must not already be an owner.
 */
async function decideOwner(deps: BootstrapDeps, account: ExistingAccount): Promise<Decision> {
  if (account.isOwner === true) {
    return {
      kind: 'none',
      message: 'That account is already the permanent owner. Nothing to do.',
    };
  }

  if (await deps.hasOwner()) {
    return {
      kind: 'refuse',
      message:
        'This project already has a permanent owner, and the database allows only one. ' +
        'Demoting or replacing the owner is refused by design; it would require a migration, ' +
        'not a flag.',
    };
  }

  if (account.role !== 'admin' || account.status !== 'active') {
    return {
      kind: 'refuse',
      message:
        'Only an active administrator can become the permanent owner. Promote and reactivate ' +
        'this account first (without --owner), then run this mode again.',
    };
  }

  return {
    kind: 'change',
    action: 'designate_owner',
    message: 'Marked the account as the permanent owner.',
  };
}

/* ------------------------------------------------------------ the real deps */

/** Wires the logic above to a service-role client. */
export function supabaseBootstrapDeps(client: SupabaseClient): BootstrapDeps {
  return {
    async findByEmail(email: string): Promise<ExistingAccount | null> {
      const { data, error } = await client
        .from('profiles')
        .select('id, email, role, status, is_owner')
        .ilike('email', email)
        .maybeSingle();

      if (error) throw new Error(`The account could not be read: ${error.message}`);
      if (!data) return null;

      return {
        id: String(data.id),
        email: typeof data.email === 'string' ? data.email : null,
        role: String(data.role ?? ''),
        status: String(data.status ?? ''),
        isOwner: data.is_owner === true,
      };
    },

    async hasOwner(): Promise<boolean> {
      const { count, error } = await client
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('is_owner', true);

      if (error) throw new Error(`The owner could not be read: ${error.message}`);
      return (count ?? 0) > 0;
    },

    async countActiveAdmins(): Promise<number> {
      const { count, error } = await client
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin')
        .eq('status', 'active');

      if (error) throw new Error(`The administrator count could not be read: ${error.message}`);
      return count ?? 0;
    },

    async promote(id: string): Promise<void> {
      // `bootstrap_admin` only runs when there is no active administrator, so
      // this is necessarily the first one. It becomes the permanent owner in the
      // same statement: two updates would leave a window in which the first
      // administrator exists but the owner guard protects nobody. `is_owner`
      // is writable only with the service role, which is what this client is.
      const { error } = await client
        .from('profiles')
        .update({ role: 'admin', is_owner: true })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },

    async designateOwner(id: string): Promise<void> {
      const { error } = await client.from('profiles').update({ is_owner: true }).eq('id', id);
      if (error) throw new Error(error.message);
    },

    async restore(id: string): Promise<void> {
      const { error } = await client.from('profiles').update({ status: 'active' }).eq('id', id);
      if (error) throw new Error(error.message);
    },

    async writeAudit(entry: BootstrapAuditEntry): Promise<void> {
      const { error } = await client.from('admin_audit_log').insert({
        // Null, and explained at the top of this file: this action has no
        // authenticated actor, and naming one would be inventing it.
        actor_id: null,
        actor_email: null,
        action: entry.action,
        target_type: 'profile',
        target_id: entry.targetId,
        reason: entry.reason,
        metadata: {
          actor: 'operator-cli',
          outcome: entry.outcome,
          requestId: entry.requestId,
          ...(entry.detail ? { detail: entry.detail.slice(0, 500) } : {}),
        },
      });

      if (error) throw new Error(error.message);
    },

    newRequestId(): string {
      // Not a Fastify request id — there is no request. Shaped so it is obvious
      // in the log that this pair came from a terminal.
      return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    },
  };
}
