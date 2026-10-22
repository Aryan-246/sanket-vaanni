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
