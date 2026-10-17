# Administrator bootstrap

How the first administrator comes to exist, and how to recover when the last one
is lost. This is the document `src/scripts/bootstrapAdmin.ts` and
`src/admin/bootstrap.ts` refer to in their headers; it did not exist until now,
so those references pointed at nothing.

**Nothing in this document is a record of a successful run.** No bootstrap has
been executed against the hosted project, and it could not have been: the
hosted database currently refuses `profiles` writes (`42501
insufficient_privilege`) and the audit table does not exist yet. See
`docs/integration-status-2026-10-15.md`. What follows describes the mechanism in
this repository and the rules it enforces, which are covered by
`apps/backend/test/admin-bootstrap.test.ts`.

---

## Why it is out of band

The first administrator cannot be created from the app. Any control that could
promote an ordinary account would be a control an ordinary account could use, so
the role would mean nothing. It is therefore granted once, by a command run by
hand against the database with a service-role key.

There is no HTTP route for it, no master password, no universal login and no
second credential store. The console signs in with the same Supabase Auth
identity as every other part of the product; the role is read from `profiles` on
every request and is never taken from the token's claims.

## Running it

```sh
cd apps/backend

# Grant the role to an account that already exists.
npm run bootstrap:admin -- --email you@example.com --reason "Initial administrator"

# Restore an administrator whose account was suspended.
npm run bootstrap:admin -- --email you@example.com --reason "Locked out" --recovery
```

| Flag | Meaning |
|---|---|
| `--email <address>` | The account to act on. **It must already exist.** |
| `--reason "<text>"` | Why, in at least 3 characters. Written to the audit log. |
| `--recovery` | Restore a suspended administrator instead of promoting. |
| `--help` | The usage text. |

`npm run` passes `--env-file-if-exists=.env`, so a local `apps/backend/.env`
holding the Supabase URL and service-role key is enough. Nothing needs to be
exported by hand.

## What it refuses

These are the rules in `src/admin/bootstrap.ts`, and they are the reason the
command is not a permanent way in:

- **It never creates an account.** An email with no account is refused. Accounts
  are created by signing up in the app.
- **It refuses to promote while any active administrator exists.** This is the
  line that keeps it from being a backdoor: it can be used exactly once, while
  the project has none.
- **`--recovery` cannot grant the role.** It restores a row that already carries
  `role = 'admin'` and is not active. It cannot promote a new account.
- **It refuses a suspended ordinary account.**
- **It refuses a reason shorter than 3 characters.**

It is idempotent: running it against an account that is already an active
administrator succeeds and changes nothing.

## What it never does

- It does not set, store, print or transmit a password. There is no password
  column, no default credential and no secret in this repository.
- It does not print the service-role key, not even truncated.
- It does not listen on a port.

## Audit

A successful run writes two rows under one `cli-…` request id: a `requested` row
before the change and an outcome row after it. The failure to write the first row
aborts the operation rather than proceeding unaudited. Because the actor is a
person at a terminal and not a signed-in account, the rows carry a null
`actor_id`/`actor_email` and record `metadata.actor = 'operator-cli'` — an
honest "no account recorded" rather than a guess at which administrator ran it.

## Recovering from losing every administrator

Removing the last active administrator is refused by both the console and the
backend, so the state is not reachable by ordinary use. If it is reached anyway —
by editing the database directly, for instance — the way back is the same
command with `--recovery`, and it can only restore an account that still carries
the role. If no such row exists, the role must be granted in the database
console; there is no path through this application by design.

## Prerequisites

1. Supabase migrations applied, including the missing `GRANT` statements on the
   `profiles` table. Until that is done, the promotion cannot succeed and the
   audit rows cannot be written.
2. The target account already present in Supabase Auth.
3. `SUPABASE_URL` and a service-role key in the environment.

`docs/admin-migration-checklist.md` covers the ordered SQL.
