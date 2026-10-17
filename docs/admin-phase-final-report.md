# Admin Phase — Final Report

**Date:** 2026-10-15
**Branch:** `3d-hand-viewer-integration` (HEAD `32937ac`, unchanged)
**Working tree:** 77 changed/untracked paths carried in from before this phase, plus this
report itself (78 total). **Nothing committed, nothing pushed, nothing deployed**

> This is a **new** file. It replaces no earlier report. `docs/task-f-final-report.md`,
> `docs/task-f-final-verification-report.md`, `docs/admin-system.md`,
> `docs/admin-migration-checklist.md`, `docs/implementation-audit.md`,
> `docs/integration-status-2026-10-15.md`, `docs/apk-verification-2026-10-15.md`,
> `docs/device-verification-2026-10-15.md` and every file owned by the parallel
> workstream are left exactly as they were.

---

## 0. A note on the "15 Admin areas" figure

The directive asks for "all 15 numbered Admin areas". **No source directive enumerates
fifteen.** The two enumerations that actually exist in the owner's instructions are:

- **8 Admin views** — §PART 11 of *SANKET VAANNI — MASTER ADMIN SYSTEM + GUEST MIGRATION COMPLETION*.
- **11 Admin capability bullets** — §2 of *SANKET VAANNI — FINAL PRODUCT COMPLETION DIRECTIVE*.

This report maps against **both** real lists. Inventing a fifteenth area to match an
unverified count would be exactly the fabrication the directive forbids, so the
discrepancy is recorded rather than papered over. (The earlier internal task title
"complete all 15 sections" was mine, not the owner's, and is corrected here.)

---

## 1. Each required Admin area and its status

### 1a. Against the eight Admin views (PART 11)

| # | Required view | Status | Where it lives | Why that status |
|---|---|---|---|---|
| 1 | Admin overview / dashboard | **COMPLETE (not live-verified)** | `apps/mobile/src/screens/AdminScreen.tsx` (`OverviewSection`), `apps/mobile/src/admin/overviewFigures.ts`, `apps/backend/src/routes/admin.ts:1545` `GET /admin/overview` | Real counts from `profiles`/`announcements`/`admin_audit_log`. A tile that cannot be measured is **not drawn**; the empty state says so in words. Needs the hosted DB to be granted before numbers appear. |
| 2 | User management / list | **COMPLETE (not live-verified)** | `AdminScreen.tsx:438` (`PeopleSection`), `GET /admin/users` (`admin.ts:489`) | Search, status filter, server-side paging, load-more. |
| 3 | User details and account actions | **COMPLETE (not live-verified)** | `AdminScreen.tsx:537`, `POST /admin/users/:id/suspend`, `.../role` | Suspend / restore / role change, each reason-gated and audited. Suspension is reported as **suspension**, never as termination. |
| 4 | Audit history | **PARTIAL** | `AdminScreen.tsx:980` (`AuditSection`), `GET /admin/audit`, `apps/backend/src/audit/`, `apps/mobile/src/admin/auditEntry.ts` | Actor, action, target, outcome, reason, correlation id all present and joined by `requestId`. **Gap:** the backend accepts `action` / `targetType` / `targetId` / `from` / `to` filters but the UI only exposes **acted-by** plus the free-text search. |
| 5 | Announcements management | **PARTIAL** | `AdminScreen.tsx:1200` (`AnnouncementsSection`), `POST /admin/announcements[/:id]`, `.../:id/dispatch` | Draft / publish / withdraw / expiry / severity / user-side retrieval / dismiss all work. **Gap:** dispatch exists server-side but *delivery* is unproven (§6 below) and nothing in the UI may claim otherwise. |
| 6 | Maintenance mode / settings | **COMPLETE (not live-verified)** | `AdminScreen.tsx` (`ServiceSection`), `POST /admin/maintenance`, `app.ts:74` request gate | Server-side gate is the real enforcement; `/`, `/health`, `/email/status`, `/notifications/status` and `/admin/*` are exempt. "Who last changed it" is re-read, not assumed. |
| 7 | Notification / configuration health | **COMPLETE, but honestly mostly "untested"** | `GET /admin/health` (`admin.ts:1703`), `apps/mobile/src/screens/AdminScreen.tsx:1756` | Every check reports one of `unconfigured` / `untested` / `verified` / `failed`. `deliveryTested` is **hard-coded `false`** — the code will not let SMTP acceptance or an FCM `messageId` be shown as delivery. |
| 8 | Role / provisioning instructions | **COMPLETE (as documentation by decision)** | `docs/admin-bootstrap.md`, `apps/backend/src/scripts/`, `docs/admin-system.md` | Deliberately *not* a console screen: a button that provisions an administrator is a backdoor. It is an out-of-band script that promotes an **existing** Supabase Auth identity. |

### 1b. Against the eleven Admin capabilities (§2)

| # | Capability | Status |
|---|---|---|
| 1 | Admin overview with real statistics and recent activity | **COMPLETE (not live-verified)** |
| 2 | User management: search, filters, pagination, details | **COMPLETE (not live-verified)** |
| 3 | Individual and bulk actions with accurate partial-success results | **COMPLETE (not live-verified)** — `POST /admin/users/bulk` returns per-target outcomes; the UI reports partial success as partial |
| 4 | Suspension, reactivation, truthful termination semantics | **PARTIAL** — suspend/reactivate are real. **Termination does not exist in the schema**, so it is not offered and never claimed (§8, D3) |
| 5 | Auditing of privileged actions | **COMPLETE (not live-verified)** — an action writes a request row *before* the mutation, so an unrecorded consequential change requires breaking the helper |
| 6 | Announcement drafts, publish/unpublish, expiry, targeting, user-side retrieval | **PARTIAL** — as view 5 above |
| 7 | Notification / configuration health | **COMPLETE, mostly "untested"** — as view 7 above |
| 8 | Global maintenance state and enforcement | **COMPLETE (not live-verified)** for this service; **honest limit**: it does not gate hosted Supabase Auth |
| 9 | Admin bootstrap / recovery | **COMPLETE (code + tests); live verification BLOCKED** — needs migrations 3/4 applied |
| 10 | Role / security test matrix | **COMPLETE** — `apps/backend/test/admin-routes.test.ts`, `admin-audit.test.ts`, `admin-bootstrap.test.ts`, `maintenance-gate.test.ts`, `apps/mobile/__tests__/admin-*.test.ts` |
| 11 | All missing navigation and interaction states | **COMPLETE** — every section has loading / success / empty / failure / retry; no inert buttons |

**Cross-cutting, and required by both lists:** every consequential action runs the full
chain `UI → typed client → authenticated API → server-side authorization → validation →
DB → audit → UI refresh`, and the authorization is server-side only. `requireAdmin`
(`routes/admin.ts:472`, applied as a `preHandler` hook to all fifteen `/admin` routes)
re-reads `profiles.role`/`status` with the service-role client on **every** request. No
route accepts an actor id from the client, so editing client state cannot grant Admin.

---

## 2. Key files and backend / database changes

### Admin authorisation and backend (new or modified)

| File | Role |
|---|---|
| `apps/backend/src/routes/admin.ts` | All **15** `/admin` routes behind one `requireAdmin` hook: `/admin/users`, `/admin/users/:id`, `/admin/users/:id/suspend`, `/admin/users/:id/role`, `/admin/users/:id/reset-password`, `/admin/users/bulk`, `/admin/audit`, `/admin/announcements`, `/admin/announcements/:id`, `/admin/announcements/:id/dispatch`, `/admin/maintenance`, `/admin/overview`, `/admin/health` |
| `apps/backend/src/middleware/requireAdmin.ts` | **Owned by the parallel workstream — not edited by me.** Validates the bearer token, re-reads role/status, sets `request.adminActor` |
| `apps/backend/src/admin/`, `announcements/`, `audit/`, `maintenance/`, `scripts/` | New modules: bootstrap, announcement dispatch, audit pair writer, maintenance gate, one-time provisioning script |
| `apps/backend/src/app.ts` | Root maintenance gate (`onRequest`), route registration |
| `apps/backend/src/routes/notifications.ts`, `email.ts`, `health.ts` | Status endpoints with the honest state ladder |

### Mobile

| File | Role |
|---|---|
| `apps/mobile/src/screens/AdminScreen.tsx` | The console: Overview, People, Audit, Notices, Learning, Service |
| `apps/mobile/src/admin/overviewFigures.ts` | Pure parsing of the overview payload; refuses to invent a figure |
| `apps/mobile/src/admin/auditEntry.ts` | Joins the two audit rows into one human action |
| `apps/mobile/src/admin/client.ts` | Typed Admin API client; fails closed when `API_BASE_URL` is unset |

### Machine-learning lifecycle (the Addendum)

| File | Role |
|---|---|
| `apps/mobile/src/ml/modelPackage.ts` | **NEW.** Versioned model package: compatibility contract, `vocabularyFingerprint`, `packageIntegrity`, `deriveHandConfiguration`, `assessCompatibility`, `verifyModelPackage` |
| `apps/mobile/src/ml/store.ts` | `exportModel` / `importModel`; imports always land as `candidate` and are never auto-activated |
| `apps/mobile/src/ml/types.ts` | `ModelImport` provenance on `ModelRecord` |
| `apps/mobile/src/ml/capture.ts` | **Defect fixed:** `ownerId` was hard-coded `null`; now read from the account at save time |
| `apps/mobile/src/ml/centre.ts` | Wires the account through to both the store and the capturer |
| `apps/mobile/src/ml/dataset.ts` | The single FNV-1a implementation, exported and reused by all three digests |
| `apps/mobile/src/screens/ml/TransferSection.tsx` | "Versions on other phones" export/import UI, with the no-catalogue statement |
| `apps/mobile/src/ble/bleTransport.ts` | **Unchanged and still a stub that throws.** No UUID was invented |

### Database

Four migrations exist under `supabase/migrations/`, **none applied to the hosted project**:

1. `20261012000000_sanket_vaanni_initial.sql` — base schema + account-creation trigger
2. `20261013000000_storage_user_media_policies.sql` — `user-media` bucket policies
3. `20261014000000_admin_audit_maintenance.sql` — `role`/`status`/`avatar_url`, `admin_audit_log`, `app_settings`, `announcements`, the privileged-column trigger, RLS + grants
4. `20261014000001_device_push_tokens.sql` — `device_push_tokens` (depends on #3)

---

## 3. Test results and commands

Run against the **final working tree**, no tests skipped or focused.

```
cd apps/mobile  && npx jest --ci      →  49 suites passed, 49 total; 938 tests passed, 938 total
cd apps/backend && npx vitest run     →   8 files passed,   8 total; 171 tests passed, 171 total
```

- **Removed for the ML-only `it` check:** zero `it.skip`, `describe.skip`, `it.only`, `xit`,
  `xdescribe` in `apps/mobile/__tests__/`; zero `.skip`, `.only`, `todo(` in `apps/backend/test/`.
- **No test was weakened or deleted to obtain a green result.** Every guard added this phase was
  falsified by an injected mutation, judged from the failure block rather than the pass count.
- The previously reported `honesty.test.tsx` flake **did not reproduce** in this run; it remains
  an open, pre-existing item rather than a fix.

---

## 4. Build outcome

| Field | Value |
|---|---|
| Build command | `cd apps/mobile/android && ./gradlew assembleRelease --no-daemon` |
| Result | **BUILD SUCCESSFUL in 2m 46s** |
| APK path | `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` |
| Size | **70,665,851 bytes** (≈67.4 MiB) |
| SHA-256 | `a11eaf320c986a4f14fd52df448807e98fa2a994601924963bb776da00465758` |
| Package ID | `com.sanketvaani` |
| Version | versionCode `1`, versionName `1.0` |
| SDKs | minSdk 24, targetSdk 36, compileSdk 37 |
| Build type | `release` — **signed with the debug keystore** (`signingConfig signingConfigs.debug`) |
| Effective API base URL | `https://sanket-vaanni-backend.onrender.com` |

**The embedded bundle was inspected, not assumed.** Unpacking `assets/index.android.bundle`
from the APK shows `https://sanket-vaanni-backend.onrender.com` and the hosted Supabase URL
inlined, and **zero occurrences of `:4000`** — so the loopback fallback is not in the artefact.

**A build hazard that had to be worked around, and would have shipped silently.** On this
machine `apps/mobile/.env.local` sets `API_BASE_URL=http://127.0.0.1:4000`, and
`react-native-dotenv` merges `.env.local` over `.env` for *every* profile. The first build of
this session therefore produced an APK pointing at loopback — useless on a phone, and
invisible behind a green build. I held `.env.local` aside, deleted the cached JS bundle so
Gradle could not report the bundle task `UP-TO-DATE` and reuse the loopback one, rebuilt, then
**restored `.env.local` byte-for-byte** (git status still 77 paths; `.env*` is gitignored).

---

## 5. What was actually verified on a physical phone and with physical gloves

**Nothing.** This is stated plainly rather than softened:

- `adb devices -l` → **empty device list**. No phone was connected during this phase, so the
  APK was never installed and no startup, connectivity or BLE behaviour was observed on hardware.
- **There is no glove firmware at all.** `firmware/left-glove/` and `firmware/right-glove/` each
  contain a single README stating *"This directory is empty on purpose."* No packet protocol,
  no GATT service UUIDs, no sensor list, no sampling rate.
- `apps/mobile/src/ble/bleTransport.ts` is headed *"Real glove transport — NOT IMPLEMENTED"*, is
  *"deliberately a stub that throws"*, and sets `isSynthetic = false`. It instructs future
  maintainers not to fill in UUIDs from inference.

Consequently **glove capture, BLE validation and the physical glove acceptance test are
BLOCKED**, and the acceptance test's own precondition — a real collected sequence, a real BLE
validation, a reviewed label, a trained/evaluated candidate, a published model and a real
prediction on the intended inference path — cannot be met. Screenshots, mocked BLE packets and
synthetic predictions are explicitly insufficient for it, and none are offered as evidence here.

**Inference placement (§2 of the directive).** The directive requires a technical evaluation
before choosing embedded inference. The decision on the available evidence is **phone-side
inference**, and it is forced rather than preferred: there is no firmware to host an embedded
runtime, so no model — of any size — can be placed on the ESP32-S3 today. A written
size/RAM/flash/latency/power evaluation cannot be completed honestly without the firmware, and
one is not fabricated.

---

## 6. Integrations: real, unconfigured or mocked

| Integration | Tested against the real service? | State |
|---|---|---|
| Hosted Supabase Postgres | **Reached, refused** | The five core tables **exist** but every role gets `42501 insufficient_privilege`; this is a missing `GRANT`, not a missing table |
| Migrations 3 & 4 tables (`admin_audit_log`, `announcements`, `app_settings`, `device_push_tokens`) | **Not applied** | `404 PGRST205` — table not in the schema cache |
| Supabase Auth | Configured | Exercised only through unit/mocked integration tests |
| SMTP | Configured, **receipt unproven** | Provider acceptance ≠ inbox delivery. `/admin/health` hard-codes `deliveryTested: false`; the state can only reach `untested` |
| Firebase push | Configured, **receipt unproven** | An FCM `messageId` ≠ device receipt. Same `deliveryTested: false` rule |
| Glove BLE | **Not implemented** | Stub; see §5 |
| ML training / persistence / publishing | **Unit-verified only** | Real code, 43 package tests + 64 store tests, but never exercised on a device |

**Delivery terms are kept distinct throughout**, as required: provider/API acceptance, provider
acceptance, and verified inbox / device receipt are never conflated, and no green tick is shown
from a stored toggle. A backend `/health` response is not treated as proof that database writes,
SMTP, push or ML training are operational.

---

## 7. Pending migrations, RLS/grants, environment config and owner approvals

**Nothing below has been run.** These are all owner-approval items.

1. **Apply four migrations**, in numbered order, to the hosted Supabase project
   (`docs/admin-migration-checklist.md` Option A `supabase link` + `db push`, or Option B one
   file at a time in the SQL editor). Order matters: #4 depends on #3.
2. **Grant the base tables.** Migrations 1–2 tables answer `42501` for both `anon` and
   service-role today — the `GRANT` migration is the fix.
3. **Provision the first administrator** out of band via `apps/backend/src/scripts/`, promoting
   an **existing** Supabase Auth identity. One-time, idempotent, audited.
4. **Environment variable NAMES only** (values never requested, never printed, never committed):
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SMTP_HOST`, `SMTP_PORT`,
   `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `GOOGLE_APPLICATION_CREDENTIALS`,
   `API_INTERNAL_SECRET`, `HOST`, `PORT`, `NODE_ENV`, `LOG_LEVEL` (backend), plus
   `API_BASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (mobile).
5. **Email and push inbox/device receipt** can only be proven by an owner-side check on a real
   inbox and a real handset.

No secret value appears in this report, and none was requested from the owner.

---

## 8. Known bugs, limitations, risks and next steps

**D1 — No glove firmware (blocking).** Physical recognition cannot be built or tested.
*Next step:* owner supplies the firmware source, or a live BLE scan, so the real UUIDs and
packet format can be written down instead of guessed.

**D2 — No phone was connected (blocking).** No install, no startup, no connectivity evidence.
*Next step:* attach the phone; install non-destructively; re-run `adb devices -l` and record the
model and Android version rather than assuming them.

**D3 — Account termination does not exist.** Only `active` and `suspended` states are in the
schema, so "permanent termination" is not offered and the UI does not claim it. A suspension
that leaves the auth identity fully active is labelled a suspension.

**D4 — Hosted migrations unapplied.** Every Admin flow needs them. Until then the console
correctly shows failure states rather than fabricated data.

**D5 — Audit UI filter gap.** The backend supports `action` / `targetType` / `targetId` /
`from` / `to` but the console exposes only acted-by and free text. `AUDIT_PAGE_SIZE` is unused
by the screens. No bulk-selection exists in the ML dataset library.

**D6 — Taxonomy separation is NOT IMPLEMENTED (§4).** Labels carry only `languageId` and free
text: there is no `kind`, and no distinction between letters/fingerspelling, digits, whole-word
signs and phrases. There is also **no temporal sequence model**, so continuous sentence
recognition is not implemented, and the app makes **no claim that concatenating isolated static
signs produces grammatical sentences** — the classifier is a per-window multinomial logistic
regression (`softmax-linear`), not a temporal or deep-learning model.

**D7 — Deletion semantics and dependent artefacts (§6) are NOT IMPLEMENTED as a four-way
distinction.** Source removal, snapshot exclusion, retraining and true machine unlearning are
not separately surfaced, and no claim of "the published weights have forgotten deleted data" is
made. Already-published model weights are not silently rewritten.

**D8 — Release signing.** The release APK is signed with the **debug keystore**. Fine for
testing; not distributable.

**D9 — Pre-existing `honesty.test.tsx` flake** remains open.

**Honest classifier description.** The model is multinomial logistic regression trained by
full-batch gradient descent with L2. It is **not** a neural network and **not** deep learning,
and it is described that way everywhere. `accuracy` is `number | null` — it is shown as unknown
rather than as zero when there is not enough data. **Storing a video is not training**, and the
media import path does not present it as such.

---

## 9. Confirmation

**No unauthorised action was taken.** Specifically, during this phase:

- **No commit, no push, no tag, no release, no deployment.**
- **No hosted Supabase migration was applied** and **no production permission or RLS policy was
  modified**. All four migrations remain unapplied.
- **No production credential was rotated, printed, or requested.**
- **No destructive Git command was run** — no `reset --hard`, no `clean`, no `checkout` that
  discards work. The tree still holds all 77 changed/untracked paths, nothing committed.
- **No file owned by the parallel workstream was edited** (`supabase/**`,
  `apps/backend/src/middleware/requireAdmin.ts`, the shared permission docs).
- **No test was weakened, skipped or deleted** to obtain a green result, and no working
  integration was replaced with a mock.
- **No competing agent edited the same files.**
- `.env.local`, temporarily held aside for the build, was **restored exactly**.
- No secret value appears anywhere in this report.

---

## 10. Verdict

**READY FOR OWNER REVIEW. Not release-ready.**

The Admin system, the ML lifecycle and the model-package work are implemented and tested at
unit and mocked-integration level, and the whole tree is green (938 mobile tests, 171 backend
tests). The APK builds and genuinely points at the hosted backend. What remains is **not code**:
an unconnected phone, absent glove firmware, and four unapplied migrations that only the owner
can approve. None of those is claimed as done.

Per the directive, work **stops here**. No ordinary-user or Guest screen has been started or
redesigned.
