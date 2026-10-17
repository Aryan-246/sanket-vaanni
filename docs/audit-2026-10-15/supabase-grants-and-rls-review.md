# Supabase grants and RLS review — migrations, as local files

**Date:** 2026-10-15
**Scope:** §8 of the completion directive — *"Review Supabase migrations, table grants and RLS as local files only. Provide a safe, least-privilege migration plan with rollback and owner approval steps. Do not execute remote SQL or alter production settings."*

**Status: NOTHING IN THIS DOCUMENT HAS BEEN EXECUTED.** No migration was applied, no
permission changed, no remote SQL run, no production setting touched. Every proposed
statement below is written to be reviewed by you and run by you.

**Ownership.** The SQL files under `supabase/` belong to the database-permission
workstream. **No file under `supabase/` was modified by this review** — it reads them
and describes them. The proposed fix is delivered as text in this document,
deliberately not as a new file under `supabase/migrations/`, so that nothing about the
deployed migration set changes until you decide it should.

---

## 0. What is currently applied to the hosted project

This matters for the ordering in §7, and the record on it is not consistent across
existing documents, so it is stated here with its evidence.

| Migration | Applied? | Evidence |
|---|---|---|
| 1 — initial schema | **Yes** | All five tables answer `42501` (exist, denied) rather than `404`/`42P01` — `docs/integration-status-2026-10-15.md:56-60`, `:63`; `docs/supabase-setup.md:70` |
| 2 — storage policies | **Unknown from the records read** | Not separately probed in any document found |
| 3 — admin/audit/maintenance | **No** | `docs/integration-status-2026-10-15.md:112-116`: the audit, announcements, maintenance and push paths "have no storage in production"; `:131` names `admin_audit_log` as **absent** |
| 4 — device push tokens | **No** | Same source, same section |

**A contradiction in the existing record, flagged rather than silently resolved.**
`docs/admin-phase-final-report.md:108` states that all four migrations exist and
**"none applied to the hosted project"**. That cannot be right: the tables from
migration 1 demonstrably exist, because a nonexistent table returns `42P01`, not
`42501`. The `integration-status` reading is the one supported by the probe. Both
cannot stand, and this document follows the probe.

**Consequence for this review:** the five tables this document grants on already exist
in the hosted project, so the file in §3 can be applied as soon as you approve it —
it does **not** depend on migrations 3 or 4. Migrations 3 and 4 must still be applied
before the administration system works at all, and before verification query 6 in §5
(the self-promotion check) can mean anything, because the trigger it tests arrives in
migration 3.

---

## 1. What was reviewed

| File | Statements reviewed |
|---|---|
| `supabase/migrations/20261012000000_sanket_vaanni_initial.sql` | 5 tables, 5 `ENABLE ROW LEVEL SECURITY`, 15 policies, 2 `SECURITY DEFINER` functions, 2 function grants |
| `supabase/migrations/20261013000000_storage_user_media_policies.sql` | Storage-bucket policies; no table grants |
| `supabase/migrations/20261014000000_admin_audit_maintenance.sql` | 3 tables, `profiles` columns, privilege-boundary trigger, 17 policies, 5 grant/revoke blocks |
| `supabase/migrations/20261014000001_device_push_tokens.sql` | 1 table, 1 function, 3 grant/revoke blocks |

Companion document: `docs/admin-migration-checklist.md`, which sequences the
deployment and the owner's review points. This document does not repeat it; it adds
the one finding the checklist does not make.

---

## 2. The finding: five tables have policies and no grants

Every `GRANT`/`REVOKE` in the migration set, in full:

| Migration | Line | Statement |
|---|---|---|
| 1 | 206 | `REVOKE EXECUTE ON FUNCTION public.delete_user_account() FROM public;` |
| 1 | 207 | `GRANT EXECUTE ON FUNCTION public.delete_user_account() TO authenticated;` |
| 3 | 240–242 | `is_admin()` — revoke from `PUBLIC`/`anon`, grant to `authenticated` |
| 3 | 408–412 | `admin_audit_log` — revoke from `anon`, revoke `UPDATE/DELETE/TRUNCATE` from `authenticated`, grant `SELECT` to `authenticated`, `INSERT`+`SELECT` to `service_role` |
| 3 | 494–496 | `app_settings` — revoke from `anon, authenticated`, grant `SELECT (key, value)`, `ALL` to `service_role` |
| 3 | 556–558 | `announcements` — revoke write verbs, grant `SELECT` to `anon, authenticated`, `ALL` to `service_role` |
| 3 | 711–713 | `is_active()` — revoke from `PUBLIC`/`anon`, grant to `authenticated` |
| 4 | 174–176 | `device_push_tokens` — revoke from `anon`/`authenticated`, grant `SELECT, INSERT, DELETE` to `authenticated` |
| 4 | 181 | `device_push_tokens` — grant `ALL` to `service_role` |
| 4 | 319–321 | `register_device_push_token(TEXT, TEXT)` — revoke from `PUBLIC`/`anon`, grant `EXECUTE` to `authenticated` |

**There is no statement anywhere in the set that grants any table privilege to
`anon`, `authenticated` or `service_role` on `profiles`, `user_preferences`,
`calibration_profiles`, `oled_profiles` or `user_history`.** Migration 1 creates all
five, enables RLS on all five and writes 15 policies across them — and grants only on
a function.

### Why this is a real gap and not a style preference

Two facts make it one.

**First, migration 3 grants on the tables it creates and not on the tables it
re-policies.** It re-creates policies on the four user-data tables — 3 each, 12 in
total — and creates 3 tables that it then grants on. The author policied the
user-data tables as though `authenticated` could reach them, then granted only on the
new ones. Whatever the intent, the two halves of the same file disagree.

**Second, the deployed project says so.** This is recorded observation, not
inference:

| Probe | Result |
|---|---|
| `GET /rest/v1/profiles?select=*&limit=0` with the **anon** key | `401`, code `42501` |
| Same, with the **service-role** key | `403`, code `42501` |
| Same pattern for all four other tables | identical, both keys |

Source: `docs/integration-status-2026-10-15.md:56-60` and `:63`.

`42501` is PostgreSQL `insufficient_privilege`. Two things follow from it:

- The tables **exist** — a missing table is `404`/`42P01`, not `42501`.
- The denial is on **grants**, not RLS. **RLS is bypassed entirely by
  `service_role`**, so if the failure were a policy problem, the service-role request
  would have succeeded. It did not.

That second point is the whole argument, and it is worth stating plainly: **a
service-role request that is refused for `insufficient_privilege` can only be refused
by the grant layer.** Policies are not consulted for that role.

### What local files cannot tell you

**Why** the defaults did not apply is not determinable from this repository. A
Supabase project normally grants on new `public` tables through `ALTER DEFAULT
PRIVILEGES` for the role the migration runs as, and a migration applied through
`supabase db push` or the SQL editor would ordinarily inherit that. Since
`service_role` is denied too, whatever created these tables did so without the
defaults in effect — a different creating role, altered defaults, or a project
setting. **This document does not claim which**, because the evidence is not in the
repository.

**The fix is the same in every case**, and it is explicit grants rather than relying on
a default that has demonstrably not applied. That is the recommendation below.

---

## 3. The proposed migration — least privilege, one file

Review the verbs before approving. They are derived from what the code actually does,
not from a template: every table/verb pair below was read out of the call sites in §4.

```sql
-- Fix: publish grants for the five core tables created by
-- 20261012000000_sanket_vaanni_initial.sql.
--
-- No table in that migration received a table grant; it granted only on a function.
-- The hosted project refuses all five for both anon and service_role with 42501,
-- which is a grant-layer denial. This file grants the minimum each role needs.

begin;

-- ---------------------------------------------------------------- anon
--
-- Nothing. A signed-out client has no business reading or writing a user's own
-- data, and no policy on these five tables names anon. Revoking is a no-op if the
-- grant is already absent, and a correction if it is not.
revoke all on public.profiles             from anon;
revoke all on public.user_preferences     from anon;
revoke all on public.calibration_profiles from anon;
revoke all on public.oled_profiles        from anon;
revoke all on public.user_history         from anon;
revoke all on public.profiles             from public;
revoke all on public.user_preferences     from public;
revoke all on public.calibration_profiles from public;
revoke all on public.oled_profiles        from public;
revoke all on public.user_history         from public;

-- ------------------------------------------------------- authenticated
--
-- profiles: read and update the caller's own row. The RLS policies restrict this to
-- `auth.uid() = id`. INSERT is deliberately withheld: the row is created by
-- `handle_new_user()`, a SECURITY DEFINER trigger on auth.users, which runs as the
-- function owner and needs no grant for the signup path. DELETE is withheld: removing
-- an account goes through `delete_user_account()`, also SECURITY DEFINER, and its
-- cascade to profiles runs as the table owner.
grant select, update on public.profiles to authenticated;

-- The four user-data tables: read, and upsert the caller's own rows. These are
-- separate verbs on purpose. `supabase-js` `.upsert()` compiles to
-- `INSERT ... ON CONFLICT DO UPDATE`, which needs INSERT *and* UPDATE.
grant select, insert, update on public.user_preferences     to authenticated;
grant select, insert, update on public.calibration_profiles to authenticated;
grant select, insert, update on public.oled_profiles        to authenticated;
grant select, insert, update on public.user_history         to authenticated;

-- ---------------------------------------------------------- service_role
--
-- The server's own credential. RLS does not apply to it, so these grants are the
-- only boundary on it — which is why they are listed rather than granted as ALL.
--
-- profiles: read for lookup and counting, update for suspend/restore and role change.
-- That is every operation the backend performs on it.
grant select, update on public.profiles to service_role;

-- The four user-data tables: service_role has no grants here, because no code path
-- reads or writes them with the service key. `apps/backend/src` selects from
-- `profiles`, `admin_audit_log`, `app_settings`, `announcements` and
-- `device_push_tokens` and nothing else.
--
-- If a future server-side feature needs them — an export, a scheduled job, a
-- migration — that is a deliberate follow-up grant, and making it deliberate is the
-- point. Withholding it costs nothing today and means the next person to reach for
-- the service key on a user's data has to say so out loud.

commit;
```

### Why the verbs are what they are

| Table | Role | Granted | Withheld, and why |
|---|---|---|---|
| `profiles` | `authenticated` | `SELECT`, `UPDATE` | `INSERT` — the signup trigger (migration 1:163-192) owns it. `DELETE` — `delete_user_account()` (migration 1:195-204) owns it. |
| `user_preferences` | `authenticated` | `SELECT`, `INSERT`, `UPDATE` | `DELETE` — the client only reads and upserts (`sync.ts:646,675,694`). |
| `calibration_profiles` | `authenticated` | `SELECT`, `INSERT`, `UPDATE` | `DELETE` — read and upsert only (`sync.ts:743,765,776`). |
| `oled_profiles` | `authenticated` | `SELECT`, `INSERT`, `UPDATE` | `DELETE` — read and upsert only (`sync.ts:820,856,875`). |
| `user_history` | `authenticated` | `SELECT`, `INSERT`, `UPDATE` | `DELETE` — read and upsert only (`sync.ts:967,986`). |
| all five | `anon` | nothing | No policy on these tables names `anon`, so any grant would be dead weight. |
| all five | `service_role` | `profiles`: `SELECT`, `UPDATE` | The other four are unread by the server (§4). |

**No `TRUNCATE` grant is proposed for any role on any table.** It is not used by
anything here, it is not constrained by RLS, and it is unrecoverable.

### Review points before you approve

1. **`service_role` gains no access to four user-data tables.** This is the least
   privilege reading of the code as it stands. If you would rather the service key be
   able to read user data — for a support tool, an export, a future job — widen the
   four lines explicitly. Do not widen them by habit.
2. **`authenticated` can `UPDATE` `profiles`.** That is required for the profile edit
   screen (`apps/mobile/src/account/AccountProvider.tsx:358`), and it is the column the
   `enforce_profile_privilege_boundary` trigger guards (migration 3). Confirm you are
   content that the trigger, not the grant, is what stops self-promotion — it is, and
   it is a `BEFORE INSERT OR UPDATE` trigger, so the grant cannot route around it.
3. **The two `SECURITY DEFINER` functions run with the owner's rights.** If the owner
   of these functions is a role with no `INSERT` on `profiles`, signup breaks. Confirm
   after applying that a test signup still creates a profile row (§5, query 5).
4. **Nothing here deletes data or changes a policy.** The whole file is
   `REVOKE`/`GRANT`. Rollback is §6.

### Idempotency

Every statement is a bare `REVOKE` or `GRANT`, which is idempotent by construction —
PostgreSQL grant state is a set, and re-running a `REVOKE` of a privilege that is
already absent, or a `GRANT` of one already held, succeeds and changes nothing. The
file is wrapped in a transaction, so a partial application is not possible.

**Deviation from the existing style, stated deliberately:** migrations 3 and 4 use
`REVOKE ALL ... FROM anon, authenticated` then re-grant. This file does not revoke
`ALL` from `authenticated` on these five tables, because doing so would drop the
`INSERT` on `profiles` that the signup trigger path may rely on if its owner differs
from the table owner. The revokes are per-role as shown.

---

## 4. Where the verb list came from

Not from a template. Every line of §3 is justified by a call site:

**Mobile (`apps/mobile/src`)**

| Table | Verb | Evidence |
|---|---|---|
| `user_preferences` | `SELECT`, upsert | `supabase/sync.ts:646`, `:675`, `:694` |
| `calibration_profiles` | `SELECT`, upsert | `supabase/sync.ts:743`, `:765`, `:776` |
| `oled_profiles` | `SELECT`, upsert | `supabase/sync.ts:820`, `:856`, `:875` |
| `user_history` | `SELECT`, upsert | `supabase/sync.ts:967`, `:986` |
| `profiles` | `SELECT`, `UPDATE` | `account/AccountProvider.tsx:138`, `:358` |

**Backend (`apps/backend/src`)**

| Table | Verb | Evidence |
|---|---|---|
| `profiles` | `SELECT` | `middleware/requireAdmin.ts:191`; `routes/admin.ts:501`, `:539`, `:690`, `:746`, `:756`, `:877`, `:887`, `:1004`, `:1078`, `:1569-1578`; `admin/bootstrap.ts:387`, `:405` |
| `profiles` | `UPDATE` | `routes/admin.ts:795`, `:943`, `:1036`; `admin/bootstrap.ts:415`, `:420` |

An exhaustive grep for `.from('<table>')` across `apps/backend/src` returns only
`profiles`, `admin_audit_log`, `app_settings`, `announcements` and
`device_push_tokens`. The four user-data tables do not appear — which is what makes
the `service_role` column in §3 defensible rather than merely tidy.

---

## 5. Verify after applying

Run these in the hosted SQL editor. Each has an expected result; a different one means
stop.

**1 — the five tables now carry grants:**

```sql
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('profiles','user_preferences','calibration_profiles',
                     'oled_profiles','user_history')
group by table_name, grantee
order by table_name, grantee;
```

Expected: `authenticated` on `profiles` as `SELECT, UPDATE`; on the other four as
`INSERT, SELECT, UPDATE`; `service_role` on `profiles` as `SELECT, UPDATE`. **No row
for `anon`.** No `DELETE` or `TRUNCATE` for any grantee.

**2 — RLS is still on everywhere** (unchanged by this file, and worth confirming it
was not the problem):

```sql
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('profiles','user_preferences','calibration_profiles',
                  'oled_profiles','user_history')
order by relname;
```

Expected: `true` for all five.

**3 — the deny-all sentinel: RLS still refuses cross-user reads.** With a normal
signed-in user's token, not service role:

```
GET /rest/v1/user_history?select=*
```

Expected: `200` with **only the caller's rows**, or an empty array. A `200` returning
another user's rows means RLS is off — stop.

**4 — the same probe that failed before now succeeds.** With the **service-role** key:

```
GET /rest/v1/profiles?select=*&limit=0
```

Expected: **`200`**, not `403 / 42501`. This is the exact request recorded as failing
in `docs/integration-status-2026-10-15.md:56`, so it is a before/after, not a proxy.

**5 — signup still provisions a profile.** Create a throwaway account through the app.
Expected: a `profiles` row and a `user_preferences` row. This is the check that the
`SECURITY DEFINER` trigger path is unaffected — if it is, the failure appears here and
nowhere else, and it would be a `42501` on the trigger's `INSERT`.

**6 — self-promotion is still refused.** As a normal signed-in user:

```sql
update public.profiles set role = 'admin' where id = auth.uid();
```

Expected: `ERROR insufficient_privilege` with the trigger's message. **If this
succeeds, stop and treat it as an incident** — the grant work must not have touched
the trigger, but confirm rather than assume.

---

## 6. Rollback

The file only adds privileges, so the inverse is a revocation. It is written out here
because a rollback that has to be improvised during an incident is how an incident
becomes two:

```sql
begin;
revoke select, update on public.profiles             from authenticated;
revoke select, insert, update on public.user_preferences     from authenticated;
revoke select, insert, update on public.calibration_profiles from authenticated;
revoke select, insert, update on public.oled_profiles        from authenticated;
revoke select, insert, update on public.user_history         from authenticated;
revoke select, update on public.profiles from service_role;
commit;
```

**This returns the project to the state it is in now — which is a broken one.** The
app cannot sync, the admin console cannot read accounts, and the bootstrap tool cannot
run. Rolling back is therefore only correct if the grants caused a problem worse than
being unable to use the database, which is hard to imagine; the realistic rollback is
"fix forward by re-running a corrected version of §3".

**Do not** reach for a blanket `REVOKE ALL ... FROM authenticated` on `public`. That
would also strip `admin_audit_log`, `announcements` and `device_push_tokens`, which
migrations 3 and 4 set up deliberately and which this file does not touch.

---

## 7. Owner approval steps

1. **Read §2** and decide whether you accept the finding. It is a claim about the
   deployed project, evidenced by two recorded probes at
   `docs/integration-status-2026-10-15.md:56-60`.
2. **Read §3's review points** — particularly point 1, the `service_role` decision,
   which is the one place a reasonable owner might choose differently.
3. **Apply §3 after `docs/admin-migration-checklist.md` §2 has been run**, not before:
   the grants are for tables that migration 1 creates.
4. **Run §5's six queries.** Query 4 is the before/after; query 6 is the one that
   matters most if anything went wrong.
5. **Then** `docs/admin-migration-checklist.md` §5 — the first administrator, which
   cannot succeed until `profiles` is writable.
6. **Keep the outputs.** They are the evidence that this is fixed, and the next
   document that claims the database works should cite them.

**Suggested ordering with the existing checklist:** migration 1 → 2 → 3 → 4 → **§3 of
this document** → verify (§5 here + `admin-migration-checklist.md` §4) → bootstrap.
This document's file must come **after** the four migrations, because it grants on
tables and a function they create.

---

## 8. Confirmation of what was and was not done

| | |
|---|---|
| Remote SQL executed | **No** |
| Migration applied to the hosted project | **No** |
| Permissions or RLS changed remotely | **No** |
| Production setting altered | **No** |
| `supabase db push` run | **No** |
| Files under `supabase/` modified by this work | **No** |
| File added under `supabase/migrations/` | **No** — the proposal is text in this document, so the deployed migration set is unchanged until you choose otherwise |
| Local files read and inventoried | **Yes** — all four migrations, statement by statement |
| Call sites read to derive the verb list | **Yes** — §4, both packages |
| Least-privilege migration prepared with rollback and verification | **Yes** — §3, §6, §5 |

**Outstanding owner action:** the six steps in §7.
