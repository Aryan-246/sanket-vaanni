# Task F — final verification report

**Date:** 2026-10-15
**Branch:** `3d-hand-viewer-integration` · **HEAD:** `32937ac` (unchanged — nothing committed)
**Scope of this document:** the re-verification pass required by *"CONTINUE TASK F — FINISH ALL
REMAINING WORK AND PERFORM FULL ANDROID DEVICE TESTING"*. It records what was **checked**, what
**passed**, what **failed**, and what was **never tested**, on the three layers the directive asks to
be kept apart: an isolated local stack, the physical phone, and live cloud.

`docs/task-f-final-report.md` is the earlier implementation report and is left as it was. This file
supersedes it only where it says so explicitly.

Nothing was committed, pushed, tagged, released or deployed. No SQL was applied to hosted Supabase.
No production data was touched. No secret value appears in this file or in any source file.

---

## 1. Implementation summary and files changed

### 1.1 Changed in this pass, after device evidence

One defect was found **on the phone** and fixed. It is the only functional change made in this
window, and it is a truthfulness defect of exactly the kind the directive targets.

| File | Change |
| --- | --- |
| `apps/mobile/src/notifications/messaging.ts` | Added `hasNotificationPermission()`. On Android it resolves `NotificationManagerCompat.areNotificationsEnabled()` — the value the system itself consults before posting a notification — so it is correct whether the user refused at the prompt or switched notifications off later in Settings. |
| `apps/mobile/src/notifications/controller.ts` | `PushBridge` gained `hasPermission()`. `restore()` now **asks the platform** instead of assuming. It previously wrote `permission: stored.enabled ? 'granted' : 'unknown'` — i.e. a stored setting was treated as proof the phone would deliver. A failed read is `'unknown'`, never `'granted'`, and is swallowed so a launch cannot fail over it. |
| `apps/mobile/src/notifications/pushRow.ts` | **New.** `describePushRow(state)` — the sentence in the Settings row, extracted from a `useMemo` in the screen so it can be asserted. It now distinguishes *switched on here* from *the phone will deliver*, and reports separately when the phone could not be asked. |
| `apps/mobile/src/screens/MoreScreen.tsx` | The inline `if` chain is replaced by `describePushRow(pushState)`. Layout untouched. |
| `apps/mobile/__tests__/push.test.ts` | Bridge fake gained `hasPermission`; three tests added to *what survives a restart* (re-asks the platform; does not prompt while restoring; an unreadable read is `unknown`). |
| `apps/mobile/__tests__/push-row.test.ts` | **New.** 10 tests over the row's sentence, including the ordering of bad news. |

**Why this was a real defect, not a theoretical one.** On the device, `dumpsys package
com.sanketvaani` reported `android.permission.POST_NOTIFICATIONS: granted=false`, while the row
described notifications as working — at one point literally *"This phone can receive notifications,
but the token could not be recorded against your account"*. (Those two readings come from separate
observations in the same device session; the phone was already unplugged when the fix was written, so
they could not be read again together. The code path below is what makes the general case certain
regardless of that timing.) The stored setting said yes; the operating system said no; nothing in the
app ever re-asked, so the screen could go on describing an arrangement the phone had stopped
honouring. The row is the only place a user learns whether an announcement will reach them, and it
was wrong in the direction that hides the problem.

**Also corrected earlier in the task, from the same source (device observation):** the audit log
attributed bootstrap actions to *"an account that no longer exists"* when the rows' own metadata said
`operator-cli`. Fixed via `recordedActorOf`/`actorLine` in `apps/mobile/src/admin/auditEntry.ts`,
propagated to `AdminScreen.tsx`, with a doc comment in `admin/client.ts` corrected, three tests
added, and four mutations killed (see §4.5). Re-verified on the phone: both rows now read
`by operator-cli (no account recorded)`.

### 1.2 Cumulative inventory

The full implementation inventory (backend Admin services, announcements/dispatch, maintenance gate,
audit, bootstrap CLI, mobile Admin screens and clients, notices card, guest migration, Supabase sync
and push) is in `docs/task-f-final-report.md`; it was not re-edited here. `git status` groups it as:

- **Backend, new:** `src/admin/`, `src/announcements/`, `src/audit/`, `src/maintenance/`,
  `src/scripts/`, and `test/{admin-audit,admin-bootstrap,admin-routes,announcement-dispatch,maintenance-gate}.test.ts`.
- **Mobile, new:** `src/admin/{auditEntry,bulkEntry,dispatchReport,overviewFigures}.ts`,
  `src/announcements/`, `src/account/suspension.ts`, `src/supabase/guestMigration.ts`,
  `src/components/NoticesCard.tsx`, `src/notifications/pushRow.ts`, and the matching suites.
- **Both, modified:** the Admin route registration, the admin client, `AdminScreen`, `MoreScreen`,
  `AccountSheet`, `AppState`, sync, waveform, and the test/bootstrap configuration.

`supabase/**` (all four migrations, `config.toml`), `apps/backend/src/middleware/**` and the
Gemini-owned docs were **not edited** by this work. `apps/backend/src/middleware/requireAdmin.ts`
appears as modified in `git status`; its mtime is `2026-10-15 01:11`, before this pass began, and I
did not write to it. `supabase/config.toml` is still 0 bytes.

---

## 2. Completion status of each previously missing Admin feature

| # | Feature | Status | Evidence |
| --- | --- | --- | --- |
| A | **Overview from real API responses** | **PASS** (isolated stack + device) | `GET /admin/overview` returned genuine counts (1 user / 1 admin / 0 suspended / 1 notice / 1 published) and 2 bootstrap audit rows. Every figure has a defined source in `overviewFigures.ts`; `parseOverview` refuses a payload it cannot stand behind. Loading / empty / error / retry / refresh states present. No fabricated counter found in `src/`. |
| B | **Notification & configuration health** | **PASS** (isolated stack) · **NOT TESTED on device** | `GET /admin/health` reported `api` and `database` as `verified` with `delivers: false`, and `email` and `push` as `unconfigured` with a truthful sentence each, `deliveryTested: false`. No credential, token, service-account JSON or private endpoint appears in the payload. The distinction *configured / unconfigured / present but not delivery-tested / tested successfully / failed* is carried by the payload and rendered by the Service view. The Service tab was never opened on the phone (§7). |
| C | **Announcement delivery end to end** | **PASS** (isolated stack, server side) · **NOT TESTED on device** | Create/validate/update/publish/unpublish/expiry/audience/read/dismissal, authorization, audit rows, duplicate-safe dispatch and per-target delivery status are covered by `announcement-dispatch.test.ts` and the mobile `admin-dispatch`/`notices` suites, and were exercised over HTTP against the isolated backend. With no Firebase credentials, dispatch reports push as **unavailable** rather than delivered — the behaviour the directive demands. The composer was **not** published from the phone. |
| D | **Account termination and deactivation** | **PASS** (isolated stack + device) | Status changes are labelled as status changes; nothing calls a profile change a deletion of the Supabase Auth identity. Self-suspension and self-demotion are refused, and the **last active administrator cannot be suspended or demoted** — both refusals surfaced truthfully on the device. Password reset reports `requested` and says whether the mail arrives is decided by the provider and not visible to the app. The migration was **not** applied to hosted Supabase. |
| E | **Full chain per screen and action** | **PASS, with the two gaps in §7** | UI → typed request → token-derived identity → permission check → validation → DB operation → audit pair → refresh/propagation was traced for suspend, role change, bulk status, password reset, announcement create/update/dispatch, maintenance write and audit reads. Each action produced a matched `requested`/`succeeded` row sharing a `requestId`; failures produced `failed` with a detail. Self/last-admin refusals, missing `reason`, unrecognised token, anonymous, suspended admin, no-profile-row and 503-unconfigured were all exercised. No inert button, fake action or success message after a failed operation was found. The main Dashboard was not redesigned. |

**Defect found and fixed by this pass (§1.1):** the notifications row could claim delivery the phone
had stopped providing. **Defect found and fixed earlier:** audit attribution asserted a deletion that
the rows contradicted.

---

## 3. Guest-migration verification results

| Check | Result | Evidence |
| --- | --- | --- |
| Independent read-back after upload (not merely the upsert response) | **PASS** (tests) | `guest-migration-readback.test.ts`. |
| Bounded, cancellable requests | **PASS** (tests) | `guest-migration.test.ts` — timeout aborts, caller abort does not surface as a failure. |
| Retry after failure | **PASS** (tests) | Same suite. |
| Dismissal / consent refused | **PASS** (tests) | `account-sheet-consent.test.tsx`. |
| Interruption mid-migration, resumed | **PASS** (tests) | `guest-migration-interruption.test.ts`. |
| Local data retained throughout | **PASS** (tests) | Same suites; nothing deletes local rows before the server copy is confirmed. |
| Supersede / double-migration safety | **PASS** (tests) | `sync-supersede.test.ts`. |
| OLED storage key reconciled with the migration | **PASS** (tests) | Covered by the migration suite (task 1.7). |
| Guest-first flow on the device | **PASS** | The phone launched into Guest mode with notices and local state intact, and signing in from that state succeeded and persisted across a cold restart. |
| Consent / read-back / timeout / dismissal branches **on the device** | **NOT TESTED** | Exercised by the automated suites only. Each branch was not forced on the phone. |

The mobile service-role key was not used, RLS was not bypassed, and no read-back was claimed on the
strength of an upsert response alone.

---

## 4. Exact test commands and results

### 4.1 Mobile

```
cd apps/mobile && npx jest
→ Test Suites: 44 passed, 44 total
  Tests:       713 passed, 713 total
  Time:        86.878 s
```

```
cd apps/mobile && npx tsc --noEmit
→ exit 0
```

### 4.2 Backend

```
cd apps/backend && npx vitest run
→ Test Files  7 passed (7)
  Tests      166 passed (166)
  Duration   1.60 s
```

```
cd apps/backend && npx tsc -p tsconfig.json --noEmit
→ exit 0
```

**Remaining failures: none.** The counts rose from 700 to 713 because 13 tests were added by §1.1;
no test was deleted, skipped, disabled or weakened to reach this result — including
`honesty.test.tsx`, which is green in the full run above.

### 4.3 `honesty.test.tsx` voice-panel failure (Phase 4, carried over)

The reported failure is **not present** in the full run. It was investigated rather than relabelled:
the suite passes in a full run and in isolation, so the earlier failure was an ordering/environment
effect rather than a real defect in the voice panel. Nothing was changed to hide it, and the test
remains in the suite, unmodified, with its assertions intact.

### 4.4 Isolated-stack end-to-end evidence

Run against a local Supabase stack on `127.0.0.1:54321` with the backend on `:4000`, reached from the
phone over `adb reverse`:

`/admin/overview`, `/admin/health`, `/admin/users`, `/admin/users/{id}`, `/admin/users/{id}/suspend`,
`/admin/users/{id}/role`, `/admin/users/bulk`, `/admin/users/{id}/reset-password`,
`/admin/audit`, `/admin/announcements`, `/admin/maintenance` — all exercised with a genuine local
administrator token, each write producing an audit pair.

### 4.5 Mutation testing of the new guards

Each mutation was applied by script, the relevant suite re-run, and the file restored; the verdict is
taken from the failure block.

| Mutation | Result |
| --- | --- |
| Remove the "phone said no" branch from `describePushRow` | **Killed** — 2 tests failed ("does not claim delivery when the phone has been asked and said no"; "names the phone's refusal before the account problem"). |
| Remove the `permission !== 'granted'` fall-through | **Killed** — 1 test failed ("does not claim delivery when the phone could not be asked"). |
| Revert `restore()` to assuming `'granted'` from stored state | **Killed** — 2 tests failed (re-asks the platform; unreadable read is `unknown`). |
| Let a failed permission read escape `readPermission` | **Killed** — the run aborted with an unhandled rejection from the controller's unawaited `restore()`, which is precisely why the read is caught. |

Earlier in the task, the audit-attribution guard was falsified the same way (4 mutations, all killed).

### 4.6 Migration validation

The migrations were executed against a throwaway local Postgres cluster rather than the hosted
project, which is the only route available without approval to touch hosted. That exercise previously
caught a NULL-logic hole in the privilege trigger.

---

## 5. APK path, package, version and SHA-256

| Field | Value |
| --- | --- |
| Path | `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` |
| Size | 143,559,246 bytes |
| mtime | **2026-10-14 22:17** |
| SHA-256 | `2991d6bb491fe3d4c01f77724c24a2986c1b27364f1a105b9b151603f03a48ad` |
| Variant | **debug** (not a release or production build) |
| Package | `com.sanketvaani` |
| Version | `versionCode=1`, `versionName=1.0` |
| SDK | `minSdk=24`, `targetSdk=36` |
| Flags | `DEBUGGABLE`, `HAS_CODE`, `ALLOW_CLEAR_USER_DATA` |

**Caveats that must not be dropped when this is quoted:**

1. **This APK was not rebuilt in this pass**, and it is not the artefact that was exercised on the
   phone. Its mtime precedes the device session. The JavaScript the phone ran came from **Metro**,
   transformed with `BABEL_ENV=local` and `apps/mobile/.env.local` (the local-stack pointer). Result
   of a Metro-served run and result of an installed-APK run are not interchangeable, and §7 records
   only the former.
2. **The APK's embedded bundle is a stale, production-mode bundle configured against the hosted
   project.** `assets/index.android.bundle` is minified and sets `__DEV__=false`, and it inlines
   `API_BASE_URL = https://sanket-vaanni-backend.onrender.com` and the hosted Supabase project URL.
   Its only `localhost` and `127.0.0.1` strings belong to the Supabase client library's own
   self-hosted-host list (`localhost`, `127.0.0.1`, `[::1]`) and its GoTrue default
   (`http://localhost:9999`); there is no `10.0.2.2` and no `:4000` in it. **So no debug APK
   pointing at localhost was produced, and the normal production API URL was not changed** — but the
   bundle also lacks strings this task added (for instance `an actor with no account recorded`),
   which means it predates the work and is further evidence that it is not the artefact §7 describes.
   The practical consequence stands: a launch that could not reach Metro would have fallen back to
   production configuration, and one such launch was in fact observed (§7.3).

---

## 6. Device detection and installation result

| Field | Value |
| --- | --- |
| Detection | `adb devices -l` |
| Serial | `1595140436001XT` |
| Model / manufacturer | **V2141** / vivo |
| Android | **14 (SDK 34)** — the directive says Android 16; see below |
| Installed package | `com.sanketvaani`, `versionCode=1 versionName=1.0`, `minSdk=24 targetSdk=36`, `DEBUGGABLE` |
| `firstInstallTime` | `2026-10-10 14:54:46` |
| `lastUpdateTime` | `2026-10-15 12:05:01` |
| `android.permission.POST_NOTIFICATIONS` | `granted=false` |
| Current attachment | **none** — `adb devices` has been empty since roughly 14:40; the phone was unplugged while in the owner's hands. |

**Installation: updated in place, non-destructively.** `adb install -r` was used; the package's
`firstInstallTime` still reads 2026-10-10 while `lastUpdateTime` moved to 2026-10-15 12:05, which is
what an in-place update looks like and what preserved the app's data. Signature compatibility was
settled before updating — the update succeeded, which is only possible with a matching signature.
**The app was never uninstalled, its data was never cleared, and the device was not reset.**

**Two discrepancies to record rather than gloss over:**

- The directive names *Android 16*; the device reports **Android 14 / SDK 34**. Everything in §7 was
  observed on Android 14. Android-16-specific behaviour was **NOT TESTED**.
- No APK was built or installed during this pass. The build/install step predates it (below).

---

## 7. Screen-by-screen record of what was genuinely run on the phone

Everything in this section was observed on the physical V2141, over Metro, against the isolated local
stack, driven with `adb shell input` and read from screenshots. A unit test passing is **not** counted
here as a device pass.

| # | Screen / scenario | Result |
| --- | --- | --- |
| 1 | Fresh launch, guest-first flow | **PASS** — launches into Guest mode with notices and local state intact. |
| 2 | Navigation across the app | **PASS** — no dead end, no trapped navigation, back always recovers. |
| 3 | Layout at the phone's real screen size | **PASS** — no clipped or overlapped content on the screens visited. |
| 4 | Sign-in with a legitimate admin session | **PASS** — signed in against the isolated stack and reached Administration. |
| 5 | Administration → Overview | **PASS** — real counts from `/admin/overview`, each with a defined source. |
| 6 | Administration → People: list, search, filter, pagination, detail | **PASS** — list, search, status filter and detail view exercised. |
| 7 | Administration → People: account actions | **PASS** — suspend/role/password reset attempted; **self-suspension and self-demotion refused truthfully**; the last-administrator refusal surfaced correctly. Password reset reported `requested` with the sentence that whether the email arrives depends on the provider and the app cannot see it. |
| 8 | Administration → Audit | **PASS, after a fix** — Attempted/Succeeded pairs with actor, timestamp, target and reason. Two bootstrap rows wrongly read *"by an account that no longer exists"*; after the fix they read `by operator-cli (no account recorded)`, re-checked on the device. |
| 9 | Administration → Notices: list and user-side display | **PASS** — notices rendered from real rows; the card's third wording state exercised. |
| 10 | Notices card: failure → retry → recovery | **PASS** — a failed check reported itself, the retry recovered, and the failure was not left as a stale or false success. |
| 11 | Maintenance row (last-changed-by line) | **PASS** — rendered from the server's resolved value. |
| 12 | Session persistence across a cold restart | **PASS** — signed-in state and the Super Admin row survived a full restart. |
| 13 | Launch while fully offline | **PASS, with one documented gap** — persistence held and the app opened. The Super Admin row was absent until the next connected restart, which is the fail-safe direction (`isAdmin` is a UI hint that stays false until the profile read succeeds — hiding is safe, showing is not). The remaining gap is that there is no in-session retry for a failed profile read. |
| 14 | Notifications row truthfulness | **FAIL → FIXED, NOT RE-VERIFIED ON DEVICE** — see §1.1 and §7.3. |
| 15 | Service tab: configuration health states | **NOT TESTED on device** (API-level PASS, §2B). |
| 16 | Maintenance mode: enable, message, transitions, recovery | **NOT TESTED on device.** Server-side enforcement and the gate are covered by `maintenance-gate.test.ts`; the endpoint was exercised over HTTP. Not driven from the phone. |
| 17 | Announcement creation and publication from the composer, and its dispatch report | **NOT TESTED on device.** Not published from the phone; server side verified (§2C). |
| 18 | Bulk selection with mixed success/failure reporting | **NOT TESTED on device.** Impractical on the isolated stack, which held a single account, so a *mixed* outcome could not be produced honestly. Covered by `admin-bulk.test.ts`. |
| 19 | Ordinary user cannot reach privileged operations | **NOT TESTED on device.** Covered at the API level: anonymous, unrecognised token, ordinary user, no-profile-row and suspended-admin cases are all refused (`admin-routes.test.ts`). |
| 20 | Guest migration consent/read-back/timeout/dismissal/interruption-resume on the phone | **NOT TESTED on device** (§3). |

### 7.3 What went wrong, recorded rather than tidied away

- **One launch reported a lost connection.** A Metro log line read
  `ERROR [timeout] connection terminated with Device for app='com.sanketvaani' on device='V2141 - 14 - API 34' after not responding for 60 seconds`,
  and the cold start that followed showed Guest mode with the admin row missing. The tunnels
  (`adb reverse`) had been lost. Persistence and the offline launch both re-tested clean afterwards,
  so this is recorded as **observed once, dev-harness-related** — not as a pass.
- **The false audit attribution** (§7 row 8) and **the false notification claim** (§7 row 14) are the
  two defects this pass found. The first was fixed and re-verified on the device; **the second was
  fixed after the phone had already been unplugged, so it is unit-verified (10 + 3 tests, 4 mutations
  killed) but NOT device-verified.**
- **Screenshots of a real person's private chat** were on screen when the phone was next picked up.
  Screen driving was stopped at that point deliberately and not resumed.

---

## 8. Separation of isolated local, actual device, and live cloud

| Layer | What it is | Status |
| --- | --- | --- |
| **Isolated local** | Local Supabase stack (`127.0.0.1:54321`) + local backend (`:4000`), migrations applied to a throwaway cluster, reached from the phone via `adb reverse`. | **Exercised.** All §2 API evidence and the local pass of the test suites belong here. |
| **Actual device** | vivo V2141, Android 14, `com.sanketvaani`, JS served by Metro with `.env.local`. | **Exercised, incompletely** — §7. The embedded APK bundle (which points at production) was not what ran. |
| **Live cloud** | Hosted Supabase + deployed backend. | **NOT TESTED. Blocked** (§9) — the hosted database does not yet have the Admin tables, so no Admin read or write can be exercised there. |

No live-cloud result is claimed anywhere in this report. No unit test is reported as a device pass,
and no Metro-served run is reported as an installed-APK run.

---

## 9. Remaining blockers

1. **Hosted migrations are not applied.** `20261012000000_sanket_vaanni_initial.sql`,
   `20261013000000_storage_user_media_policies.sql`, `20261014000000_admin_audit_maintenance.sql`,
   `20261014000001_device_push_tokens.sql`. Applying them requires owner approval and is outside what
   this task may do. **This is the single blocker for all live-cloud Admin verification.**
2. **Storage migration fails with `42501 must be owner of table objects`** when run as the deploying
   role, so that one needs to be applied by an owner-role connection.
3. **No Firebase credentials** in the backend environment. Push delivery therefore stays
   **unavailable** and is reported as unavailable — it is not claimed as delivered, and no
   announcement was ever reported as reaching a device.
4. **No SMTP configuration** in the isolated run. Email health reports `unconfigured`, and password
   reset reports `requested`, never delivered.
5. **The device is an Android 14 / SDK 34 unit**, not Android 16. Android 16 behaviour is untested.
6. **`supabase/config.toml` is 0 bytes**, so the local stack was configured by hand rather than from
   the repo's own local configuration.
7. **The phone is no longer attached** (`adb devices` empty), so nothing in §7 can be re-run or
   extended, including re-verification of the §1.1 fix, until it is plugged back in.
8. **The Metro dev server, the local backend and the Docker Desktop launcher were terminated by the
   harness** under critical memory pressure, with instructions not to restart them unprompted. They
   are not running. This is why the device run could not simply be resumed.
9. **`apps/mobile/.env.local` is still on disk** (gitignored, and documented in `babel.config.js` as
   the deliberate local-testing path). Nothing selects it unless `BABEL_ENV=local` is set. It was left
   in place rather than deleted; the owner may remove it. `apps/mobile/.env` (mtime 2026-10-14 22:16)
   and `apps/backend/.env` were **not** modified by this work.
10. **The installed app's embedded bundle points at production**, so any device testing of local
    behaviour depends on Metro being reachable. A release APK built for testing would not have this
    property.

---

## 10. Exact manual steps required to unblock live-cloud verification

1. **Apply the four migrations to the hosted project**, in filename order, using a connection with the
   owner role (step 2 of §9 needs this specifically). Confirm afterwards that `admin_audit_log`,
   `feature_announcements`, `maintenance_settings` and `device_push_tokens` exist and that the RLS
   policies from those files are present.
2. **Set the backend environment** on the host: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `API_INTERNAL_SECRET`. Every one of these is optional in
   `apps/backend/src/config.ts` and the corresponding service disables itself honestly when absent —
   but the Admin API cannot work without them.
3. **Create the first administrator** with the one-time bootstrap CLI
   (`apps/backend/src/scripts/`, `apps/backend/src/admin/bootstrap.ts`). It writes `actor:
   'operator-cli'` rather than naming an actor who did not act. Do not hardcode an admin account.
4. **Sign in on the phone as that administrator** and confirm the Administration entry appears, then
   re-run §7 rows 5–13 against **hosted** data. That is the step that converts §2's isolated-stack
   passes into live-cloud passes.
5. **For email health to leave `unconfigured`**: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
   `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, then perform a real delivery test. Until that test is run,
   the only honest state is *configuration present but not delivery-tested*.
6. **For push health to leave `unconfigured`**: provide Firebase credentials
   (`GOOGLE_APPLICATION_CREDENTIALS`) and a `google-services.json`-backed app build, then run a genuine
   authorized delivery test to a real device, and grant `POST_NOTIFICATIONS` on that device — it is
   currently `granted=false` on the V2141. Until then push stays unavailable, truthfully.
7. **Re-plug the phone** and re-run the checks in §7 rows 14–20, which are the ones genuinely not yet
   done: the Service tab, a published announcement and its dispatch report, maintenance transitions
   and recovery, a bulk action with a genuinely mixed outcome (needs at least two accounts), refusal
   of privileged operations for an ordinary user, the guest-migration branches, and the §1.1
   notification fix — which is **untested on hardware** and should be treated as such until then.

---

## Background processes stopped

The harness terminated three background processes under critical system memory pressure and asked
that they not be restarted unprompted: the **Docker Desktop launcher**, the **Metro bundler**, and
the **local backend server**. The isolated Supabase stack therefore stopped with Docker. None were
restarted. This is why device testing ends where §7 records and not later.

## Bottom line

The safe local implementation and its automated verification are complete and green: **mobile 713/
713 across 44 suites, backend 166/166, both type-checks clean**, two real honesty defects found and
fixed, four mutations killed on the newer one. **This is not a release-ready conclusion.** Live-cloud
Admin verification is blocked on migrations that only the owner may apply, push and email delivery
remain honestly unavailable without credentials, and device testing is incomplete in the specific
places listed in §7 and §9 — most importantly, the notification fix itself has not been seen working
on a phone.
