# Sanket Vaanni — Execution Report, 2026-10-18

Statuses used: **VERIFIED** (observed with evidence), **IMPLEMENTED BUT
UNVERIFIED**, **PARTIAL**, **BLOCKED**, **PLANNED**, **UNKNOWN**, plus
**FAILED** and **NOT TESTED** where those are the truthful description.

No commit, push, deploy, hosted migration or data-clearing action was performed.
No secret value is reproduced in this document.

---

## A. Implemented or changed in this block

| Change | Files | Evidence |
|---|---|---|
| Auth deep-linking, pending-signup truthfulness, resend cooldown, six-digit confirmation, Google browser hand-off | `apps/mobile/src/supabase/auth.ts`, `linking.ts`, `components/AccountSheet.tsx`, `app/RootNavigator.tsx` | committed in `0156a91`/`7806a0a`, covered by 26 auth tests and 7 rendered AccountSheet tests |
| iOS auth callback registration | `ios/SanketVaani/Info.plist`, `AppDelegate.swift` | committed; compiles only on macOS (not built here) |
| Lint errors removed (unused symbols) | `TeamEditor.tsx`, `orb/OrbShader.tsx`, `orb/OrbStage.tsx`, `AdminScreen.tsx`, `theme/ThemeProvider.tsx` | `npm run lint` → 0 errors, 124 warnings; `tsc --noEmit` → 0 |
| Hosted-state evidence appended to the approval packet | `docs/MIGRATION_REVIEW_FOR_APPROVAL_2026-10-17.md` | read-only PostgREST probes + throwaway-cluster run |
| HTTP email transport for hosts that block SMTP (Render free tier) | `apps/backend/src/config.ts`, `src/services/email.ts`, `src/routes/email.ts`, `src/app.ts`, `.env.example`, `render.yaml`, `test/email-http.test.ts` | explicit `EMAIL_PROVIDER=smtp\|brevo`; no silent fallback; 11 tests against a real local HTTP server; no key present |
| Migration hardening: idempotent policies, private `user-media` bucket, non-additive grants, owner/email privilege guard, advisory lock, avatar constraint | the six files in `supabase/migrations/` | re-applied twice on PostgreSQL 18.4; 26/26 behavioural checks |
| Permanent-owner designation from the operator scripts | `src/admin/bootstrap.ts`, `src/admin/provision.ts`, `src/scripts/bootstrapAdmin.ts`, tests | first-admin promotion sets `is_owner` in the same update; `bootstrap:admin --owner` for existing projects; 6 new tests |

Working-tree diff is those source files plus the migration files and docs.
Nothing was committed or pushed.

## B. Physical-device verification

**NOT TESTED for the 2026-10-18 artefact.** `adb devices -l` returned an empty
list for the whole block; the install command blocked at "waiting for device"
and was stopped. The handset (`1595140436001XT`, vivo V2141) was not attached.

Earlier hardware evidence remains valid for the build tested on 2026-10-15 only
(`docs/device-verification-2026-10-15.md`): Dashboard, Settings, notices error,
Notifications honesty state, and the ML learning centre. It does **not** cover
today's APK, and it does **not** include Admin.

## C. Admin end-to-end

| Item | Status | Evidence |
|---|---|---|
| Admin screen code, sections, forms | IMPLEMENTED BUT UNVERIFIED on device | 1088 mobile tests, typecheck, lint |
| Hosted admin routes exist and require auth | VERIFIED | `/admin/team`, `/admin/users`, `/admin/announcements` → **401** "A bearer access token is required." |
| Hosted admin data path | **FAILED / BLOCKED** | `public.team_members`, `admin_audit_log`, `app_settings`, `device_push_tokens`, `announcements`, `account_deletion_challenges` return `PGRST205` (missing) |
| Real admin sign-in, CRUD, persistence, audit rows, retries | NOT TESTED | no Admin credential was requested or used; no device |

The Admin chain cannot be exercised on the hosted backend until the four pending
migrations are applied **and** an owner session exists. Both need your action.

## D. APK artefact

| Field | Value |
|---|---|
| Path | `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` |
| Built | 2026-10-18 13:47 |
| Size | 70,789,927 bytes |
| SHA-256 | `fe1d2b9bcea6ad1c8c6d76b1d50a2e578f18289e8a40b5b134a44923e266c358` |
| Package / version | `com.sanketvaani` / versionCode 1, versionName 1.0 |
| Bundle | `assets/index.android.bundle`, 2,638,592 bytes, SHA-256 `f761d307852a84ebb0154894c9eac3b3215b51f53ffe62cdba3163e8c5d13afe` |
| Embedded hosts | `https://sanket-vaanni-backend.onrender.com`, `https://mmovhldjwadvljxtloes.supabase.co`; **0** occurrences of `localhost:4000` / `127.0.0.1:4000`; **0** `service_role` literals |
| Deep link in manifest | VIEW + BROWSABLE, scheme `sanketvaani`, host `auth-callback` |
| Signer | `CN=Android Debug`, cert SHA-256 `fac61745…b9c` |

The build used the hold-out script so `.env.local` could not override the hosted
`.env`; `.env.local` was restored (143 bytes, original timestamp) and no
`.env.local.holdout` remains.

**This APK is debug-signed. It is not production-ready.**

Standalone start (no Metro) is **NOT TESTED** for this artefact because there
was no device. The release variant embeds the bundle, and the manifest carries
the auth filter, but neither substitutes for launching it.

## E. Test evidence (exit codes from this block)

| Command | Result |
|---|---|
| `apps/backend: npm run typecheck` | 0 |
| `apps/backend: npm test` | 0 — 12 files, **256 tests passed** |
| `apps/mobile: npm run typecheck` | 0 |
| `apps/mobile: npm run lint` | 0 — **0 errors**, 124 warnings |
| `apps/mobile: npx jest --silent` | 0 — **59 suites, 1088 tests passed** |
| Throwaway PostgreSQL 18.4, all six migrations | all **PASS**; 11 tables, 10 functions |
| Same six migrations applied a **second time** | all **PASS** (idempotency) |
| Hardening checks (grants, bucket, avatar, client escalation) | **26/26** as designed |
| Guard trigger behaviour (6 cases) | all as designed — owner and last-admin operations refused; ordinary admin demotion allowed |

## F. Live integrations

| Integration | Status | Evidence |
|---|---|---|
| Hosted backend liveness | VERIFIED | `GET /health` → 200 `{"status":"ok","version":"0.1.0"}` |
| Hosted backend root | VERIFIED | `GET /` → 200 |
| Hosted team content | **FAILED** | `GET /team` → 502; cause `PGRST205` on `team_members` |
| Hosted admin authentication gate | VERIFIED | 401 without a token |
| Hosted database schema | **PARTIAL / FAILED** | five base tables exist; six required tables missing |
| Google provider on hosted project | VERIFIED (authorize stage) | 302 to `accounts.google.com` with the existing client id, preserving `redirect_to=sanketvaani://auth-callback` |
| Google OAuth round trip on device | NOT TESTED | no device; provider allowlist completion unproven |
| Email status | SMTP configured, delivery **FAILED**; HTTP fallback IMPLEMENTED BUT UNCONFIGURED | `configured:true`, `smtp.gmail.com:465`, `connected:false`, "Connection timeout" (Render free tier blocks outbound SMTP). A Brevo HTTPS transport now exists behind `EMAIL_PROVIDER=brevo`, tested against a local HTTP server; it needs `BREVO_API_KEY` in Render and has sent nothing yet |
| Actual email delivery to an inbox | NOT TESTED | no controlled authorised inbox; SMTP auth is not delivery |
| Push / FCM | **BLOCKED** | `/notifications/status` → `configured:false`: no Firebase service account |
| Supabase auth (email/password) | IMPLEMENTED BUT UNVERIFIED end-to-end | provider reachable; no real signup/sign-in was performed today |
| BLE / glove | **BLOCKED** | no verified firmware protocol; no hardware attached |
| ML / gesture / speech | IMPLEMENTED BUT UNVERIFIED | no trained model, no data; app reports "No recognition model is loaded" |

## G. Remaining blockers (each needs you)

1. **Approve applying the four migrations** to hosted Supabase. Without them
   `/team` is 502, Settings shows the missing-`announcements` error, and Admin
   cannot work against hosted data. All six migration files were validated on a
   throwaway cluster today.
2. **Reconnect the vivo handset** (`1595140436001XT`) by USB. Then this APK can
   be installed over the existing package (same debug signer, no data clearing),
   launched with Metro unreachable, walked through Admin and the core flows, and
   its Logcat captured. Until then device claims remain untested.
3. **An owner/Admin session** for the hosted environment. Do not paste
   credentials into chat; use the documented bootstrap command after approval.
4. **Firebase service account** configured in the Render dashboard for push.
5. **Email delivery from Render.** Port 465 times out. The code now supports a
   zero-budget HTTP provider (Brevo, 300/day free) through `EMAIL_PROVIDER=brevo`
   and `BREVO_API_KEY`, keeping the sender `sanketvaanni.auth@gmail.com`. The key
   must be added in the Render dashboard; nothing has been sent yet.
6. **Glove firmware/protocol** and a physical glove for BLE verification.

## H. Safety and change status

- No commit, push, merge, branch switch, stash, reset, clean or history rewrite.
- No hosted migration, SQL write, deploy or production change.
- No `.env` contents printed; no key, token, password or signing material
  reproduced. The OAuth client id visible in a provider redirect is public by
  design and is not a secret.
- No app data cleared and no app uninstalled.
- Preserved all pre-existing local changes; source edits are the lint fixes,
  the email provider, the owner designation, and the migration hardening.
- Release artefact uses the public Android debug key: **not production-ready**.
- Admin/Guest expansion was not started; awaiting your review as directed.

---

## I. Acceptance matrix — final state of this block

Exactly one status per integration, using the four required words.

| Integration / claim | Status | Basis |
|---|---|---|
| Backend unit/route suite | **VERIFIED** | 12 files, 256 tests, exit 0 |
| Mobile test suite | **VERIFIED** | 59 suites, 1088 tests, exit 0 |
| Mobile/backend typecheck | **VERIFIED** | exit 0 |
| Mobile lint | **VERIFIED** | 0 errors (124 warnings) |
| All six migrations apply in order | **VERIFIED** | PostgreSQL 18.4 throwaway cluster |
| All six migrations are re-runnable | **VERIFIED** | second application, no errors |
| Owner/last-admin trigger behaviour | **VERIFIED** | 6/6 behavioural cases |
| Client cannot set `is_owner`/`email`/`role` | **VERIFIED** | 4/4 checks as `authenticated` |
| Grant scope (no TRUNCATE/DELETE/audit writes) | **VERIFIED** | 8/8 privilege checks |
| Avatar constraint accepts own folder only | **VERIFIED** | 4/4 checks |
| `user-media` bucket exists and is private | **VERIFIED** | throwaway cluster |
| Email HTTP transport (Brevo) code path | **VERIFIED** | 11 tests against a real local HTTP server |
| Hosted database schema | **FAILED** | six required tables return `PGRST205` |
| Hosted `/team` endpoint | **FAILED** | 502, caused by the missing table |
| Hosted SMTP delivery | **FAILED** | port 465 times out on Render free tier |
| Real email into an inbox | **NOT TESTED** | no key/provider account, no authorised inbox |
| Real push on device | **BLOCKED** | no Firebase service account on Render; no device |
| Hosted migrations applied | **BLOCKED** | awaiting explicit owner approval of the corrected set |
| App installed/launched on the vivo handset | **BLOCKED** | `adb devices` lists nothing; USB debugging authorisation or cable |
| Standalone APK launch (no Metro) | **NOT TESTED** | requires the device above |
| Admin CRUD, audit rows, screenshots, Logcat | **NOT TESTED** | requires a device and an owner session |
| Google OAuth full round trip | **NOT TESTED** | authorize stage verified; device callback untested |
| Android background behaviour | **NOT TESTED** | requires a device |
| BLE / glove | **BLOCKED** | no firmware protocol, no hardware |
| ML inference | **BLOCKED** | no trained model or dataset; UI reports this honestly |

### Human actions that unblock the remainder

1. Reconnect the vivo (`1595140436001XT`) and accept **Allow USB debugging**
   on the handset. Then the built APK can be installed and exercised.
2. Reply with the approval sentence for the corrected migration set.
3. Add `BREVO_API_KEY` (and set `EMAIL_PROVIDER=brevo`) in the Render dashboard.
4. Add the Firebase service account to Render for push.

No secret should be pasted into chat; each is a dashboard/environment action.
