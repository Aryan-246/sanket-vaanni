# Requirement-by-requirement matrix — 2026-10-15

Every row below was checked against the **current working tree** (branch
`3d-hand-viewer-integration`, HEAD `32937ac`, Admin-phase changes uncommitted and present).
No row is carried over from an earlier report on trust: where a file and a line are cited, the
file was read in this pass.

---

## 0. How to read this

### 0.1 Status vocabulary

| Status | Means |
|---|---|
| **IMPLEMENTED** | The requirement is met in source, and a test or a read of the artefact confirms it. |
| **PARTIAL** | Part of the requirement is real; the specific missing part is named in the row. |
| **NOT IMPLEMENTED** | No code satisfies it. Not a stub, not a placeholder — absent. |
| **BLOCKED-OWNER** | The code exists and cannot run until the owner performs an action outside this session (applying a migration, holding a key). |
| **STALE CLAIM** | A repository document asserts something the current source contradicts. |

### 0.2 The hardware axis is separate, and that is deliberate

"Verified on physical hardware" is **not** a sixth mutually exclusive status — it is an
independent axis. A requirement can be IMPLEMENTED *and* hardware-verified, or IMPLEMENTED and
never run on a device. Collapsing the two is exactly how a code-complete feature gets reported
as a working one. Each row therefore carries its own **HW** column.

`HW = YES` appears in this entire matrix **once**. `adb devices -l` is empty; the only handset
session on record is `docs/device-verification-2026-10-15.md` (vivo V2141, Android 14), and it
observed the app launching, the Dashboard, the ML centre and an honest backend-failure notice —
**no glove, no sign-in, no Admin console, no TalkBack.**

### 0.3 The two governing directives are not in this repository

The two documents that define the Admin phase — *SANKET VAANNI — MASTER ADMIN SYSTEM + GUEST
MIGRATION COMPLETION* and *SANKET VAANNI — FINAL PRODUCT COMPLETION DIRECTIVE* — **exist only
as references inside `docs/admin-phase-final-report.md`** (lines 22, 30). Their text is not in
the repo.

Consequence: this matrix cannot check the directives line by line. It checks the **two
requirement lists those directives are reported to contain** — the **8 Admin views (PART 11)**
and the **11 Admin capabilities (§2)** — as transcribed in `docs/admin-phase-final-report.md`.
If that transcription is incomplete, this matrix is incomplete in the same way. That is a real
limit, and it is stated rather than papered over.

Separately, the frequently repeated figure **"15 Admin areas" is unsupported** — no source for
it exists in the repository. The real lists are 8 views and 11 capabilities.

---

## 1. Admin views — PART 11 (8 rows)

| # | Requirement | Status | Evidence from current source | HW |
|---|---|---|---|---|
| 1 | Admin overview / dashboard | **IMPLEMENTED** | `AdminScreen.tsx` `OverviewSection`; `src/admin/overviewFigures.ts`; `apps/backend/src/routes/admin.ts:1545` `GET /admin/overview`. Real counts from `profiles`/`announcements`/`admin_audit_log`. An unmeasurable tile is **not drawn**, and the empty state says so in words. | NO |
| 2 | User management / list | **IMPLEMENTED** | `AdminScreen.tsx:438` `PeopleSection`; `GET /admin/users` (`admin.ts:489`). Search, status filter, server-side paging, load-more. | NO |
| 3 | User details and account actions | **IMPLEMENTED** | `AdminScreen.tsx:537`; `POST /admin/users/:id/suspend`, `.../role`. Suspend / restore / role change, each reason-gated and audited. Suspension is reported as **suspension**, never as termination. | NO |
| 4 | Audit history, **with filtering** | **IMPLEMENTED** (was PARTIAL) | `AdminScreen.tsx` `AuditSection`; `GET /admin/audit`; `src/admin/auditFilters.ts`. The gap recorded in `admin-phase-final-report.md:41` — that the backend accepted `action`/`targetType`/`targetId`/`from`/`to` filters but the UI exposed only acted-by plus free text — is **closed**: `auditFilters.ts` builds and clears the full filter set, with `__tests__/admin-audit-filters.test.ts` covering it. | NO |
| 5 | Announcements management, **with delivery status** | **IMPLEMENTED, with a deliberately weak claim** (was PARTIAL) | `AdminScreen.tsx` `AnnouncementsSection`; `POST /admin/announcements[/:id]`, `.../:id/dispatch`; `src/admin/lastDispatch.ts`. The gap at `admin-phase-final-report.md:42` is **closed**: the section now reads the durable `dispatch_announcement` audit rows through the endpoint it already calls and renders a per-notice badge. The badge is **weaker than the live one on purpose** — a `complete` dispatch that reached zero registered devices is audited `succeeded`, so `succeeded` is rendered as `Recorded: not confirmed`, never "Sent". A notice with no dispatch row shows `No recent attempt`; if the log cannot be read the UI says `History unread` rather than implying none occurred. | NO |
| 6 | Maintenance mode / settings | **IMPLEMENTED** | `AdminScreen.tsx` `ServiceSection`; `POST /admin/maintenance`; `apps/backend/src/maintenance/gate.ts` as a root `onRequest` hook. `/`, `/health`, `/email/status`, `/notifications/status` and all `/admin*` are exempt. "Who last changed it" is re-read, not assumed. `expectedEndAt` is stored but **not enforced**, and no scheduler exists — see `final-report.md`. | NO |
| 7 | Notification / configuration health | **IMPLEMENTED, mostly "untested"** | `GET /admin/health` (`admin.ts:1703`); `AdminScreen.tsx:1756`. Every check reports one of `unconfigured` / `untested` / `verified` / `failed`. `deliveryTested` is hard-coded `false` — the code will not let SMTP acceptance or an FCM `messageId` be shown as delivery. | NO |
| 8 | Role / provisioning instructions | **IMPLEMENTED (documentation by decision)** | `docs/admin-bootstrap.md`; `apps/backend/src/scripts/`; `docs/admin-system.md`. Deliberately not a console screen: a button that provisions an administrator is a backdoor. It is an out-of-band script promoting an **existing** Supabase Auth identity, and `src/admin/bootstrap.ts:18-32` refuses to act while any active administrator exists. | NO |

---

## 2. Admin capabilities — §2 (11 rows)

| # | Requirement | Status | Evidence / named gap | HW |
|---|---|---|---|---|
| 1 | Admin overview with real statistics and recent activity | **IMPLEMENTED** | `overviewFigures.ts`, `GET /admin/overview`. | NO |
| 2 | User management: search, filters, pagination, details | **IMPLEMENTED** | `admin.ts:489-632`. | NO |
| 3 | Individual and bulk actions with accurate partial-success results | **IMPLEMENTED** | `POST /admin/users/bulk` returns per-target outcomes; `src/admin/bulkEntry.ts` reports partial success **as partial**, and a partial failure is **not** rolled back. `MAX_BULK_TARGETS = 50` (`admin.ts:83`). | NO |
| 4 | Suspension, reactivation, **truthful termination semantics** | **PARTIAL — by design, and correctly refused** | Suspend/reactivate are real. Termination **does not exist in the schema**: `profiles.status` is `CHECK ('active','suspended')` (`supabase/migrations/20261014000000_admin_audit_maintenance.sql:162`) and there is no delete route. So termination is neither offered nor claimed — which is the right behaviour and still an unmet requirement. Also recorded as D3. | NO |
| 5 | Auditing of privileged actions | **IMPLEMENTED** | `apps/backend/src/audit/trail.ts`. The actor comes from `auth.getUser`'s subject, never from the client, and a request row is written **before** the mutation, so an unrecorded consequential change requires breaking the helper. `test/admin-audit.test.ts`. | NO |
| 6 | Announcement drafts, publish/unpublish, expiry, targeting, user-side retrieval | **IMPLEMENTED except targeting** | Draft/publish/withdraw/expiry/severity and user-side retrieval + dismiss-all work; `src/announcements/` (backend) and `reader.ts` (mobile, read through RLS rather than the admin API). **Targeting is not implemented**: announcements are global; there is no audience/segment selector in the schema or the route. | NO |
| 7 | Notification / configuration health | **IMPLEMENTED, mostly "untested"** | As view 7 above. | NO |
| 8 | Global maintenance state and enforcement | **IMPLEMENTED, with a stated limit** | `src/maintenance/controller.ts` (fail-safe cached state; `parseSetting` rejects coercion at `:79-90`), server gate `maintenance/gate.ts`. **Honest limit:** it does not gate hosted Supabase Auth, so a user already signed in is not ejected. | NO |
| 9 | Admin bootstrap / recovery | **BLOCKED-OWNER** | Implemented and tested (`admin/bootstrap.ts`, `scripts/bootstrapAdmin.ts`, `test/admin-bootstrap.test.ts`). Cannot run until migrations 3 and 4 are applied remotely. | NO |
| 10 | Role / security test matrix | **IMPLEMENTED** | `apps/backend/test/{admin-routes,admin-audit,admin-bootstrap,maintenance-gate}.test.ts`; `apps/mobile/__tests__/admin-*.test.ts`. Covers the 503/401/401/403/403 authorisation ladder in `middleware/requireAdmin.ts` and the bulk partial-outcome path. | NO |
| 11 | All missing navigation and interaction states | **IMPLEMENTED** | Every section has loading / success / empty / failure / retry; no inert buttons. `src/admin/failureState.ts` centralises the failure rendering. Cross-checked in `mobile-screen-and-navigation-review.md`. | NO |

**Authorisation ladder, verified by reading the real order** (`middleware/requireAdmin.ts`):
503 unconfigured (`:203-206`) → 401 missing token (`:208-212`) → 401 `auth.getUser` invalid
(`:214-218`) → 403 non-admin (`:230-237`) → 403 suspended (`:239-243`) → sets
`request.adminActor` (`:245-246`). All **15** `/admin` routes sit behind one
`app.addHook('preHandler', requireAdmin)` at `routes/admin.ts:472`.

---

## 3. `docs/admin-system.md` — claims against source

| Claim | Document says | Source says | Verdict |
|---|---|---|---|
| Endpoint count | "Twelve endpoints" | **15** `/admin/*` routes | **STALE CLAIM** |
| Write count | "seven writes" | **eight** | **STALE CLAIM** |
| Overview view | "Not built" | Built: `OverviewSection`, `overviewFigures.ts`, `GET /admin/overview` | **STALE CLAIM** |
| Health view | "Not built" | Built: `GET /admin/health`, `AdminScreen.tsx:1756` | **STALE CLAIM** |
| Push dispatch | "Not built" | Built: `apps/backend/src/announcements/dispatch.ts`, `admin.ts` `/admin/announcements/:id/dispatch`, `services/firebase.ts:105` | **STALE CLAIM** |
| Bulk limit | — | `MAX_BULK_TARGETS = 50`, `admin.ts:83` | consistent |
| Bootstrap | out-of-band script, refuses while an admin exists | matches `admin/bootstrap.ts:18-32` | consistent |

---

## 4. Roadmap milestones — `docs/roadmap.md`

| Milestone / requirement | Status | Evidence / named gap | HW |
|---|---|---|---|
| **M2 exit** — live flex/IMU from a physically connected glove; a recorded fixture replays offline (`roadmap.md:26-28`) | **NOT IMPLEMENTED** | `src/ble/bleTransport.ts:24-26,42,55-57`: `BleTransport.scan`/`connect` throw `ProtocolUnverifiedError`, status `unavailable`. Only `MockTransport` produces frames, and they are labelled synthetic (`__tests__/transport.test.ts:14-19`). No recorded capture fixture exists. `firmware/left-glove/README.md:5-8` and `right-glove` are empty of code. | NO |
| **M3** calibration & signal processing; repeatable normalised values | **PARTIAL** | Mechanism exists and is tested: `src/sensors/calibration.ts:100-129` normalise/apply, `src/sensors/processing.ts:26-76` EMA + pipeline, persisted `src/storage/index.ts:116-125`. **Missing: the capture flow.** `calibration.ts:9-13` states the guided rest/flex poses "arrives in milestone M3" and it is not built. IMU bias/scale explicitly "not implemented" (`calibration.ts:124-127`). | NO |
| **M4** vocabulary with a Deaf-led reviewer; honest per-sign accuracy on held-out signers | **PARTIAL** | Honest-measurement machinery is real: `src/ml/metrics.ts:49-115` (per-class P/R/F1 as `number | null`), `src/ml/split.ts` (session-grouped), `src/ml/modelStore.ts` activation gate. **But there is no vocabulary** — every profile is `planned` with `vocabularySize: 0` and `vocabulary: []` (`src/recognition/profiles.ts:66-94`); `UnimplementedRecogniser.recognise()` always returns `null` (`recognition/index.ts:69-81`). Labels are user-typed strings, not a Deaf-led vocabulary. **No accuracy figure is published — correctly**: `metrics.ts:189-194` returns "Not measured". | NO |
| **M5** text composition & speech; offline TTS; fingerspelling fallback | **PARTIAL** | Offline platform TTS **is** implemented: `speech/index.ts:60-72` `UnavailableSpeaker`, `DeviceSpeaker` (`speech/index.ts:82`, `speech/nativeSpeaker.ts`), state machine `speech/controller.ts:121-176`, manifest `<queries>` for TTS (`AndroidManifest.xml:43-45`). **Missing: text composition/grammar** — `translation/index.ts:45-52` `UnimplementedTranslator.translate()` returns `null` and constructs no sentence. **Fingerspelling fallback: no code** — repo-wide grep for "fingerspell" is empty. | NO |
| **M6** on-device history; introduce the database (planned SQLite) | **PARTIAL** | AsyncStorage + history store exist: `storage/index.ts:107-180`, `HISTORY_LIMIT:67-68`; `HistoryScreen.tsx` renders an honest empty state. **Missing: the planned SQLite database was never introduced** — storage is `@react-native-async-storage/async-storage`, no sqlite dependency. No recognised phrases exist to store. | NO |
| **M7** backend persistence, model/vocabulary distribution, optional sync, telemetry **with explicit consent**, auth | **BLOCKED-OWNER** | Implemented: opt-in sync `src/supabase/sync.ts` (uploads gated by `uploadLocalData`, `:11-28,465-467`), auth `src/supabase/auth.ts:51-124`, model distribution `src/ml/modelPackage.ts`, migrations present. **Missing: telemetry — no telemetry code exists at all.** **BLOCKED:** migrations 3 and 4 unapplied, so sync cannot authenticate against the hosted project; observed on the device run. | NO |
| **M8** `apps/web` Next.js dashboard | **NOT IMPLEMENTED** | `apps/web/` holds only `README.md` and `.env.example`; `apps/web/README.md:1-24` says it is a reserved placeholder — "Do not scaffold Next.js here until M8". No `package.json`. | NO |
| Cross-cutting: accessibility reviewed every milestone | **PARTIAL** | `MIN_TOUCH_TARGET = 48` (`theme/index.ts:100`) applied to buttons/rows/selectors; dynamic-type guard test `__tests__/design-system.test.tsx:230-292`; reduced motion honoured (`RootNavigator.tsx:122-139`, `hooks/useReduceMotion.ts`); labels/roles across ~39 components. **Missing:** the TalkBack pass was never run, and no per-milestone accessibility review is recorded. | NO |
| Cross-cutting: battery & thermal budget tracked once continuous BLE streaming exists | **NOT IMPLEMENTED** | No battery/thermal tracking code. The precondition (continuous BLE) does not exist either. | NO |
| Cross-cutting: privacy review before any data leaves the device | **NOT IMPLEMENTED** | No privacy-review artefact anywhere in `docs/`; "privacy" appears only in `roadmap.md`. Uploads are opt-in and storage is local-first, but **no review was recorded**. | NO |

---

## 5. `docs/task-f-final-report.md` — the four §6 guest-migration results

| Requirement | Status | Evidence | HW |
|---|---|---|---|
| **1.5** Independent read-back verification | **IMPLEMENTED** | `src/supabase/readBack.ts:65-341` — `canonical()`, four verifiers `verifyPreferences/verifyCalibration/verifyOledProfiles/verifyHistory` (`:178,210,243,304`), fails closed, detects foreign rows. Wired at `sync.ts:418-435,690-696`. 24 `it` blocks in `__tests__/guest-migration-readback.test.ts`. | NO |
| **1.6** Bounded, cancellable requests | **IMPLEMENTED** | `SYNC_REQUEST_TIMEOUT_MS = 20_000` (`sync.ts:76`); `request()` uses an `AbortController` carried into postgrest via `.abortSignal(s)` (`sync.ts:367-404`); distinct `SyncTimeoutError` (`:85`) vs `SyncCancelledError` (`:107`). 12 `it` blocks in `__tests__/guest-migration-interruption.test.ts`. | NO |
| **1.7** OLED key consistency | **IMPLEMENTED** | One key literal: `storage/index.ts:48` `oledProfiles: 'sv/v1/oled-profiles'`, exposed as `featureKeys.oledProfiles:257-261`; sync reads/writes it by name (`sync.ts:809-814,917`). | NO |
| **1.8** Regression tests that fail when the guard is removed | **PARTIAL** | The guard tests exist. **The falsification procedure itself is not reproducible from the tree** — it was a one-off manual process (guard removed, suite re-run, restore hash-verified) and nothing in the repository records or automates it. This audit reproduced it once for the new `lastDispatch` guard and recorded the result in `tests-static-checks-and-apk.md` §4. | NO |

---

## 6. `docs/task-f-final-report.md` — appendix requirements 1.1–14

| Requirement | Status | Evidence / named gap | HW |
|---|---|---|---|
| 1.1 Strict migration consent scope | **IMPLEMENTED** | `guestMigration.ts:141-172` discards a record naming an unknown scope; `isMigratableScope` validated against the implemented list (`sync.ts:143-147`); unknown scopes dropped before upload (`sync.ts:465-467`). | NO |
| 1.2 Failure accounting | **IMPLEMENTED** | `describeStepFailures` reports N of the consented steps, de-duped reasons, no fake ratio (`sync.ts:237-253,599-614`). | NO |
| 1.3 No late async UI resurrection | **IMPLEMENTED** | Supersede guard + cancelled-restore (`sync.ts:283-331,564-597`); screen-level `attemptRef`/`cancelled` guard (`AccountSheet.tsx:173-183,212-228`). | NO |
| 1.4 Recovery without masking the original error | **IMPLEMENTED** | `readBack.ts:355-372` `describeReadBackFailure` preserves SQLSTATE and message; re-raised at `sync.ts:428-431`. | NO |
| 1.5 / 1.6 / 1.7 | **IMPLEMENTED** | See §5 above. | NO |
| 1.8 | **PARTIAL** | See §5 above. | NO |
| 2–4. One identity system, one server-side permission model, no duplicate login | **BLOCKED-OWNER** | Single Supabase auth path (`src/supabase/auth.ts:51-124`); server-side role/status re-read in `middleware/requireAdmin.ts`; RLS plus the privileged-column trigger in `20261014000000_admin_audit_maintenance.sql`. **Cannot run until the owner applies the migrations.** | NO |
| 3. Secure one-time admin bootstrap | **IMPLEMENTED** | `apps/backend/src/admin/bootstrap.ts:18-32` — "No invented account", refuses while any active administrator exists; CLI `scripts/bootstrapAdmin.ts`; `test/admin-bootstrap.test.ts`. | NO |
| 4. Least privilege | **BLOCKED-OWNER** | Grant/RLS matrix in `20261014000000_admin_audit_maintenance.sql` and `20261014000001_device_push_tokens.sql`; the trigger on `profiles` fails closed. Not applied remotely. See `supabase-grants-and-rls-review.md`. | NO |
| 5. User management | **PARTIAL** | List with search/status/paging (`admin.ts:489-632`), suspend/reactivate, bulk 1–50 (`admin.ts:294-303`), role change, audit pair. **Termination is absent and not buildable as specified** — see capability 4. Matches D3. | NO |
| 6. Audit logging with a verified actor, never trusting the client | **IMPLEMENTED** | `apps/backend/src/audit/trail.ts`; actor from `auth.getUser` subject (`requireAdmin.ts`); append-only grants in migration 3; `test/admin-audit.test.ts`. | NO |
| 7. Announcements | **IMPLEMENTED except targeting and pagination**; the report's push claim is **STALE** | The report says push dispatch is "not implemented" (`:271-273`, `:358`) — **false now**: `announcements/dispatch.ts`, `/admin/announcements/:id/dispatch`, `services/firebase.ts:105`, `src/admin/dispatchReport.ts`, migration #4 `device_push_tokens`. Still true: the `/admin/announcements` list is **unpaginated** (`admin.ts:636-647`), and delivery is never claimed (`dispatchReport.ts` refuses `deliveryConfirmed !== false`). | NO |
| 8. Maintenance mode, server-side, with exemptions | **IMPLEMENTED** | `src/maintenance/controller.ts` (fail-safe cached state; `parseSetting` rejects coercion `:79-90`); gate `apps/backend/src/maintenance/gate.ts`. Honest limit: hosted Auth is not gated (D4). | NO |
| 9–10. Guest-first, no service-role in the app, audit-first | **IMPLEMENTED** | No service-role key in mobile; the admin client sends no `actorId` (`src/admin/client.ts`); announcements are read via RLS policy, not the admin API (`announcements/reader.ts:1-30`). | NO |
| 11. Premium accessible Admin UI, eight views | **IMPLEMENTED in source**; the report's view claim is **STALE** | The report says views 1 and 7 are absent (`:283-285`, `:361`) — **false now**: `AdminScreen.tsx:131-138` has six sections including `overview` and `service`; "Configuration health" exists at `:2247-2280`. Accessibility labels are present; **no assistive technology has been run**, so "accessible" is a source claim, not a verified one. | NO |
| 12. Role/security test matrix on isolated local infrastructure | **PARTIAL** | Backend role/gate/bulk matrices exist. **No isolated end-to-end environment and no device run** of the admin flow (`task-f-final-report.md:237-259`). | NO |
| 13. Contract → types → backend → frontend → tests → docs | **PARTIAL — the contract leg is unwired** | `packages/contracts/src/index.ts:1-6` states the package is "types-only and is NOT yet imported by any application". No contract test exists. Everything downstream is implemented. | NO |
| 14. Documentation and handover | **IMPLEMENTED** | `docs/admin-system.md`, `docs/admin-migration-checklist.md`, `docs/task-f-final-report.md` present (three of them partly stale — see §3). | NO |
| **Deployed and live** | **BLOCKED-OWNER** | Four migrations unapplied; the owner must run the migration and create the first admin. The device run confirmed the tables are missing. | NO |

---

## 7. `docs/testing-strategy.md` — every rule

| Requirement | Status | Evidence / named gap | HW |
|---|---|---|---|
| Unit — pure logic incl. frame decoding from a **recorded fixture** | **PARTIAL** | Unit tests exist (`__tests__/sensors.test.ts`, `ml-pipeline.test.ts`). **Missing: decoding from a recorded fixture** — no recorded byte fixture exists anywhere; the only fixtures are formula-generated (`__tests__/mlFixtures.ts:1-20`). | NO |
| Contract — shapes match `packages/contracts` | **NOT IMPLEMENTED** | `packages/contracts/src/index.ts:4-6`: "NOT yet imported by any application"; no test references it. | NO |
| Integration (backend) | **IMPLEMENTED** | `apps/backend/test/{admin-routes,admin-audit,admin-bootstrap,maintenance-gate,config,health}.test.ts`. | NO |
| Integration (mobile) — mock transport drives the UI | **IMPLEMENTED** | `__tests__/{launch-flow,device-state,honesty,transport}.test.tsx`. | NO |
| Hardware-in-the-loop | **NOT IMPLEMENTED** | No glove; no HIL test. | NO |
| Fixture rule — recognition/calibration/transport testable from recorded byte fixtures | **NOT IMPLEMENTED** | No recorded capture fixture; M2 was never reached. | NO |
| Fixture rule — synthetic frames never presented as real captures; labelled generated | **IMPLEMENTED** | `__tests__/mlFixtures.ts:1-20` — "generated by a formula… not a recording of anybody signing"; a test result is required to say so (`ml-pipeline.test.ts:4-9`). | NO |
| Demo Mode vs real — test names make synthetic obvious | **IMPLEMENTED** | `transport.test.ts:1-6,14-19`; the `MOCK_DEVICE_NAME` sentinel is never shown (`honesty.test.tsx:567`). | NO |
| Honest metrics — any figure must state vocabulary size, profile, signers, held-out vs train | **PARTIAL** | Machinery is honest (`metrics.ts`; `describeAccuracy:189-194`; no threshold presented as validated — `recognition/outcome.ts:44-49`, `ml/inference.ts:18-27`). **There is no figure to report** — no vocabulary, no model. | NO |
| Honest metrics — "no accuracy figure exists yet; code must treat any figure as absent, not estimate" | **IMPLEMENTED** | Code refuses to invent: `recognition/index.ts:58-81`, `profiles.ts:12-17`, `metrics.ts:130-133,189-194`, `modelStore.ts` activation gate (tested at `ml-pipeline.test.ts:561-619`); `honesty.test.tsx:489-501` asserts no percentage appears anywhere. | **YES** — `device-verification-2026-10-15.md:139-146` observed on the real handset: "0 confirmed windows… nothing to fit", training disabled, no invented accuracy |
| A11y — TalkBack pass on every primary flow | **NOT IMPLEMENTED** | Never run: `task-f-final-report.md:255`; the device session did not run it (`device-verification-2026-10-15.md:158`). Labels exist in source only. | NO |
| A11y — contrast checks | **PARTIAL** | Ratios measured and documented in `src/theme/palette.ts:27-34` (dark ~18:1, light ~17:1; `textMuted` deliberately below AA). **No automated contrast test** and no recorded manual check. | NO |
| A11y — dynamic-type checks | **IMPLEMENTED** | `__tests__/design-system.test.tsx:230-292` walks every `Text` on every tab at 1.4× scaling and fails fixed-width columns. | NO |
| A11y — reduced motion honoured (intro + animations) | **PARTIAL** | Honoured in code: `RootNavigator.tsx:122-139` (intro skipped when `isReduceMotionEnabled`), `hooks/useReduceMotion.ts`, `Orb.tsx:152-206`, `SpeechOutputWaveform.tsx:74-207`. **Missing: a test asserting the honoured behaviour** — the only test touching it checks that a Settings label exists (`more-screen.test.tsx:108`). | NO |
| A11y — touch targets ≥ 48 dp | **PARTIAL** | Implemented: `MIN_TOUCH_TARGET = 48` (`theme/index.ts:100`) used by `ActionButton.tsx:111`, `ListRow.tsx:125`, `LanguageSelector.tsx:151`, `TextField.tsx:81`, `CollapsibleSection.tsx:101`, `FingerReadings.tsx:217`, plus `hitSlop` in `Avatar.tsx:153`, `IconButton.tsx:26-29`. **Missing: no test asserts the 48 dp floor.** Four controls are *under* 44 dp visually and rely entirely on `hitSlop`: `IconButton` 36 dp (+8 = 52), `Sheet` close 32 dp (+12 = 56), `HandViewer` preset chip 40 dp (+8 = 56), `Toggle` track 28 dp (+12 = 52). Each is sufficient today, and none is guarded by a test — a future edit can silently remove the `hitSlop`. | NO |
| A11y — manual, per milestone, recorded in the milestone report | **NOT IMPLEMENTED** | No milestone document contains a manual accessibility pass; `task-f-final-report.md:255-257` records the a11y items as NOT TESTED. | NO |

---

## 8. `docs/glove-input-layer.md` §3 — permissions vs the real manifest

None of the §3 permissions exists. This matches the document's own admission that they are
"deliberately **not** declared yet" (`:97-100`) — an **honest gap, not a stale claim**. The
manifest declares only `INTERNET` (`:3`), `RECORD_AUDIO` (`:13`), `POST_NOTIFICATIONS` (`:29`)
plus the speech/TTS `<queries>` (`:39-46`), independently confirmed by `aapt2 dump badging` on
the shipped release APK.

| Requirement | Status | Evidence | HW |
|---|---|---|---|
| `BLUETOOTH_SCAN` (API 31+) | **NOT IMPLEMENTED** | Absent from `AndroidManifest.xml:1-77`. | NO |
| `BLUETOOTH_CONNECT` (API 31+) | **NOT IMPLEMENTED** | Absent. | NO |
| `BLUETOOTH`, `BLUETOOTH_ADMIN` `maxSdkVersion="30"` | **NOT IMPLEMENTED** | Absent. | NO |
| `ACCESS_FINE_LOCATION` `maxSdkVersion="30"` | **NOT IMPLEMENTED** | Absent. | NO |
| `uses-feature android.hardware.bluetooth_le required="false"` | **NOT IMPLEMENTED** | No `<uses-feature>` element at all. | NO |
| §6 unblock order: (1) firmware protocol, (2) recorded frame capture, (3) BLE library decision, (4) permissions added + reviewed | **NOT IMPLEMENTED (all four)** | (1) `firmware/*/README.md` empty; the protocol is still `ble-protocol.md:1-17` "PROPOSED, NOT YET VERIFIED". (2) No capture fixture. (3) No BLE dependency in `apps/mobile/package.json`. (4) Permissions absent. The app's own half is complete and inert: `bleTransport.ts:8-15`, `link.ts`, `controller.ts`. | NO |

**Physical glove integration: BLOCKED.** See `ble-and-firmware-verification.md` for the four
independent probes. No UUID, packet format, sample rate, sensor value, label, model metric or
live prediction is asserted anywhere in this audit, because none can be observed.

---

## 9. Tally

Counting only the **8 Admin views + 11 Admin capabilities** — the two lists the directives
actually are reported to contain — and treating the audit-filter and announcement-delivery
closures of this pass as done:

| Status | Views | Capabilities |
|---|---|---|
| IMPLEMENTED | 8 | 9 |
| PARTIAL | 0 | 2 *(termination semantics; announcement targeting)* |
| NOT IMPLEMENTED | 0 | 0 |
| BLOCKED-OWNER | 0 | 0 (bootstrap is implemented; running it is blocked) |

**The Admin phase is code-complete against both lists, with two named PARTIALs that are refused
by design rather than left unbuilt** — termination, which the schema cannot express, and
targeting, which does not exist. Neither is offered in the UI, so neither is falsely claimed.

Everything outside those two lists is where the real absence is: M2/M8, hardware-in-the-loop,
recorded fixtures, the contract leg, telemetry, privacy review, TalkBack, and the remote
deployment. Those are enumerated in `final-report.md`.

---

## 10. Stale-claim register

Four documents assert things the current source contradicts. Each is a live risk, because a
reader has no way to tell a stale doc from a current one.

1. **`docs/task-f-final-report.md:271-273, :358`** — "announcement push dispatch absent", "no
   delivery channel exists". A full dispatch path exists. What is still true: delivery is never
   claimed, and the announcements list is unpaginated.
2. **`docs/task-f-final-report.md:283-285, :361`** — "views 1 and 7 absent". Both exist.
3. **`docs/admin-system.md`** — "Twelve endpoints" (15), "seven writes" (eight), and "Not built"
   rows for overview, health and push dispatch (all built).
4. **`apps/mobile/src/audit/findings.ts:637-641`** — the Audit screen tells the user *"no screen
   calls it, so nothing is sent anywhere today"*. Supabase sync, auth and the admin client now
   send data. This one is the most serious of the four: it is not a stale doc but a **stale
   on-screen statement that understates what leaves the device**, which is the exact opposite of
   the project's stated honesty rule. It is flagged for a fix rather than fixed here, because
   `src/audit/` is another workstream's surface.

Also stale, but lower risk: **`apps/mobile/src/ml/README.md:10-12`** claims the app "ships an
`UnimplementedRecogniser` whose `recognise()` always returns null" (still literally true) and
that there are "deliberately no metrics" (stale — `src/ml/metrics.ts` is a working honest-metrics
implementation).
