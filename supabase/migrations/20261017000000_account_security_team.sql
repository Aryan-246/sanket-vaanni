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
