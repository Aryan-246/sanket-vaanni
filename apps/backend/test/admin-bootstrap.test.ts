/**
 * The one-time administrator bootstrap.
 *
 * These tests are mostly about refusals, because that is what this code is: a
 * narrow exception to the rule that only an administrator can create an
 * administrator. The happy path is one case at the end. What matters is that the
 * exception stays narrow — that it stops working the moment the project has an
 * administrator, that it cannot grant the role through the mode meant for
 * recovering a locked-out one, and that it does not touch a suspended account.
 *
 * Every rule below is asserted against a described account rather than a
 * database, and — where it matters — the test also asserts that nothing was
 * written, because "refused" and "refused but recorded something" are different
 * facts.
 */
import { describe, expect, it } from 'vitest';

import {
  runBootstrap,
  type BootstrapAuditEntry,
  type BootstrapDeps,
  type ExistingAccount,
} from '../src/admin/bootstrap.js';

interface Harness {
  readonly deps: BootstrapDeps;
  readonly audit: BootstrapAuditEntry[];
  readonly changes: string[];
}

function harness(
  account: ExistingAccount | null,
  options: { activeAdmins?: number; auditFails?: boolean; changeFails?: boolean } = {},
): Harness {
  const audit: BootstrapAuditEntry[] = [];
  const changes: string[] = [];
  let requestIds = 0;

  const deps: BootstrapDeps = {
    findByEmail: async () => account,
    countActiveAdmins: async () => options.activeAdmins ?? 0,
    promote: async (id: string) => {
      if (options.changeFails) throw new Error('connection reset');
      changes.push(`promote:${id}`);
    },
    restore: async (id: string) => {
      if (options.changeFails) throw new Error('connection reset');
      changes.push(`restore:${id}`);
    },
    writeAudit: async (entry: BootstrapAuditEntry) => {
      // The request half failing must abort; the outcome half failing must not.
      // Distinguishing them here is what makes that asymmetry testable.
      if (options.auditFails && entry.outcome === 'requested') {
        throw new Error('permission denied for table admin_audit_log');
      }
      audit.push(entry);
    },
    newRequestId: () => {
      requestIds += 1;
      return `cli-test-${requestIds}`;
    },
  };

  return { deps, audit, changes };
}

const FIRST_EMAIL = 'first@example.test';

const ORDINARY: ExistingAccount = {
  id: 'user-1',
  email: FIRST_EMAIL,
  role: 'user',
  status: 'active',
};

const ADMIN_ROW: ExistingAccount = { ...ORDINARY, role: 'admin' };
const SUSPENDED_ADMIN: ExistingAccount = { ...ORDINARY, role: 'admin', status: 'suspended' };
const SUSPENDED_USER: ExistingAccount = { ...ORDINARY, status: 'suspended' };

const REASON = 'Initial administrator while the project is being set up';

function promote(email = FIRST_EMAIL, reason = REASON) {
  return { email, reason, mode: 'promote' as const };
}

function restore(email = FIRST_EMAIL, reason = REASON) {
  return { email, reason, mode: 'restore' as const };
}

describe('when the project already has an administrator', () => {
  it('refuses to promote anybody else, and says where administrators come from', async () => {
    /*
     * The line that stops this being a permanent backdoor. Once an administrator
     * exists, the only way to add another is the audited API, where the actor is
     * a verified person.
     */
    const { deps, audit, changes } = harness(ORDINARY, { activeAdmins: 1 });

    const result = await runBootstrap(deps, promote());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/already 1 active administrator/);
    expect(result.message).toMatch(/administration API/);
    expect(changes).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('counts more than one in words a person would write', async () => {
    const { deps } = harness(ORDINARY, { activeAdmins: 3 });

    const result = await runBootstrap(deps, promote());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/already 3 active administrators/);
  });

  it('still restores a suspended administrator', async () => {
    /*
     * The recovery case, and the only one that works while other administrators
     * exist. It cannot grant the role — see the test below — so it is not a way
     * around the refusal above.
     */
    const { deps, changes, audit } = harness(SUSPENDED_ADMIN, { activeAdmins: 2 });

    const result = await runBootstrap(deps, restore());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.action).toBe('restore_admin');
    expect(result.changed).toBe(true);
    expect(changes).toEqual(['restore:user-1']);
    expect(audit.map((entry) => entry.outcome)).toEqual(['requested', 'succeeded']);
  });
});

describe('the recovery mode', () => {
  it('cannot grant the administrator role to an ordinary account', async () => {
    /*
     * The whole reason promote and restore are separate modes. If `--recovery`
     * could promote, the flag an operator reaches for when locked out would also
     * be the flag that mints a new administrator.
     */
    const { deps, changes, audit } = harness(ORDINARY, { activeAdmins: 0 });

    const result = await runBootstrap(deps, restore());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/would be a promotion, which this mode does not perform/);
    expect(changes).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('does nothing, successfully, when the administrator is already active', async () => {
    // Idempotent. "There was nothing to do" is a distinct outcome from "this was
    // not allowed", and it is a success.
    const { deps, changes, audit } = harness(ADMIN_ROW, { activeAdmins: 1 });

    const result = await runBootstrap(deps, restore());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changed).toBe(false);
    expect(result.action).toBe('none');
    expect(changes).toEqual([]);
    // Recorded, because an operator did ask for something and the answer is that
    // it was already true.
    expect(audit.map((entry) => entry.outcome)).toEqual(['requested', 'succeeded']);
  });
});

describe('the accounts it will not touch', () => {
  it('refuses an address that has no account, and does not create one', async () => {
    /*
     * The script promotes an existing Supabase Auth identity. It has no way to
     * make one, which is what keeps it from being a place a password would ever
     * have to be invented or stored.
     */
    const { deps, audit, changes } = harness(null);

    const result = await runBootstrap(deps, promote('nobody@example.test'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/No account exists with the address nobody@example\.test/);
    expect(result.message).toMatch(/never creates one/);
    expect(changes).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('refuses to promote a suspended ordinary account', async () => {
    // Granting a privilege that is simultaneously unusable reads as success
    // while delivering nothing.
    const { deps, changes } = harness(SUSPENDED_USER);

    const result = await runBootstrap(deps, promote());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/Reactivate it before/);
    expect(changes).toEqual([]);
  });

  it('points a suspended administrator at the mode that helps them', async () => {
    const { deps } = harness(SUSPENDED_ADMIN);

    const result = await runBootstrap(deps, promote());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/--recovery/);
  });

  it('requires a reason long enough for the audit table to accept', async () => {
    // The database has a CHECK on this, and the script's job is to give the
    // operator the sentence rather than the constraint violation.
    const { deps, audit } = harness(ORDINARY);

    const result = await runBootstrap(deps, promote(FIRST_EMAIL, 'x'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/at least 3 characters/);
    expect(audit).toEqual([]);
  });

  it('requires an address that looks like one', async () => {
    const { deps } = harness(ORDINARY);

    const result = await runBootstrap(deps, promote('not-an-address'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/must look like one/);
  });
});

describe('recording what happened', () => {
  it('does not act when the record of the attempt cannot be written', async () => {
    /*
     * Same guarantee as every admin route: a privilege change that cannot be
     * recorded does not happen.
     */
    const { deps, changes } = harness(ORDINARY, { auditFails: true });

    const result = await runBootstrap(deps, promote());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/could not be written/);
    expect(result.message).toMatch(/does not happen/);
    expect(changes).toEqual([]);
  });

  it('pairs the two rows under one id, and names the actor as the operator', async () => {
    const { deps, audit } = harness(ORDINARY);

    const result = await runBootstrap(deps, promote());

    expect(result.ok).toBe(true);
    expect(audit).toHaveLength(2);
    expect(audit[0]?.outcome).toBe('requested');
    expect(audit[1]?.outcome).toBe('succeeded');
    expect(audit[1]?.requestId).toBe(audit[0]?.requestId);
    expect(audit[0]?.action).toBe('bootstrap_admin');
    expect(audit[0]?.reason).toBe(REASON);
    expect(audit[0]?.targetId).toBe(ORDINARY.id);
  });

  it('reports a change that failed rather than claiming it worked', async () => {
    const { deps, audit } = harness(ORDINARY, { changeFails: true });

    const result = await runBootstrap(deps, promote());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/failed and was not applied/);
    expect(audit[0]?.outcome).toBe('requested');
    expect(audit[1]?.outcome).toBe('failed');
    expect(audit[1]?.detail).toMatch(/connection reset/);
  });

  it('still reports success, with a warning, when only the outcome row fails', async () => {
    /*
     * The deliberate asymmetry: by the time the outcome is recorded the change
     * has happened, so failing the run could not undo it and would only invite a
     * second attempt. The row left saying `requested` reads as unresolved, which
     * is what it is.
     */
    const audit: BootstrapAuditEntry[] = [];
    const deps: BootstrapDeps = {
      findByEmail: async () => ORDINARY,
      countActiveAdmins: async () => 0,
      promote: async () => undefined,
      restore: async () => undefined,
      writeAudit: async (entry) => {
        if (entry.outcome === 'requested') {
          audit.push(entry);
          return;
        }
        throw new Error('permission denied');
      },
      newRequestId: () => 'cli-test-1',
    };

    const result = await runBootstrap(deps, promote());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changed).toBe(true);
    expect(result.warning).toMatch(/outcome could not be recorded/);
    expect(audit).toHaveLength(1);
  });
});

describe('the first administrator', () => {
  it('promotes the account and records it', async () => {
    const { deps, changes, audit } = harness(ORDINARY, { activeAdmins: 0 });

    const result = await runBootstrap(deps, promote());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.action).toBe('bootstrap_admin');
    expect(result.changed).toBe(true);
    expect(result.userId).toBe(ORDINARY.id);
    expect(changes).toEqual(['promote:user-1']);
    expect(audit).toHaveLength(2);
  });

  it('does nothing when the account is already an active administrator', async () => {
    // Running it twice must be safe. The second run finds an administrator — it
    // is the one it made — and stops.
    const { deps, changes } = harness(ADMIN_ROW, { activeAdmins: 1 });

    const result = await runBootstrap(deps, promote(FIRST_EMAIL));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changed).toBe(false);
    expect(changes).toEqual([]);
  });

  it('matches the address without regard to case or surrounding spaces', async () => {
    const seen: string[] = [];
    const deps: BootstrapDeps = {
      findByEmail: async (email) => {
        seen.push(email);
        return ORDINARY;
      },
      countActiveAdmins: async () => 0,
      promote: async () => undefined,
      restore: async () => undefined,
      writeAudit: async () => undefined,
      newRequestId: () => 'cli-test-1',
    };

    await runBootstrap(deps, promote('  First@Example.TEST  '));

    // Lowercased and trimmed, because `ilike` on the account lookup is not the
    // only place this string ends up.
    expect(seen).toEqual(['first@example.test']);
  });
});
