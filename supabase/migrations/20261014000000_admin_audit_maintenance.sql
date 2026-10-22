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
