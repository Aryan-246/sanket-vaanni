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
