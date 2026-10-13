# Sanket Vaanni — Remediation Report

**Date:** 2026-10-13
**Branch:** `3d-hand-viewer-integration` (HEAD `a4a537e` + uncommitted working tree)
**Scope:** the six remediation areas A–F. Nothing was committed, pushed, deployed,
or applied to the remote database. No secret value was printed, read aloud, or
written into any file, including this one.

This report is the "what is left" document. The full implementation record is
`docs/final-delivery-report.md`; the integration-by-integration status is
`docs/integrations-guide.md`; the Supabase specifics are `docs/supabase-setup.md`.

---

## 1. What changed, area by area

### A — Mobile environment loading

**The root cause was not what it looked like.** `react-native-dotenv` v5 *is*
installed and the Babel mechanism *was* correctly wired all along. The values
never reached the app for two independent reasons, and neither was the one an
earlier note blamed:

1. `apps/mobile/.env` was empty, so the plugin had nothing to substitute.
2. `apps/mobile/package.json` declared `@react-native-babel-preset` — a scope with
   no package name after it. That is not a valid name, so **every** npm command in
   that app aborted, including the install that would have put
   `@supabase/supabase-js` and the Firebase packages into `apps/mobile/node_modules`.

Fixed: the dependency name was corrected to `@react-native/babel-preset` (the
name at HEAD, the name `babel.config.js` imports, and the name physically
installed), the three variables are present in `apps/mobile/.env`, and the
documentation that described the mechanism wrongly has been corrected in
`docs/supabase-setup.md` §2, `apps/mobile/.env.example`, and
`apps/mobile/src/types/env.d.ts`.

**The one thing to remember about this mechanism:** `react-native-dotenv`
substitutes values at **build** time. Editing `.env` changes nothing for a
running app. Development needs a Metro restart with `--reset-cache`; an installed
APK needs to be **rebuilt**. Nothing read this way is secret.

### B — Backend environment and Supabase admin configuration

`apps/backend/.env` has been left exactly as it was — no value printed, no
variable overwritten, no duplicate created. All 15 variables the server actually
reads are present.

Verified in code that the privileged key is confined to the server:
`apps/mobile/src` contains **zero** occurrences of `service_role`,
`SERVICE_ROLE`, `serviceRole` or `SECRET`. The service-role key appears only in
`apps/backend/src/config.ts`, in `requireAdmin` (which builds the client only
after authenticating and authorising the caller as an active administrator), and
in SQL grants to the `service_role` database role. If it is absent, the admin API
disables itself and says so — there is no weaker fallback.

Corrected: `apps/backend/src/config.ts` carried the comment "There are currently
no secrets", which stopped being true when SMTP and Supabase credentials were
added. It now states the opposite and explains the handling rules.

### C — Package installation without destroying existing work

`@supabase/supabase-js` is now installed locally in `apps/mobile/node_modules`
instead of being resolved from the hoisted root copy. The temporary resolver
workaround in `apps/mobile/metro.config.js` has been reverted to the standard
config, because it treated a symptom of the malformed dependency name.

**The root `package.json` and `package-lock.json` have not been deleted, moved,
overwritten or regenerated.** They remain untracked, and the recovery copy under
`.recovery/root-package-2026-10-13/` is intact. Nothing in the build needs them
any more, but they are yours to decide about.

### D — Supabase remote schema and RLS

Determined by **read-only** `GET`/`HEAD` requests with the app's publishable key.
No `db push`, no migration applied, no data touched. The full table of results is
`docs/integrations-guide.md` §1.1. The headline findings:

| Fact | Status |
|---|---|
| The five core tables exist remotely | **Confirmed** — `401 / 42501`, not `404` |
| `anon` is refused on all of them | **Confirmed, read-only** |
| `admin_audit_log`, `app_settings`, `device_push_tokens` | **Do not exist remotely** (`404`) |
| Google OAuth | **Enabled** — falsifies the old "disabled by default" claim |
| Email confirmation | **Required** (`mailer_autoconfirm: false`) |
| Row-level isolation between two users | **NOT TESTED** — needs two sessions |
| The `user-media` bucket | **Unresolved** — `NoSuchBucket` is ambiguous |
| The `sanketvaani://auth-callback` redirect URL | **Unresolved** — a control probe proved the check is inconclusive |
| The four storage policies | **Unconfirmed** — the old "verified" claim has no evidence |

### E — Firebase Android push client

Implemented: `@react-native-firebase/app` and `@react-native-firebase/messaging`
v26.4.0 installed; `com.google.gms:google-services:4.4.4` on the buildscript
classpath; the plugin applied **conditionally** on `google-services.json`
existing (it hard-fails the build when the file is missing, and the file is
gitignored); `POST_NOTIFICATIONS` declared and requested only when the user opts
in; a permission/token/registration state machine in
`apps/mobile/src/notifications/`; token release **before** sign-out; token-refresh
re-registration; foreground, tap and cold-start handling; and 18 unit tests.

Documentation corrected so the three facts are recorded separately — code
implemented, provider configured, function tested — in
`docs/integrations-guide.md` §1 and §4. **Android push is implemented and NOT
TESTED.** No notification has reached any device. iOS is deliberately
unimplemented and **on hold**; Android was not blocked on it.

### F — Corrections and testing restrictions

Preserved untouched: Supabase Auth, Google OAuth, database, Storage and session
recovery work; Gmail SMTP and Nodemailer configuration; the root recovery files.
Nothing was committed, pushed, deployed, or paid for. No broad test cycle or
build was run during remediation.

---

## 2. Remaining manual actions

These need a human with dashboard or account access. Each is a click-path, not
code.

### 2.1 Supabase Dashboard — confirm or create the Storage bucket

Project `mmovhldjwadvljxtloes` → **Storage → Buckets**.

1. Does a bucket named exactly `user-media` exist, and is it **Private**?
   - **If it does not exist:** create it, private, and then run
     `supabase/migrations/20261013000000_storage_user_media_policies.sql` in the
     SQL Editor.
   - **If it exists:** open **Storage → Policies**, select `user-media`, and
     confirm the four policies `user_media_select_own_folder`,
     `user_media_insert_own_folder`, `user_media_update_own_folder` and
     `user_media_delete_own_folder` are present, each `TO authenticated`, each
     with `bucket_id = 'user-media' AND (storage.foldername(name))[1] = (auth.uid())::text`.
     If any is missing, run the migration above — it is idempotent.

### 2.2 Supabase Dashboard — confirm the redirect URL

**Authentication → URL Configuration → Redirect URLs.** Confirm the entry:

```text
sanketvaani://auth-callback
```

Without it, password recovery and any OAuth return cannot come back to the app.
A read-only probe could not determine this (see §1.1 of the integrations guide).

### 2.3 Supabase Dashboard — Google OAuth

The provider is **enabled**, which is a change from what the documents said. Two
things to confirm by eye, since enabled is not the same as working:

1. **Authentication → Providers → Google** — are a Client ID and Client Secret
   actually filled in?
2. **Authentication → URL Configuration** — is there a Site URL / redirect entry
   that Google's callback can reach?

### 2.4 Supabase Dashboard — email delivery for signup

`mailer_autoconfirm` is `false`, so a new account must confirm its address before
it can sign in. Confirm **Authentication → Emails** is usable — either Supabase's
built-in sender within its rate limits, or a custom SMTP. This is a hard
dependency of any real sign-up test, not a defect.

### 2.5 Grant yourself the admin role — after the admin migration is applied

The Super Admin section is drawn only when the signed-in account holds the admin
role, read from `public.profiles.role`. That column arrives with
`20261014000000_admin_audit_maintenance.sql`. Once it is applied, promote exactly
one account with the SQL Editor (replace the address with your own):

```sql
UPDATE public.profiles
SET role = 'admin'
WHERE id = (SELECT id FROM auth.users WHERE email = 'you@example.com');
```

Do not put a hardcoded admin account or password in the app; there is none, and
there should not be one.

### 2.6 A physical device on the same Wi-Fi as the backend

`API_BASE_URL` must hold the host machine's **LAN** address for a physical phone,
not `10.0.2.2` (that is the Android emulator's alias for the host loopback), and
the backend must be started with `HOST=0.0.0.0` so it accepts the connection.
Changing `API_BASE_URL` means rebuilding the APK — it is compiled in.

---

## 3. Exact environment variable names

All six are already present on disk. Listed for completeness; no values shown.

**`apps/mobile/.env`** — read at build time via the `@env` Babel module. Nothing
here is secret; everything here ends up readable in the bundle.

| Variable | Meaning |
|---|---|
| `API_BASE_URL` | Sanket Vaanni backend base URL. Must be the host's LAN IP for a physical device. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key. The only Supabase key that belongs in a client. |

**`apps/backend/.env`** — read at runtime by Node via `--env-file-if-exists=.env`.

| Variable | Meaning |
|---|---|
| `HOST` | Bind address. `127.0.0.1` keeps it off the network; `0.0.0.0` lets a phone reach it. |
| `PORT` | Listen port. Keep in step with the mobile `API_BASE_URL`. |
| `NODE_ENV` | `development` \| `test` \| `production`. |
| `LOG_LEVEL` | pino level. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Absolute path to the Firebase service-account JSON, outside the repository. |
| `SMTP_HOST` | SMTP host. |
| `SMTP_PORT` | SMTP port. |
| `SMTP_SECURE` | Implicit TLS. |
| `SMTP_USER` | Authenticated sender account. |
| `SMTP_PASS` | Gmail App Password. **Secret.** |
| `SMTP_FROM` | Formatted sender address. |
| `API_INTERNAL_SECRET` | Shared secret for the server-to-server email and notification routes. **Secret.** |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_ANON_KEY` | Anon key; used only to validate incoming access tokens. |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses every RLS policy. **Secret. Server-side only.** |

The mobile and backend `.env` files are read by different processes at different
times. A variable in one is invisible to the other. **Do not copy any backend
variable into the mobile app.**

---

## 4. Unverified functionality

Recorded as **NOT TESTED**, never as a pass. Nothing in this list should be
described as working.

### Blocked by a missing device or hardware

- **Physical glove over BLE** — no glove present. The simulator ran; hardware did not.
- **Physical OLED panel** — no panel and no verified command set.
- **Real sign recognition** — no model loaded.
- **Speech output on this handset** — the device reports no usable TTS engine.

### Blocked by an approval not yet given

- **The admin / audit / maintenance / announcement feature set** — code complete,
  but `admin_audit_log` and `app_settings` do not exist remotely. Needs the
  migration in §5 below.
- **Push token registration** — code complete, but `device_push_tokens` does not
  exist remotely. Needs the migration in §5 below.

### Implemented but never exercised against the live service

- **Android FCM delivery** — no notification has reached a device. The 18 unit
  tests drive a fake bridge; that tests the state machine, not delivery.
- **Supabase Auth round trip** — no sign-in, sign-up or password reset has been
  performed against the live project.
- **Row-level isolation between two users** — only unauthenticated access has been
  shown to be refused. Two-user isolation needs two sessions and a cross-read.
- **Storage upload and download** — the bucket's existence is unresolved (§2.1).
- **Nodemailer / Gmail SMTP** — configured, never sent.
- **Backend Firebase Admin dispatch** — configured, never dispatched.
- **OAuth and password-recovery deep links** — the redirect URL is unconfirmed
  (§2.2), and the probe that tried to test it was inconclusive.

### Not attempted

- **iOS APNs / FCM** — deliberately on hold; no Apple Developer access.

---

## 5. Approval requested: two migrations

Neither has been applied. The remote project is untouched. Both are new files in
an untracked `supabase/` directory, so the "diff" is the file.

The sections below are numbered by size, not by apply order. The **apply order is
`20261014000000_admin_audit_maintenance.sql` first, then
`20261014000001_device_push_tokens.sql`** — the filenames sort that way and the
steps at the end of this section follow it.

### 5.1 `20261014000001_device_push_tokens.sql` — 321 lines

Creates `public.device_push_tokens` (token as PRIMARY KEY, `user_id` →
`auth.users` ON DELETE CASCADE, `platform`, three timestamps) with CHECK
constraints on `platform` (`android`/`ios` only) and on token length; an index
on `user_id`; RLS enabled with three policies (`select_own`, `insert_own`,
`delete_own`, all `auth.uid() = user_id`), deliberately **no UPDATE policy**;
and one `SECURITY DEFINER` function:

`public.register_device_push_token(p_token text, p_platform text)`

**What to review.** The token is the primary key, so one install belongs to
exactly one account — when somebody signs out and somebody else signs in, the
token changes hands rather than existing under both, which is what stops the
first person's notifications arriving on a phone they signed out of. That
transfer is why the function needs `SECURITY DEFINER`: claiming a token means
taking a row that may belong to another user, and RLS correctly forbids that.

The function was rewritten in the hardening pass. It now takes the owner
**only** from `auth.uid()` (there is no `p_user_id` parameter to abuse), runs
with `SET search_path = ''` and every reference schema-qualified, validates the
token length and the platform before writing anything, and claims the token
with a **single** `INSERT ... ON CONFLICT (token) DO UPDATE` instead of the
previous `DELETE`-then-`INSERT`. It also caps one account at 20 tokens,
trimming only the caller's own oldest rows. `anon` is revoked explicitly rather
than only through `PUBLIC`, because Supabase's default privileges grant EXECUTE
on new functions directly to `anon`.

It is idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `CREATE OR
REPLACE`) and safe to re-run.

**Table privileges are stated rather than inherited.** Supabase's default
privileges grant `ALL` on a newly created table directly to `anon` and
`authenticated`. The file now revokes explicitly and then grants back only what
the app uses:

```sql
REVOKE ALL ON public.device_push_tokens FROM anon;
REVOKE ALL ON public.device_push_tokens FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.device_push_tokens TO authenticated;
GRANT ALL ON public.device_push_tokens TO service_role;
```

`service_role` is deliberately left wide: it is the trusted server credential,
it bypasses RLS by design, and the notification dispatcher depends on it.

Measured, not assumed — `has_table_privilege` reports `authenticated` holding
exactly `SELECT, INSERT, DELETE` on this table, and the withheld verbs are
refused in practice, not only in the catalogue: a `TRUNCATE` as an authenticated
user fails with `42501`. **TRUNCATE is the verb that could not have been covered
by a policy**, because RLS filters rows for SELECT, INSERT, UPDATE and DELETE and
does not apply to TRUNCATE at all. PostgREST exposes no TRUNCATE route, so this
was a latent capability rather than a live hole, and the file says so; a
privilege no caller needs should not sit under a command no policy can guard.

**What the app actually calls, checked in the source.** `apps/mobile/src/notifications/register.ts`
performs exactly two operations: `rpc('register_device_push_token', …)` and
`.from('device_push_tokens').delete().eq('token', token)`. Nothing in
`apps/backend/src` mentions the table. So the narrowed grant covers the
registration and sign-out-deletion flows with room to spare; the `SELECT` grant
is not used by any current caller and is there because reading your own
registrations is the obvious thing to want next.

### 5.2 `20261014000000_admin_audit_maintenance.sql` — 788 lines, summarised

Too long to reproduce here; it is the file itself that should be reviewed, and
it is what gets copied into the SQL Editor.

- **`profiles`** — adds `role` and `status` columns, three named CHECK
  constraints, indexes on both, an admin-read policy, and a trigger
  `enforce_profile_privilege_boundary` that stops a user promoting themselves.
- **`admin_audit_log`** — table, three indexes, RLS, an admin-read policy;
  `UPDATE`/`DELETE`/`TRUNCATE` revoked, so the log is append-only.
- **`app_settings`** — table, RLS, a policy that exposes **only** the
  `maintenance` row, and column-level `SELECT (key, value)` grants to `anon` and
  `authenticated`. Writes go only to `service_role`.
- **`announcements`** — table, indexes, RLS, a published-read policy for
  everyone and an admin-read policy for the rest, plus an `updated_at` trigger.
- **Functions** — `is_admin()`, `is_active()`, `touch_updated_at()`, and a
  rewritten `handle_new_user()`.
- **Tightened policies** on `user_preferences`, `calibration_profiles`,
  `oled_profiles` and `user_history`, adding the `is_active()` check to every
  SELECT, INSERT and UPDATE policy.

**What to review.** Three things changed behaviour for existing users, and one
is a bug fix.

1. **`is_admin()` and `is_active()` no longer take an argument.** The old
   `check_uid UUID DEFAULT auth.uid()` let any signed-in user pass somebody
   else's id and learn whether that account was an administrator or suspended.
   Verified by execution: on the old revision `is_admin('<alice>')` returned
   `true` to an ordinary user; on the revised one the same call fails with *no
   function matches the given name and argument types*.
2. **Suspension now covers writes as well as reads.** The previous revision
   gated only the four SELECT policies and the history INSERT; a suspended
   account could still insert and update its preferences, calibrations and OLED
   profiles, because a permissive policy that never mentions `is_active()` still
   grants access.
3. **The maintenance setting is no longer world-readable as a whole table.**
   `USING (true)` published every setting, including ones added later. The
   policy now matches `key = 'maintenance'` only, and the grant is column-level,
   which also stops `updated_by` — the administrator's own id — from being
   published.
4. **Bug fix.** `handle_new_user()` had lost the `user_preferences` insert that
   the initial migration performed, so new accounts had no preferences row. It
   is restored.

Everything is `IF NOT EXISTS` / `DROP ... IF EXISTS` / `CREATE OR REPLACE`, and
the file was run three times in succession against a real PostgreSQL 18 instance
with no errors.

**Verification performed for this revision.** A throwaway PostgreSQL 18 cluster
was created outside the repository, Supabase's roles, `auth.users`,
`auth.uid()`, `storage.*` and default privileges were stubbed, and both
migrations were executed. The suite is **145 assertions, all passing**, across
four runs:

| Run | What it establishes | Result |
|---|---|---|
| Fresh install | both migrations over the initial + storage migrations | clean |
| Repeatability | each migration run three times in succession; object counts unchanged (2 identity functions, 1 token function, 23 policies, 4 triggers) | clean |
| Behaviour (62) | anon/authenticated/service-role access, suspension on reads *and* writes, active-user regression, self-promotion by INSERT and by UPDATE, audit-log immutability, token transfer between accounts, token validation and the 20-token cap | 62 / 62 |
| Privilege matrix (21) | the exact table-privilege set per role, and the withheld verbs refused in practice | 21 / 21 |
| Upgrade | both migrations applied over a database carrying the previous revision, then the behaviour suite re-run | 62 / 62, data intact |
| Static checks (10) | no bare `IF NOT trusted`, `COALESCE` around `current_setting`, empty `search_path` on every definer function, the revoke-then-grant sequence, no credential literal | 10 / 10 |

Executing them found a real defect that reading had not: the privilege trigger
used `IF NOT trusted` against a value that could be NULL, and an ordinary
authenticated user could insert a profile with `role = 'admin'`. It is fixed and
has a named regression test.

The upgrade run also proves the previous revision's identity oracle is gone
rather than merely shadowed. Before: an ordinary user calling
`is_admin('<somebody else>')` gets `true`. After: the same call fails with *no
function matches the given name and argument types*. Pre-existing rows survived
it — 2 profiles, 2 preferences, 1 history row, 1 token, 2 settings and 1 audit
row, all unchanged.

### 5.3 Findings the validation surfaced but did not change

Recorded because they are real, and left alone because they belong to a
migration that is already applied remotely and is not the one under review.

**The five core tables still carry the default `ALL` grant for `authenticated`.**
Measured on the cluster:

| Table | `authenticated` holds |
|---|---|
| `profiles`, `user_preferences`, `calibration_profiles`, `oled_profiles`, `user_history` | `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE` |
| `admin_audit_log` | `INSERT, REFERENCES, SELECT, TRIGGER` |
| `announcements` | `REFERENCES, SELECT, TRIGGER` |

These come from Supabase's default privileges at table-creation time in
`20261012000000_sanket_vaanni_initial.sql`, which is the migration already
applied remotely. The `TRUNCATE` entries are the same latent capability that was
just removed from `device_push_tokens`, and they are not reachable through
PostgREST either — no route exposes TRUNCATE. The `INSERT` left on
`admin_audit_log` was probed and is refused by RLS (`new row violates row-level
security policy`); the `INSERT` left on `announcements` was probed and is refused
at the grant level. Neither is exploitable as things stand.

Narrowing these would mean a fifth migration of `REVOKE ALL` / `GRANT` pairs, one
per table, on tables that already have live data. That is a change with real
blast radius on a database in use, so it is reported here for a decision rather
than folded silently into a file you are being asked to approve.

### How to apply, once approved

The two files, by exact path and with the identity of the revision reviewed here:

| Path | Lines | SHA-256 |
|---|---|---|
| `supabase/migrations/20261014000000_admin_audit_maintenance.sql` | 788 | `c4898301f875542824ae7f85f07b59033988aaf7afaa42d6d58455251e28cef5` |
| `supabase/migrations/20261014000001_device_push_tokens.sql` | 321 | `26232168b924e98cbfbe87381919a4bc2d383c1c7b6f2bf455f4b6e4502b2637` |

For each file in turn: Dashboard → **SQL Editor** → new query → open
`supabase/migrations/20261014000000_admin_audit_maintenance.sql`, select all, copy,
paste, **Run**. Then repeat with `20261014000001_device_push_tokens.sql`. The order
matters and is the order above; the second file's `register_device_push_token()`
is independent of the first, but the two are a pair and are documented together in
`docs/supabase-setup.md`.

Applying from this machine would need `npx supabase login` and
`npx supabase link`, which is your call, not something to be started
unattended.

**Neither file has been applied to the remote project.** Project
`mmovhldjwadvljxtloes` was not connected to, queried or modified during this
pass; every result above comes from the throwaway cluster on `127.0.0.1:55432`.
Both files remain untracked in Git (the whole `supabase/` directory is), nothing
was committed, pushed or deployed, and the working tree is otherwise untouched at
HEAD `a4a537e`.

---

## 6. What happens after approval

Then, and only then, the single comprehensive verification phase: a fresh Android
build and install, a real sign-in, live database and RLS access, a real email, a
real FCM delivery, offline behaviour, and the app UI on the device. Anything that
turns out to be blocked by a missing credential, permission, device or piece of
hardware will be reported as blocked — with the reason — rather than as a pass.
