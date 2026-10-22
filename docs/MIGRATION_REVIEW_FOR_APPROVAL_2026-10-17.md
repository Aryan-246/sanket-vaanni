# Sanket Vaanni — Migration Review for Owner Approval
**Date:** 2026-10-17  
**Status:** Ready for your review and explicit approval before application  
**Environment:** Hosted Supabase (mmovhldjwadvljxtloes.supabase.co)

---

## EXECUTIVE SUMMARY

Four migrations must be applied to your hosted Supabase in exact order. All are **idempotent and safe to re-run**. No data is deleted. The most critical one is Migration #3 (owner protection trigger), which is the core of your permanent ownership system.

**One breaking change exists:** Migration #1 drops the old function signatures `is_admin(uuid)` and `is_active(uuid)`. If you have saved queries, views, or external jobs using these signatures, they will fail. Otherwise, this does not affect you.

---

## THE FOUR MIGRATIONS IN DETAIL

### Migration #1: `20261014000000_admin_audit_maintenance.sql`

**What it adds:** Admin role/status columns, audit log, announcements system, privilege-boundary trigger, maintenance mode.

**Key design decisions:**
- `profiles.role` and `profiles.status` are writable **only by service role** (enforced by trigger)
- Audit log is append-only: `authenticated` holds only SELECT; `service_role` holds SELECT and INSERT. No role holds UPDATE or DELETE, and there is no write policy for a client role.
- Announcements and maintenance mode are readable by anonymous users (signed-out clients need to see outage notices)
- `is_admin()` and `is_active()` functions take no arguments (caller's identity derived from JWT token)

**Breaking change:**
```sql
DROP FUNCTION IF EXISTS public.is_admin(UUID);    -- Old signature with argument
DROP FUNCTION IF EXISTS public.is_active(UUID);   -- Old signature with argument
```

Replaced with zero-argument versions:
```sql
CREATE OR REPLACE FUNCTION public.is_admin()      -- New: no argument
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER ...
```

**Questions for you:**
1. Do you have any **saved queries, views, or scheduled jobs** in the hosted project that call `is_admin(some_uuid)` or `is_active(some_uuid)`?
2. If yes, they will break when this runs. Would you need to fix them manually afterwards?

**Impact:** None on user data. Profiles table gains 3 new columns with defaults.

**Risk:** LOW — fully idempotent, all statements use IF NOT EXISTS or probe carefully

---

### Migration #2: `20261014000001_device_push_tokens.sql`

**What it adds:** Device push token registry for Firebase Cloud Messaging.

**Design:**
- `token` is PRIMARY KEY (one token, one owner at a time)
- When user signs out on phone, token is deleted (next person won't get their notifications)
- When a new person uses the same phone, token is claimed/transferred to them
- Claim happens atomically via `register_device_push_token()` function (SECURITY DEFINER)
- Cap: max 20 tokens per user (prevents storage abuse)

**Key hardened decisions:**
- `platform` must be 'android' or 'ios' (constraint checked before insert)
- `token` must be 20-4096 characters long (rejects junk)
- `search_path = ''` with schema-qualified names (prevents shadowing attacks)
- Uses upsert instead of DELETE-then-INSERT (atomic, safe under concurrency)

**Dependencies:** Depends on Migration #1 (needs `public.is_admin()` function to exist, even though not directly used)

**Impact:** None on user data. New table created.

**Risk:** LOW — fully idempotent, all constraints probe by (schema, table, name)

---

### Migration #3: `20261017000000_account_security_team.sql` 

**What it adds:** Permanent owner protection, last-admin guard, account deletion OTP challenges, team/about content, storage buckets.

**CRITICAL: The owner protection trigger**

```sql
CREATE OR REPLACE FUNCTION public.guard_owner_and_last_admin()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE remaining_active_admins INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- 1. Block owner deletion entirely
    IF OLD.is_owner THEN
      RAISE EXCEPTION 'owner_protected: the permanent owner account cannot be deleted'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 2. Block deletion of last active admin
    IF OLD.role = 'admin' AND OLD.status = 'active' THEN
      SELECT count(*) INTO remaining_active_admins
        FROM public.profiles p
       WHERE p.role = 'admin' AND p.status = 'active' AND p.id <> OLD.id;
      IF remaining_active_admins = 0 THEN
        RAISE EXCEPTION 'last_admin_protected: the last active administrator cannot be deleted'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  -- 3. Owner cannot be demoted, suspended, or unmarked
  IF OLD.is_owner THEN
    IF NEW.is_owner IS DISTINCT FROM true
       OR NEW.role IS DISTINCT FROM 'admin'
       OR NEW.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'owner_protected: the permanent owner cannot be unmarked, demoted or suspended'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- 4. Last active admin cannot be demoted or suspended
  IF OLD.role = 'admin' AND OLD.status = 'active'
     AND NOT (NEW.role = 'admin' AND NEW.status = 'active') THEN
    SELECT count(*) INTO remaining_active_admins
      FROM public.profiles p
     WHERE p.role = 'admin' AND p.status = 'active' AND p.id <> OLD.id;
    IF remaining_active_admins = 0 THEN
      RAISE EXCEPTION 'last_admin_protected: the last active administrator cannot be demoted or suspended'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
```

**This protects:**
1. Owner from deletion (even via cascade from auth.users deletion)
2. Owner from demotion, suspension, or unmarking
3. Last active admin from deletion
4. Last active admin from demotion or suspension

**Other additions:**

- `profiles.is_owner` BOOLEAN NOT NULL DEFAULT false
- Unique index: at most one profile can have `is_owner = true`
- CHECK constraint: owner must have `role = 'admin' AND status = 'active'`
- `account_deletion_challenges` table (OTP codes for verified deletion)
- `claim_deletion_challenge()` function (atomic OTP verification with FOR UPDATE)
- `team_members` table (About screen content)
- Storage buckets: `avatars` (user-scoped writes), `team-media` (admin-only writes)

**Dependencies:** Requires Migration #1 (uses `is_admin()` function)

**Foreign key safety:**
```sql
actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL
```
When a profile is deleted, audit log's `actor_id` becomes NULL (audit record preserved).

```sql
user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
```
When auth user is deleted, deletion challenges are cascaded away (expected).

**Impact:** None on existing data. Adds new columns, new tables, new buckets.

**Risk:** MEDIUM (most critical security feature, but fully tested and idempotent)

**Why `search_path = public, auth`?** The trigger needs to COUNT profiles and call auth.uid(). Public schema has tables, auth schema has the JWT functions.

---

### Migration #4: `20261017000001_base_table_grants.sql`

**What it adds:** Table-level privileges (GRANT/REVOKE) to fix hosted permission errors.

**The problem it solves:**
- Local Supabase applies default privileges (all roles get something)
- Hosted Supabase did not apply those defaults
- Result: even `service_role` (which bypasses RLS) gets `42501 permission denied` on base tables
- RLS and grants are different—RLS alone cannot fix this

**Exact changes:**

```sql
-- Reset both client roles first. Supabase's default privileges grant ALL on
-- new public tables, including TRUNCATE, which bypasses RLS entirely.
REVOKE ALL ON public.profiles             FROM anon, authenticated;
REVOKE ALL ON public.user_preferences     FROM anon, authenticated;
REVOKE ALL ON public.calibration_profiles FROM anon, authenticated;
REVOKE ALL ON public.oled_profiles        FROM anon, authenticated;
REVOKE ALL ON public.user_history         FROM anon, authenticated;

-- Five base tables from initial migration
GRANT SELECT, INSERT, UPDATE ON public.profiles             TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_preferences     TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.calibration_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.oled_profiles        TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_history         TO authenticated;

-- Backend client
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_preferences     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calibration_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oled_profiles        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_history         TO service_role;

-- Explicitly deny anonymous (included in the reset above; shown for clarity)
REVOKE ALL ON public.profiles             FROM anon;
REVOKE ALL ON public.user_preferences     FROM anon;
REVOKE ALL ON public.calibration_profiles FROM anon;
REVOKE ALL ON public.oled_profiles        FROM anon;
REVOKE ALL ON public.user_history         FROM anon;
```

**Why reset rather than add?**
- `GRANT` is additive. On a project whose default privileges handed `ALL` to `authenticated`, a bare GRANT would leave `DELETE`, `TRUNCATE`, `REFERENCES` and `TRIGGER` in place.
- `TRUNCATE` is a table-level operation that does **not** consult RLS: a signed-in user holding it could empty `profiles` without matching a policy.
- The reset removes only privileges granted by the role running the migration; on Supabase that is the role that set the defaults.

**Why no DELETE for authenticated?**
- No DELETE policy exists on these tables (RLS already denies it)
- Adding DELETE grant would be privilege without policy—expressly avoided
- Service role (backend) gets DELETE (it needs administrative access)

**Dependencies:** None on other migrations (can technically run first, but semantically should run last)

**Impact:** None on data. Changes permissions only.

**Risk:** LOW — fully idempotent GRANT/REVOKE, no functional change

---

## EXACT DEPLOYMENT SEQUENCE

**Prerequisites:**
1. You have `supabase` CLI installed
2. Your project is linked: `supabase link --project-ref mmovhldjwadvljxtloes`
3. You have tested these migrations against a local PostgreSQL (✅ done by team)

**Option A: Supabase CLI (recommended)**
```bash
cd supabase
supabase migration list                    # Confirms current state
supabase db push                           # Applies #1, #2, #3, #4 in order
```

**Option B: SQL editor (one file at a time, in order)**
1. Copy contents of `supabase/migrations/20261014000000_admin_audit_maintenance.sql`
2. Paste into Supabase > SQL editor > Run
3. Wait for success
4. Repeat for `20261014000001_device_push_tokens.sql`
5. Repeat for `20261017000000_account_security_team.sql`
6. Repeat for `20261017000001_base_table_grants.sql`

**If a file fails:**
- Note the error message
- Do NOT proceed to the next file
- Re-run the same file (all are idempotent)
- If it fails again, stop and report the error

---

## VERIFICATION AFTER DEPLOYMENT

After applying all four migrations, run these queries in the Supabase SQL editor to confirm:

**1. All tables exist**
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'admin_audit_log', 'announcements', 'app_settings', 
    'device_push_tokens', 'team_members', 'account_deletion_challenges'
  )
ORDER BY table_name;
-- Expected: 6 rows
```

**2. Owner and role columns exist**
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
  AND column_name IN ('is_owner', 'role', 'status', 'avatar_url')
ORDER BY column_name;
-- Expected: 4 rows
```

**3. Trigger exists**
```sql
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'public.profiles'::regclass
  AND NOT tgisinternal
  AND tgname = 'guard_owner_and_last_admin';
-- Expected: 1 row, tgenabled = 'O' (enabled)
```

**4. Audit log is append-only for client roles**
```sql
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'admin_audit_log'
ORDER BY grantee, privilege_type;
-- Expected: 
--   authenticated → SELECT only
--   service_role → INSERT, SELECT
-- NO UPDATE or DELETE for any role
```

**5. RLS enabled on all protected tables**
```sql
SELECT relname, relrowsecurity FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('profiles', 'admin_audit_log', 'app_settings', 'announcements',
                  'device_push_tokens', 'team_members', 'user_preferences',
                  'calibration_profiles', 'oled_profiles', 'user_history')
ORDER BY relname;
-- Expected: all rows have relrowsecurity = true
```

**6. Self-promotion guard works (signed-in user test)**
```sql
UPDATE public.profiles SET role = 'admin' WHERE id = auth.uid();
-- Expected: ERROR insufficient_privilege
-- "Changing role, status, ownership or email requires the service role. Client tokens cannot promote, suspend, own or re-address an account."

UPDATE public.profiles SET is_owner = true WHERE id = auth.uid();
-- Expected: ERROR insufficient_privilege (same message)
```

If any verification fails, stop and report.

---

## ROLLBACK (If Needed)

**There is no automatic down-migration.** This is intentional—rollbacks are operations on live data and should be explicit decisions, not one-command accidents.

**If you must rollback**, the safe options in order of preference are:

1. **Re-run the migration file** (all are idempotent — re-running completes what was interrupted)
2. **Restore from a Supabase backup** (if data was damaged by something other than the migration itself)
3. **Hand-written script** if a specific object must be removed (the reversals are: DROP the three new tables, DROP the two new buckets, DROP the new columns/constraints/triggers/functions)

**What you must NOT do:**
- Do not drop `public.profiles` or `auth.users` (cascades to all user data)
- Do not manually edit RLS policies without understanding them (RLS fails closed)
- Do not try to "undo" by editing the migration file (that file is the source of truth)

---

## QUESTIONS FOR YOU

Before you approve, please consider:

1. **Function signature breaking change:** Do you have any queries/views/jobs using `is_admin(some_uuid)` or `is_active(some_uuid)`? 
   - Answer: If unsure, search your Supabase dashboard > SQL queries, scheduled functions, external integrations
   - Action: If yes, note them down before applying—you may need to update them afterwards

2. **Team member onboarding:** Once these migrations run, designate the owner:
   ```bash
   cd apps/backend
   # The account must already exist (sign up in the app first).
   npm run bootstrap:admin -- --email <your-email> --reason "Initial administrator"
   ```
   - On a fresh project this promotes the account and marks it as the permanent owner in one update.
   - On a project that already has administrators, promote normally, then run the same command with `--owner` to designate the owner without changing the role.
   - `bootstrap:admin` never creates an account and never prints a password. The separate `provision:admin` script can create the *first* identity when no administrator exists; it generates a password and prints it once, to be stored outside the repository.
   - You then control who else gets admin access.

3. **Maintenance window:** Would you prefer to apply these during a specific time when nobody is using the app?
   - The migrations take ~30 seconds
   - RLS policies are fail-closed (if a policy drops temporarily, no rows are returned instead of all rows being exposed)

---

## WHAT HAPPENS NEXT (After You Approve)

1. You review this document and confirm all questions answered
2. You give explicit written approval: "**Yes, apply these migrations**"
3. I run:
   ```bash
   cd supabase
   supabase db push
   ```
4. I verify all 6 verification queries above pass
5. You then run:
   ```bash
   cd apps/backend
   npm run bootstrap:admin -- --email <your-email> --reason "Initial administrator"
   ```
6. Admin API becomes fully operational
7. You can test the Admin screen on your phone with real data

---

## SUMMARY

| Migration | File | Adds | Breaking | Risk | Depends On |
|---|---|---|---|---|---|
| #1 | `20261014000000_admin_audit_maintenance.sql` | Role/status, audit log, announcements, maintenance mode, privilege trigger | ✅ Yes (`is_admin(uuid)` signature changes) | LOW | None |
| #2 | `20261014000001_device_push_tokens.sql` | Push token registry, claims function | ❌ No | LOW | #1 |
| #3 | `20261017000000_account_security_team.sql` | Owner protection, team content, storage buckets, deletion challenges | ❌ No | MEDIUM | #1 |
| #4 | `20261017000001_base_table_grants.sql` | Table-level grants (fixes permission errors) | ❌ No | LOW | None |

**All tested locally against real PostgreSQL. All idempotent. No data loss. Ready for your approval.**

---

**Prepared:** 2026-10-17T15:30 UTC  
**Repository:** https://github.com/Aryan-246/sanket-vaanni  
**Branch:** `3d-hand-viewer-integration`

---

## RE-VALIDATION — 2026-10-18 (hosted evidence, read-only)

Nothing was applied. The hosted project was probed through PostgREST with the
publishable key only; results are existence checks, not writes.

**Hosted schema state (`https://mmovhldjwadvljxtloes.supabase.co/rest/v1/*`):**

| Table | Response | Meaning |
|---|---|---|
| `profiles` | `42501 permission denied` | **exists** (grants pending) |
| `user_history` | `42501 permission denied` | **exists** (grants pending) |
| `user_preferences` | `42703 column does not exist` | **exists** |
| `oled_profiles` | `42703 column does not exist` | **exists** |
| `calibration_profiles` | `42501 permission denied` | **exists** (grants pending) |
| `announcements` | `PGRST205` | **MISSING** |
| `admin_audit_log` | `PGRST205` | **MISSING** |
| `device_push_tokens` | `PGRST205` | **MISSING** |
| `app_settings` | `PGRST205` | **MISSING** |
| `account_deletion_challenges` | `PGRST205` | **MISSING** |
| `team_members` | `PGRST205` | **MISSING** |

This is the direct cause of two visible failures:

- `GET https://sanket-vaanni-backend.onrender.com/team` → **502** ("The team content could not be read."). The route's 503 branch did **not** fire, so the Supabase environment is configured; the query failed because `public.team_members` does not exist.
- On the handset, Settings reports: *"Could not find the table 'public.announcements' in the schema cache"*.

**Throwaway-cluster result (PostgreSQL 18.4, Supabase `auth`/`storage` stubs):**

All six files applied in filename order with `ON_ERROR_STOP=1`:

```
PASS 20261012000000_sanket_vaanni_initial.sql
PASS 20261013000000_storage_user_media_policies.sql
PASS 20261014000000_admin_audit_maintenance.sql
PASS 20261014000001_device_push_tokens.sql
PASS 20261017000000_account_security_team.sql
PASS 20261017000001_base_table_grants.sql
```

All 11 tables and all 10 functions in this document's verification list were
created. Behavioural checks on the guard trigger:

| Check | Result |
|---|---|
| Demote one of two active admins | allowed (`UPDATE 1`) |
| Demote the last active admin | refused — `last_admin_protected` |
| Delete the last active admin | refused — `last_admin_protected` |
| Unmark the owner | refused — `owner_protected` |
| Delete the owner | refused — `owner_protected` |
| Demote the owner while another admin exists | refused — `owner_protected` |

**The two non-approval gaps remain.** Applying these four migrations to the
hosted project is a privileged, irreversible-in-practice change and still
requires the owner's explicit "Yes, apply these migrations".

---

## CHANGES SINCE THIS REVIEW — 2026-10-18

The review above described the files as they stood on 2026-10-17. A full
re-read found six defects in the set; they are fixed in the working tree and
have **not been applied anywhere**. The approval request is for this corrected
set, not the earlier text.

| File | Defect found | Fix |
|---|---|---|
| `20261012000000_sanket_vaanni_initial.sql` | 15 `CREATE POLICY` statements with no `DROP POLICY IF EXISTS`, so a re-run failed on the first duplicate | Each is preceded by a drop; the file is now re-runnable |
| `20261013000000_storage_user_media_policies.sql` | Policies name a `user-media` bucket the file never creates; a bucket made public in the dashboard would bypass them | Creates the bucket if absent and forces `public = false` on every run |
| `20261014000000_admin_audit_maintenance.sql` | `profiles.avatar_url` CHECK rejected the public URL the app actually stores | Accepts `<uid>/...` or the public `avatars` bucket URL for that uid, `NOT VALID` for legacy rows |
| `20261014000000_admin_audit_maintenance.sql` | Audit log kept a default-granted INSERT for `authenticated` | Full `REVOKE ALL` for `anon, authenticated`, then SELECT only |
| `20261017000000_account_security_team.sql` | The privilege-boundary trigger did not guard `is_owner` or `email`: an administrator could make themselves permanent owner | Trigger now refuses client-token changes to role, status, `is_owner` and `email` |
| `20261017000000_account_security_team.sql` | Last-admin count-then-write could lose both admins under concurrency | Transaction-scoped advisory lock around the decision |
| `20261017000001_base_table_grants.sql` | GRANTs were additive; default privileges could leave TRUNCATE (which bypasses RLS) | `REVOKE ALL` for `anon, authenticated` before granting the intended set |

Code was corrected to match: the first-administrator promotion now sets
`is_owner` in the same statement (bootstrap and provision), and
`bootstrap:admin --owner` designates an owner on a project that already has
administrators.

**Re-validation (PostgreSQL 18.4 throwaway cluster, Supabase `auth`/`storage` stubs):**

- All six files apply in filename order.
- All six apply a **second time** with no error.
- 26/26 behavioural checks pass, including: `authenticated` has no
  TRUNCATE/DELETE/REFERENCES on the base tables and no INSERT/UPDATE on the
  audit log; the avatar constraint accepts
  the owner's folder (path and public URL) and refuses another user's folder or
  an unrelated URL; a client token cannot set `is_owner`, change `email` or
  promote itself, but can change `display_name`; the service role can designate
  one owner and the unique index refuses a second.
- The six owner/last-admin guard cases above still pass unchanged.

Backend suite: 256 tests in 12 files pass, including six new owner-designation
cases.

**Still required from you:** the explicit approval sentence. No hosted SQL has
been executed.

