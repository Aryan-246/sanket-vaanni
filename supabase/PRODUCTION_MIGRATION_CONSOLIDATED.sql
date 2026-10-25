-- Table-level privileges for the five tables created by the initial migration.
--
-- This is the grant fix proposed in `docs/audit-2026-10-15/hosted-migration-plan.md`
-- §4. The local Supabase stack installs default privileges on new `public`
-- tables; the hosted project did not, so the same schema answered `42501`
-- (permission denied) there even for `service_role`, which bypasses RLS. Grants
-- and RLS are different mechanisms, and this is the missing grant layer.
--
-- ## Revoke first
--
-- Supabase's own default privileges grant `ALL` on new `public` tables to
-- `anon` and `authenticated`. On such a project a plain `GRANT SELECT, INSERT,
-- UPDATE` would be additive and would leave `DELETE`, `TRUNCATE`, `REFERENCES`
-- and `TRIGGER` in place. `TRUNCATE` is the dangerous one: it is a table-level
-- operation that **bypasses RLS entirely**. A signed-in user holding it could
-- empty `profiles` without matching a single policy.
--
-- So each role is reset to no privileges before the intended set is granted.
-- `REVOKE ALL` removes only privileges granted by the role running this
-- migration; on Supabase that is the same role that set the defaults, so the
-- removal is effective. Running the file a second time is harmless.
--
-- `SELECT, INSERT, UPDATE` — not `ALL` — for `authenticated`, because those are
-- exactly the verbs the initial and admin migrations create policies for. No
-- `DELETE` policy exists on any of the five, so a `DELETE` grant would confer a
-- privilege no policy permits.
--
-- `service_role` is the backend's administrative client and keeps the full set;
-- it bypasses RLS by design and is never exposed to a client.
--
-- No grants to `anon`: no policy on these five tables serves a signed-out
-- caller. RLS is untouched; this migration changes which roles may reach a
-- table, not which rows they see.
--
-- Rollback is a matching REVOKE. Nothing is dropped and no data moves.

REVOKE ALL ON public.profiles             FROM anon, authenticated;
REVOKE ALL ON public.user_preferences     FROM anon, authenticated;
REVOKE ALL ON public.calibration_profiles FROM anon, authenticated;
REVOKE ALL ON public.oled_profiles        FROM anon, authenticated;
REVOKE ALL ON public.user_history         FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.profiles             TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_preferences     TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.calibration_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.oled_profiles        TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_history         TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_preferences     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calibration_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oled_profiles        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_history         TO service_role;
-- Sanket Vaanni — administration, audit, announcements and maintenance mode.
-- Version: 20261014000000
--
-- Additive only. Nothing in the initial migration is altered, dropped or
-- rewritten, and every statement here is written so that re-running it is safe.
--
-- ## The one design decision that matters
--
-- `profiles.role` and `profiles.status` are writable by **nobody except the
-- service role**. Not by the row's owner, and not by an administrator acting
-- through the client.
--
-- That is deliberate and it is enforced below by a trigger, not by a policy that
-- someone could forget to check. An administrator's powers are exercised through
-- the backend service, which holds the service-role key, verifies the caller's
-- Supabase access token, confirms the caller is an administrator *by reading the
-- database*, and only then writes. The consequence is that a bug in the mobile
-- client cannot promote anybody: the client has no path to the column at all.
--
-- ## Role model: there is exactly one administrator tier
--
-- `profiles.role` is constrained to ('user', 'admin'). That is the complete
-- authority model, and it is what the rest of the system already implements:
-- the mobile client shows the Super Admin section on `role === 'admin'`
-- (`apps/mobile/src/account/AccountProvider.tsx`), the backend's `requireAdmin`
-- gates on `role === 'admin' AND status = 'active'`
-- (`apps/backend/src/middleware/requireAdmin.ts`), and the admin routes
-- deliberately refuse to remove the **last** remaining administrator
-- (`apps/backend/src/routes/admin.ts`), which is the check that would be
-- misplaced if a second, higher tier existed.
--
-- There is therefore **no separate `super_admin` role**, and adding one would
-- create a level that no route, screen or check in this repository consults.
-- If a second tier is ever wanted, it needs its own authorization path first;
-- introducing the label without that path would look like security while
-- granting nothing and denying nothing.
--
-- ## What changed in this revision
--
-- Four hardening changes, each marked [HARDENED] below, plus one behavioural
-- regression repaired in §9. The reasoning for each is at the point of change.

-- ---------------------------------------------------------------------------
-- 0. Idempotent cleanup: release the previous function signatures
-- ---------------------------------------------------------------------------
--
-- `public.is_admin` and `public.is_active` previously took an optional
-- `check_uid UUID DEFAULT auth.uid()` argument. Two problems follow from that
-- shape, and both are fixed by removing the argument entirely:
--
--   * Any role holding EXECUTE could pass **someone else's** id and learn
--     whether that account is an administrator, or whether it is suspended.
--     Neither fact is the caller's to know. A function that takes the identity
--     as a parameter cannot be made safe by granting it carefully, because
--     policies inside a table are evaluated as the *invoking* user — so the
--     `authenticated` role must have EXECUTE for the policies to work at all.
--     The only safe signature is one that derives the identity itself.
--   * `CREATE OR REPLACE FUNCTION` does **not** replace a function of a
--     different argument list; it creates a second function and leaves the
--     first in place, still granted, still callable. Dropping the old signature
--     explicitly is the only way to be sure it is gone.
--
-- The dependent policies must go first: a policy holds a reference to the
-- function, and Postgres will refuse to drop a function that a policy depends
-- on. Every policy this migration creates is dropped here and recreated later,
-- which is what makes the file safe to run against a database where the
-- previous revision was already applied.
--
-- The `to_regclass` guard matters on a first run: `admin_audit_log` and
-- `announcements` are created further down this file, so they do not exist yet.
--
-- Dropping and recreating is safe in the fail-closed direction: a table with
-- RLS enabled and no policy returns no rows and accepts no writes, so there is
-- no window in which more is visible than before.

DO $cleanup$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('public.profiles',             'Administrators can read all profiles'),
      ('public.admin_audit_log',      'Administrators can read the audit log'),
      ('public.announcements',        'Administrators can read all announcements'),

      ('public.user_preferences',     'Users can read own preferences'),
      ('public.user_preferences',     'Users can insert own preferences'),
      ('public.user_preferences',     'Users can update own preferences'),

      ('public.calibration_profiles', 'Users can read own calibration'),
      ('public.calibration_profiles', 'Users can insert own calibration'),
      ('public.calibration_profiles', 'Users can update own calibration'),

      ('public.oled_profiles',        'Users can read own oled profiles'),
      ('public.oled_profiles',        'Users can insert own oled profiles'),
      ('public.oled_profiles',        'Users can update own oled profiles'),

      ('public.user_history',         'Users can read own history'),
      ('public.user_history',         'Users can insert own history'),
      ('public.user_history',         'Users can update own history')
    ) AS t(tbl, pol)
  LOOP
    IF to_regclass(target.tbl) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %s', target.pol, target.tbl);
    END IF;
  END LOOP;
END
$cleanup$;

DROP FUNCTION IF EXISTS public.is_admin(UUID);
DROP FUNCTION IF EXISTS public.is_active(UUID);

-- ---------------------------------------------------------------------------
-- 1. Profile columns the app already reads
-- ---------------------------------------------------------------------------
--
-- `apps/mobile/src/account/AccountProvider.tsx` selects `avatar_url`, `role` and
-- `status`. They did not exist. Adding them here rather than changing the client
-- keeps one source of truth for the shape of a profile.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- Named constraints, added separately so the statements are re-runnable: an
-- unnamed CHECK cannot be guarded with IF NOT EXISTS.
--
-- [HARDENED] Each probe is now scoped to this table and schema. The previous
-- revision matched on `conname` alone, and a constraint name is unique per
-- table, not per database — so a same-named constraint on any other table would
-- have made this block conclude the constraint already existed and silently skip
-- adding it here. The three CHECK constraints below are the thing standing
-- between a client and `role = 'admin'`, so a probe that can be fooled is worth
-- fixing even when nothing currently collides.
DO $profile_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'profiles_role_check'
      AND n.nspname = 'public'
      AND t.relname = 'profiles'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_check CHECK (role IN ('user', 'admin'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'profiles_status_check'
      AND n.nspname = 'public'
      AND t.relname = 'profiles'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_status_check CHECK (status IN ('active', 'suspended'));
  END IF;

  -- An avatar is the address of this account's own photo.
  --
  -- The mobile client uploads to `avatars/<user-id>/<file>` and stores the
  -- public URL that Storage returns (`apps/mobile/src/account/avatar.ts:190`),
  -- so a constraint that rejects every `http(s)://` value rejects every real
  -- avatar and fails the save with 23514. The earlier form of this check did
  -- exactly that.
  --
  -- The accepted shapes are now the two the application can actually produce:
  --   * a bare object path, `<id>/<file>`, and
  --   * the project's public URL, `.../storage/v1/object/public/avatars/<id>/<file>`.
  -- Both are tied to the row's own id, so one account cannot point its profile
  -- at another account's folder. NOT VALID: rows written before this rule are
  -- left alone rather than blocking the migration; every new write is checked.
  ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_avatar_path_check;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'profiles_avatar_path_check'
      AND n.nspname = 'public'
      AND t.relname = 'profiles'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_avatar_path_check
      CHECK (
        avatar_url IS NULL
        OR avatar_url LIKE id::text || '/%'
        OR avatar_url LIKE '%/storage/v1/object/public/avatars/' || id::text || '/%'
      ) NOT VALID;
  END IF;
END
$profile_constraints$;

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role) WHERE role = 'admin';
CREATE INDEX IF NOT EXISTS idx_profiles_status ON public.profiles(status);

-- ---------------------------------------------------------------------------
-- 2. Is the caller an administrator?
-- ---------------------------------------------------------------------------
--
-- [HARDENED] No argument. The identity is always the caller's, taken from
-- `auth.uid()`. There is no way to ask about anybody else, so the function
-- cannot be used as an oracle for another account's role.
--
-- SECURITY DEFINER because it reads `profiles`, which is itself protected by
-- row-level security policies that call this function. Without the definer
-- rights the read would recurse into the policy and Postgres would refuse it
-- with "infinite recursion detected in policy".
--
-- `STABLE` because the answer does not change within a statement.
--
-- `search_path = ''` rather than `public, pg_temp`. An empty path is the
-- strongest form: every object this body touches is schema-qualified
-- (`public.profiles`, `auth.uid()`), so there is nothing to shadow, and
-- `pg_temp` is deliberately not searched — a temporary table is the classic way
-- to shadow a real one inside a definer function. Built-in functions such as
-- `now()` still resolve, because `pg_catalog` is always searched implicitly.
--
-- `(SELECT auth.uid())` is wrapped in a sub-select on purpose: it makes the
-- call an InitPlan, evaluated once for the whole statement, instead of once per
-- candidate row.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'admin'
      AND status = 'active'
  );
$$;

-- [HARDENED] `anon` is revoked explicitly, not just through PUBLIC. Supabase
-- sets default privileges that grant EXECUTE on new functions in `public` to
-- `anon`, `authenticated` and `service_role` directly, so revoking from PUBLIC
-- alone leaves the direct grant to `anon` untouched and the function callable
-- without signing in.
--
-- Note what is deliberately *not* revoked: `authenticated` keeps EXECUTE, and
-- it must. A row-level policy is evaluated as the invoking user, so the roles a
-- policy serves need EXECUTE on every function the policy calls. A signed-out
-- caller has no policies that use this function, so it has no need of it.
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

COMMENT ON FUNCTION public.is_admin() IS
  'True when the calling user holds the admin role and is not suspended. Takes no argument: it can only ever answer about the caller. SECURITY DEFINER to avoid RLS recursion.';

-- ---------------------------------------------------------------------------
-- 3. Nobody may grant themselves a privileged column
-- ---------------------------------------------------------------------------
--
-- This trigger fires on INSERT as well as UPDATE, and it needs to. The initial
-- migration leaves an INSERT policy on `profiles` so that a client can create
-- its own row if the signup trigger did not; without an INSERT check, a client
-- could insert a row with `role = 'admin'` and promote itself, which no UPDATE
-- policy would ever have to permit.
--
-- The rule is the same for both operations: `role` and `status` may only hold
-- their ordinary values unless the writer is the service role.
--
-- ## Why `current_user` is checked as well as the claim
--
-- `handle_new_user()` runs SECURITY DEFINER as the function owner, inside the
-- auth trigger. Its JWT claim is whoever signed up — an ordinary client — so
-- testing the claim alone would make every signup fail. It executes as
-- `postgres`, and that is the signal that the write is trusted system code
-- rather than a client request.
--
-- `current_user` is the load-bearing half of this check. It cannot be set by a
-- client, whereas the claim is read from a session setting. The claim is
-- consulted as an additional allow, never as the only one, so a claim that is
-- missing or unreadable makes the write *less* trusted, not more — which is the
-- safe direction for a test that decides whether to permit a privilege change.
--
-- ## Why this function is SECURITY INVOKER
--
-- It is deliberately *not* SECURITY DEFINER, and that is load-bearing. Inside a
-- SECURITY DEFINER function `current_user` is the function's *owner*, not the
-- caller — so an administrator or an ordinary client would both read as
-- `postgres`, every write would be judged trusted, and the boundary below would
-- enforce nothing. Running as the invoker is what makes `current_user` mean
-- "who is actually making this request".
--
-- This function reads no tables, so it needs no elevated rights. Removing the
-- definer clause costs nothing and is the difference between a rule and the
-- appearance of one.

CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_boundary()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  -- [HARDENED] COALESCE, not a bare read. `current_setting(..., true)` returns
  -- NULL when the setting is absent, and NULL then infects `trusted` below.
  acting_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  trusted BOOLEAN;
BEGIN
  trusted := (acting_role = 'service_role')
             OR (current_user IN ('postgres', 'supabase_admin', 'service_role'));

  IF TG_OP = 'INSERT' THEN
    -- Defaults are 'user' and 'active'. Anything else is a privilege request.
    IF NEW.role IS DISTINCT FROM 'user' OR NEW.status IS DISTINCT FROM 'active' THEN
      -- `IS NOT TRUE`, not `NOT`. This is the difference between a guard and the
      -- appearance of one: if `trusted` were ever NULL, `IF NOT trusted` would
      -- evaluate to NULL, the branch would be skipped, and the row would be
      -- inserted with whatever role the caller asked for — silently. `IS NOT
      -- TRUE` denies on NULL, on FALSE, and only permits a definite TRUE.
      --
      -- This is not hypothetical. An earlier revision of this file read the
      -- claim without COALESCE and tested it with `NOT trusted`; an INSERT as
      -- an ordinary authenticated user with role='admin' succeeded. Only
      -- executing it revealed that, which is why the behaviour is tested rather
      -- than reasoned about.
      IF trusted IS NOT TRUE THEN
        RAISE EXCEPTION
          'A new profile cannot be created with a privileged role or status.'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role IS NOT DISTINCT FROM OLD.role
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF trusted IS NOT TRUE THEN
    RAISE EXCEPTION
      'Changing role or status requires the service role. Client tokens cannot promote or suspend an account.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_profile_privilege_boundary ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_boundary
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_profile_privilege_boundary();

-- ---------------------------------------------------------------------------
-- 4. Administrators may read the user list
-- ---------------------------------------------------------------------------
--
-- Read only. There is no admin INSERT, UPDATE or DELETE policy on `profiles`,
-- so the admin UI cannot write through the client even if the role column were
-- somehow wrong — the trigger above and the absent policy are two independent
-- barriers to the same mistake.
--
-- A suspended account still reaches its own row through this policy's
-- `id = auth.uid()` branch, and through the initial migration's "Users can read
-- own profile". That is deliberate and is explained in §10.

DROP POLICY IF EXISTS "Administrators can read all profiles" ON public.profiles;
CREATE POLICY "Administrators can read all profiles"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.is_admin() OR id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5. Audit log
-- ---------------------------------------------------------------------------
--
-- Every consequential administrative action writes a row here, and a row can
-- never be edited or deleted by anyone. `REVOKE UPDATE, DELETE` is what makes
-- that true rather than a convention: the table is append-only at the database
-- level, so "who suspended this account, and why" stays answerable.

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  /** Mandatory. A consequential action without a stated reason is not allowed. */
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_reason_not_empty CHECK (length(btrim(reason)) >= 3)
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON public.admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON public.admin_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON public.admin_audit_log(target_type, target_id);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Administrators can read the audit log" ON public.admin_audit_log;
CREATE POLICY "Administrators can read the audit log"
  ON public.admin_audit_log
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Append-only. No UPDATE or DELETE policy exists for any role, and the grants
-- are withdrawn so that even a policy added by mistake in future cannot make
-- the log mutable.
--
-- [HARDENED] `anon` loses everything rather than just the write verbs. There is
-- no policy on this table that serves a signed-out caller, so there is no
-- reason for the role to hold any privilege on it.
--
-- [HARDENED 2026-10-18] `authenticated` is reset the same way. Revoking only
-- UPDATE/DELETE/TRUNCATE left an INSERT granted by Supabase's default
-- privileges in place. RLS still has no INSERT policy, so it could not be
-- exercised — but the grant described a capability the design does not have,
-- and would become a real write path the day a policy was added by mistake.
REVOKE ALL ON public.admin_audit_log FROM anon, authenticated;
GRANT SELECT ON public.admin_audit_log TO authenticated;
GRANT INSERT ON public.admin_audit_log TO service_role;
GRANT SELECT ON public.admin_audit_log TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Application settings, including maintenance mode
-- ---------------------------------------------------------------------------
--
-- One row per setting, or one row? A single row with named columns would need a
-- migration every time a setting is added. A key/value table with a typed
-- payload needs none, and the keys are few enough that the flexibility is
-- cheaper than the migrations.
--
-- Maintenance mode is **readable by anyone, including signed-out clients**.
-- That is the point: the whole purpose is to stop someone signing in, and a
-- check that only runs after authentication cannot do that.
--
-- ## [HARDENED] Which settings are public
--
-- The previous revision granted `SELECT` on the whole table to `anon` and
-- `authenticated` with `USING (true)`. That made every setting public **by
-- default**, including settings added in future by someone who never thought
-- about visibility. A maintenance flag is safe to publish; a feature flag, a
-- rate limit or an internal id is not, and the difference would have been
-- whether the author happened to read this comment.
--
-- The public surface is now named twice, in the two places that both have to
-- agree:
--
--   * row level — the policy matches `key = 'maintenance'` and nothing else;
--   * column level — the grant covers `(key, value)` only.
--
-- The column half matters because the row also carries `updated_by`, the id of
-- the administrator who last changed the setting. That is a fact about a person,
-- not about maintenance, and publishing it would turn a public status endpoint
-- into a way to watch which admin is on duty. `updated_at` is withheld for the
-- same reason: nothing reading this row needs it.
--
-- The backend's admin route reads `updated_at` with the service-role client,
-- which bypasses row level security and holds table-wide privileges, so it is
-- unaffected by the narrower grant.
--
-- A new key added tomorrow is invisible to both client roles until a future
-- migration names it. That is the intended default.

CREATE TABLE IF NOT EXISTS public.app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

INSERT INTO public.app_settings (key, value)
VALUES (
  'maintenance',
  jsonb_build_object(
    'enabled', false,
    'message', '',
    'enabledAt', NULL,
    'expectedEndAt', NULL
  )
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- The old, too-broad policy is dropped by name. Leaving it in place would not
-- be neutral: policies are permissive by default and are OR'd together, so a
-- surviving `USING (true)` would make the narrower policy below decorative.
DROP POLICY IF EXISTS "Settings are readable by everyone" ON public.app_settings;
DROP POLICY IF EXISTS "The maintenance setting is publicly readable" ON public.app_settings;
CREATE POLICY "The maintenance setting is publicly readable"
  ON public.app_settings
  FOR SELECT
  TO anon, authenticated
  USING (key = 'maintenance');

-- No write policy. Writes come from the backend with the service-role key, so
-- that a maintenance toggle is always accompanied by an audit row and a reason.
--
-- [HARDENED] `REVOKE ALL` rather than revoking only the write verbs, so the
-- table-wide `SELECT` that Supabase's default privileges grant to new tables is
-- withdrawn before the narrower column grant replaces it. Without that, the
-- column list below would sit alongside a full-table grant and restrict nothing.
REVOKE ALL ON public.app_settings FROM anon, authenticated;
GRANT SELECT (key, value) ON public.app_settings TO anon, authenticated;
GRANT ALL ON public.app_settings TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Announcements
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  /** 'info' is informational; 'critical' is shown before the app is usable. */
  severity TEXT NOT NULL DEFAULT 'info',
  published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT announcements_severity_check CHECK (severity IN ('info', 'warning', 'critical')),
  CONSTRAINT announcements_title_not_empty CHECK (length(btrim(title)) > 0),
  CONSTRAINT announcements_body_not_empty CHECK (length(btrim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_announcements_live
  ON public.announcements(published, published_at DESC)
  WHERE published = true;

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

-- Published, unexpired announcements are readable by everyone, signed in or
-- not: an announcement about an outage is precisely the thing a user needs to
-- see before they can sign in.
DROP POLICY IF EXISTS "Published announcements are readable by everyone" ON public.announcements;
CREATE POLICY "Published announcements are readable by everyone"
  ON public.announcements
  FOR SELECT
  TO anon, authenticated
  USING (
    published = true
    AND (published_at IS NULL OR published_at <= now())
    AND (expires_at IS NULL OR expires_at > now())
  );

-- Administrators may also read drafts, so the admin list is not empty of its
-- own unpublished rows.
DROP POLICY IF EXISTS "Administrators can read all announcements" ON public.announcements;
CREATE POLICY "Administrators can read all announcements"
  ON public.announcements
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Announcements are authored through the backend, which holds the service-role
-- key and writes an audit row. No client role may write one.
--
-- These grants are stated explicitly rather than left to Supabase's default
-- privileges, which grant INSERT, UPDATE and DELETE on a new table to `anon`
-- and `authenticated`. With RLS enabled and no write policy those grants are
-- not reachable today, but an explicit REVOKE means a policy added by mistake
-- later still cannot open a write path.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.announcements FROM anon, authenticated;
GRANT SELECT ON public.announcements TO anon, authenticated;
GRANT ALL ON public.announcements TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Updated-at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touch_announcements ON public.announcements;
CREATE TRIGGER touch_announcements
  BEFORE UPDATE ON public.announcements
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS touch_app_settings ON public.app_settings;
CREATE TRIGGER touch_app_settings
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 9. A new account must never be created as an administrator
-- ---------------------------------------------------------------------------
--
-- `handle_new_user()` from the initial migration inserts the profile row. This
-- replaces it with a version that names the privileged columns explicitly as
-- their defaults, so a future change to a column default cannot silently make
-- every new signup an administrator, and so that a crafted `raw_user_meta_data`
-- payload cannot set a role.
--
-- [REPAIRED] The previous revision of this file dropped the second half of the
-- original function — the `user_preferences` row. The initial migration created
-- one for every signup, and nothing replaced it, so a newly registered account
-- would have had no preferences row at all. Whether that is survivable depends
-- on code elsewhere tolerating its absence, and it is a silent behaviour change
-- in a security-sensitive file, so it is restored here rather than left for
-- someone to discover from a support report.
--
-- It remains safe to re-run: CREATE OR REPLACE on the same signature, and the
-- preferences insert is `ON CONFLICT DO NOTHING`.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, role, status)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NULLIF(btrim(NEW.raw_user_meta_data ->> 'display_name'), ''),
      split_part(COALESCE(NEW.email, ''), '@', 1)
    ),
    -- Literal defaults, not column defaults. A metadata key named "role" in the
    -- signup payload is ignored: this statement never reads it.
    'user',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_preferences (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. Suspending an account must take effect
-- ---------------------------------------------------------------------------
--
-- A suspension that leaves every row readable is a label, not a suspension.
-- The policies below tighten the user-data tables so a suspended account can
-- neither read nor write its own data.
--
-- The check goes through `is_active()`, a SECURITY DEFINER function, rather than
-- through an inline `EXISTS (SELECT 1 FROM profiles ...)`. Two reasons: the
-- inline form makes the `profiles` policy run once per candidate row, and an
-- inline subquery inside a policy is one `search_path` mistake away from
-- reading a different table than it names.
--
-- [HARDENED] The previous revision applied the check to the four SELECT
-- policies and to the history INSERT policy only. Every other write policy from
-- the initial migration was left untouched, and a permissive policy that does
-- not mention `is_active()` still grants access — policies are OR'd together, so
-- one surviving `auth.uid() = user_id` makes the suspension gate irrelevant for
-- that operation. A suspended account could therefore still insert and update
-- its preferences, calibrations, OLED profiles and history.
--
-- The complete set is rewritten here, per table and per operation:
--
--   user_preferences      SELECT, INSERT, UPDATE
--   calibration_profiles  SELECT, INSERT, UPDATE
--   oled_profiles         SELECT, INSERT, UPDATE
--   user_history          SELECT, INSERT, UPDATE
--
-- Each name matches the policy it replaces, so the `DROP` really removes the
-- looser version rather than sitting beside it.
--
-- ## What is deliberately not changed
--
--   * **No DELETE policy is added.** The initial migration defines none on these
--     tables, and with RLS enabled an absent policy denies the operation. A
--     suspended account therefore cannot delete its rows either, which is the
--     outcome the suspension wants; adding a policy here would weaken it.
--
--   * **`profiles` keeps its own-row SELECT and UPDATE policies.** A suspended
--     account can still read its own profile row, and it must: the app reads
--     `status` to explain what has happened, and an account locked out with no
--     explanation is worse than one that is told. Profile UPDATE is left open
--     for the same reason it always was — it reaches `display_name` and
--     `avatar_url` and nothing else, since `role` and `status` are held by the
--     trigger in §3 regardless of what any policy allows.
--
--   * **`user_preferences` INSERT stays available to active users**, because
--     `handle_new_user()` is the primary path but a client may legitimately
--     create the row if the signup trigger did not. The gate is on being
--     active, not on the operation.

-- [HARDENED] No argument, for the same reason as `is_admin()`: a caller must not
-- be able to ask whether some other account is suspended.

CREATE OR REPLACE FUNCTION public.is_active()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND status = 'active'
  );
$$;

-- [HARDENED] `anon` explicitly revoked, as for `is_admin()`. The previous
-- revision *granted* this one to `anon`, which let a signed-out caller ask
-- whether any known account id was suspended. A signed-out caller has no policy
-- that consults this function, so it needs no access to it.
REVOKE ALL ON FUNCTION public.is_active() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_active() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_active() TO authenticated;

COMMENT ON FUNCTION public.is_active() IS
  'True when the calling user is not suspended. Takes no argument: it can only ever answer about the caller. SECURITY DEFINER so policies on other tables do not re-enter the profiles policy.';

-- ------------------------------------------------------- user_preferences

DROP POLICY IF EXISTS "Users can read own preferences" ON public.user_preferences;
CREATE POLICY "Users can read own preferences"
  ON public.user_preferences FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND public.is_active());

DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
CREATE POLICY "Users can insert own preferences"
  ON public.user_preferences FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_active());

DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
CREATE POLICY "Users can update own preferences"
  ON public.user_preferences FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND public.is_active())
  WITH CHECK (auth.uid() = user_id AND public.is_active());

-- --------------------------------------------------- calibration_profiles

DROP POLICY IF EXISTS "Users can read own calibration" ON public.calibration_profiles;
CREATE POLICY "Users can read own calibration"
  ON public.calibration_profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND public.is_active());

DROP POLICY IF EXISTS "Users can insert own calibration" ON public.calibration_profiles;
CREATE POLICY "Users can insert own calibration"
  ON public.calibration_profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_active());

DROP POLICY IF EXISTS "Users can update own calibration" ON public.calibration_profiles;
CREATE POLICY "Users can update own calibration"
  ON public.calibration_profiles FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND public.is_active())
  WITH CHECK (auth.uid() = user_id AND public.is_active());

-- ---------------------------------------------------------- oled_profiles

DROP POLICY IF EXISTS "Users can read own oled profiles" ON public.oled_profiles;
CREATE POLICY "Users can read own oled profiles"
  ON public.oled_profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND public.is_active());

DROP POLICY IF EXISTS "Users can insert own oled profiles" ON public.oled_profiles;
CREATE POLICY "Users can insert own oled profiles"
  ON public.oled_profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_active());

DROP POLICY IF EXISTS "Users can update own oled profiles" ON public.oled_profiles;
CREATE POLICY "Users can update own oled profiles"
  ON public.oled_profiles FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND public.is_active())
  WITH CHECK (auth.uid() = user_id AND public.is_active());

-- ------------------------------------------------------------ user_history

DROP POLICY IF EXISTS "Users can read own history" ON public.user_history;
CREATE POLICY "Users can read own history"
  ON public.user_history FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND public.is_active());

DROP POLICY IF EXISTS "Users can insert own history" ON public.user_history;
CREATE POLICY "Users can insert own history"
  ON public.user_history FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_active());

DROP POLICY IF EXISTS "Users can update own history" ON public.user_history;
CREATE POLICY "Users can update own history"
  ON public.user_history FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND public.is_active())
  WITH CHECK (auth.uid() = user_id AND public.is_active());
-- Sanket Vaanni — device push token registry.
-- Version: 20261014000001
--
-- Depends on `20261014000000_admin_audit_maintenance.sql` having run first: that
-- migration defines `public.is_active()`, which is not used here, but the two
-- files are a pair and the ordering is stated in `docs/supabase-setup.md`.
--
-- ## The shape of the problem
--
-- A push token identifies a *device installation*, not a person. It is issued by
-- FCM to the app on that phone, and it stays the same when one user signs out and
-- another signs in. So the same string can be claimed by two different accounts
-- in sequence, and the database has to end up with one owner, not two.
--
-- The registry therefore makes the token the PRIMARY KEY. That is the whole
-- design: one token, one row, one owner. There is no way to represent "this token
-- belongs to Alice and Bob" even by accident.
--
-- Handing the token over cannot be done from the client. The row being taken may
-- belong to another user, and RLS correctly forbids one user from deleting
-- another's row. So the transfer runs through a SECURITY DEFINER function, which
-- is the one place in this file with elevated rights — and it is written to do
-- exactly one narrow thing.
--
-- ## What changed in this revision
--
-- Six hardening changes, marked [HARDENED]. The reasoning is at each point.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.device_push_tokens (
  token         TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL DEFAULT 'android',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- [HARDENED] Constraints are added separately, and each probe is scoped to this
-- table and schema.
--
-- The previous revision put no constraints on `platform` at all, so a client
-- could register a token under any string it liked. `platform` is read by the
-- notification dispatcher to choose a transport, and an unconstrained value
-- there is a value that decides behaviour. FCM's own tokens are far longer than
-- a hand-typed string, so a short one is a caller error or an attempt to store
-- something that is not a token; the length bound rejects both.
--
-- The scoping matters: a constraint name is unique per table, not per database.
-- Probing on `conname` alone would match a same-named constraint on an unrelated
-- table and make this block skip adding the constraint here — silently leaving
-- the column unconstrained while appearing to have added it.
DO $device_token_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'device_push_tokens_platform_check'
      AND n.nspname = 'public'
      AND t.relname = 'device_push_tokens'
  ) THEN
    ALTER TABLE public.device_push_tokens
      ADD CONSTRAINT device_push_tokens_platform_check
      CHECK (platform IN ('android', 'ios'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'device_push_tokens_token_length_check'
      AND n.nspname = 'public'
      AND t.relname = 'device_push_tokens'
  ) THEN
    ALTER TABLE public.device_push_tokens
      ADD CONSTRAINT device_push_tokens_token_length_check
      CHECK (length(token) BETWEEN 20 AND 4096);
  END IF;
END
$device_token_constraints$;

CREATE INDEX IF NOT EXISTS device_push_tokens_user_id_idx
  ON public.device_push_tokens (user_id);

ALTER TABLE public.device_push_tokens ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. What a signed-in user may do with their own tokens
-- ---------------------------------------------------------------------------
--
-- Three policies, matching the three operations the app performs directly:
-- list your own tokens, insert one for yourself, release one of your own on
-- sign-out. The release matters — `apps/mobile/src/notifications/` deletes the
-- token *before* sign-out, so that the next person to use the phone does not
-- begin receiving the previous person's notifications.
--
-- ## Why there is deliberately no UPDATE policy
--
-- Claiming a token that is already held by somebody else is the one operation
-- RLS must not permit, because the row belongs to another user. That path goes
-- through `register_device_push_token()`, which is the only code allowed to move
-- ownership. If an UPDATE policy existed here, it would either be useless (it
-- could only ever match your own rows) or an escalation (if it could match
-- another user's). Neither is wanted, so there is none.
--
-- ## Why `anon` has nothing
--
-- A push token is registered by a signed-in user about themselves. A signed-out
-- caller has no business reading, creating or releasing any of them, and no
-- policy below names `anon`.

DROP POLICY IF EXISTS "device_push_tokens_select_own" ON public.device_push_tokens;
CREATE POLICY "device_push_tokens_select_own"
  ON public.device_push_tokens
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "device_push_tokens_insert_own" ON public.device_push_tokens;
CREATE POLICY "device_push_tokens_insert_own"
  ON public.device_push_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "device_push_tokens_delete_own" ON public.device_push_tokens;
CREATE POLICY "device_push_tokens_delete_own"
  ON public.device_push_tokens
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- [HARDENED] Grants are stated explicitly rather than left to Supabase's default
-- privileges, which hand a new table ALL to `anon` and `authenticated` the moment
-- it is created.
--
-- Each role is revoked first and granted second, so the grant list is the whole
-- truth about what the role holds. `GRANT` alone would not be enough: it adds to
-- whatever is already present, and Supabase's `ALTER DEFAULT PRIVILEGES` has
-- already given `authenticated` UPDATE, TRUNCATE, REFERENCES and TRIGGER
-- alongside the three verbs the app actually uses.
--
-- ## Which withheld verb actually matters, and how much
--
-- **TRUNCATE is the one that cannot be covered by a policy.** Row level security
-- filters rows for SELECT, INSERT, UPDATE and DELETE. It does not apply to
-- TRUNCATE at all — that command is checked against table privileges and nothing
-- else — so no policy can constrain it, and it cannot be undone. If the
-- privilege is ever reachable, it is reachable in full.
--
-- It is **not reachable through the app's API today**, and this comment should
-- not pretend otherwise: PostgREST exposes read, insert, update, delete and RPC,
-- and has no TRUNCATE route. The grant is a latent capability rather than a live
-- hole, and the honest reason to remove it is that a privilege no caller needs
-- should not be sitting under a command that no policy can guard. It would
-- become live the moment any SECURITY INVOKER routine, maintenance script,
-- direct connection or extension executed SQL as this role.
--
-- `authenticated` is every signed-in user, so the role is the widest one there
-- is; that is what makes least privilege on it worth stating rather than
-- assuming.
--
-- The rest is defence in depth and is described as such: UPDATE is already
-- blocked by the deliberate absence of an UPDATE policy, and REFERENCES and
-- TRIGGER have no client use and are not reachable through PostgREST either.
-- Revoking them means a policy or trigger added carelessly later still cannot
-- open a path, because the privilege underneath is gone.
REVOKE ALL ON public.device_push_tokens FROM anon;
REVOKE ALL ON public.device_push_tokens FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.device_push_tokens TO authenticated;
-- The dispatcher lists tokens server-side to send notifications. It holds the
-- service-role key and is the only role with write access to another user's row.
-- It is deliberately NOT narrowed: it is the trusted server credential, it
-- bypasses RLS by design, and the admin and notification routes depend on it.
GRANT ALL ON public.device_push_tokens TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Claiming a token
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER, and it has to be: claiming a token means taking a row that
-- may currently belong to a different account, which no row-level policy can
-- allow. The elevated rights are the reason every other decision in this
-- function is written to be as tight as possible.
--
-- ## [HARDENED] The identity comes from `auth.uid()`, never from a parameter
--
-- The signature takes only the token and the platform. There is no `p_user_id`
-- to pass, so a caller cannot register a token against somebody else's account,
-- and cannot claim a token *for* a victim. The owner is always the caller.
--
-- ## [HARDENED] `search_path = ''`
--
-- The previous revision used `SET search_path = public`. A definer function
-- whose path includes a schema that a client can write to is the classic
-- privilege-escalation shape: create an object that shadows a name the function
-- uses, and the function will call yours — with the definer's rights. The path is
-- now empty and every object is schema-qualified (`public.device_push_tokens`,
-- `auth.uid()`), so there is nothing to shadow. `pg_temp` is excluded for the
-- same reason, since a temporary object shadows a real one without any warning.
-- Built-ins (`now()`, `length()`, `btrim()`, `lower()`, `coalesce`) still
-- resolve, because `pg_catalog` is always searched implicitly.
--
-- ## [HARDENED] One atomic statement instead of DELETE-then-INSERT
--
-- The previous revision ran `DELETE ... WHERE token = p_token` and then an
-- `INSERT ... ON CONFLICT DO UPDATE`. The two statements are redundant — the
-- upsert already handles a pre-existing row — and the DELETE was the more
-- dangerous of the pair: it was an unconditional delete of any row holding that
-- token, executing with definer rights, before a validation that could still
-- fail. Deleting first and failing second leaves the other user's registration
-- destroyed with nothing put back.
--
-- The upsert alone is also correct under concurrency in a way the pair was not.
-- Two devices claiming the same token at the same moment both reach the
-- `INSERT`; Postgres serialises them on the primary key, one inserts and the
-- other takes the `DO UPDATE` branch. The final value is the later writer's.
-- There is no interleaving that produces two rows or a half-deleted state,
-- because there is only ever one statement.
--
-- ## [HARDENED] Input validation, before anything is written
--
-- The token is trimmed once into a local and reused, so a leading or trailing
-- space cannot produce a row that differs from the one the next call matches.
-- Length and platform are checked against the same bounds the table constraints
-- enforce, so a malformed call is rejected with a message that says what was
-- wrong rather than surfacing a raw constraint violation. The platform is
-- lower-cased before comparison so `'Android'` is accepted rather than treated
-- as an unknown platform.
--
-- ## [HARDENED] A bound on how many tokens one account may amass
--
-- Each sign-in on each device creates a claim, and nothing removed the old ones.
-- The cap trims the caller's **own** oldest rows and touches no other account.
-- The just-inserted row has the newest `last_seen_at` and is never the one
-- removed; `token` is the tiebreaker so the ordering is deterministic when two
-- rows share a timestamp.
--
-- ## Precondition: `auth.uid()` is null for a signed-out caller
--
-- `SECURITY DEFINER` changes the role, not the JWT, so `auth.uid()` is still
-- read from the caller's token and is NULL when there is none. The explicit check
-- turns that into a clear error rather than an insert that fails on a NOT NULL.

CREATE OR REPLACE FUNCTION public.register_device_push_token(
  p_token    TEXT,
  p_platform TEXT DEFAULT 'android'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller         UUID := auth.uid();
  clean_token    TEXT := btrim(COALESCE(p_token, ''));
  clean_platform TEXT := lower(btrim(COALESCE(p_platform, 'android')));
  -- Enough for every phone, tablet and emulator one person could plausibly
  -- sign in on, and small enough that the table cannot be used as free storage.
  max_tokens CONSTANT INTEGER := 20;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'register_device_push_token requires an authenticated user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF length(clean_token) < 20 OR length(clean_token) > 4096 THEN
    RAISE EXCEPTION
      'register_device_push_token requires a push token between 20 and 4096 characters (received %)',
      length(clean_token)
      USING ERRCODE = 'check_violation';
  END IF;

  IF clean_platform NOT IN ('android', 'ios') THEN
    RAISE EXCEPTION
      'register_device_push_token supports only the android and ios platforms (received %)',
      clean_platform
      USING ERRCODE = 'check_violation';
  END IF;

  -- The token is the primary key, so this is the entire claim/transfer:
  -- insert it if it is new, take it over if somebody else held it, refresh it
  -- if we already did. One owner per token, always.
  INSERT INTO public.device_push_tokens (token, user_id, platform)
  VALUES (clean_token, caller, clean_platform)
  ON CONFLICT (token) DO UPDATE
    SET user_id      = EXCLUDED.user_id,
        platform     = EXCLUDED.platform,
        updated_at   = now(),
        last_seen_at = now();

  -- Keep only the caller's own most recent `max_tokens` registrations.
  DELETE FROM public.device_push_tokens
  WHERE user_id = caller
    AND token NOT IN (
      SELECT token
      FROM public.device_push_tokens
      WHERE user_id = caller
      ORDER BY last_seen_at DESC, token
      LIMIT max_tokens
    );
END;
$$;

COMMENT ON FUNCTION public.register_device_push_token(TEXT, TEXT) IS
  'Claims a push token for the calling user. Derives the owner from auth.uid() only, so a caller cannot register a token against another account. SECURITY DEFINER because taking a token from a previous owner crosses a row-level policy; search_path is empty and all references are schema-qualified.';

-- [HARDENED] `anon` is revoked explicitly as well as through PUBLIC. Supabase
-- grants EXECUTE on new functions in `public` to `anon`, `authenticated` and
-- `service_role` directly via its default privileges, so revoking from PUBLIC
-- alone would leave the direct grant to `anon` in place and the function callable
-- without signing in.
REVOKE ALL ON FUNCTION public.register_device_push_token(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_device_push_token(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_device_push_token(TEXT, TEXT) TO authenticated;
-- Sanket Vaanni — account security, permanent owner protection and Team content
-- Version: 20261017000000
--
-- ## Why this is a new file
--
-- The existing migrations are owned by the database-permissions workstream and
-- are deliberately not edited here. This migration is additive and depends on
-- `20261014000000_admin_audit_maintenance.sql` being applied first (it uses
-- `public.is_admin()` and the `profiles.role/status/avatar_url` columns).
--
-- ## What it adds
--
--   1. `profiles.is_owner` and a single-owner index.
--   2. A database-level guard for the permanent owner and the last active
--      administrator, on UPDATE and DELETE, including cascade deletes.
--   3. `delete_user_account()` is closed: it can no longer delete anything,
--      because deletion must go through the OTP-verified server flow.
--   4. `account_deletion_challenges`, visible only to `service_role`.
--   5. `team_members`, publicly readable when published, writable only by the
--      backend with the service role.
--   6. Two public-read storage buckets whose writes are scoped: `avatars`
--      (a user may write only their own folder) and `team-media` (only an
--      administrator may write).
--
-- ## What it deliberately does not do
--
-- No existing table is dropped, no existing row is deleted, no existing column
-- is made nullable or removed. Applying it is additive. Reverting it requires a
-- hand-written script; the destructive part would be dropping the two new
-- tables and the two buckets, which is why it is not automatic.

-- ---------------------------------------------------------------------------
-- 1. Permanent owner
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT false;

-- At most one permanent owner. A partial unique index is the constraint; the
-- trigger below refuses to leave that owner demoted, suspended or unmarked.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_single_owner
  ON public.profiles ((is_owner))
  WHERE is_owner;

-- The owner must, by construction, be an active administrator. This CHECK is
-- what makes `is_owner = true` unable to coexist with a suspended or demoted
-- row, even for a writer that bypassed the application.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'profiles'
      AND c.conname = 'profiles_owner_is_admin_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_owner_is_admin_check
      CHECK (NOT is_owner OR (role = 'admin' AND status = 'active'));
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1b. Privileged columns introduced by this file
-- ---------------------------------------------------------------------------
--
-- `enforce_profile_privilege_boundary` (migration 20261014000000) was written
-- before `is_owner` existed, so it guards role and status but not ownership.
-- That left a real hole: an active administrator could call PostgREST's
-- own-row UPDATE policy and set `is_owner = true` on themselves, which the
-- unique partial index would then make permanent — and the owner guard below
-- refuses to clear `is_owner` even for the service role. The owner would have
-- had to be fixed with DDL.
--
-- This replacement keeps the original rules and adds ownership and email to
-- the set of columns a client token may not change. `is_owner` is set only by
-- the service role (the bootstrap/provision scripts); `email` is the Auth
-- identity's address, not a profile preference.
--
-- Same NULL discipline as the original: `trusted` is COALESCEd and tested with
-- `IS NOT TRUE`, so an absent JWT claim denies rather than silently permits.

CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_boundary()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  acting_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  trusted BOOLEAN;
BEGIN
  trusted := (acting_role = 'service_role')
             OR (current_user IN ('postgres', 'supabase_admin', 'service_role'));

  IF TG_OP = 'INSERT' THEN
    IF NEW.role IS DISTINCT FROM 'user'
       OR NEW.status IS DISTINCT FROM 'active'
       OR NEW.is_owner IS TRUE THEN
      IF trusted IS NOT TRUE THEN
        RAISE EXCEPTION
          'A new profile cannot be created with a privileged role, status or ownership.'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role IS NOT DISTINCT FROM OLD.role
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.is_owner IS NOT DISTINCT FROM OLD.is_owner
     AND NEW.email IS NOT DISTINCT FROM OLD.email THEN
    RETURN NEW;
  END IF;

  IF trusted IS NOT TRUE THEN
    RAISE EXCEPTION
      'Changing role, status, ownership or email requires the service role. Client tokens cannot promote, suspend, own or re-address an account.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Owner and last-administrator guard
-- ---------------------------------------------------------------------------
--
-- This is the defence the application cannot provide on its own. The backend
-- already refuses self-suspension, self-demotion and removing the last active
-- administrator, but a cascade delete through `auth.users` never passes through
-- the backend. The trigger does.
--
-- `SECURITY DEFINER` is required because the count must see every profile, not
-- only the rows the calling role's RLS allows. `search_path` is pinned.
--
-- The UPDATE branch allows an owner row to change its own non-protected fields
-- (display name, avatar path) and refuses any change to `is_owner`, `role` or
-- `status` that would stop it being an active administrator.
--
-- The DELETE branch refuses the owner outright and refuses the only remaining
-- active administrator. Deleting a suspended administrator, or one of several
-- active administrators, remains possible for legitimate maintenance.

CREATE OR REPLACE FUNCTION public.guard_owner_and_last_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  remaining_active_admins INTEGER;
BEGIN
  -- Serialise every owner/admin demotion and deletion.
  --
  -- Counting "how many active admins remain" and then acting on the row is a
  -- read-then-write. With exactly two active admins, two concurrent demotions
  -- could each see one remaining and both succeed, leaving none. A transaction-
  -- scoped advisory lock makes the count and the write one decision. It is
  -- released automatically at commit or rollback.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('public.profiles.guard_owner_and_last_admin', 0)
  );

  IF TG_OP = 'DELETE' THEN
    IF OLD.is_owner THEN
      RAISE EXCEPTION
        'owner_protected: the permanent owner account cannot be deleted'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF OLD.role = 'admin' AND OLD.status = 'active' THEN
      SELECT count(*) INTO remaining_active_admins
        FROM public.profiles p
       WHERE p.role = 'admin' AND p.status = 'active' AND p.id <> OLD.id;
      IF remaining_active_admins = 0 THEN
        RAISE EXCEPTION
          'last_admin_protected: the last active administrator cannot be deleted'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;

    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.is_owner THEN
    IF NEW.is_owner IS DISTINCT FROM true
       OR NEW.role IS DISTINCT FROM 'admin'
       OR NEW.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION
        'owner_protected: the permanent owner cannot be unmarked, demoted or suspended'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF OLD.role = 'admin' AND OLD.status = 'active'
     AND NOT (NEW.role = 'admin' AND NEW.status = 'active') THEN
    SELECT count(*) INTO remaining_active_admins
      FROM public.profiles p
     WHERE p.role = 'admin' AND p.status = 'active' AND p.id <> OLD.id;
    IF remaining_active_admins = 0 THEN
      RAISE EXCEPTION
        'last_admin_protected: the last active administrator cannot be demoted or suspended'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_owner_and_last_admin ON public.profiles;
CREATE TRIGGER guard_owner_and_last_admin
  BEFORE UPDATE OR DELETE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_owner_and_last_admin();

-- ---------------------------------------------------------------------------
-- 3. Close the unverified self-deletion RPC
-- ---------------------------------------------------------------------------
--
-- The original function deleted the caller's `auth.users` row with no
-- re-authentication and no last-administrator guard. The grant is left in place
-- so an older client receives a clear, actionable error instead of a transport
-- error, but the function can no longer delete anything.
--
-- Deletion now happens in `apps/backend/src/routes/account.ts`, which:
--   * derives the account from the bearer token (never from the body),
--   * requires a single-use emailed code before acting,
--   * removes owned storage objects,
--   * and deletes through the Auth admin API, where the trigger above applies.

CREATE OR REPLACE FUNCTION public.delete_user_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated: sign in before requesting deletion'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_owner) THEN
    RAISE EXCEPTION
      'owner_protected: the permanent owner account cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid() AND p.role = 'admin' AND p.status = 'active'
  ) AND (
    SELECT count(*) FROM public.profiles p
     WHERE p.role = 'admin' AND p.status = 'active'
  ) <= 1 THEN
    RAISE EXCEPTION
      'last_admin_protected: the last active administrator cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RAISE EXCEPTION
    'otp_required: account deletion must be confirmed with the emailed code through the account API'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_user_account() FROM public;
GRANT EXECUTE ON FUNCTION public.delete_user_account() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Deletion challenges
-- ---------------------------------------------------------------------------
--
-- Only a hash of the code is stored. The row is read and written exclusively by
-- the backend with the service-role key; there is no policy for a client role,
-- and the grants remove everything from `anon` and `authenticated`.

CREATE TABLE IF NOT EXISTS public.account_deletion_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_deletion_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT account_deletion_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_deletion_challenges_user
  ON public.account_deletion_challenges(user_id, created_at DESC);

ALTER TABLE public.account_deletion_challenges ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.account_deletion_challenges FROM anon;
REVOKE ALL ON public.account_deletion_challenges FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_deletion_challenges TO service_role;

-- Claiming a challenge is one transaction, not a read followed by a write.
--
-- The backend could read the row, compare the hash and then update it, but two
-- concurrent confirmations would both read the same unconsumed row and both
-- proceed. `FOR UPDATE` here serialises them, so exactly one caller can claim a
-- code. The attempt counter is incremented in the same transaction, which is
-- what makes the five-attempt ceiling hold under retry.
--
-- Returns a token rather than raising, so the backend can turn each outcome
-- into a truthful HTTP response without parsing a database message.

CREATE OR REPLACE FUNCTION public.claim_deletion_challenge(
  p_user_id UUID,
  p_code_hash TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  challenge public.account_deletion_challenges%ROWTYPE;
BEGIN
  SELECT * INTO challenge
    FROM public.account_deletion_challenges
   WHERE user_id = p_user_id AND consumed_at IS NULL
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  IF challenge.expires_at <= now() THEN
    RETURN 'expired';
  END IF;

  IF challenge.attempts >= 5 THEN
    RETURN 'too_many';
  END IF;

  IF challenge.code_hash IS DISTINCT FROM p_code_hash THEN
    UPDATE public.account_deletion_challenges
       SET attempts = attempts + 1
     WHERE id = challenge.id;
    RETURN 'mismatch';
  END IF;

  UPDATE public.account_deletion_challenges
     SET consumed_at = now()
   WHERE id = challenge.id;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_deletion_challenge(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_deletion_challenge(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.claim_deletion_challenge(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_deletion_challenge(UUID, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Team / About content
-- ---------------------------------------------------------------------------
--
-- Published rows are readable by anyone (including a signed-out guest, who must
-- be able to read the About screen). There is no client write policy: writes go
-- through the Admin API, which authenticates an active administrator and
-- records the change.

CREATE TABLE IF NOT EXISTS public.team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  photo_path TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_members_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT team_members_role_length CHECK (length(btrim(role)) BETWEEN 1 AND 120),
  CONSTRAINT team_members_bio_length CHECK (length(bio) <= 2000),
  CONSTRAINT team_members_photo_path_check
    CHECK (photo_path IS NULL OR photo_path ~ '^team-media/[A-Za-z0-9._/-]+$')
);

CREATE INDEX IF NOT EXISTS idx_team_members_order
  ON public.team_members(published, sort_order, created_at);

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Published team members are readable" ON public.team_members;
CREATE POLICY "Published team members are readable"
  ON public.team_members
  FOR SELECT
  TO anon, authenticated
  USING (published);

REVOKE ALL ON public.team_members FROM anon;
REVOKE ALL ON public.team_members FROM authenticated;
GRANT SELECT ON public.team_members TO anon;
GRANT SELECT ON public.team_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_members TO service_role;

CREATE OR REPLACE FUNCTION public.touch_team_member_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touch_team_member_updated_at ON public.team_members;
CREATE TRIGGER touch_team_member_updated_at
  BEFORE UPDATE ON public.team_members
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_team_member_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Storage buckets
-- ---------------------------------------------------------------------------
--
-- Both buckets are public-read. That is a deliberate, documented decision:
-- a profile photo and a team portrait are displayed to other people, and making
-- the bucket private would require the mobile client to request a signed URL for
-- every avatar. Neither bucket is publicly WRITABLE — writes are folder-scoped
-- to the owner (avatars) or to an active administrator (team-media).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  2097152,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'team-media',
  'team-media',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Avatars: read by anyone with the path; written only inside one's own folder.
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
CREATE POLICY "Avatars are publicly readable"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Users upload their own avatar" ON storage.objects;
CREATE POLICY "Users upload their own avatar"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

DROP POLICY IF EXISTS "Users replace their own avatar" ON storage.objects;
CREATE POLICY "Users replace their own avatar"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

DROP POLICY IF EXISTS "Users delete their own avatar" ON storage.objects;
CREATE POLICY "Users delete their own avatar"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

-- Team media: read by anyone; written only by an active administrator.
DROP POLICY IF EXISTS "Team media is publicly readable" ON storage.objects;
CREATE POLICY "Team media is publicly readable"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'team-media');

DROP POLICY IF EXISTS "Administrators upload team media" ON storage.objects;
CREATE POLICY "Administrators upload team media"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'team-media' AND public.is_admin());

DROP POLICY IF EXISTS "Administrators replace team media" ON storage.objects;
CREATE POLICY "Administrators replace team media"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'team-media' AND public.is_admin())
  WITH CHECK (bucket_id = 'team-media' AND public.is_admin());

DROP POLICY IF EXISTS "Administrators delete team media" ON storage.objects;
CREATE POLICY "Administrators delete team media"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'team-media' AND public.is_admin());

-- ---------------------------------------------------------------------------
-- Final: Promote admin@sanket.vaanni to permanent owner and admin role
-- ---------------------------------------------------------------------------
UPDATE public.profiles
SET role = 'admin', status = 'active', is_owner = true
WHERE email ILIKE 'admin@sanket.vaanni';

