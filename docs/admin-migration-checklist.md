# Sanket Vaanni — Migration Review and Deployment Checklist

**For:** the project owner.
**Status: NOTHING IN THIS DOCUMENT HAS BEEN RUN.** No migration has been applied to the hosted Supabase project. No permission has been changed remotely. No data has been modified. This file is a prepared, ordered list for **you** to review and execute yourself.

**Why it is hand-written rather than automatic:** the brief for this work forbids applying migrations, altering permissions or running `supabase db push` against the hosted project without explicit owner approval. Preparing the exact commands and the review points is the deliverable; running them is yours.

**Ownership note:** the SQL files under `supabase/` belong to the database-permission workstream. This checklist **reads and describes** them. It does not modify them, and no file under `supabase/` was changed as part of this work.

---

## 0. What is being deployed, and why it is safe to deploy

Four migrations, in this order (timestamp order is deployment order):

| # | File | Adds |
|---|---|---|
| 1 | `20261012000000_sanket_vaanni_initial.sql` | The base schema: `profiles`, `user_preferences`, `calibration_profiles`, `oled_profiles`, `user_history`, and the account-creation trigger. |
| 2 | `20261013000000_storage_user_media_policies.sql` | Policies on the `user-media` storage bucket. |
| 3 | `20261014000000_admin_audit_maintenance.sql` | `role`/`status`/`avatar_url` on `profiles`; `admin_audit_log`, `app_settings`, `announcements`; the privileged-column trigger; all RLS policies and grants for the administration system. |
| 4 | `20261014000001_device_push_tokens.sql` | `device_push_tokens` and the `register_device_push_token` function. Header states it **depends on #3 having run first**. |

**Every statement in #3 and #4 is idempotent and safe to re-run.** Verified statement by statement: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guarded `ADD CONSTRAINT` (each probed against `pg_constraint` by name, schema and table), `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, `DROP POLICY IF EXISTS` + `CREATE POLICY`, `INSERT … ON CONFLICT (key) DO NOTHING`, and re-runnable `GRANT`/`REVOKE`. A second run is expected to change nothing and raise nothing.

**No migration deletes user data.** Across #3 and #4 there is **no** `DROP TABLE`, **no** `DROP COLUMN`, **no** `TRUNCATE`, **no** `DELETE`, and **no** `ALTER … DROP CONSTRAINT`. The only seed row is the `maintenance` setting, inserted with `ON CONFLICT DO NOTHING`.

---

## 1. Before you start — capture the current state

Do this first. If anything goes wrong, this is what tells you what changed.

```bash
# From the repository root.
git status --porcelain            # expect: no unstaged changes under supabase/
git log -1 --format='%H %s'       # record the commit you are deploying at
```

```bash
# Record what is currently applied to the hosted project.
cd supabase
supabase migration list
```

Keep that output. **Read it before proceeding:** if it already lists migrations 3 or 4 as applied, stop and reconcile rather than re-running them blind.

---

## 2. Suggested approach — review first, then apply

Do **not** paste all four files in one go. Apply, then verify after each one.

### Option A — Supabase CLI (preferred if the project is linked)

```bash
cd supabase
supabase link --project-ref <your-project-ref>    # only if not already linked
supabase migration list                            # confirm what is outstanding
supabase db push                                   # applies outstanding migrations in order
```

`db push` applies outstanding migrations in filename order, which is the order in the table above.

### Option B — SQL editor, one file at a time

Paste each file's contents into the hosted SQL editor and run it, **in the numbered order**, verifying after each (see §4). Run the whole file as one unit — several files open a `DO` block and depend on statements earlier in the same file.

### Whichever you choose

- **Do not skip #3 before #4.** #4's function depends on the account model #3 establishes.
- **Do not hand-edit a migration to make it apply.** If one fails, stop; the failure is information.
- **Work in a maintenance window if you can.** #3 creates policies, and there is a brief window mid-file during which some tables have fewer policies than before. RLS **fails closed** — no policy means no rows returned and no writes accepted — so the failure mode is unavailability, not exposure. Re-running the file completes it.

---

## 3. The review points — read these before approving

### 3.1 The one genuinely destructive statement in the set

```sql
DROP FUNCTION IF EXISTS public.is_admin(UUID);
DROP FUNCTION IF EXISTS public.is_active(UUID);
```

In `20261014000000_admin_audit_maintenance.sql`. These drop the **previous, argument-taking** versions of the helper functions, replacing them with zero-argument versions that read `auth.uid()` themselves.

**Why it matters to you:** the file drops the dependent policies immediately before this, so the drop itself succeeds. But if **anything outside these migrations** calls `is_admin(some_uuid)` or `is_active(some_uuid)` — a saved query, a view, a scheduled job, an external integration — that object will break the moment this runs.

**Action:** search the hosted project for other definitions referencing these two functions before applying. The functions themselves are recoverable (recreate with the old signature), so this is a review step, not a blocker.

### 3.2 The privileged-column trigger — the guard that matters most

`enforce_profile_privilege_boundary`, a `BEFORE INSERT OR UPDATE` trigger on `public.profiles`.

**What it prevents:** any client session promoting itself to `admin`, or lifting its own suspension, with a single PostgREST call. Without it, `profiles` would be a table where the `role` column is advisory.

**How it decides who is trusted:**

```sql
trusted := (current_setting('request.jwt.claim.role', true) = 'service_role')
        OR (current_user IN ('postgres', 'supabase_admin', 'service_role'));
```

**And it fails closed.** The claim is `COALESCE`d to `''`, so an absent or unreadable claim yields `''`, not `NULL`; the two disjuncts are booleans, so when neither matches, `trusted` is `FALSE` rather than `NULL`; and the guard is written `IF trusted IS NOT TRUE`, which denies on `NULL` as well as on `FALSE`.

**A NULL actor cannot bypass it.** This is stated explicitly because an earlier revision using `NOT trusted` without the `COALESCE` let an authenticated `INSERT` with `role = 'admin'` through — that hole is repaired in this version. If you review only one thing in this document, review this trigger.

> **Correction to an earlier note on file.** The privileged-column trigger is on **`profiles`**, not on `device_push_tokens`. `device_push_tokens` has no trigger at all; its tighter design is the absence of an UPDATE policy plus a minimal grant. Both guards are real; they are on different tables.

### 3.3 The grants that make the audit log append-only

```sql
REVOKE ALL ON public.admin_audit_log FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE ON public.admin_audit_log FROM authenticated;
GRANT SELECT ON public.admin_audit_log TO authenticated;
GRANT INSERT ON public.admin_audit_log TO service_role;
GRANT SELECT ON public.admin_audit_log TO service_role;
```

Three independent mechanisms — no UPDATE/DELETE policy exists for any role, the write verbs are revoked from `authenticated`, and `INSERT` is granted only to `service_role`. **Confirm after deployment that `authenticated` holds `SELECT` only** (§4, query 4).

### 3.4 What is exposed to signed-out clients — check you are comfortable

Two policies name `anon`:

| Policy | Table | Grants |
|---|---|---|
| `The maintenance setting is publicly readable` | `app_settings` | `SELECT` where `key = 'maintenance'` — the value only |
| `Published announcements are readable by everyone` | `announcements` | `SELECT` where published, already live, and not expired |

Both are **intentional and load-bearing**: a signed-out app has to be able to learn that the service is closed and to read notices. `app_settings` is column-granted (`SELECT (key, value)`), so `updated_by` is not readable by `anon`.

**Review:** confirm you are content that an unauthenticated caller can read the maintenance message and published notices. If you are not, that is a product decision to raise — not something to fix by quietly removing the policies, which would break the closed-app screen for signed-out users.

### 3.5 Announcing the "no super-admin role" decision

`profiles.role` is CHECK-constrained to `('user','admin')`. Adding a third tier is **not** part of these migrations. If you want a distinct highest-privilege role, that is a new migration and a policy audit, not a change to these files.

---

## 4. Verify after deployment

Run these in the SQL editor. Each has an expected result; if you get something else, stop and investigate.

**1 — The three administration tables exist:**

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('admin_audit_log', 'app_settings', 'announcements', 'device_push_tokens')
order by table_name;
-- expect 4 rows
```

**2 — The seed row is present and off:**

```sql
select key, value from public.app_settings where key = 'maintenance';
-- expect: enabled = false, message = ''
```

**3 — The trigger exists and is BEFORE INSERT OR UPDATE:**

```sql
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.profiles'::regclass and not tgisinternal;
-- expect: enforce_profile_privilege_boundary, tgenabled = 'O'
```

**4 — The audit log is append-only for client sessions:**

```sql
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'admin_audit_log'
order by grantee, privilege_type;
-- expect: authenticated → SELECT only
--         service_role  → INSERT, SELECT
--         no UPDATE or DELETE for any grantee
```

**5 — RLS is enabled on every protected table:**

```sql
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('profiles','admin_audit_log','app_settings','announcements',
                  'device_push_tokens','user_preferences','calibration_profiles',
                  'oled_profiles','user_history')
order by relname;
-- expect relrowsecurity = true for every row
```

**6 — The self-promotion guard actually works.** Run this **as a normal signed-in user's session** (not service role, not the SQL editor's owner role):

```sql
update public.profiles set role = 'admin' where id = auth.uid();
-- expect: ERROR  insufficient_privilege
--         "Changing role or status requires the service role.
--          Client tokens cannot promote or suspend an account."
```

If that `UPDATE` **succeeds**, the trigger is not doing its job and the deployment must not be considered complete.

---

## 5. After deployment — the first administrator

The `/admin` API requires an existing administrator, so the first one comes from the CLI. It is **not** an HTTP route, so it cannot be reached remotely.

```bash
cd apps/backend
# The account must already exist — sign up through the app first.
npm run bootstrap:admin -- --email <address> --reason "initial administrator"
```

It refuses while any active administrator exists, never creates an account, never sets a password, and writes an audit row identifying itself as `operator-cli` rather than as a user. Full behaviour table in `docs/admin-system.md` §7.

---

## 6. Rollback

**There is no down-migration.** None of these files has an inverse, and none should be improvised in production. What is available, in order of preference:

1. **Re-run the file.** Everything is idempotent. If a run was interrupted partway, running the same file again completes it. This is the correct response to almost every failure.
2. **Restore from a Supabase backup** if data was damaged. Take a backup before you begin; neither of these migrations deletes data, but the base schema (#1) is the one whose failure would be structural.
3. **Targeted reversal, by hand, if a specific change must be undone.** The reversals are all additive-to-remove and are *not* written out here on purpose — each one is a judgement call about live data, and a copy-pasteable "undo everything" block is how a rollback becomes the incident. If you need one, the objects to look at are: the three tables and `device_push_tokens`; the `role`, `status` and `avatar_url` columns on `profiles`; the `enforce_profile_privilege_boundary` trigger; and the two zero-argument `is_admin()` / `is_active()` functions.

**What you must not do:** drop `public.profiles` or `auth.users` to "start over". The first cascades through every user-data table; the second destroys every account in the project.

---

## 7. Confirmation of what was and was not done

| | |
|---|---|
| Migrations applied to the hosted project | **No** |
| Permissions or RLS changed remotely | **No** |
| Live data read, written or modified | **No** |
| `supabase db push` run | **No** |
| Files under `supabase/` modified by this work | **No** |
| Migrations executed against a throwaway **local** PostgreSQL cluster for validation | **Yes** — a disposable local cluster, never the hosted project; this is how the NULL-logic hole in the trigger was found and fixed before it could reach production. |
| Proposed commands prepared for owner review | **Yes** — §2 |

**Outstanding owner action:** review §3, apply §2 in order, run §4's verification, then complete §5.
