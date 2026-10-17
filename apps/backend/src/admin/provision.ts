/**
 * Creates the first administrator, or rotates an existing administrator's
 * password. Run by hand, never by the server.
 *
 * ## Why this exists next to `bootstrap.ts`
 *
 * `bootstrap.ts` promotes an account that is **already there**. That is the right
 * rule for a system that already has a sign-up path, and it is why its refusal
 * message tells the operator to sign up first.
 *
 * But the fold has a chicken-and-egg problem: sign-up writes to `profiles`, the
 * admin gate reads `role` from `profiles`, and on a project whose migrations are
 * not applied there is no `role` column to read. An owner who cannot sign up
 * therefore cannot be promoted either. This module closes exactly that gap and
 * nothing more: it can create **one** identity, when no administrator exists.
 *
 * ## What it will not do
 *
 * - It will not create an account while any active administrator exists. That
 *   rule exists in `decide` below and is the same one `bootstrap.ts` applies, for
 *   the same reason: an operator-held path that always works is a backdoor, not a
 *   recovery route.
 * - It will not promote an account. Promotion stays in `bootstrap.ts`. Rotation
 *   refuses an account that is not already an administrator, so this module can
 *   never be used to grant the role.
 * - It will not log, echo, audit or return the password. The password is a
 *   parameter, is passed once into `createAccount`/`setPassword`, and is never
 *   put into an audit row, a message, a detail string or an error. The tests
 *   assert that, because it is the kind of promise that decays silently.
 * - It will not set a password on an address that is not an administrator, which
 *   is what keeps `rotate` from becoming a second promotion path.
 *
 * ## The email-confirmed question
 *
 * `createAccount` may mark the address confirmed without the owner proving they
 * receive mail at it. That is deliberate: the trust boundary here is possession
 * of the service-role key, not possession of the mailbox, and making first-run
 * setup depend on SMTP would mean a project with an unconfigured mail provider
 * could never be administered at all. Confirmation-required and SMTP are the
 * right rules for self-service sign-up; they are the wrong rules for the
 * operator-held bootstrap. The returned `emailConfirmed` flag says which
 * happened, and the caller reports it rather than assuming.
 *
 * ## Testability
 *
 * As in `bootstrap.ts`, every outside interaction is injected, so the rules —
 * who may be created, when it refuses, what is written — are tested by
 * describing an account and reading back what was decided.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** What the operator asked for. */
export type ProvisionMode = 'create' | 'rotate';

/** The account as it exists, before anything is changed. */
export interface ProvisionAccount {
  readonly id: string;
  readonly email: string | null;
  readonly role: string;
  readonly status: string;
}

export interface ProvisionAuditEntry {
  readonly action: string;
  readonly targetId: string;
  readonly reason: string;
  readonly requestId: string;
  readonly outcome: 'requested' | 'succeeded' | 'failed';
  readonly detail?: string;
}

/** Everything this needs from the outside world, injected for testing. */
export interface ProvisionDeps {
  findByEmail(email: string): Promise<ProvisionAccount | null>;
  countActiveAdmins(): Promise<number>;
  /** Creates the identity. Not a privilege change on its own. */
  createAccount(
    email: string,
    password: string,
  ): Promise<{ readonly id: string; readonly emailConfirmed: boolean }>;
  promote(id: string): Promise<void>;
  setPassword(id: string, password: string): Promise<void>;
  writeAudit(entry: ProvisionAuditEntry): Promise<void>;
  newRequestId(): string;
}

export interface ProvisionRequest {
  readonly email: string;
  readonly password: string;
  readonly mode: ProvisionMode;
  readonly reason: string;
}

export type ProvisionResult =
  | {
      readonly ok: true;
      readonly action: 'provision_admin' | 'rotate_admin_password';
      readonly userId: string;
      /** False when the identity was created but the address is not confirmed. */
      readonly emailConfirmed: boolean;
      readonly message: string;
      /** Set when the action happened but its outcome could not be recorded. */
      readonly warning?: string;
    }
  | { readonly ok: false; readonly message: string };

/** The shortest reason the audit table's own CHECK constraint will accept. */
const MIN_REASON_LENGTH = 3;

/**
 * The shortest generated password this will accept.
 *
 * The generator produces 32 characters of base64url from 24 CSPRNG bytes, so
 * this floor is a guard against a caller passing something short and typed by
 * hand, not a target. Length is the property that matters for a value nobody
 * has to remember.
 */
const MIN_PASSWORD_LENGTH = 16;

/**
 * Values that would pass the length check and still be a bad administrator
 * password. Not a strength meter — just the handful of strings that appear in
 * every leaked-credential list and in every hastily-written deployment script.
 */
const OBVIOUS_PASSWORDS = new Set([
  'password',
  'passwordpassword',
  'administrator',
  'administrator123',
  'changeme',
  'changemechangeme',
  'letmeinletmein',
  'adminadminadmin',
]);

const ACTION_FOR: Record<ProvisionMode, string> = {
  create: 'provision_admin',
  rotate: 'rotate_admin_password',
};

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Creates the first administrator, or rotates an existing one's password.
 *
 * Refusals are returned rather than thrown: each is an expected outcome of
 * running this, and the operator needs the sentence, not a stack trace.
 */
export async function runProvision(
  deps: ProvisionDeps,
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const email = normaliseEmail(request.email);
  if (email.length === 0 || !email.includes('@')) {
    return { ok: false, message: 'An email address is required, and it must look like one.' };
  }

  const reason = request.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      message:
        `A reason is required, and must be at least ${MIN_REASON_LENGTH} characters. ` +
        'It is stored in the audit log, which is the only record of who did this.',
    };
  }

  /*
   * Checked before the password, so a weak password is reported as a weak
   * password rather than as whatever the account lookup would have said.
   *
   * The message never quotes the value. An error message is the single most
   * likely place for a credential to end up in a log, and "your password is
   * too short" does not need to contain it.
   */
  if (request.password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (OBVIOUS_PASSWORDS.has(request.password.toLowerCase())) {
    return { ok: false, message: 'That password is on the list of obvious ones. Choose another.' };
  }

  const account = await deps.findByEmail(email);

  if (request.mode === 'create') {
    if (account !== null) {
      return {
        ok: false,
        message:
          `An account already exists with the address ${email}. This will not overwrite an ` +
          "existing account's password. Use `bootstrap:admin` to promote it, or pass " +
          '`--rotate` to give it a new password if it is already an administrator.',
      };
    }

    /*
     * The one rule that keeps this from being a permanent way in. Checked after
     * the existing-account test so that, on a project with an administrator, the
     * operator is told to use the recovery path rather than told to pick another
     * address.
     */
    const activeAdmins = await deps.countActiveAdmins();
    if (activeAdmins > 0) {
      return {
        ok: false,
        message:
          `This project already has ${activeAdmins} active administrator` +
          `${activeAdmins === 1 ? '' : 's'}. Creating another one from a terminal is not ` +
          'allowed, because a path that always works is a backdoor rather than a recovery ' +
          'route. Use `bootstrap:admin` to promote an existing account, or `--rotate` to give ' +
          'an existing administrator a new password.',
      };
    }

    /*
     * The identity is created first, and it grants nothing: a row in the auth
     * schema with no matching administrator role cannot pass the admin gate. The
     * privilege change is the promotion, and the promotion is ordered after a
     * successful audit write below — the same ordering every route in
     * `../routes/admin.ts` uses, and for the same reason.
     */
    let created: { readonly id: string; readonly emailConfirmed: boolean };
    try {
      created = await deps.createAccount(email, request.password);
    } catch (error) {
      return {
        ok: false,
        message:
          `The account could not be created: ${(error as Error).message}. ` +
          'Nothing was promoted, so no access was granted.',
      };
    }

    const requestId = deps.newRequestId();
    try {
      await deps.writeAudit({
        action: ACTION_FOR.create,
        targetId: created.id,
        reason,
        requestId,
        outcome: 'requested',
      });
    } catch (error) {
      return {
        ok: false,
        message:
          `The account was created but was NOT made an administrator, because its audit ` +
          `record could not be written (${(error as Error).message}). A privilege change that ` +
          'cannot be recorded does not happen. Run `bootstrap:admin` with this address once the ' +
          'audit table is reachable to promote it: this script would only refuse, because the ' +
          'account now exists.',
      };
    }

    try {
      await deps.promote(created.id);
    } catch (error) {
      const detail = (error as Error).message;
      await settle(deps, requestId, {
        action: ACTION_FOR.create,
        targetId: created.id,
        reason,
        outcome: 'failed',
        detail,
      });
      return {
        ok: false,
        message:
          `The account exists but the promotion failed, so it is NOT an administrator: ${detail}`,
      };
    }

    const warning = await settle(deps, requestId, {
      action: ACTION_FOR.create,
      targetId: created.id,
      reason,
      outcome: 'succeeded',
    });

    return {
      ok: true,
      action: 'provision_admin',
      userId: created.id,
      emailConfirmed: created.emailConfirmed,
      message:
        `Created ${email} and made it an administrator.` +
        (created.emailConfirmed
          ? ' The address was marked confirmed, so the account can sign in immediately.'
          : ' The address is NOT confirmed; confirmation may be required before sign-in.'),
      ...(warning ? { warning } : {}),
    };
  }

  /* --- rotate ------------------------------------------------------------ */

  if (account === null) {
    return {
      ok: false,
      message:
        `No account exists with the address ${email}, so there is no password to rotate. ` +
        'Drop `--rotate` to create the first administrator.',
    };
  }

  /*
   * Refusing a non-administrator here is what stops `rotate` from doubling as a
   * promotion path. Without it, anyone who could run this could grant the role by
   * rotating a password and then promoting themselves through the app.
   */
  if (account.role !== 'admin') {
    return {
      ok: false,
      message:
        `The account ${email} exists but is not an administrator, so its password will not be ` +
        'changed — that would make this script a way to grant the role. Use `bootstrap:admin` ' +
        'to promote it first.',
    };
  }

  const requestId = deps.newRequestId();
  try {
    await deps.writeAudit({
      action: ACTION_FOR.rotate,
      targetId: account.id,
      reason,
      requestId,
      outcome: 'requested',
    });
  } catch (error) {
    return {
      ok: false,
      message:
        `Nothing was changed: the audit record could not be written ` +
        `(${(error as Error).message}).`,
    };
  }

  try {
    await deps.setPassword(account.id, request.password);
  } catch (error) {
    const detail = (error as Error).message;
    await settle(deps, requestId, {
      action: ACTION_FOR.rotate,
      targetId: account.id,
      reason,
      outcome: 'failed',
      detail,
    });
    return { ok: false, message: `The password was not changed: ${detail}` };
  }

  const warning = await settle(deps, requestId, {
    action: ACTION_FOR.rotate,
    targetId: account.id,
    reason,
    outcome: 'succeeded',
  });

  return {
    ok: true,
    action: 'rotate_admin_password',
    userId: account.id,
    emailConfirmed: true,
    message: `Set a new password for the administrator ${email}.`,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Writes the outcome half, and reports rather than throws on failure.
 *
 * The same asymmetry as `bootstrap.ts` and `../audit/trail.ts`: the change has
 * already happened, so throwing could not undo it and would only invite a second
 * run. A row left saying `requested` is true as far as it goes.
 */
async function settle(
  deps: ProvisionDeps,
  requestId: string,
  entry: Omit<ProvisionAuditEntry, 'requestId'>,
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

/** The service-role-backed implementation, used by the CLI script. */
export function supabaseProvisionDeps(client: SupabaseClient): ProvisionDeps {
  return {
    async findByEmail(email: string): Promise<ProvisionAccount | null> {
      const { data, error } = await client
        .from('profiles')
        .select('id, email, role, status')
        .ilike('email', email)
        .maybeSingle();

      if (error) throw new Error(`The account could not be read: ${error.message}`);
      if (!data) return null;

      return {
        id: String(data.id),
        email: typeof data.email === 'string' ? data.email : null,
        role: String(data.role ?? ''),
        status: String(data.status ?? ''),
      };
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

    async createAccount(email: string, password: string) {
      const { data, error } = await client.auth.admin.createUser({
        email,
        password,
        /*
         * See the note at the top of this file. The operator holds the
         * service-role key; requiring a mailbox round-trip as well would make
         * first-run setup depend on an SMTP provider this project may not have.
         */
        email_confirm: true,
      });

      if (error) throw new Error(error.message);
      if (!data.user) throw new Error('The auth service returned no user.');

      return { id: data.user.id, emailConfirmed: data.user.email_confirmed_at !== null };
    },

    async promote(id: string): Promise<void> {
      const { error } = await client.from('profiles').update({ role: 'admin' }).eq('id', id);
      if (error) throw new Error(error.message);
    },

    async setPassword(id: string, password: string): Promise<void> {
      const { error } = await client.auth.admin.updateUserById(id, { password });
      if (error) throw new Error(error.message);
    },

    async writeAudit(entry: ProvisionAuditEntry): Promise<void> {
      const { error } = await client.from('admin_audit_log').insert({
        // Null, and for the same reason as `bootstrap.ts`: this action has no
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
      return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    },
  };
}
