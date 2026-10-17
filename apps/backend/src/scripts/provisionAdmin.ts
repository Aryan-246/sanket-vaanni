/**
 * Creates the first administrator, or rotates an existing administrator's
 * password. Run by hand, never by the server.
 *
 * ## Running it
 *
 *   cd apps/backend
 *   npm run provision:admin -- --email admin@example.com --reason "Initial administrator"
 *   npm run provision:admin -- --email admin@example.com --reason "Locked out" --rotate
 *
 * The service-role key must be in the environment. `npm run` passes
 * `--env-file-if-exists=.env`, so a local `.env` works and nothing needs to be
 * exported by hand. See `docs/admin-bootstrap.md`.
 *
 * ## The password
 *
 * There is no `--password` flag, deliberately. A password typed on a command
 * line is in the shell history, in the process table and in whatever the
 * terminal scrollback is being piped into. This generates one from the CSPRNG
 * instead, and the operator never chooses it.
 *
 * It is written to `apps/backend/.env`, which is gitignored, and printed once to
 * the terminal the operator is looking at. It is written to no other file: not to
 * `admin_audit_log`, not to the server log, not to a report. `runProvision`
 * structurally cannot put it there — it never receives it in a field that is
 * logged, and the tests assert the audit rows are password-free.
 *
 * ## What it will not do
 *
 * It will not create an account while an active administrator exists, and it will
 * not promote an account — that is `bootstrap:admin`'s job. See
 * `../admin/provision.ts` for the rules and the reasoning.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { runProvision, supabaseProvisionDeps, type ProvisionMode } from '../admin/provision.js';
import { loadConfig } from '../config.js';

interface Options {
  readonly email: string;
  readonly reason: string;
  readonly mode: ProvisionMode;
  /** False when `--no-write-env` was passed. */
  readonly writeEnv: boolean;
}

const USAGE = `
Create the first administrator, or rotate an administrator's password.

  --email <address>   The account to create or to act on.
  --reason "<text>"   Why. Stored in the audit log; at least 3 characters.
  --rotate            Give an EXISTING administrator a new password instead of
                      creating the first one.
  --no-write-env      Do not write the credential to .env; print it only.
  --help              This text.

A password is generated, never supplied. The script refuses to create an account
while an active administrator exists, and refuses to rotate a password for an
account that is not an administrator.
`.trimStart();

/** Parses argv, or returns the text explaining what was wrong with it. */
function parseArgs(argv: readonly string[]): Options | { readonly error: string } {
  let email = '';
  let reason = '';
  let mode: ProvisionMode = 'create';
  let writeEnv = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { error: USAGE };
    if (arg === '--rotate') {
      mode = 'rotate';
      continue;
    }
    if (arg === '--no-write-env') {
      writeEnv = false;
      continue;
    }
    if (arg === '--email' || arg === '--reason') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `\n${arg} needs a value.\n\n${USAGE}` };
      }
      if (arg === '--email') email = value;
      else reason = value;
      index += 1;
      continue;
    }
    return { error: `\nUnrecognised argument: ${arg}\n\n${USAGE}` };
  }

  if (email.length === 0) return { error: `\n--email is required.\n\n${USAGE}` };
  if (reason.length === 0) return { error: `\n--reason is required.\n\n${USAGE}` };

  return { email, reason, mode, writeEnv };
}

/**
 * A password for a value nobody has to remember or type.
 *
 * 24 CSPRNG bytes rendered as base64url: 32 characters, 192 bits of entropy.
 * url-safe because this is pasted into a phone keyboard, where `+`, `/` and `=`
 * are the characters people mistype.
 */
function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Sets `key=value` in an env file, preserving every other line.
 *
 * Rewrites only lines whose key matches, and appends the key when it is absent.
 * Comments, blank lines, ordering and every unrelated value — including the
 * service-role key, the SMTP password and anything the owner added themselves —
 * are carried through untouched. There is no code path here that rewrites the
 * file from a parsed map, because that is how unrelated secrets get lost.
 *
 * When replacing, the line stays in place rather than moving to the end, so a
 * diff shows one changed line instead of a reordering.
 */
function setEnvValue(source: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');

  if (pattern.test(source)) return source.replace(pattern, line);

  // Preserve whether the file ended with a newline before appending.
  const separator = source.length === 0 || source.endsWith('\n') ? '' : '\n';
  return `${source}${separator}${line}\n`;
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
   * Bound to locals so the non-null check narrows them. The names of the missing
   * variables, never their values: this key bypasses every row-level policy in
   * the project.
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

  const password = generatePassword();

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await runProvision(supabaseProvisionDeps(client), {
    email: parsed.email,
    password,
    reason: parsed.reason,
    mode: parsed.mode,
  });

  if (!result.ok) {
    /*
     * A refusal is printed as a refusal. Nothing was written, so there is no
     * audit entry to point at, and saying "failed" would imply an attempt.
     *
     * `runProvision` never quotes the password, so this line is safe to print
     * and safe to redirect into a file.
     */
    process.stdout.write(`\nRefused. Nothing was changed.\n\n${result.message}\n`);
    return 1;
  }

  const email = parsed.email.trim().toLowerCase();

  let envNote = '';
  if (parsed.writeEnv) {
    const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
    try {
      const existing = readFileSync(envPath, 'utf8');
      const updated = setEnvValue(
        setEnvValue(existing, 'ADMIN_EMAIL', email),
        'ADMIN_PASSWORD',
        password,
      );
      writeFileSync(envPath, updated, 'utf8');
      envNote = `Written to ${envPath}. That file is gitignored.`;
    } catch (error) {
      /*
       * Reported, not fatal: the account was created and promoted, and that is
       * the part that cannot be repeated. Losing the password file means the
       * operator must rotate, which this says how to do.
       */
      envNote =
        `The credential could NOT be written to .env (${(error as Error).message}). ` +
        'The password printed below is the only copy; record it now, or run again with --rotate.';
    }
  }

  process.stdout.write(
    `\n${result.message}\n\n` +
      '  This is the only time the password is shown. It is not recorded anywhere else.\n\n' +
      `  login:    ${email}\n` +
      `  password: ${password}\n\n` +
      (envNote ? `${envNote}\n` : ''),
  );

  if (result.warning) process.stderr.write(`\nWarning: ${result.warning}\n`);

  process.stdout.write(`\nThe action is recorded in admin_audit_log (target ${result.userId}).\n`);
  return 0;
}

/*
 * `process.exitCode` rather than `process.exit()`, so stdout is flushed before
 * the process ends. On a pipe, `process.exit()` can truncate the credential the
 * operator needs — which, for this script, would be the only copy.
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
