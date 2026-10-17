# Task F — Master Admin System + Guest Migration Completion: Final Report

**Date:** 2026-10-15
**Repository:** `C:\PROJECT\SANKET VAANNI`, branch `3d-hand-viewer-integration`, HEAD `32937ac` at the start of this pass.
**Nature of this pass:** local implementation only. Nothing was committed, pushed, tagged, released or deployed. No migration was applied to the hosted Supabase project. No permission was changed remotely. No live data was read or modified.

**Companion documents:**
- `docs/admin-system.md` — how administration actually works.
- `docs/admin-migration-checklist.md` — what the owner must review and run.
- `docs/implementation-audit.md` — the earlier read-only inventory this pass worked from.

---

## 1. Verdict

# READY FOR OWNER REVIEW — **not** ready for release.

**Why review-ready:** the administration chain is connected end to end and covered by tests — a control in the console reaches an authenticated backend route, which authorises from the database, validates, mutates, writes a two-row audit record, and returns a result the UI reports honestly. The backend suite is **121/121 green** with `tsc --noEmit` clean, and the mobile suite is **622/623**, the single failure being a pre-existing flake documented in §9 and not caused by this work.

**Why not release-ready — three reasons, none of them code quality:**

1. **The database is not deployed.** Three of the four migrations that make any of this work have never run against the hosted project. Until the owner runs §3 of the checklist, the administration API cannot authenticate anybody, because `profiles.role` and `profiles.status` do not exist there yet.
2. **No device or emulator run was performed.** Everything below is verified by unit and component tests against fakes. No Android device touched this work (§8).
3. **Two client-declared parts of the brief are genuinely absent, not merely unfinished** — announcement push dispatch, and account termination/deletion. Both are absent because the project has no delivery channel and no such status in its schema. They are reported, not faked (§9).

**Nothing in this pass claims more than it verified.** Where a requirement is unmet, §9 and the checklist at the end say so.

---

## 2. Files changed, by group

The working tree is **shared with a second workstream.** Files marked *†* belong to that workstream (database permissions) and were read for reconciliation only — not edited. Everything else was written in this pass.

### Group A — Administration backend (new)

| File | What it is |
|---|---|
| `apps/backend/src/routes/admin.ts` | The 12 `/admin` endpoints (1,311 lines). |
| `apps/backend/src/admin/bootstrap.ts` | First-administrator decisions (451 lines). |
| `apps/backend/src/scripts/bootstrapAdmin.ts` | The CLI entry point. |
| `apps/backend/src/audit/trail.ts` | Two-row audited action (`beginAction`). |
| `apps/backend/src/maintenance/gate.ts` | The server-side maintenance hook. |
| `apps/backend/src/app.ts` *modified* | Registers the admin plugin and the gate. |
| `apps/backend/package.json` *modified* | `npm test`, `bootstrap:admin`. |

### Group B — Audit and authorisation middleware

| File | Status |
|---|---|
| `apps/backend/src/middleware/requireAdmin.ts` † | **Belongs to the other workstream.** Read to confirm the contract this code depends on: token validated via `auth.getUser`, role and status re-read from `profiles`, actor taken from the token subject. Not edited here. |

### Group C — Guest migration and sync (mobile)

| File | What it is |
|---|---|
| `apps/mobile/src/supabase/guestMigration.ts` | Consent record, scope list, decision read/write. |
| `apps/mobile/src/supabase/readBack.ts` | Independent post-upload verification + `canonical`. |
| `apps/mobile/src/supabase/sync.ts` *modified* | Bounded cancellable requests; OLED key reconciliation. |

### Group D — Administration and announcements (mobile)

| File | What it is |
|---|---|
| `apps/mobile/src/admin/client.ts` | Typed API client; no `actorId` is ever sent. |
| `apps/mobile/src/admin/auditEntry.ts` | Audit row → human sentence. |
| `apps/mobile/src/admin/bulkEntry.ts` | Bulk answer → honest sentence. |
| `apps/mobile/src/announcements/{index,reader}.ts` | Published-only reading, expiry, dismiss state. |
| `apps/mobile/src/screens/AdminScreen.tsx` *modified* | The console: People, Audit, Notices, Service. |
| `apps/mobile/src/screens/MoreScreen.tsx` *modified* | Entry point to the console. |
| `apps/mobile/src/components/AccountSheet.tsx` *modified* | Guest-migration consent. |
| `apps/mobile/src/components/NoticesCard.tsx` | Announcements display. |
| `apps/mobile/src/app/AppState.tsx` *modified* | Announcements refresh; no late async UI resurrection. |

### Group E — Test-harness integrity (the most consequential change in the pass)

| File | What it is |
|---|---|
| `apps/mobile/babel.config.js` *modified* | **Points the test environment at `.env.test`, which does not exist.** |
| `apps/mobile/jest.config.js` *modified* | A 15 s harness budget, with the measured numbers in the comment. |

`react-native-dotenv` is a babel plugin: it inlines a `.env` file into the bundle **at transform time**. Jest was therefore inheriting whatever credentials the developer had on disk. Probing confirmed that **every app render issued two real HTTPS requests to a live Supabase project**, and that `API_BASE_URL` resolved to the deployed Render backend. Tests were talking to production. They now resolve to no Supabase URL and a localhost API base and make **zero** network calls — verified by count, not by assumption. This also satisfies the brief's requirement that tests generate no traffic to production or real user data.

### Group F — Tests (new)

Backend: `admin-audit`, `admin-bootstrap`, `admin-routes`, `maintenance-gate`.
Mobile: `guest-migration`, `guest-migration-readback`, `guest-migration-interruption`, `account-sheet-consent`, `admin-audit`, `admin-bulk`, `notices`, `notices-card`, plus the `fakeSupabase` helper.

### Group G — Documentation (new)

`docs/admin-system.md`, `docs/admin-migration-checklist.md`, `docs/task-f-final-report.md` (this file).

### Not changed

No file under `supabase/` was modified. No migration was created. `docs/supabase-setup.md`, `docs/integrations-guide.md` and `docs/remediation-report.md` belong to the other workstream and were left alone.

---

## 3. Migrations

**Four migrations, deployed in this order. NONE has been applied to the hosted project.**

| # | File | Adds |
|---|---|---|
| 1 | `20261012000000_sanket_vaanni_initial.sql` | Base schema and the account-creation trigger. |
| 2 | `20261013000000_storage_user_media_policies.sql` | `user-media` bucket policies. |
| 3 | `20261014000000_admin_audit_maintenance.sql` | `role`/`status`/`avatar_url`; `admin_audit_log`, `app_settings`, `announcements`; the privileged-column trigger; all RLS and grants. |
| 4 | `20261014000001_device_push_tokens.sql` | `device_push_tokens` + `register_device_push_token`. **Depends on #3.** |

**Confirmation, stated plainly:**

| | |
|---|---|
| Applied to the hosted Supabase project | **No** |
| `supabase db push` run | **No** |
| Remote permissions or RLS altered | **No** |
| Live data read, written or altered | **No** |
| Migration files created or modified | **No** |

**One genuinely destructive statement exists in the set**, and the checklist flags it: `DROP FUNCTION IF EXISTS public.is_admin(UUID)` / `is_active(UUID)` in #3, which removes the previous argument-taking signature. Anything outside these migrations still calling `is_admin(some_uuid)` would break. This is a review item, not a blocker.

**All statements in #3 and #4 are idempotent and safe to re-run** — verified statement by statement. No migration deletes user data. The six verification queries, the rollback position, and the review points are in `docs/admin-migration-checklist.md`. **The owner's ordered checklist and exact proposed commands are there; none were run.**

---

## 4. Role and permission matrix

**The schema supports two roles: `user` and `admin`.** There is no super-admin. `profiles.role` is CHECK-constrained to `('user','admin')`; a third tier does not exist, and inventing one in the UI would have been a screen backed by a role the database rejects.

The brief permits this — *"otherwise explain the existing role model and implement a safe equivalent without pretending the separate role exists."* The safety a top tier would provide is provided instead by four mechanisms that do exist and are tested: **last-active-administrator protection** (single and bulk routes both refuse to remove the final one), **self-lockout refusal** on both routes, the **one-time CLI bootstrap** that refuses while any active admin exists, and an **append-only audit log** attributing every action to the verified token subject.

| Action | Ordinary user | Suspended | Administrator | Service role |
|---|---|---|---|---|
| Own preferences / calibration / OLED / history — read & write | Own rows | **No** (`is_active()` gates every policy) | Own rows | Yes |
| Read published, in-window announcements | **Yes, even signed out** | Yes | Yes | Yes |
| Read drafts / expired | No | No | Yes | Yes |
| Read the maintenance setting | **Yes, even signed out** (value only) | Yes | Yes | Yes |
| Change the maintenance setting | No | No | Yes | Yes |
| Read `profiles` | Own row | Own row | **All rows** | Yes |
| **Change `role` or `status`** | **No** | No | **No — even an administrator** | **Yes** |
| Read `admin_audit_log` | No | No | Yes | Yes |
| Write `admin_audit_log` | No | No | No | **Insert only** |
| Update/delete an audit row | **No — ever, for anyone** | No | No | **No grant exists** |
| Register a device push token | Own, max 20 | Own | Own | Yes |

**The row that matters most:** an administrator cannot change `role` or `status` from a client session at all. They do it *through the API*, which holds the service key and writes the audit row. A database trigger (`enforce_profile_privilege_boundary` on `profiles`) raises `insufficient_privilege` unless the acting role is `service_role`. Without it, any authenticated user could promote themselves to admin with one PostgREST call. The trigger **fails closed**: `trusted IS NOT TRUE`, with a `COALESCE` so an unreadable claim yields `''` rather than `NULL`, and a missing actor cannot slip through. This is verified — the checklist includes a query to prove it refuses, and running the migration file locally caught an earlier revision that used bare `NOT trusted` and **would** have let an authenticated `INSERT` with `role='admin'` through.

> **Correction on file:** an earlier note described the privileged-column trigger as being on `device_push_tokens`. It is on **`profiles`**. `device_push_tokens` has no trigger; its tightening is a missing UPDATE policy plus a minimal `GRANT SELECT, INSERT, DELETE`, with ownership decided solely inside one `SECURITY DEFINER` function from `auth.uid()`.

---

## 5. Admin features — the full chain

Each row is a feature that reaches the database and comes back, not a button that exists.

| Feature | UI → API → DB → audit → UI |
|---|---|---|
| **User list** | Console → `GET /admin/users` (typed) → paged `select` on `profiles` → read, no audit → list refreshes with server-side total, search and status filter. |
| **Suspend / reactivate one** | Reason gate → `POST /admin/users/:id/suspend` → `UPDATE profiles.status` → requested + outcome rows → the row's chip updates. Refuses self and the last active admin **server-side**. |
| **Bulk suspend / restore** | Multi-select → `POST /admin/users/bulk` (1–50) → per-account `UPDATE` → one `requestId` pairs every requested/succeeded row → the summary names how many changed **out of how many**, and lists each account left alone with the service's reason. |
| **Change role** | Reason gate → `POST /admin/users/:id/role` → `UPDATE profiles.role` → audit pair → list refreshes. |
| **Password reset** | Reason gate → `POST /admin/users/:id/reset-password` → Supabase sends the account its own reset mail → audit pair → UI reports **`requested`**, never "sent" or "delivered". |
| **Read a profile** | `GET /admin/users/:id` → single row → no audit. |
| **Audit history** | Console → `GET /admin/audit` → paged read with 7 filters → the pure `auditEntry` module joins the two rows by `requestId` and renders one action, with the failure detail surfaced. |
| **Announcements** | Create/publish/unpublish → `POST /admin/announcements[/:id]` → `INSERT`/`UPDATE` with CHECK-enforced non-empty title and body → audit pair → admin list refreshes. |
| **Maintenance mode** | Toggle + message + reason → `POST /admin/maintenance` → `UPDATE app_settings` → audit pair → the *who last changed it* is **re-read, not assumed**. |

**The two rules that make these honest:**

- **Every write writes its audit pair, and the request row is written before the mutation.** If the request row cannot be written, the action does not happen. If the *outcome* row cannot be written, the action is not failed retroactively — a row is left saying `requested`, which is true as far as it goes and is exactly what an investigator should read as unresolved rather than done.
- **A partial result is never rounded up.** In a bulk action the UI counts the per-account rows rather than the service's tally, and only says "Suspended N of N" when every account changed. Otherwise it names the ones that did not.

**Deliberately absent from the console:** there is no way to read a user's recognitions, conversations, history or calibration, and no way to see or set a password. Administering accounts does not require reading what people said, and no endpoint could.

---

## 6. Guest migration — the four required results

**1.5 — Independent read-back verification.**
After uploads, verification is performed by **reading the stored rows back and comparing them to what was meant to be written** (`readBack.ts`), not by trusting a successful response. Four independent verifiers — `verifyPreferences`, `verifyCalibration`, `verifyOledProfiles`, `verifyHistory` — each compare against a canonical form (`canonical()`), so a value that round-trips to a different shape is caught rather than passing on a loose equality. A read-back that throws is converted to a described failure rather than swallowed. Covered by `guest-migration-readback.test.ts` (22 tests).

**1.6 — Bounded, cancellable requests.**
`SYNC_REQUEST_TIMEOUT_MS = 20_000`, with the deadline firing an `AbortController` that is carried **into postgrest-js** via `.abortSignal(signal)`. This is the point the brief insisted on: the timeout does not merely race a promise against a timer while the underlying write continues invisibly — it aborts the request itself. Cancellation is a distinct outcome (`SyncCancelledError`) from a timeout (`SyncTimeoutError`), so a user leaving the screen is not reported as a failure. Covered by `guest-migration-interruption.test.ts` (11 tests).

**1.7 — OLED key consistency.**
Local OLED state lives under one key, `featureKeys.oledProfiles` → `KEYS.oledProfiles`, whose literal value is `'sv/v1/oled-profiles'`. The guest-migration path, the sync path and the OLED studio screen now all read and write that same key. Previously two writers used paths that *happened* to be equal, which is a divergence waiting to happen — the migration could have uploaded from one key while the screen wrote to another, and nothing would have looked wrong. Reconciled so equality is structural rather than coincidental.

**1.8 — Regression tests that fail when the guard is removed.**
Every guard added in this pass was **falsified**: the guard was removed from the source, the suite was re-run, and the run was required to fail. The source is restored and the restore is verified **by hash**, not assumed.

| Guard | Falsified by |
|---|---|
| Bulk batch: all active admins protected | 5 mutations, all caught |
| Bulk input validation (size, shape, dedup, self) | 5 mutations, all caught |
| Bulk answer never rounded to "done" | 6 mutations, all caught |
| Maintenance `enabled === true` parsing | mutation caught |
| Guest-migration consent scope | mutations caught |

**A note on how the falsification was itself checked.** The bulk-answer probe initially reported a mutation as *caught* when the suite had not failed — because Jest prints **passing** test names too, so a regex over the raw output matched either way. The probe was corrected to read only names inside a `●` failure block. That correction then exposed a real gap: the strict `typeof ok === 'boolean'` check had no test that distinguished it from a weaker truthiness check, because every payload either omitted `ok` or passed a real boolean. A test with `ok: 1`, `ok: 'true'` and `ok: null` was added, and the mutation is now genuinely caught. **The guard and the test that claims to cover it were both wrong, and only the corrected probe found it.**

A separate hypothesis of mine was also wrong and is recorded as such: I believed an `announcements.refresh()` call caused the suite's timeouts. Removing it (md5-verified restore) made the run **worse** — 7 failures instead of 4 — so the hypothesis was withdrawn rather than left in place.

---

## 7. Exact commands and test counts

### Backend — 121 tests, 6 files, 627 ms

```bash
cd apps/backend
npm test                      # vitest run  →  121 passed (121), 6 files, 627 ms
npx tsc --noEmit              # exit 0
```

| File | Focus |
|---|---|
| `test/admin-routes.test.ts` | **59 tests** — all 12 routes, incl. 14 for bulk actions |
| `test/admin-audit.test.ts` | The two-row audit pair, `requestId` correlation, actor identity |
| `test/admin-bootstrap.test.ts` | Bootstrap and recovery decisions, every refusal path |
| `test/maintenance-gate.test.ts` | Gate exemptions, `enabled === true` parsing, unreadable → allow |
| `test/config.test.ts`, `test/health.test.ts` | Configuration and liveness |

### Mobile — 623 tests, 38 files

```bash
cd apps/mobile
npx jest                      # 622 passed, 1 failed (623) — the flake in §9
npx tsc --noEmit              # exit 0
npx eslint                   # exit 0
```

New files this pass: `guest-migration` (31), `guest-migration-readback` (22), `account-sheet-consent` (24), `notices` (24), `admin-bulk` (13), `guest-migration-interruption` (11), `admin-audit` (10), `notices-card` (6).

**The one failure is pre-existing and not caused by this work.** Failure counts on unchanged code across runs were observed at 1, 2, 4, 6 and 7 — non-monotonic, and *worse* when the new test files were excluded. The cause is slow whole-app-render tests against Jest's unconfigured 5 s default; the measured slowest *completing* tests take 2.3–5.6 s. A 15 s harness budget was set, with the measurements recorded in the config comment. It relaxes **no assertion**; a hanging test is still reported as a failure. See §9 for the one residual.

---

## 8. UI/device testing actually performed

**No physical Android device and no emulator were used in this pass. This is NOT a device-verified result.**

What **was** executed:

- Component-level render tests under Jest for the admin console sections, the notices card, the guest-migration consent sheet and the maintenance screen, using a fake Supabase client (`__tests__/fakeSupabase.ts`) that performs **no network I/O**.
- Pure-function tests for the decision modules (`auditEntry`, `bulkEntry`, guest-migration scope/consent and read-back verification).
- Type checking (`tsc --noEmit`) and linting on every changed file.

**Scenarios explicitly NOT executed, because the infrastructure to run them honestly is not available here:**

| Scenario | Status |
|---|---|
| Console flows against a live backend on a device | **NOT TESTED** |
| Signing in as an administrator on a device and seeing the console | **NOT TESTED** |
| Maintenance mode closing the app on a real launch | **NOT TESTED** — server gate and screen logic are unit-tested; the device experience is not |
| Bulk selection by touch on a device | **NOT TESTED** |
| Screen-reader traversal (TalkBack) | **NOT TESTED** — accessibility labels exist in the source, but no assistive technology was run |
| Reduced-motion and large-font behaviour on device | **NOT TESTED** |
| Push notification arriving on a device | **NOT APPLICABLE** — no dispatch path exists (§9) |

**No browser or device E2E infrastructure was available, so none was used.** I have not converted a component test into a device pass, and the app has not been claimed as running on a phone.

---

## 9. Remaining defects and required external configuration

### D1 — Pre-existing flake: the voice-panel test (open, not fixed)

`__tests__/honesty.test.tsx › the voice panel › does not report ready until an engine exists`

Passes alone in ~180 ms; exceeds the timeout under full-suite load (~30 s). `VoicePanel` contains no timers, intervals, animations or effects, and the test is a single render plus a string assertion — so it is **starved, not deadlocked**. This is a defect in the suite's load behaviour (the app-render suites are heavy), recorded rather than hidden. It was not fixed because the honest fix is to reduce render cost in the heavy suites, which is a change to tests this pass did not own.

### D2 — Announcement push dispatch: absent

No delivery channel exists in this project. There is therefore no dispatch, no retry, no backoff, no delivery receipt, no dedup, and no per-audience targeting. **Nothing in the code claims a notification was delivered.** Building this would require a real channel and, under the standing constraints, a spend decision that is the owner's.

### D3 — Account termination / deletion: absent, and not buildable as specified

`profiles.status` is CHECK-constrained to `('active','suspended')`. There is no terminated or deleted state and no delete route. Suspension is described as **suspension** everywhere in the console; nothing says an account was terminated or deleted. Deleting the `auth.users` row cascades to `profiles` and is an owner-level operation, not a console action.

### D4 — Maintenance mode does not gate hosted Auth

Sign-in happens against Supabase's hosted `/auth/v1/token`. A Fastify hook cannot see those requests. The server gate covers this service's own endpoints; sign-in is blocked **on the client**, reading the same world-readable setting. A middleware claiming to block hosted Auth would be a false claim, so none was written.

### D5 — Two of the eight requested console views are absent

Present: People (2 & 3), Audit (4), Notices (5), Service (6). **Absent: the overview/dashboard (1) and notification/configuration health (7).** `/email/status` and `/notifications/status` exist and are exempt from the gate but are not surfaced. **No dashboard numbers were fabricated** — an invented statistic is worse than an empty screen. Role/provisioning instructions (8) are delivered as documentation rather than as a console view.

### D6 — Required external configuration, by name only

| Variable | Where | Needed for |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | backend | Every admin route and the maintenance gate |
| `API_INTERNAL_SECRET` | backend | Internal dispatch endpoints |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | mobile | Sign-in and client reads |
| `API_BASE_URL` | mobile | Reaching the admin API at all |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | backend | Transactional email — the path that would carry password resets |
| `GOOGLE_APPLICATION_CREDENTIALS` | backend | Firebase push — present, but there is no dispatch path to use it |

**Values are never printed, in this document or anywhere else.** The service-role key exists only in the backend; it is never in the mobile bundle, the APK, or a client request.

### D7 — No migration is deployed, so none of this is live

The clearest statement of the current state: the admin API cannot authenticate anybody against the hosted project until the owner runs the migrations. `profiles.role` and `profiles.status` do not exist there yet.

---

## 10. Residual security risks and hosted-Auth limitations

| # | Risk | Assessment | Mitigation in place |
|---|---|---|---|
| R1 | **Hosted Auth is outside the service boundary** | Sign-in and signup cannot be rate-limited, gated or audited by this backend. A caller who bypasses the app can talk to hosted Auth directly during a maintenance window. | Stated as a limit rather than papered over. A second auth system was rejected because it would break more than it fixes. |
| R2 | **Service-role key is a full-bypass credential** | It bypasses every policy and the privileged-column trigger by design. Its compromise ends every guarantee. | Backend-only, never in a client. Never logged or printed. The bootstrap script prints variable **names** when they are missing, never values. |
| R3 | **The mobile bundle is public** | Any control can be replicated by anyone with a token. | Not a security boundary and never treated as one — every route re-authorises server-side from the database. Hiding a button changes nothing about who can act; this is documented in the screen itself. |
| R4 | **No rate limiting on admin routes** | An authenticated administrator could issue bulk requests repeatedly. | Bounded at 50 targets per request and audited per account. A determined administrator is already trusted; the exposure is log volume, not escalation. **Not mitigated further — reported as residual.** |
| R5 | **Maintenance state is world-readable** | A signed-out caller learns the service is closed, and can read the administrator's message. | Deliberate and load-bearing: the closed-app screen and signed-out clients depend on it. Only `(key, value)` is granted; `updated_by` is not exposed. |
| R6 | **Append-only is enforced by three mechanisms, not one** | If a future migration adds an UPDATE grant or policy, the log becomes mutable. | No UPDATE/DELETE policy for any role, write verbs revoked from `authenticated`, INSERT granted only to `service_role`. The checklist includes a query to verify this after deployment. |
| R7 | **Audit rows are written by the same service that performs the action** | A compromised backend could act without recording it. | The request row is written **before** the mutation and its failure aborts the action, so an unrecorded consequential change requires actively breaking the helper rather than merely interrupting it. |
| R8 | **Tests previously reached production** | Confirmed and **fixed** (§2 Group E): every app render issued two real HTTPS requests to a live project. | The test environment now resolves to `.env.test`, which does not exist. Verified: zero fetch calls, matching a fresh clone. |

---

## 11. Exact manual next steps requiring owner approval

**Nothing below has been done. All of it is yours to approve and run.**

1. **Review the database changes.** Read `docs/admin-migration-checklist.md` §3 — in particular the two `DROP FUNCTION` statements, the privileged-column trigger, and the two `anon`-readable policies (maintenance setting and published announcements). Decide whether you accept that signed-out callers can read those two.
2. **Search the hosted project** for any other object calling `is_admin(...)` or `is_active(...)` with an argument. Those break when migration #3 runs.
3. **Take a backup.**
4. **Apply the four migrations in order** — `supabase db push`, or one file at a time in the SQL editor. **Approve this explicitly; it has not been run.**
5. **Run the six verification queries** (checklist §4). Query 6 must raise `insufficient_privilege`; if that `UPDATE` succeeds, the deployment is not complete.
6. **Create the first administrator:**
   `npm run bootstrap:admin -- --email <address> --reason "initial administrator"` — from `apps/backend`, against an account that already exists.
7. **Configure the environment** (§9, D6) and decide whether to establish an email channel. Until one exists, password-reset requests will be recorded as `requested` and no mail will arrive.
8. **Run the app on a real Android device** and execute the scenarios in §8, none of which has been run. On the evidence available to me, this is the largest untested area in the whole pass.
9. **Decide on the two absent features** (§9, D2 and D3): whether to fund a notification channel, and whether a terminated/deleted account state is wanted. Both need a schema change and a policy audit, not a UI change.
10. **Decide about the pre-existing flake** (D1): fix the heavy render suites, or leave it and accept a reported failure on some runs.

**Nothing has been committed, pushed, tagged, released or deployed.** No remote migration, permission or data change has been made.

---

## Appendix — Complete / incomplete / blocked

| Requirement | Status |
|---|---|
| 1.1 Strict migration consent scope | **Complete** — validated against implemented scope names; an unknown name is not silently accepted |
| 1.2 Failure accounting | **Complete** |
| 1.3 No late async UI resurrection | **Complete** |
| 1.4 Recovery without masking the original error | **Complete** |
| 1.5 Independent read-back verification | **Complete** — 4 verifiers, 22 tests |
| 1.6 Bounded, cancellable requests | **Complete** — 20 s, aborted at the transport, not raced |
| 1.7 OLED key consistency | **Complete** — one key, `'sv/v1/oled-profiles'` |
| 1.8 Regression tests that fail when the guard is removed | **Complete** — every new guard falsified, restores hash-verified |
| 2–4. One identity system, one server-side permission model, no duplicate login | **Complete** |
| 3. Secure one-time admin bootstrap | **Complete** — CLI, refuses while an admin exists, writes no row on refusal |
| 4. Least privilege | **Complete** — see the matrix in §4 |
| 5. User management | **Substantially complete** — search, filters, server-side paging, suspend/reactivate, role, **bulk actions**, confirmations with reasons, last-admin and self-lockout protection, audited, honest status. **Termination/deletion: blocked** — no such state exists in the schema (§9, D3) |
| 6. Audit logging with verified actor, never trusting the client | **Complete** — `actor_email` never left NULL |
| 7. Announcements | **Partial** — create/publish/unpublish, validation, expiry, user-side published-only read, dismiss, audit: **complete**. Push dispatch, retry, targeting, admin pagination: **not implemented** (§9, D2) |
| 8. Maintenance mode, server-side, with exemptions | **Complete** for this service's endpoints; **honest limit** for hosted Auth (§9, D4) |
| 9–10. Guest-first, no service-role in the app, audit-first integrations | **Complete as constrained** — no provider configured, no delivery claimed |
| 11. Premium accessible Admin UI, **eight** views | **Partial** — 4 of 8 sections exist (People, Audit, Notices, Service) covering views 2–6; **views 1 and 7 absent**, view 8 delivered as documentation. No numbers fabricated. Accessibility: labels, contrast and touch targets present in source; **no assistive technology was run** |
| 12. Role/security test matrix on isolated local infrastructure | **Partial** — 121 backend tests incl. role and gate matrices; **no isolated end-to-end environment or device run** |
| 13. Contract → types → backend → frontend → tests → docs | **Complete** for everything implemented |
| 14. Documentation and handover | **Complete** — `docs/admin-system.md`, `docs/admin-migration-checklist.md`, this report |
| **Deployed and live** | **Not applicable — nothing is deployed.** Four migrations await owner approval |
