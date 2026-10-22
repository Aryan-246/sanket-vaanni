/**
 * Creates or restores the first administrator. Run by hand, never by the server.
 *
 * ## Running it
 *
 *   cd apps/backend
 *   npm run bootstrap:admin -- --email you@example.com --reason "Initial administrator"
 *   npm run bootstrap:admin -- --email you@example.com --reason "Locked out" --recovery
 *   npm run bootstrap:admin -- --email you@example.com --reason "Designate owner" --owner
 *
 * The service-role key must be in the environment. `npm run` passes
 * `--env-file-if-exists=.env`, so a local `.env` works and nothing needs to be
 * exported by hand. See `docs/admin-bootstrap.md`.
 *
 * ## What it will not do
 *
 * It does not create an account, does not set or print a password, does not
 * listen on a port, and is not reachable over HTTP. It refuses to act while any
 * active administrator exists, so it is not a permanent way in — see
 * `../admin/bootstrap.ts` for the rules and the reasoning.
 *
 * Nothing here prints a secret. The service-role key is read from the
 * environment and passed to the client; it is never echoed, not even truncated.
 */
import { createClient } from '@supabase/supabase-js';

import { runBootstrap, supabaseBootstrapDeps, type BootstrapMode } from '../admin/bootstrap.js';
import { loadConfig } from '../config.js';

interface Options {
  readonly email: string;
  readonly reason: string;
  readonly mode: BootstrapMode;
}

const USAGE = `
Create or restore the first administrator.

  --email <address>   The account to act on. It must already exist.
  --reason "<text>"   Why. Stored in the audit log; at least 3 characters.
  --recovery          Restore a suspended administrator instead of promoting.
  --owner             Mark an existing active administrator as the permanent owner.
                      Records the designation in the audit log.
  --help              This text.

The script refuses to promote anybody while an active administrator exists.
Promotion of the first administrator also designates it as the permanent owner.
--owner exists for projects that already have administrators but no owner.
`;

/** Parses argv, or returns the text explaining what was wrong with it. */
function parseArgs(argv: readonly string[]): Options | { readonly error: string } {
  let email = '';
  let reason = '';
  let mode: BootstrapMode = 'promote';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { error: USAGE };
    if (arg === '--recovery') {
      mode = 'restore';
      continue;
    }
    if (arg === '--owner') {
      mode = 'owner';
      continue;
    }
    if (arg === '--email' || arg === '--reason') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `\n${arg} needs a value.\n${USAGE}` };
      }
      if (arg === '--email') email = value;
      else reason = value;
      index += 1;
      continue;
    }
    return { error: `\nUnrecognised argument: ${arg}\n${USAGE}` };
  }

  if (email.length === 0) return { error: `\n--email is required.\n${USAGE}` };
  if (reason.length === 0) return { error: `\n--reason is required.\n${USAGE}` };

  return { email, reason, mode };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if ('error' in parsed) {
    // A usage message is not a failure of the program, but it is not a success
    // either. 2 keeps it distinguishable from a refusal when scripted.
    process.stdout.write(parsed.error);
    return 2;
  }

  const config = loadConfig();

  /*
   * Bound to locals so the two non-null checks below narrow them, and written as
   * one guard so a missing variable is reported as a configuration problem
   * rather than surfacing later as an undefined reaching `createClient`.
   *
   * The names of the missing variables, never their values. Same rule as
   * `adminApiAvailability` in the middleware, for the same reason: this key
   * bypasses every row-level policy in the project.
   */
  const url = config.supabaseUrl;
  const serviceKey = config.supabaseServiceRoleKey;

  if (!url || !serviceKey) {
    const missing: string[] = [];
    if (!url) missing.push('SUPABASE_URL');
    if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

    process.stderr.write(
      `\nThis needs ${missing.join(' and ')} in the environment (apps/backend/.env).\n` +
        'It reads the database directly, so it cannot run without them.\n',
    );
    return 1;
  }

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await runBootstrap(supabaseBootstrapDeps(client), {
    email: parsed.email,
    reason: parsed.reason,
    mode: parsed.mode,
  });

  if (!result.ok) {
    // A refusal is printed as a refusal. Nothing was written, so there is no
    // audit entry to point at, and saying "failed" would imply an attempt.
    process.stdout.write(`\nRefused. Nothing was changed.\n\n${result.message}\n`);
    return 1;
  }

  process.stdout.write(`\n${result.changed ? 'Done.' : 'Nothing to do.'}\n\n${result.message}\n`);
  if (result.warning) process.stderr.write(`\nWarning: ${result.warning}\n`);
  process.stdout.write(`\nThe action is recorded in admin_audit_log (target ${result.userId}).\n`);
  return 0;
}

/*
 * `process.exitCode` rather than `process.exit()`, so stdout is flushed before
 * the process ends. On a pipe — which is how this is likely to be run when
 * scripted — `process.exit()` can truncate the message the operator needs.
 */
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`\nThe script itself failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
