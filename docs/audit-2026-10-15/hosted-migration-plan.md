# Hosted Admin — proposed migration and grant plan

**Status: NOT APPLIED. Nothing in this document has been run against the hosted
project.** Every hosted statement below was read-only (a `SELECT` with `limit 0`, or a
`POST` to an RPC that either does not exist or is denied). Applying any of this requires
the owner's explicit approval of this exact plan.

Hosted project: `mmovhldjwadvljxtloes.supabase.co`.

---

## 1. What the hosted project contains today

Measured, not inferred. PostgREST distinguishes the two cases cleanly: `PGRST205` means
the table is absent from the schema cache; `42501` means it exists and the caller has no
privilege; `42703` means the column does not exist.

| Object | State | Evidence |
| --- | --- | --- |
| `profiles` | exists | `42501` on `select id` |
| `profiles.role`, `status`, `avatar_url` | **absent** | `42703` on `select id, role` etc. |
| `profiles.id`, `email` | exist | `42501` (not `42703`) |
| `user_preferences` | exists | `42501` |
| `calibration_profiles` | exists | `42501` |
| `oled_profiles` | exists | `42501` |
| `user_history` | exists | `42501` |
| `delete_user_account()` | exists | RPC returns `42501`, not `PGRST202` |
| `admin_audit_log` | **absent** | `PGRST205` |
| `app_settings` | **absent** | `PGRST205` |
| `announcements` | **absent** | `PGRST205` |
| `device_push_tokens` | **absent** | `PGRST205` |
| `is_admin()` | **absent** | RPC `PGRST202` |
| `is_active()` | **absent** | RPC `PGRST202` |
| `register_device_push_token()` | **absent** | RPC `PGRST202` |
| Storage bucket `user-media` | exists | `listBuckets()` |
| Storage policies on `user-media` | **UNKNOWN** | cannot read `pg_policies` without SQL access |

**Conclusion.** Migration `20261012000000_sanket_vaanni_initial` is applied.
`20261014000000_admin_audit_maintenance` and `20261014000001_device_push_tokens` are
**not** applied. The storage migration is partly evidenced — the bucket exists — but its
policies are unverified.

---

## 2. The blocking defect: the base tables have no grants

This is separate from the two unapplied migrations, and it would break the Admin system
even after they were applied.

**Measurement.** The backend uses the service-role key, which bypasses row-level
security. It is nonetheless refused:

```
profiles      select(id)     -> 42501  permission denied for table profiles
profiles      select(email)  -> 42501  permission denied for table profiles
user_history  select(user_id)-> 42501  permission denied for table user_history
```

RLS is not the obstacle — `service_role` bypasses RLS. **Table-level `GRANT`s are
missing**, and those are a different mechanism.

**Why it works locally.** The local Supabase stack grants privileges on new `public`
tables automatically, through the default privileges its own bootstrap installs. Those
defaults never applied to this hosted project's tables. The defect is invisible locally
and fatal remotely — which is exactly why the local stack passing proves nothing here.

**Root cause in the repository.** No migration grants privileges on the five base tables.
Searched every file in `supabase/migrations/`:

```
GRANT ... ON (TABLE) (profiles|user_preferences|calibration_profiles|oled_profiles|user_history)
  -> no matches
```

The three later migrations grant privileges conscientiously on the tables they create
(`admin_audit_log`, `app_settings`, `announcements`, `device_push_tokens`) and revoke
`anon` where appropriate. The five base tables were left to the platform's defaults.
That is a real gap in the schema's own consistency, not merely a hosted accident, and
fixing it explicitly also makes the local and hosted schemas agree.

---

## 3. The ordered plan

| Step | Action | Destructive? | Reversible? |
| --- | --- | --- | --- |
| 1 | New migration: grants on the five base tables | No — grants only | Yes — `REVOKE` |
| 2 | Apply `20261014000000_admin_audit_maintenance.sql` | Adds columns/tables | Only by hand (§7) |
| 3 | Apply `20261014000001_device_push_tokens.sql` | Creates one table | Yes — `DROP TABLE` |
| 4 | Verify bucket `user-media` policies | No | — |
| 5 | Provision the administrator identity (no SQL) | Creates one account | Yes |

**Order matters.** Step 1 before step 2: `is_admin()` is `SECURITY DEFINER` and would
read `profiles` regardless, but the *backend* reads `profiles` as `service_role`, and
without the grant the Admin API answers `42501` on every route even with the schema in
place. Grants first turns a two-variable failure into a one-variable one.

---

## 4. Step 1 — new migration: base-table grants

Proposed filename: `supabase/migrations/20261015000000_base_table_grants.sql`.

```sql
-- Table-level privileges for the five tables created by the initial migration.
--
-- The platform's default privileges grant these on the local stack, and did not
-- on this hosted project, so the same schema behaved differently in the two
-- places. Stating the grants makes the requirement explicit and the environments
-- agree. Row-level security is untouched and remains the boundary that decides
-- *which rows* each role sees; these grants only decide whether the role may
-- reach the table at all.

GRANT SELECT, INSERT, UPDATE ON public.profiles             TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_preferences     TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.calibration_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.oled_profiles        TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_history         TO authenticated;

GRANT ALL ON public.profiles             TO service_role;
GRANT ALL ON public.user_preferences     TO service_role;
GRANT ALL ON public.calibration_profiles TO service_role;
GRANT ALL ON public.oled_profiles        TO service_role;
GRANT ALL ON public.user_history         TO service_role;

-- No grants to `anon`. There is no policy on any of these five tables that
-- serves a signed-out caller, so the role has no reason to hold a privilege.
REVOKE ALL ON public.profiles             FROM anon;
REVOKE ALL ON public.user_preferences     FROM anon;
REVOKE ALL ON public.calibration_profiles FROM anon;
REVOKE ALL ON public.oled_profiles        FROM anon;
REVOKE ALL ON public.user_history         FROM anon;
```

**Why `SELECT, INSERT, UPDATE` and not `ALL` for `authenticated`:** those are exactly the
verbs the initial and admin migrations create policies for. There is no `DELETE` policy
on any of the five, so a `DELETE` grant would confer a privilege no policy permits —
least privilege, and it keeps the grant list and the policy list in agreement.

**Privilege changes:** adds to `authenticated`, adds to `service_role`, removes all from
`anon`.

**RLS impact:** none. `ENABLE ROW LEVEL SECURITY` is already set on all five by the
initial migration, and this migration adds no policy and changes no policy.

**Rollback:** trivially reversible with `REVOKE` — nothing is dropped and no data moves.

**Verification:** re-run the `42501` probe; each of the five should stop returning it.

### Open question (not part of this plan)

There is no `DELETE` policy on `user_history`, so a user cannot delete their own
recognition history and no grant here would let them. If "delete my data" is meant to
cover recognition history, that needs a policy, an audit decision, and an owner
decision — it is raised here rather than silently included.

---

## 5. Step 2 — `20261014000000_admin_audit_maintenance.sql` (788 lines)

### 5.1 Exact schema changes

| # | Change |
| --- | --- |
| 1 | `profiles` gains `avatar_url TEXT`, `role TEXT NOT NULL DEFAULT 'user'`, `status TEXT NOT NULL DEFAULT 'active'` |
| 2 | Three named CHECK constraints: `profiles_role_check` (`role IN ('user','admin')`), `profiles_status_check` (`status IN ('active','suspended')`), `profiles_avatar_path_check` (an avatar must not be an `http(s)://` URL — it is a path in a private bucket, so a public link must not be storable) |
| 3 | Partial index `idx_profiles_role` (`WHERE role = 'admin'`), index `idx_profiles_status` |
| 4 | New table `admin_audit_log` with `CHECK (length(btrim(reason)) >= 3)` — a consequential action without a stated reason cannot be recorded |
| 5 | Three indexes on `admin_audit_log` (`created_at DESC`, `actor_id`, `(target_type, target_id)`) |
| 6 | New table `app_settings` + a seeded row for the maintenance setting |
| 7 | New table `announcements` + a partial index `idx_announcements_live` |
| 8 | Functions `is_admin()`, `is_active()`, `enforce_profile_privilege_boundary()` (+ trigger on `profiles`, `BEFORE INSERT OR UPDATE`) |
| 9 | `handle_new_user()` replaced: now also writes the `user_preferences` row and pins `role`/`status` to literals, ignoring any `role` key in signup metadata |
| 10 | `DROP FUNCTION IF EXISTS public.is_admin(UUID)` and `is_active(UUID)` — both absent on hosted, so no-ops |

`ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT` on a table with rows is safe on
PostgreSQL 11+ (the default is stored in the catalogue; the table is not rewritten).
Hosted runs PostgreSQL 17. There is one existing auth user, so this matters here.

### 5.2 Privilege changes

| Object | Change |
| --- | --- |
| `is_admin()`, `is_active()` | `REVOKE ALL FROM PUBLIC`, `REVOKE ALL FROM anon`, `GRANT EXECUTE TO authenticated` |
| `admin_audit_log` | `REVOKE ALL FROM anon`; `REVOKE UPDATE, DELETE, TRUNCATE FROM authenticated`; `GRANT SELECT TO authenticated`; `GRANT INSERT, SELECT TO service_role` |
| `app_settings` | `REVOKE ALL FROM anon, authenticated`; `GRANT SELECT (key, value) TO anon, authenticated`; `GRANT ALL TO service_role` |
| `announcements` | `REVOKE INSERT, UPDATE, DELETE, TRUNCATE FROM anon, authenticated`; `GRANT SELECT TO anon, authenticated`; `GRANT ALL TO service_role` |

The explicit `REVOKE ... FROM anon` on the two functions is deliberate and documented in
the file: Supabase grants `EXECUTE` on new `public` functions **directly** to `anon`,
`authenticated` and `service_role`, so revoking from `PUBLIC` alone would leave the
direct grant to `anon` in place and the function callable while signed out.

### 5.3 RLS impact

| Table | Effect |
| --- | --- |
| `profiles` | RLS already on. Adds policy "Administrators can read all profiles" (`FOR SELECT TO authenticated USING (is_admin() OR id = auth.uid())`). Read-only: **no** admin INSERT/UPDATE/DELETE policy exists, so the admin UI cannot write through the client even if `role` were wrong |
| `admin_audit_log` | RLS enabled. One policy: administrators may `SELECT`. Append-only is enforced by the *absent* UPDATE/DELETE policy **and** by withdrawal of the grants — two independent barriers |
| `app_settings` | RLS enabled. Policy: the maintenance setting is publicly readable (it must be, so a closed app can be explained to a signed-out user) |
| `announcements` | RLS enabled. Two policies: published announcements readable by everyone; administrators read all (including drafts) |
| `user_preferences`, `calibration_profiles`, `oled_profiles`, `user_history` | **15 policies rewritten** to add `AND public.is_active()`. This is the change that makes a suspension real — without it a suspended account keeps full access to its own data |

**Ordering inside the file is correct and load-bearing:** `is_active()` is defined before
the policies that call it, and `is_admin()` is `SECURITY DEFINER` specifically so the
`profiles` policy does not recurse into itself ("infinite recursion detected in policy").

**One behaviour change to expect.** After this migration a suspended user cannot read
their own data. That is the intent, and it is also the reason the earlier local
verification of a suspension was meaningful: the status column and the policies that
honour it arrive together.

### 5.4 Rollback limitations — **read this before approving**

- Supabase migrations have **no automatic down step**. Reverting is a hand-written script.
- Reverting means dropping `admin_audit_log`, `app_settings` and `announcements`.
  Dropping `admin_audit_log` **destroys the audit history irrecoverably**. Any admin
  action taken between applying and reverting becomes unattributable.
- Reverting means `ALTER TABLE profiles DROP COLUMN role`. That **silently removes every
  administrator grant**, including yours — the project returns to having no admin, and
  `provision:admin` must be run again.
- The 15 rewritten policies would need restoring from the initial migration — **but the
  initial migration cannot simply be re-run.** It contains 15 bare `CREATE POLICY`
  statements with no `DROP POLICY IF EXISTS`, so a second run fails with
  `policy "..." already exists` at the first one. Restoring them requires a hand-written
  migration. This is the sharpest rollback limitation in the set.
- `handle_new_user()` would need restoring by hand from the initial migration's body.

**Mitigation, if you want one:** take a database backup or a `pg_dump --schema-only` plus
a data export of `profiles` before applying. I can prepare the exact commands, but I will
not run an export that writes your data anywhere without your say-so.

### 5.5 Verification steps (run after applying, before provisioning)

```sql
-- 1. columns exist
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='profiles'
  and column_name in ('role','status','avatar_url');

-- 2. constraints exist
select conname from pg_constraint c
join pg_class t on t.oid=c.conrelid
join pg_namespace n on n.oid=t.relnamespace
where n.nspname='public' and t.relname='profiles' and conname like 'profiles_%';

-- 3. no administrator exists yet (must be 0)
select count(*) from public.profiles where role='admin' and status='active';

-- 4. policies on the user-data tables all mention is_active
select tablename, policyname, qual from pg_policies
where schemaname='public' and tablename in
  ('user_preferences','calibration_profiles','oled_profiles','user_history');

-- 5. append-only audit log: these must NOT be present
select grantee, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name='admin_audit_log';
```

Then, from the application side: `GET /admin/overview` must return **401 without a
token** (not 500, and not 200).

---

## 6. Step 3 — `20261014000001_device_push_tokens.sql` (321 lines)

### 6.1 Exact schema changes

- New table `device_push_tokens`: `token TEXT PRIMARY KEY`, `user_id UUID NOT NULL
  REFERENCES auth.users(id) ON DELETE CASCADE`, `platform TEXT NOT NULL DEFAULT 'android'`,
  `created_at`/`updated_at`/`last_seen_at`.
- Constraints added separately and guarded (the file's own note explains the previous
  revision left `platform` unconstrained, so a client could store any string in a column
  the dispatcher reads to choose a transport; a length bound rejects both a typo and an
  attempt to store something that is not a token).
- Index on `user_id`, RLS enabled, three policies (`select_own`, `insert_own`,
  `delete_own`).
- Function `register_device_push_token(TEXT, TEXT)`.

### 6.2 Privilege changes

- `REVOKE ALL FROM anon`, `REVOKE ALL FROM authenticated`, then
  `GRANT SELECT, INSERT, DELETE TO authenticated` — **no UPDATE**: a client may register
  and remove its own token, not rewrite an existing row.
- `GRANT ALL TO service_role`.
- `register_device_push_token(TEXT, TEXT)`: `REVOKE` from `PUBLIC` and `anon`,
  `GRANT EXECUTE TO authenticated`.

### 6.3 Rollback

`DROP TABLE public.device_push_tokens` and `DROP FUNCTION register_device_push_token(TEXT,TEXT)`.
Reversible with no lasting data loss in principle: a lost registration is regenerated the
next time the app opens, provided the app re-registers. **Devices would not receive push
notifications until each one next launches.**

---

## 7. Step 4 — storage policies

The `user-media` bucket exists. The policies in
`20261013000000_storage_user_media_policies.sql` isolate per-user folders via
`(storage.foldername(name))[1] = (auth.uid())::text` for SELECT, INSERT, UPDATE, DELETE.

Because the policies cannot be read from here, this step is **verify, then decide**:

```sql
select policyname, cmd, qual from pg_policies
where schemaname='storage' and tablename='objects';
```

If they are absent they must be applied; if present, nothing to do. **They are not
urgent**: no code in the app uploads to this bucket — a search of the whole mobile
codebase for `storage.from(` returns no call sites. The gap is latent, not active.

---

## 8. Step 5 — provisioning the administrator (no SQL)

After step 2, with the hosted `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in
`apps/backend/.env`:

**If you already have an account you want to use** (the project has one auth user):

```
cd apps/backend
npm run bootstrap:admin -- --email <your-address> --reason "Initial administrator"
```

**If you want a new account created for you:**

```
cd apps/backend
npm run provision:admin -- --email <your-address> --reason "Initial administrator"
```

Both refuse if any active administrator already exists; `bootstrap` never creates an
account and `provision` refuses to touch an address that already has one. So running the
wrong one cannot produce a duplicate or a second administrator. The password is generated
locally from 24 CSPRNG bytes, written only to the gitignored `apps/backend/.env`, and
printed once to your terminal. It is never written to an audit row, a log, or any
committed file.

---

## 9. What is not in this plan

- No change to `delete_user_account()`. The missing last-administrator guard and the
  absent email-verification step (Priority 3) need their own migration; designing the OTP
  challenge is a schema decision I want you to see separately rather than bundling into a
  plan whose approval is already a large ask.
- No `ALTER DEFAULT PRIVILEGES`. It would stop this class of defect recurring, but it
  changes defaults for all future tables, which is a bigger commitment than fixing the
  five tables that exist.
- No remote SQL, no backup export, no branch, no commit, no deploy.

## 10. What I need from you

Approval of **this exact plan** — specifically: (1) the new grants migration in §4,
(2) applying `20261014000000`, (3) applying `20261014000001`, (4) the storage
verification in §7, (5) which of `bootstrap:admin` or `provision:admin` you want in §8,
and whether you want a backup taken first.

Say the word and I will do them in this order, verifying after each step rather than at
the end, so a failure at step 2 does not leave you wondering which step caused it.
