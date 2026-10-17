/**
 * Creating the first administrator, and rotating an existing one's password.
 *
 * The tests are mostly about what this refuses to do, because that is what this
 * code is: the single narrow exception to the rule that only an administrator
 * creates an administrator. What matters is that the exception stays narrow —
 * that it stops working the moment the project has an administrator, that the
 * rotation mode cannot be used to grant the role, and that no failure path ever
 * leaves a promotion applied without a record of it.
 *
 * The other half is the credential itself. `runProvision` receives the password
 * as a parameter, which means every string it builds afterwards is a place the
 * password could leak into. Those strings are printed to a terminal and written
 * into `admin_audit_log`, so "it is not in there" is asserted rather than
 * assumed, and asserted against the whole serialised result rather than against
 * the fields a leak was expected in.
 *
 * Every rule is asserted against a described account rather than a database, and
 * where it matters the test also asserts that nothing was written, because
 * "refused" and "refused but recorded something" are different facts.
 */
import { describe, expect, it } from 'vitest';

import {
  runProvision,
  type ProvisionAccount,
  type ProvisionAuditEntry,
  type ProvisionDeps,
} from '../src/admin/provision.js';

/** A password that clears the length floor, so tests exercise the rule under test. */
const PASSWORD = 'test-password-value-0123456789';
const EMAIL = 'admin@example.com';
const REASON = 'Initial administrator';

interface Harness {
  readonly deps: ProvisionDeps;
  readonly audit: ProvisionAuditEntry[];
  readonly changes: string[];
  readonly created: string[];
}

function harness(
  account: ProvisionAccount | null,
  options: {
    activeAdmins?: number;
    auditFails?: boolean;
    createFails?: boolean;
    promoteFails?: boolean;
    setPasswordFails?: boolean;
    emailConfirmed?: boolean;
  } = {},
): Harness {
  const audit: ProvisionAuditEntry[] = [];
  const changes: string[] = [];
  const created: string[] = [];
  let requestIds = 0;

  const deps: ProvisionDeps = {
    findByEmail: async () => account,
    countActiveAdmins: async () => options.activeAdmins ?? 0,

    createAccount: async (email: string) => {
      if (options.createFails) throw new Error('auth service unavailable');
      created.push(email);
      return { id: 'new-user-1', emailConfirmed: options.emailConfirmed ?? true };
    },

    promote: async (id: string) => {
      if (options.promoteFails) throw new Error('connection reset');
      changes.push(`promote:${id}`);
    },

    setPassword: async (id: string) => {
      if (options.setPasswordFails) throw new Error('auth service unavailable');
      changes.push(`setPassword:${id}`);
    },

    writeAudit: async (entry: ProvisionAuditEntry) => {
      // The request half failing must abort; the outcome half failing must not.
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

  return { deps, audit, changes, created };
}

function adminAccount(overrides: Partial<ProvisionAccount> = {}): ProvisionAccount {
  return { id: 'existing-1', email: EMAIL, role: 'admin', status: 'active', ...overrides };
}

/* ------------------------------------------------------- input validation */

describe('input validation', () => {
  it('refuses an email that does not look like one', async () => {
    const h = harness(null);
    const result = await runProvision(h.deps, {
      email: 'not-an-address',
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    expect(h.created).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('refuses a reason shorter than the audit table would accept', async () => {
    const h = harness(null);
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: '  x ',
    });

    expect(result.ok).toBe(false);
    expect(h.created).toEqual([]);
  });

  it('refuses a password shorter than the floor, without quoting it', async () => {
    const h = harness(null);
    const short = 'too-short';
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: short,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).not.toContain(short);
    expect(h.created).toEqual([]);
  });

  it('refuses a password on the obvious list, without quoting it', async () => {
    const h = harness(null);
    const obvious = 'changemechangeme';
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: obvious,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).not.toContain(obvious);
  });

  it('normalises the address before checking whether the account exists', async () => {
    let lookedUp: string | null = null;
    const h = harness(null);
    const deps: ProvisionDeps = {
      ...h.deps,
      findByEmail: async (email: string) => {
        lookedUp = email;
        return null;
      },
    };

    await runProvision(deps, {
      email: '  Admin@Example.COM  ',
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(lookedUp).toBe('admin@example.com');
  });
});

/* ---------------------------------------------------------------- create */

describe('create mode', () => {
  it('creates the identity, promotes it, and records both halves under one request id', async () => {
    const h = harness(null);
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(true);
    expect(h.created).toEqual([EMAIL]);
    expect(h.changes).toEqual(['promote:new-user-1']);

    expect(h.audit.map((entry) => entry.outcome)).toEqual(['requested', 'succeeded']);
    expect(h.audit.map((entry) => entry.action)).toEqual(['provision_admin', 'provision_admin']);
    expect(h.audit.map((entry) => entry.requestId)).toEqual(['cli-test-1', 'cli-test-1']);
    expect(h.audit.map((entry) => entry.targetId)).toEqual(['new-user-1', 'new-user-1']);
  });

  it('refuses to touch an address that already has an account', async () => {
    const h = harness(adminAccount());
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    expect(h.created).toEqual([]);
    expect(h.changes).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('refuses to create an administrator while one is already active', async () => {
    const h = harness(null, { activeAdmins: 1 });
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/backdoor|already has/);
    expect(h.created).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('reports the existing-account refusal before the administrator-exists refusal', async () => {
    // On a project that already has an administrator, the operator should be told
    // to use the recovery path, not told to pick a different address.
    const h = harness(adminAccount(), { activeAdmins: 3 });
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/already exists/);
  });

  it('does not promote when the audit record cannot be written', async () => {
    const h = harness(null, { auditFails: true });
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    // The identity was created — that is unavoidable once createUser returns —
    // but the privilege change must not have happened.
    expect(h.changes).toEqual([]);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/NOT made an administrator/);
  });

  it('says plainly that a failed promotion left a non-administrator behind', async () => {
    const h = harness(null, { promoteFails: true });
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/NOT an administrator/);
    expect(h.audit.map((entry) => entry.outcome)).toEqual(['requested', 'failed']);
  });

  it('grants nothing when the identity cannot be created', async () => {
    const h = harness(null, { createFails: true });
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(false);
    expect(h.changes).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('reports an unconfirmed address rather than claiming sign-in will work', async () => {
    const h = harness(null, { emailConfirmed: false });
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.emailConfirmed).toBe(false);
    expect(result.message).toMatch(/NOT confirmed/);
  });

  it('still succeeds, with a warning, when only the outcome row fails to write', async () => {
    const audit: ProvisionAuditEntry[] = [];
    const h = harness(null);
    const deps: ProvisionDeps = {
      ...h.deps,
      writeAudit: async (entry: ProvisionAuditEntry) => {
        if (entry.outcome === 'succeeded') throw new Error('connection reset');
        audit.push(entry);
      },
    };

    const result = await runProvision(deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.warning).toBeDefined();
    expect(audit.map((entry) => entry.outcome)).toEqual(['requested']);
  });
});

/* ---------------------------------------------------------------- rotate */

describe('rotate mode', () => {
  it('sets a new password on an existing administrator', async () => {
    const h = harness(adminAccount());
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'rotate',
      reason: 'Locked out',
    });

    expect(result.ok).toBe(true);
    expect(h.changes).toEqual(['setPassword:existing-1']);
    expect(h.created).toEqual([]);
    expect(h.audit.map((entry) => entry.action)).toEqual([
      'rotate_admin_password',
      'rotate_admin_password',
    ]);
  });

  it('refuses to rotate a password for an account that does not exist', async () => {
    const h = harness(null);
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'rotate',
      reason: 'Locked out',
    });

    expect(result.ok).toBe(false);
    expect(h.changes).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('refuses to rotate a password for an account that is not an administrator', async () => {
    // This is the rule that stops `rotate` from being a second way to grant the
    // role: without it, anyone who could run this could take over a normal
    // account and then promote themselves from inside the app.
    const h = harness(adminAccount({ role: 'user' }));
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'rotate',
      reason: 'Locked out',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/not an administrator/);
    expect(h.changes).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('does not change the password when the audit record cannot be written', async () => {
    const h = harness(adminAccount(), { auditFails: true });
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'rotate',
      reason: 'Locked out',
    });

    expect(result.ok).toBe(false);
    expect(h.changes).toEqual([]);
  });

  it('does not touch the account status, so rotating cannot un-suspend an administrator', async () => {
    const h = harness(adminAccount({ status: 'suspended' }));
    await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'rotate',
      reason: 'Locked out',
    });

    expect(h.changes).toEqual(['setPassword:existing-1']);
    expect(h.changes.some((change) => change.includes('status'))).toBe(false);
  });

  it('reports a failed password change as a failure, not a success', async () => {
    const h = harness(adminAccount(), { setPasswordFails: true });
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'rotate',
      reason: 'Locked out',
    });

    expect(result.ok).toBe(false);
    expect(h.audit.map((entry) => entry.outcome)).toEqual(['requested', 'failed']);
  });
});

/* ------------------------------------------------ the password must not leak */

describe('the password never leaves the call', () => {
  /**
   * Applied to every outcome, successful or refused.
   *
   * Asserting against `JSON.stringify` of the whole result and the whole audit
   * array — rather than against the two or three fields a leak was expected in —
   * is the point: it catches a leak in a field that did not exist when this test
   * was written.
   */
  function expectNoPasswordLeak(result: unknown, audit: readonly unknown[]): void {
    const serialised = `${JSON.stringify(result)}${JSON.stringify(audit)}`;
    expect(serialised).not.toContain(PASSWORD);
  }

  it.each([
    ['create, success', null, {}, 'create'],
    ['create, refused on existing account', adminAccount(), {}, 'create'],
    ['create, refused on active administrator', null, { activeAdmins: 1 }, 'create'],
    ['create, audit write failed', null, { auditFails: true }, 'create'],
    ['create, promotion failed', null, { promoteFails: true }, 'create'],
    ['create, identity creation failed', null, { createFails: true }, 'create'],
    ['rotate, success', adminAccount(), {}, 'rotate'],
    ['rotate, account missing', null, {}, 'rotate'],
    ['rotate, not an administrator', adminAccount({ role: 'user' }), {}, 'rotate'],
    ['rotate, password change failed', adminAccount(), { setPasswordFails: true }, 'rotate'],
  ] as const)('%s does not contain the password in its result or audit rows', async (_name, account, options, mode) => {
    const h = harness(account, options);
    const result = await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode,
      reason: REASON,
    });

    expectNoPasswordLeak(result, h.audit);
  });

  it('never writes a password-shaped field into an audit row', async () => {
    const h = harness(null);
    await runProvision(h.deps, {
      email: EMAIL,
      password: PASSWORD,
      mode: 'create',
      reason: REASON,
    });

    for (const entry of h.audit) {
      expect(Object.keys(entry)).not.toContain('password');
      expect(entry.detail ?? '').not.toContain(PASSWORD);
    }
  });
});
