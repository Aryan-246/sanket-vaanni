# Sanket Vaanni — Read-Only Implementation Audit

**Date:** 2026-10-14
**Repository:** `C:\PROJECT\SANKET VAANNI`, branch `3d-hand-viewer-integration`, HEAD `32937ac`, working tree clean at the time of the audit.
**Nature of this pass:** read-only. No file was created, edited, moved or deleted in the repository, no build or test was run, no remote service was contacted, and nothing was committed or pushed. The only files written anywhere are this report and a throwaway PostgreSQL cluster outside the repository, used earlier for migration validation.
**Deliverable:** a component-by-component implementation inventory, a gap list against the brief, the security blockers, the Super Admin finding, and a phased plan with safe ownership.

This report deliberately does **not** re-derive the Supabase permission matrix. Gemini owns the database-permission analysis and local migration validation (per the brief), so the RLS and grant detail is reported only at the structural level here and the authoritative permission matrix is left to that workstream. See §7.

---

## 0. How to read this report

### 0.1 Status vocabulary

| Label | Means |
|---|---|
| **IMPLEMENTED** | Real code that does the thing, with the source path given. Does not imply it was run against a live service or a device. |
| **IMPLEMENTED-UNVERIFIED** | Real code, but no evidence in the repository that it has ever executed against the real service or hardware. |
| **PARTIAL** | Some of the requirement exists; the stated remainder does not. |
| **UI-ONLY** | A control or screen exists and does nothing durable, or the data path stops before it reaches the user. |
| **STUB** | A deliberate placeholder that refuses or returns nothing, and says so. |
| **MISSING** | No evidence found. Searched; not present. |
| **BLOCKED** | Depends on something that does not exist yet (hardware, firmware, credential, approval). |

### 0.2 A note on what this repository already gets right

This is unusual and it matters for the plan: the codebase is **candid to an unusual degree, and the candour is load-bearing**. `ml/` and `firmware/` contain only READMEs that explain why they are empty. `UnimplementedRecogniser.recognise()` returns `null` and declares `isAvailable = false`. The audit module (`apps/mobile/src/audit/findings.ts`) exists to make it impossible to render a green badge without evidence. `docs/testing-strategy.md:48` states that any accuracy figure in the repository "should be treated as absent, not as an estimate".

The finding that follows from this is not "the project is dishonest". It is almost the opposite: the honesty is enforced in code and in tests, and the places where it breaks down are **specific and few**. §2.3 lists them, and the most serious one is a genuine contradiction between what the app tells the user and what the app then does.

---

## 1. Implementation inventory

### 1.1 Application shell, navigation and brand

| Item | Status | Evidence | Note |
|---|---|---|---|
| Navigation model | IMPLEMENTED | `apps/mobile/src/app/RootNavigator.tsx:54` — two routes `intro \| tabs`, a `TabKey`, and a depth-1 detail stack; no router dependency | Only the active screen is mounted; asserted by `__tests__/launch-flow.test.tsx` |
| Screen inventory | IMPLEMENTED | 12 screens in `apps/mobile/src/screens/` — Dashboard, OLED, Textboard, History, More(→"Settings"), Profile, About, Admin, Audit, ML, Maintenance, Intro | |
| Bottom navigation contents | **PARTIAL vs brief** | `apps/mobile/src/components/TabBar.tsx:36-67` — actual order **Dashboard · OLED · Textboard · History · Settings** | Brief asks for Textboard near Dashboard and OLED (✓ it is, position 3) with other sections under "More". The "more" tab exists but is **labelled "Settings"**, and there is an extra **History** tab the brief does not list |
| Header: "संकेत वाणी" + subtitle + avatar | IMPLEMENTED | `apps/mobile/src/components/BrandHeader.tsx:40,99,103-118,125-135` | Subtitle is `<screen> · ISL → English`, both halves read live from preferences, never hardcoded. Avatar opens the account sheet |
| Header present on every screen? | **PARTIAL** | Used on Dashboard, Textboard, History, Settings. OLED/Admin/About/Profile use `ScreenHeader`/`DetailHeader` instead | Deliberate, but the brief's "header must use…" implies a consistent header per screen — worth an owner decision |
| Devanagari font from the intro video | **MISSING (deliberate, documented)** | Zero font files in `apps/mobile` (`find -iname '*.ttf' -o -iname '*.otf'` → nothing). `BrandHeader.tsx:20-27` states the system Devanagari face is used: *"No font is bundled and no proprietary typeface is claimed"* | The intro video exists (`apps/mobile/src/assets/intro/sanket-vaani-intro.mp4`). Extracting its typeface is a licensing question for the owner, not an oversight — see §6 Phase 0 |
| Dashboard left unchanged | **HONOURED** | No redesign performed | Per the brief, the Dashboard stays as-is until the owner approves it |

### 1.2 Guest-first experience

| Item | Status | Evidence | Note |
|---|---|---|---|
| Usable without an account | **IMPLEMENTED** | `apps/mobile/src/app/RootNavigator.tsx:256-305` renders the tab tree unconditionally; the only pre-tab gates are the intro and maintenance | There is **no auth screen at launch**. Sign-in lives in a modal `AccountSheet` |
| Guest identity model | IMPLEMENTED | `apps/mobile/src/account/AccountProvider.tsx:398` — `isGuest: user === null` | No Supabase configured ⇒ still a guest, `isReady` immediately |
| Persistent guest banner | **PARTIAL** | `apps/mobile/src/components/GuestBanner.tsx` is real and correct, but is rendered **only on the Dashboard** (`DashboardScreen.tsx:244`), and dismissal is component state only (`DashboardScreen.tsx:105`) — not persisted, not shown on other tabs | The brief says "persistent, compact guest banner". It is neither persistent across screens nor across launches |
| Banner copy | IMPLEMENTED | `GuestBanner.tsx:51-55` | States plainly that nothing reaches a server and that uninstalling removes it |
| Sign In / Sign Up / Continue as Guest | IMPLEMENTED | `AccountSheet.tsx:413,488,588` | |
| Warning that local data is lost | IMPLEMENTED | Four sites: `GuestBanner.tsx:52-55`, `AccountSheet.tsx:581-586`, `MoreScreen.tsx:428-431`, `ProfileScreen.tsx:210-212` | |
| Guest → account data migration with consent, duplicate protection, conflict handling, sync states | **MISSING as a designed flow; and the copy contradicts the behaviour** | See §2.3 | This is the most serious honesty defect found |

### 1.3 Supabase authentication and account creation

| Item | Status | Evidence |
|---|---|---|
| Sign up | IMPLEMENTED | `apps/mobile/src/supabase/auth.ts:51-98` — `client.auth.signUp(...)` |
| Sign in | IMPLEMENTED | `supabase/auth.ts:103-144` — `signInWithPassword` |
| Sign out | IMPLEMENTED | `supabase/auth.ts:149-164`; local clear at `AccountProvider.tsx:274-283` |
| Password reset (request + apply) | IMPLEMENTED | `supabase/auth.ts:170-228`; deep link at `supabase/linking.ts:64-114` |
| Account deletion | IMPLEMENTED | `supabase/auth.ts:233-254` — `client.rpc('delete_user_account')` |
| Client construction | IMPLEMENTED | `supabase/client.ts:74-78`; returns `null` when unconfigured and every operation degrades with a message |
| OAuth / social sign-in | **MISSING** | No `signInWithOAuth`/`signInWithIdToken` anywhere. `AccountSheet.tsx:574` states Google Sign-In is not enabled on the project |
| **Any of the above tested against the live project** | **NOT-TESTED** | No sign-in, sign-up or reset round trip appears in the repository |

### 1.4 Super Admin provisioning and authorization

**See §4 for the full finding.** Summary: authorization is genuinely server-side and correct; **provisioning does not exist as an automated step**.

### 1.5 User profile and guest-to-account migration

| Item | Status | Evidence |
|---|---|---|
| Profile completion status | IMPLEMENTED | `ProfileScreen.tsx:64-83` — derived checklist |
| Display-name write | IMPLEMENTED | `AccountProvider.tsx:318-372` — writes `profiles` and deliberately excludes `role`/`status` |
| Profile photo / avatar upload | **MISSING** | `ProfileScreen.tsx:250-259`: *"No upload control, because there is no picker in this build"*. `avatar_url` is only ever **read** (`AccountProvider.tsx:139,158`); nothing writes it. No `.upload(`, `storage.from(`, `createSignedUrl` or `getPublicUrl` call exists anywhere in `apps/mobile/src` |
| Emergency contact / trusted identity / SOS | **MISSING** | Repo-wide search for `emergency`, `SOS`, `trusted contact`, `next of kin`, `guardian` across `apps/`, `packages/`, `supabase/` returns **zero** hits. Entirely unstarted |
| Local persistence | IMPLEMENTED | `apps/mobile/src/storage/index.ts:27-49`, versioned `sv/v1/...` namespace; preferences restored at `AppState.tsx:176-189`, theme at `ThemeProvider.tsx:73-96`, OLED at `useOledStudio.ts:281-286` |
| History local cap | IMPLEMENTED | 200 entries (`storage/index.ts:68`) |
| Cloud sync | **PARTIAL — manual only** | `supabase/sync.ts` has a real `SyncStatus = 'idle'\|'syncing'\|'synced'\|'error'\|'offline'` machine, but the **only** triggers are post-sign-in (`AccountSheet.tsx:135`) and a "Sync Now" button (`AccountSheet.tsx:229`). No foreground/resume sync, no retry, no queue — `pendingChangesCount` is hard-coded `0` (`sync.ts:30`) |

### 1.6 User management, history, activity and audit logs

| Item | Status | Evidence |
|---|---|---|
| Admin user search / filters / pagination | IMPLEMENTED | `apps/backend/src/routes/admin.ts:137-182` — `q` ilike on email + display_name, `status` filter, `page`/`perPage` |
| Registered vs guest separation | **PARTIAL** | `GET /admin/users` reads `profiles` only, so guests are simply absent. There is **no guest table, no guest column, and zero "guest" references anywhere server-side**. Honest (guest records are never counted as registered users) but it does not give the brief's "accurate separation of registered users and locally tracked/server-tracked guests" |
| Per-user detail | **PARTIAL** | `admin.ts:185-199` returns profile fields only. No activity, devices or diagnostics route |
| Admin audit log — write | IMPLEMENTED | `apps/backend/src/middleware/requireAdmin.ts:237-245`; written **before** the action and throws on failure, so an unrecorded change cannot occur |
| Admin audit log — read | IMPLEMENTED | `admin.ts:202-226` |
| Audit log append-only | IMPLEMENTED | No route updates or deletes it; DB-level `REVOKE UPDATE, DELETE, TRUNCATE` on the table |
| Reason required | IMPLEMENTED | `admin.ts:76-90` (≥3 chars) plus DB `CHECK` |
| **Actor email recorded** | **PARTIAL — defect** | `requireAdmin.ts:211` hardcodes `request.adminActor = { id: user.id, email: null }`, so the `actor_email` column in `admin_audit_log` is **always NULL**. Attribution works via `actor_id` only; the email column is dead. See §2.3 |
| Read operations audited | **MISSING** | No `GET /admin/*` writes an audit row; denied attempts are logged but not audited |
| App's own diagnostic audit | IMPLEMENTED | `apps/mobile/src/audit/findings.ts` — a pure function mapping a snapshot to severity-graded rows, where a row is `healthy` only when something actually reported |

### 1.7 Maintenance mode

| Item | Status | Evidence |
|---|---|---|
| Flag storage | IMPLEMENTED | `app_settings` key `'maintenance'`; written by the backend service-role client (`admin.ts:682-687`), read **directly by the mobile client** (`apps/mobile/src/maintenance/controller.ts:179-183`) |
| **Server-side enforcement** | **MISSING** | No middleware, preHandler or route guard in `apps/backend/src` consults the maintenance flag. Grep for `maintenance` in the backend returns hits **only** inside `admin.ts`'s own read/write routes. Enforcement is 100% client-side |
| Blocks the whole app, not just the Dashboard | IMPLEMENTED | `RootNavigator.tsx:210,225` — the early return renders `MaintenanceScreen` **before** the intro route and before any tab. Nothing dashboard-specific exists |
| Blocks sign-in | **NOT BLOCKED (deliberate)** | `RootNavigator.tsx:243-247` still mounts `AccountSheet` so an administrator can sign in. A non-admin who signs in stays blocked |
| Blocks sign-up | **UI-ONLY** | `AccountSheet.tsx:428` `disabled={maintenanceOn}`. There is no server-side block — the Supabase signup endpoint remains directly reachable |
| Branded maintenance screen | IMPLEMENTED | `screens/MaintenanceScreen.tsx` — orb, wordmark, badge, operator message, expected-end and closed-since timestamps, offline explanation, and a hidden admin entry after 7 taps (`:30`) |
| 10-second countdown | IMPLEMENTED | `MaintenanceScreen.tsx:18,88-103,178` — a 1 Hz interval that re-asks every 10s and says so |
| Refresh triggers | IMPLEMENTED | Launch (`AppState.tsx:287`), app return to foreground (`AppState.tsx:290`), and every 10s while blocked. **No refresh while the app is open, foregrounded and not in maintenance** — so maintenance turned on is not noticed until relaunch or a background/resume cycle |
| Offline / stale cache | **PARTIAL — documented trade-off with a real gap** | `controller.ts:136-158`: a cached **on** keeps the app closed; a cached **off**, **or no cache at all**, opens the app with status `'unreadable'`. `checkedAtMs` is recorded but **never used to age the cache out**. Code comments acknowledge this (`controller.ts:23-28`) |
| Admin recovery during maintenance | IMPLEMENTED | `RootNavigator.tsx:211` `adminExempt`; the exemption grants nothing the backend would not re-check |
| Maintenance audited with actor + reason | IMPLEMENTED | `admin.ts:656-668`; message mandatory to turn it on (`admin.ts:649-654`) |

### 1.8 Announcements and notifications

| Item | Status | Evidence |
|---|---|---|
| Announcements table + admin create/update | IMPLEMENTED | `admin.ts:505-626`; table in `20261014000000_admin_audit_maintenance.sql:502-558` |
| Announcement delete | **MISSING** | No DELETE route |
| **End-user read path** | **MISSING** | Grep of `apps/mobile/src` for `announcement` returns only the admin client, the admin screen and type definitions. **A published announcement is written and then displayed to nobody.** The user-facing half does not exist |
| Audience targeting | **MISSING** | No `audience`/`target` column |
| Severity | IMPLEMENTED | `info\|warning\|critical`, DB `CHECK` |
| Scheduling / expiry | **PARTIAL** | `expires_at` stored and enforced in the read policy; publication is a boolean stamped "now" — no future-dated publish |
| Read/unread state | **MISSING** | No `read_at` column and no read-tracking table anywhere |
| Android push state machine | IMPLEMENTED | `apps/mobile/src/notifications/` — permission, token acquisition, registration via `rpc('register_device_push_token')`, refresh, release on sign-out, foreground, tap, cold start |
| Backend dispatch | IMPLEMENTED | `services/firebase.ts:105-121` `messaging.send(...)`; routes guarded by the internal shared secret |
| **Evidence of any delivery** | **NOT-TESTED** | No test, log or record shows a message arriving. `docs/final-delivery-report.md:211-213` states no notification has ever been delivered |
| iOS | **NOT IMPLEMENTED — ON HOLD** | `apps/mobile/ios/` has only an inert plist; no messaging code, no pods entry |
| `google-services.json` | Present locally, **gitignored and untracked** | `apps/mobile/android/app/google-services.json`; `.gitignore:35`. The Gradle plugin is applied **conditionally** on the file existing (`android/app/build.gradle:26-34`) |

### 1.9 Email / SMTP

| Item | Status | Evidence |
|---|---|---|
| Transactional email code | IMPLEMENTED-UNVERIFIED | `apps/backend/src/routes/email.ts` + `services/email.ts` — three templates: security alert, welcome, generic |
| Transport | IMPLEMENTED | `services/email.ts:44-52` — nodemailer SMTP, default `smtp.gmail.com:465`. Unconfigured ⇒ transporter null and every send returns `accepted:false` |
| Route protection | IMPLEMENTED | Send routes require `API_INTERNAL_SECRET` (`middleware/auth.ts`) |
| Email health endpoint | **IMPLEMENTED but unauthenticated** | `GET /email/status` (`email.ts:38-55`) has **no preHandler**. It returns `{configured, host, port, secure, sender, connected, error}`. No password or credential is echoed — but the host, port, sender address and raw SMTP error text are public |
| **"Outbound SMTP is blocked on Render Free"** | **NOT RECORDED ANYWHERE IN THE REPOSITORY** | Repo-wide search of `docs/`, `apps/backend/` and `render.yaml` for render+SMTP, outbound, egress, port 25: **no such statement exists.** The brief cites it as fact from "the latest report", but the repo does not record it and no code accounts for it. `render.yaml:5` does confirm `plan: free` and configures `SMTP_*` |
| HTTPS email-API fallback | **MISSING** | No Resend/SendGrid/Postmark/Mailgun/Brevo/SES/mailjet. `apps/backend/package.json` has `nodemailer` only |

### 1.10 Supabase PostgreSQL, RLS and Storage

Read-only structural view. **The authoritative permission matrix is Gemini's deliverable — not reproduced here.**

| Item | Status | Evidence |
|---|---|---|
| Migrations present | 4 files in `supabase/migrations/` | `20261012000000_sanket_vaanni_initial.sql` (207 lines), `20261013000000_storage_user_media_policies.sql` (55), `20261014000000_admin_audit_maintenance.sql` (788), `20261014000001_device_push_tokens.sql` (321) |
| Tables defined | 9 | `profiles`, `user_preferences`, `calibration_profiles`, `oled_profiles`, `user_history`, `admin_audit_log`, `app_settings`, `announcements`, `device_push_tokens` |
| RLS enabled | All 9 | Per the migration SQL |
| Storage bucket policies | IMPLEMENTED (SQL) | `20261013000000_...sql:14-55` — SELECT/INSERT/UPDATE/DELETE, `TO authenticated`, owner-scoped by `(storage.foldername(name))[1] = (auth.uid())::text` |
| Bucket row creation | **MISSING** | No `insert into storage.buckets` in any migration. The bucket must be created by hand in the dashboard; `docs/final-delivery-report.md:225-227` records it answering `NoSuchBucket` and marks the migration **unconfirmed** |
| Media type/size validation | **MISSING** | No MIME or size constraint anywhere |
| Migrations applied remotely | 2 of 4 | `admin_audit_maintenance` and `device_push_tokens` are **not applied**. Against the live project today, maintenance mode's backing row, the audit log, announcements and the push-token table do not exist |
| A second/parallel auth store | **NONE FOUND** | No `users` table outside Supabase Auth, no local password store, no JWT secret in the app |

### 1.11 Image and video upload

| Item | Status | Evidence |
|---|---|---|
| Client upload code | **MISSING** | Zero `.upload(`, `storage.from(`, `createSignedUrl`, `getPublicUrl` matches in `apps/mobile/src` |
| Download / signed URL | **MISSING** | Same |
| Deletion | **MISSING client-side** | A DELETE policy exists; no client call exists |
| Probe | **MISSING** | Not even a text probe exists in the app |
| Tested against the live service | **NO** | No round trip of any kind appears in the repository |

### 1.12 About Us content management

| Item | Status | Evidence |
|---|---|---|
| Five contributor slots | IMPLEMENTED | `apps/mobile/src/about/team.ts` — five `TeamMember` records, every field `null` |
| No fabricated content | **IMPLEMENTED, exemplary** | The file's header explains why: *"a filled-in placeholder is indistinguishable from a real person to everyone except the people who filled it in"* |
| Team layout | IMPLEMENTED | `AboutScreen.tsx:71-72` rows with an `Avatar` that renders initials until a photo exists |
| Animated left/right reveal or staggered layout | **MISSING** | `grep -n "Animated\|useNativeDriver\|stagger\|translateX\|withTiming\|interpolate"` on `AboutScreen.tsx` returns **zero** hits. There is no animation in the file |
| Admin-configurable role/bio | **MISSING** | Content is a hardcoded TypeScript constant. No backend route, no table, no admin UI |

### 1.13 ML settings and the glove-training platform

| Item | Status | Evidence |
|---|---|---|
| `ml/` contents | **EMPTY BY DESIGN** | Exactly one file: `ml/README.md`. No datasets, training, evaluation, export or checkpoints. A repo-wide `find` for `*.onnx *.tflite *.pt *.pth *.h5 *.pb *.csv *.ipynb` returns **nothing** |
| Dataset | **MISSING** | `ml/README.md:5` — *"No dataset has been collected"*. No sample count, format or labels exist to report because no data file exists |
| Trained model | **MISSING** | No weights anywhere in the repository |
| Evaluation metric from real data | **MISSING** | No script computes one. `docs/testing-strategy.md:48`: *"No accuracy figure exists yet… Any figure in this repository today should be treated as absent, not as an estimate"* |
| Train/val/test split, preprocessing, versioning, rollback | **MISSING** | No training code of any kind |
| Unknown/ambiguous gesture + confidence | **PARTIAL (scaffold only)** | `recognition/outcome.ts:49` defines a `0.7` threshold and an `'uncertain'` outcome, and the same file warns it is *"a presentation threshold, not a validated operating point… this number has no empirical basis"*. Nothing produces a confidence value |
| **Any model loaded at runtime** | **NO** | `AppState.tsx:206` wires `new UnimplementedRecogniser(profile)`; `recognition/index.ts:69-81` hardcodes `isAvailable = false` and `recognise()` returns `null`. All profiles are `status: 'planned'`, `vocabularySize: 0` (`recognition/profiles.ts:66-94`) |
| ML settings UI | **UI-ONLY (honest)** | `MlScreen.tsx` reports model/vocabulary status; it administers nothing and claims nothing |
| `docs/hand-model-evaluation.md` | **Real numbers, but not ML** | Its metrics are produced by a real script (`design-reference/evaluate_hands.py`) and backed by real artifacts — but they evaluate **3D mesh assets**, not gesture recognition, and nothing in `ml/` backs them |

### 1.14 Android application and backend/cloud integration

| Item | Status | Evidence |
|---|---|---|
| Android app | IMPLEMENTED | `apps/mobile/android/`; APKs in `release/` |
| Native modules | IMPLEMENTED | `android/app/src/main/java/com/sanketvaani/native/` — `SpeechRecognizerBridge.kt`, `SanketVaanniModule.kt`, `SanketVaanniPackage.kt` |
| Backend API | IMPLEMENTED | Fastify, 5 route plugins, 2 services |
| Backend database access | IMPLEMENTED | Service-role client confined to the server |
| Cloud deployment blueprint | IMPLEMENTED | `render.yaml` — `plan: free`, `rootDir: apps/backend` |
| **Deploy blocker: Firebase credentials** | **MISSING FROM THE BLUEPRINT** | `GOOGLE_APPLICATION_CREDENTIALS` is in `apps/backend/.env.example` but **absent from `render.yaml`**. `services/firebase.ts:61-62` initialises with `cert(resolvedPath)` — a **filesystem path** to the service-account JSON — which a Render container has no way to supply. Push dispatch cannot work on the deployed backend as configured |
| Deploy blocker: SMTP | **UNVERIFIED** | See §1.9 |
| Web dashboard (`apps/web`) | **DOES NOT EXIST** | Contains only `.env.example` and `README.md`, which says *"Do not scaffold Next.js here until M8"* |
| CI/CD | **MISSING** | No workflow files found |

### 1.15 OLED, BLE, calibration and physical glove connectivity

| Item | Status | Evidence |
|---|---|---|
| Glove firmware | **MISSING** | `firmware/` contains only two READMEs. No `.ino`, `.c`, `.cpp`, no ESP-IDF/Arduino project. `right-glove/README.md:5` — *"This directory is empty on purpose"* |
| BLE protocol | **MISSING (placeholders only)** | `docs/ble-protocol.md:16` — *"No UUID in this file is real. Placeholders are written as `<UNVERIFIED: …>`"* |
| Wire format in contracts | **DELIBERATELY ABSENT** | `packages/contracts/src/sensor.ts:4-8` — *"There is no wire-format type here, and that is deliberate"* |
| Real BLE client | **STUB** | `apps/mobile/src/ble/bleTransport.ts:55-61` — `scan()` and `connect()` both `throw new ProtocolUnverifiedError()`. No BLE library in `apps/mobile/package.json`; no Bluetooth permission in the manifest |
| What runs instead | **SIMULATED, labelled** | `AppState.tsx:136,139` construct `MockTransport('left'/'right')` emitting synthetic 20 Hz frames. `ble/mockTransport.ts:12-16` — *"It is not a model of the hardware… not derived from a measurement"*. The `__demo__` sentinel prevents a "live" label (`ble/types.ts:56`) |
| Flex/IMU values | **SIMULATED** | `mockTransport.ts:51-56,206-215` — per-finger sine waves; *"Values are illustrative, not measured"* |
| Calibration data | **PARTIAL** | Structure exists (`sensors/calibration.ts:26-45`); the only instance is `createDemoCalibration` with `rest: 0, fullFlex: 1`, documented as *"NOT a usable calibration for real hardware"*. The capture flow is **MISSING** (milestone M3) |
| Signal pipeline | **IMPLEMENTED (real maths, synthetic input)** | `sensors/processing.ts:26` EMA smoother; `calibration.ts:90-98` clamped signed-span normalisation |
| OLED: what the app sends | **NOTHING** | `oled/layout.ts:19-26` — *"There is no command encoding here. No byte sequence is produced, and nothing in this file claims a panel was written to"* |
| OLED: verified command set | **MISSING** | No serialiser exists |
| OLED: does saving a profile write to a panel? | **NO** | `oled/useOledStudio.ts:238` writes AsyncStorage only. Confirmed by `audit/findings.ts:395` |
| OLED media/image pipeline | **PARTIAL** | Constraint copy and exact-output preview implemented; picker, crop/fit, threshold/dither, video trim and any device write are **not implemented and not claimed** (`docs/oled-media.md:168-178`) |
| **Tested on physical hardware** | **NOT-TESTED** | `docs/final-delivery-report.md:237` — *"no glove present. The simulator ran; hardware did not"* |

### 1.16 Textboard / live captions

| Item | Status | Evidence |
|---|---|---|
| Speech-to-text engine | **IMPLEMENTED (real native recogniser)** | `SpeechRecognizerBridge.kt` uses the platform `android.speech.SpeechRecognizer`: `createSpeechRecognizer` (`:129`), `ACTION_RECOGNIZE_SPEECH` (`:195`), `startListening` (`:213`) |
| Microphone permission | IMPLEMENTED | `captions/controller.ts:367-386`; requested only on user action (`:188-201`), declared in the manifest |
| Listening status / start / stop | IMPLEMENTED | `controller.ts:54` state `'idle'\|'starting'\|'listening'\|'denied'\|'error'`; `start()` `:188`, `stop()` `:229` |
| Error handling | IMPLEMENTED | Kotlin `describeError` is exhaustive over Android's codes (`:291-306`); mapped to `snapshot.error` (`controller.ts:325-343`) |
| Language selection | IMPLEMENTED | `controller.ts:215` from `preferences.targetLanguageCode`; Kotlin sets `EXTRA_LANGUAGE` |
| Transcript clearing | IMPLEMENTED | `controller.ts:253-257` → `nativeClearTranscript()` |
| Accessibility-friendly text sizing | IMPLEMENTED | `TextboardScreen.tsx:204-228` — settled lines use heading/body variants; interim text is smaller, muted, with a trailing ellipsis |
| Separated from glove sign-to-text | IMPLEMENTED by design | `controller.ts:42` `CaptionSource = 'microphone' \| 'glove' \| 'typed'`; each line badged with provenance (`captions/provenance.ts`). Note: since no recogniser exists, **glove lines are never actually produced** |
| Offline guarantee | **HONESTLY NOT CLAIMED** | `SpeechRecognizerBridge.kt:24-31` — `EXTRA_PREFER_OFFLINE` is a *preference*, and the bridge *"never reports whether recognition was local, because it cannot know"* |
| **Demonstrated working end-to-end** | **NOT-TESTED** | Only store-rule tests exist (`__tests__/captions.test.ts`), no real audio |

### 1.17 Recognition and translation output

| Item | Status | Evidence |
|---|---|---|
| Recognition | **STUB** | `recognition/index.ts:78-80` — `recognise()` always returns `null`; `isAvailable = false` |
| Translation | **STUB** | `translation/index.ts:46-51` — `translate()` returns `null`; `isAvailable = false` |
| Any surface displaying a non-real sign or translation | **NONE — verified** | Every text-bearing surface is gated behind `outcome.kind === 'result'`, a state unreachable because `recognise()` returns `null`. `RecognitionPanel.tsx:170` renders "Not implemented"; `TranslatorPanel.tsx:74` shows a hard-coded "Not implemented" badge; the OLED panel draws `--` |
| Tests guarding this | IMPLEMENTED | `__tests__/honesty.test.tsx` asserts no percentage appears on a fresh Dashboard; `__tests__/recognition.test.ts` exists *"mainly to fail if someone later adds a placeholder that invents a sign or a confidence"* |
| 3D hand viewer | IMPLEMENTED (model viewer) | `webview/hands/*.html` + three.js, posed from flex via `hands/pose.ts`. It is a viewer, **not** a recogniser, and displays no recognised sign |

### 1.18 UI/UX quality, accessibility, spacing and navigation

| Item | Status | Evidence |
|---|---|---|
| Theme system | IMPLEMENTED | `theme/` with `ThemeProvider`, light/dark, accent, and a preference-not-platform-scheme model |
| Accessibility semantics | IMPLEMENTED | `accessibilityRole`/`accessibilityLabel` used throughout, e.g. `BrandHeader.tsx:93,120-134`; `TabBar.tsx:139` |
| Reduced-motion handling | **NOT VERIFIED** | Not established in this pass |
| Touch targets | **NOT VERIFIED** | Not established in this pass |
| **Density / verbosity** | **CONFIRMED PROBLEM** | `DashboardScreen.tsx` renders ~11 stacked blocks before any sheet — `BrandHeader`, `GuestBanner`, `GloveConnectionBar`, `OrbStage`, `DetectedTextCard`, `ActionButton`, `VoicePanel`, `HandViewer`, `FingerReadings`, `DiagnosticsCard`, `ActionButton` (`:240-313`). Screen sizes: `OledScreen.tsx` 1579 lines, `AdminScreen.tsx` 1035, `DashboardScreen.tsx` 733 |
| Dashboard redesign | **NOT PERFORMED — awaiting approval** | Per the brief |

### 1.19 Tests and coverage

| Item | Status | Evidence |
|---|---|---|
| Mobile tests | 31 files in `apps/mobile/__tests__/` (30 collected + `support.tsx` scaffolding) | Run with `npm test` (jest). Broad and unusually substantive: pose maths, honesty assertions, launch flow, storage round-trips, OLED model, accessibility layout |
| Backend tests | 2 files in `apps/backend/test/` | Run with `npm test` (vitest) |
| Static analysis | PARTIAL | `npm run typecheck` in both apps; `npm run lint` is mobile-only — `docs/final-delivery-report.md:134` records the backend has **no ESLint config or dependency** |
| **Mock-dependent tests** | **3 suites** | `supabase-auth.test.ts` asserts only on a hand-written mock client; `supabase-sync.test.ts` verifies the mock was called, not that anything persisted; `supabase-client.test.ts:64` asserts on `AsyncStorage` itself rather than the app's adapter. These would pass with the feature broken. Separately, **two tests are tautological** and are listed as defects in §2.3 (D12) |
| Test counts | 481 mobile assertions across 30 suites; 18 backend | `docs/final-delivery-report.md` also discloses a flaky run and a 481-vs-463 count discrepancy in its own text, which is itself a mark of honesty rather than a problem |
| **End-to-end test against real backend / real Supabase / real device** | **MISSING** | None exists |
| Device evidence | PARTIAL | `docs/final-delivery-report.md:55-79` records screens verified running on a real handset (vivo V2141, Android 14) |

### 1.20 Documentation

| Item | Status |
|---|---|
| Doc set | 16 markdown files in `docs/`, plus two PNG asset directories (`left-hand-orientation-fix/`, `screenshots-final/`) |
| `docs/architecture.md` | **STALE — materially contradicts the code.** It states: *"No database. No ORM. No migrations."*, *"No authentication provider or API keys."*, *"No account, login or profile of any kind. No screen offers one"*, *"backend — Stateless REST API. No database yet"*, and describes *"four tab keys: dashboard, oled, audit, more"*. All five statements are now false — Supabase Auth, Postgres, 9 tables, a Profile screen and a changed tab bar all exist. This is the document a new contributor reads first |
| `docs/roadmap.md` | **STALE in the same direction.** M1 is marked "this milestone" complete; M6 (database) and M7 (authentication) — which the doc describes as *"the first point a requirement justifies it"* — are both already built |
| `docs/hand-viewer.md` | **SUPERSEDED, not annotated.** A dated findings document recording that no 3D dependency was evaluated. Commit `a4a537e` later shipped the three.js hand viewer; the doc does not say its conclusion was revisited (D3) |
| `docs/supabase-setup.md` | **Mostly honest, two flaws.** Line 166 states the OLED conflict key is `(user_id, name)`; it is `(user_id, profile_id)`. And §7 asserts the bucket is "**Private** (`public = false`)" at line 176 — then retracts the section as unconfirmed at line 180. The confident claim survives above its own retraction (D11) |
| `docs/integrations-guide.md` | **CONTAINS AN IMPLEMENTATION THAT DOES NOT EXIST.** Lines 143-147, under "Integration Matrix & Implementation Status", list Firebase Web Push in `apps/web`: a VAPID key, `NEXT_PUBLIC_FIREBASE_VAPID_KEY` in `apps/web/.env.local`, and `apps/web/public/firebase-messaging-sw.js`. `apps/web` contains only `.env.example` and a README that says not to scaffold it until M8. (The VAPID key is a public key by design, so this is a fabrication-of-status problem, not a secret leak) |
| `docs/final-delivery-report.md` | **STRONG.** Has explicit sections for "Configured-but-unverified, and not-configured — separated", "Blocked / not tested", "Deliberately not implemented" and "Corrections to earlier statements". One line is now stale: it says `release/` holds "only these two files" and four APKs are present — the accompanying "no `.env`, no JSON key, no keystore" claim still holds |
| `docs/remediation-report.md` | **STRONG** for its scope. Its §2 claims are scoped accurately — including the `is_active()` tightening, which names the four tables it actually rewrote. What it omits is that `profiles` was left ungated (D9). Its "145 assertions" figure cannot be reproduced from the repository (D10) |
| `docs/testing-strategy.md` | **HONEST** — explicitly says any accuracy figure should be treated as absent |

---

## 2. Gap analysis

### 2.1 Existing and working (real code, no invented behaviour)

Guest-first launch; Supabase auth wrappers; local persistence and restore; the theme system; the full navigation shell; the brand header; the Textboard captions pipeline including a real native Android recogniser; the 3D hand viewer; the OLED design model and preview; the runtime signal pipeline; the app's own evidence-based audit module; server-side admin authorization; the admin API's write surface with mandatory reasons and pre-write audit; the token-registry design; 31 mobile test suites with genuine assertions.

### 2.2 Missing or incomplete against the brief

| Brief section | Gap |
|---|---|
| §3.A | Font from the intro video not used (deliberate, needs a licensing decision); tab labelled "Settings" not "More"; extra History tab; header not on every screen |
| §3.B | Guest banner not persistent; guest→account migration has no consent, no duplicate protection, no conflict handling, no surfaced sync state — and the in-app copy contradicts the behaviour (§2.3) |
| §3.C | No animation/staggered layout; no admin-configurable role/bio; content is a hardcoded constant |
| §3.D | None material — the caption separation is done well. Only real-audio verification is outstanding |
| §3.E | Emergency contact / trusted identity / SOS entirely absent; profile photo upload absent; sync is manual-only with no queue |
| §3.F | Bulk suspension, account termination, announcement delete, per-user warnings/notifications, per-user activity/devices/diagnostics, admin-guarded email health, About Us CMS, ML administration — all missing. Registered-vs-guest separation is implicit rather than explicit |
| §3.G | No server-side enforcement; sign-up not blocked server-side; no cache expiry; no `TRUNCATE`-equivalent for maintenance; no refresh while foregrounded and not blocked |
| §3.H | No HTTPS email-API fallback; `GET /email/status` is unauthenticated; the Render SMTP-blockage caveat is not recorded anywhere in the repo |
| §3.I | No end-user announcement read path; no audiences; no read/unread; no delivery evidence; delivery cannot work on the deployed backend as configured (§1.14) |
| §3.J | No upload, download, signed-URL, validation or deletion path; the bucket row is not created by any migration; nothing tested |
| §3.K | `ml/` empty, no dataset, no model, no metrics, no pipeline. Preconditioned on firmware that does not exist |
| §4 | Storage bucket uncreated; two migrations unapplied; media validation absent |
| §5 | Density problem confirmed; Dashboard redesign correctly withheld pending approval |
| §6 | No end-to-end suite exists (correctly reserved for the end, per the brief) |

### 2.3 Defects found — where the app's claims and its behaviour disagree

These are the findings most worth the owner's attention, because the rest of the codebase holds itself to a high standard and these are the places where it does not.

**D1 — The app promises it will not upload guest data, then uploads it. (Highest priority.)**
`AccountSheet.tsx:584-586` tells the user:

> *"A guest who has never signed in does not exist on the server at all, so no administrator can see, restore or recover that data — **and signing in later does not upload it.**"*

`supabase/sync.ts:113-123` does exactly that:

```ts
if (!remote) {
  // Upload local preferences to remote
  const { upsertErr } = await client.from('user_preferences').upsert({ user_id: userId, … });
```

`syncOledProfiles` merges local→remote on the same path. The trigger is post-sign-in (`AccountSheet.tsx:135`) — precisely the moment the copy says nothing will be uploaded. This is a consent and truthfulness defect, not a crash.

**D2 — `admin_audit_log.actor_email` is always NULL.**
`requireAdmin.ts:211` hardcodes `email: null`, so the column the audit log records attribution into is never populated. Attribution survives via `actor_id`, and the mobile UI falls back to it (`AdminScreen.tsx:566`), but a column that is documented as recorded and is structurally always empty is misleading — especially in an append-only audit log.

**D3 — Three documents describe a system that no longer exists.**
`docs/architecture.md` states *"No database. No ORM. No migrations."*, *"No authentication provider or API keys."*, *"No account, login or profile of any kind. No screen offers one"*, and lists four tab keys `dashboard, oled, audit, more`. Every one of those is now false — Supabase Auth, Postgres, 9 tables, a Profile screen and a five-tab bar with different keys all exist. It is dated Oct 10 (M1) and is the entry point for anyone new. `docs/roadmap.md` is stale in the same direction: it marks M6 (database) and M7 (authentication) as future work under *"the first point a requirement justifies it"*, and both are built. `docs/hand-viewer.md` is a dated findings document — the statement *"No 3D dependency was added, and none was evaluated"* was true when written, and commit `a4a537e` ("feat: complete 3D hand viewer") later shipped a three.js viewer; the document does not record that its own conclusion was superseded. Only the first two are wrong; the third is simply not annotated as historical.

**D4 — `docs/integrations-guide.md` describes a Firebase Web Push implementation in `apps/web` that does not exist.**
See §1.20. VAPID key, env variable and service-worker path for a directory containing two files.

**D5 — No server-side enforcement of maintenance mode.**
The app blocks itself; the backend does not. A client that ignores the flag — a modified build, or any direct API caller — is not blocked at all. The client-side implementation is careful and honest, but the brief's requirement is a *server-enforced* global flag.

**D6 — The audit log does not record reads or denied attempts.** No `GET /admin/*` writes a row. Denials are logged to stdout only.

**D7 — The maintenance cache has no expiry.** `checkedAtMs` is stored and never used; a device that last saw "off" opens the app offline indefinitely.

**D8 — `GET /email/status` is unauthenticated.** It leaks the SMTP host, port, sender address and raw connection error text to anyone.

**D9 — Suspension does not gate the `profiles` table itself.** `docs/remediation-report.md:358-360` says the migration tightened `user_preferences`, `calibration_profiles`, `oled_profiles` and `user_history` by adding `is_active()` to every SELECT, INSERT and UPDATE policy — and that claim is **accurate and correctly scoped to those four tables**. What the document does not state is the consequence: `profiles` was **not** tightened. Its three own-row policies are still `USING (auth.uid() = id)` with no `is_active()` term (`20261012000000_...sql:78-92`), and the initial migration contains no reference to `is_active()` at all. So a **suspended account can still read and update its own profile row** — display name and avatar — while being locked out of every other table. Severity is low, because `enforce_profile_privilege_boundary` still stops the account reinstating itself and the suspension does block the data that matters, but the asymmetry is real and currently undocumented. **This is a database-policy finding, so it sits inside Gemini's workstream — recorded here for reconciliation, not as a proposed change.**

**D10 — A line in the in-repo validation harness cannot run.** `supabase/.temp/privilege-checks.sql:339` calls `public.is_admin('1111…')` **with an argument**, but the revised migration defines `is_admin()` with **no** argument (`20261014000000_...sql:214`) — the disarming of the old id-probing oracle is precisely what changed the signature. That line would raise *"function does not exist"*. The file is gitignored and self-described as a harness, so nothing shipped is affected, but the repository does not contain a runnable reproduction of the validation it is meant to support.

**D11 — `docs/supabase-setup.md` is stale in one line and self-contradictory in one place.** Line 166 says OLED profiles are *"upserted with unique constraints on `(user_id, name)`"*; the actual conflict key is `(user_id, profile_id)`, and `apps/mobile/src/supabase/types.ts:135-147` carries a comment explaining why `name` must not be the key. Separately, §7 states confidently that the bucket is *"**Private** (`public = false`)"* at line 176, and then four lines later retracts the whole section as **unconfirmed** — the confident claim survives above its own retraction, which is the wrong way round for a reader skimming.

**D12 — Two tests are structurally incapable of failing.** `storage.test.ts:94-105` is titled around handling unparseable history but writes a **valid** entry, then asserts the data is valid — it never writes corrupt data, so it passes whether or not corruption is handled. `supabase-client.test.ts:21-34` branches on `isSupabaseAvailable()` and asserts the matching expectation in each branch, so it passes whichever way configuration resolves. Both are tautologies rather than weakened assertions. This is narrower than the mock-dependence noted in §1.19 (those test something real, just against a double); these two assert nothing at all.

**D13 — Minor surface findings.** `supabase/config.toml` exists but is **0 bytes** — there is no local Supabase CLI configuration. `apps/mobile/android/app/debug.keystore` **is committed**; this is a standard React Native debug keystore, not a release signing key, and it is not a leak — but it should not be mistaken for evidence of a release-signing setup, which does not exist in this repository. No service-account JSON, no `*.jks`, `*.p12` or `*.pem`, and no credential file of any kind is tracked, which is the correct state.

---

## 3. Dependency and security blockers

### 3.1 Security — verified sound

These were checked by reading the code, not by assuming:

- **Admin authorization is genuinely server-side.** `apps/backend/src/middleware/requireAdmin.ts:147` validates the bearer token through Supabase Auth (`authClient.auth.getUser(token)`); lines 156-160 read `role` and `status` from `profiles` with the **service-role** client; line 196 denies unless `role === 'admin'`; line 205 denies unless `status === 'active'`. No client-supplied role or actor id is trusted anywhere.
- **The client-side admin flag is not an authorization boundary, and the code says so.** `AccountProvider.tsx:19-26` and `AdminScreen.tsx:51-59` document that `isAdmin` is a UI hint only. Every privileged action is re-authorized on the backend.
- **Missing credentials fail closed.** `requireAdmin.ts:169-172` answers every admin request with **503** when the service-role client cannot be constructed, before any work.
- **The service-role key never reaches the client.** `grep` of `apps/mobile/src` for `service_role`, `SERVICE_ROLE`, `serviceRole`, `SECRET` returns **0 matches**. The mobile bundle loads only the publishable key.
- **No plaintext password handling.** No route or service stores, retrieves or returns a password or auth secret. The admin reset route asks the provider to email the user a reset link (`admin.ts:480`) and returns only a status. Passwords on the client flow only through the Supabase SDK.
- **Self-promotion is blocked at the database.** A trigger and CHECK constraints prevent a client from setting `role` or `status`; verified by execution in the earlier hardening pass.
- **No hardcoded admin credential.** No admin password, admin email constant or seeded credential exists anywhere in source. A repo-wide search found only support/contact addresses and test fixtures.
- **No secret is tracked in Git.** `apps/backend/.env` and `apps/mobile/.env` are present but gitignored; the Firebase service-account JSON lives **outside** the repository (`C:\SanketVaanni-Secrets\`); `google-services.json` and all `*.apk` files are gitignored. `release/` holds four APKs and no credential file. The one tracked key-like file, `apps/mobile/android/app/debug.keystore`, is the standard React Native **debug** keystore — not a release signing key (D13).
- **Only one identity store exists.** `public.profiles` is `id UUID PRIMARY KEY REFERENCES auth.users(id)`, populated by an `on_auth_user_created` trigger. There is no second user table, no `bcrypt`/`jsonwebtoken` dependency, no local password hash, and no JWT signing secret anywhere in `apps/*/src` or `packages/*/src`. Token verification is delegated to Supabase, never reimplemented.

### 3.2 Security — open items

| Item | Severity | Note |
|---|---|---|
| No server-side maintenance enforcement (D5) | **High** | The single widest gap between the brief and the implementation |
| `GET /email/status` unauthenticated (D8) | **Medium** | Information disclosure: host, port, sender, raw error text |
| `actor_email` always NULL (D2) | **Medium** | Audit attribution is weaker than documented |
| Storage bucket row not created by any migration | **Medium** | Upload cannot work until it is created; the migration is unconfirmed against the live project |
| No media type/size validation | **Medium** | Should be added with the bucket policy work |
| Reads and denied attempts not audited (D6) | **Low-Medium** | |
| Maintenance cache has no expiry (D7) | **Low-Medium** | Documented trade-off; the fix is to bound staleness, not to remove the fallback |
| `profiles` is not gated by `is_active()` (D9) | **Low** | A suspended account can still read and update its own display name and avatar. Self-reinstatement is still blocked by the privilege trigger. **Gemini's workstream** — recorded for reconciliation only |
| Three mock-dependent test suites | **Low** | They would pass with the feature broken |
| Two tautological tests (D12) | **Low** | `storage.test.ts:94-105` and `supabase-client.test.ts:21-34` assert nothing that could fail |
| A broken line in the in-repo validation harness (D10) | **Cosmetic** | `supabase/.temp/privilege-checks.sql:339` calls the no-arg `is_admin()` with an argument |
| Stale docs: `architecture.md`, `roadmap.md`, `hand-viewer.md`, one line of `supabase-setup.md` (D3, D11) | **Low** | Misleads a new contributor; no runtime effect |
| The five core tables still carry Supabase's default `ALL` grant | **Owner decision** | Measured in the earlier validation pass and recorded in `docs/remediation-report.md` §5.3. **Gemini's workstream** — not touched here |

### 3.3 Non-security blockers

| Blocker | Blocks |
|---|---|
| No glove firmware, no verified BLE protocol | All hardware integration, calibration capture, real recognition, the ML dataset |
| No dataset, no model | Everything in §3.K |
| `apps/web` does not exist | Any web admin dashboard; the dashboard must currently be the mobile Admin screen |
| `GOOGLE_APPLICATION_CREDENTIALS` absent from `render.yaml`, and `firebase.ts` initialises from a **file path** | Push dispatch on the deployed backend |
| SMTP-only email, no HTTPS fallback; the Render blockage is unrecorded | Backend transactional email |
| Two migrations unapplied; storage bucket uncreated | Maintenance mode, announcements, audit log, push-token registration, uploads — against the live project |
| Supabase Auth requires email confirmation (`mailer_autoconfirm: false`) | Any real sign-up test |
| No Apple Developer account | iOS push (deliberately on hold) |
| ₹0 budget | No paid email API, no paid hosting tier |

---

## 4. Super Admin provisioning — the direct answer

**Does provisioning already exist? No. Not as an automated step.**

- There is **no bootstrap script, no seed, no first-admin route, and no migration** that creates or promotes the first administrator. A repo-wide search for `bootstrap`, `seed`, `first admin`, `ADMIN_EMAIL`, `INITIAL_ADMIN` and `SUPER_ADMIN` found only explanatory comments and one unrelated "re-seed the draft" in the OLED studio.
- The only role-changing route, `POST /admin/users/:id/role` (`admin.ts:363`), is itself behind `requireAdmin` — so it cannot be the path that mints the first administrator.
- The initial migration contains no role logic at all; the admin migration fixes existing accounts as `'user'`.
- Provisioning is therefore a **manual SQL step documented in a doc file**: `docs/remediation-report.md:164-178` gives an `UPDATE public.profiles SET role = 'admin' WHERE id = (SELECT id FROM auth.users WHERE email = …)` to be run in the Supabase SQL Editor. `docs/supabase-setup.md:84-86` references the same procedure.
- Combined with the **last-admin protection** (`admin.ts:290-313` refuses to suspend the last active admin, `admin.ts:383-399` refuses to demote it, and self-suspension/self-demotion are refused), an empty or locked admin set can only be recovered with direct database console access.

**How is Super Admin enforced? Correctly, and server-side.** See §3.1. The short version: token validated by Supabase Auth → role and status re-read from `profiles` using the service-role client on **every request** → deny unless `role === 'admin' AND status === 'active'` → fail closed with 503 if the privileged client is unavailable. The client-side `isAdmin` flag only decides whether to draw the menu.

**What is missing for a safe, documented, one-time bootstrap:** the procedure exists but is prose in a report, not an artifact. It should become a documented, repeatable, server-side bootstrap that (a) uses the Supabase Auth admin API where an account must be created, (b) never invents or stores a password, (c) drives a reset/rotation flow rather than a fixed credential, and (d) is idempotent and refuses to run once an administrator exists. Note the last-admin armoury means this procedure is also the documented break-glass recovery path — which today it is not.

---

## 5. Prioritized, phased implementation plan

Ownership note: **Gemini owns database permissions, RLS, migrations and backend permission files.** Phases below are marked by whether they can proceed now, must coordinate, or must wait.

### Phase 0 — Owner decisions (no code; blocks other phases)

| # | Decision needed | Blocks |
|---|---|---|
| 0.1 | **Approve the Dashboard** so UI/spacing work can begin | All §5 UI work |
| 0.2 | The five contributors' names, roles, biographies and photographs | About Us content |
| 0.3 | Whether to extract and license the intro video's Devanagari typeface, or accept the system face | §3.A header |
| 0.4 | Whether to add an HTTPS email API (zero-cost only) or accept that backend email is unverified | §3.H |
| 0.5 | How the Firebase service-account JSON will reach the deployed backend (Render secret file vs inline env) | Push dispatch in production |
| 0.6 | Authorize the guest-data consent design for D1 | Phase 1.1 |

### Phase 1 — Safe to start now, in parallel with Gemini (mobile-only; no file overlap)

Runs independently of the database-permission workstream. Touches `apps/mobile/` only.

| # | Work | Why safe | Acceptance criteria | Targeted tests |
|---|---|---|---|---|
| 1.1 | **Fix D1**: make the guest-data copy true and add explicit migration consent, duplicate protection, conflict handling and a visible sync state | Mobile-only. Does not change schema | The copy matches behaviour; a guest signing in is asked before anything is uploaded; duplicates are not created; each sync state is shown truthfully | Extend `supabase-sync.test.ts` against a real in-memory store, not a mock call assertion; a new test asserting no upload occurs without consent |
| 1.2 | Make the guest banner persistent: shown on every tab and dismissal persisted | Mobile-only | Visible on all five tabs until dismissed; dismissal survives relaunch | New render test per tab; a storage round-trip test |
| 1.3 | About Us presentation: staggered/animated layout, honouring reduced-motion | Mobile-only. Content stays null until 0.2 | Animation present and restrained; reduced-motion respected; five unfilled slots still render deliberately | New `about.test.tsx` |
| 1.4 | Tab bar: label the section "More", and decide History's placement with the owner | Mobile-only | Label matches the brief; tab order confirmed by the owner | Extend `launch-flow.test.tsx` |
| 1.5 | Avatar upload plumbing in the app (picker, validation, upload call, progress, retry, delete) | Mobile-only. **Uses** the existing bucket policy spec; does not change it | Picker works; type/size validated client-side; owner-scoped path; errors and retries surfaced | New upload test with a faked storage client |
| 1.6 | Bound the maintenance cache staleness (D7) — use the stored `checkedAtMs` | Mobile-only | A cache older than a defined window is treated as unreadable, not as "off" | Extend the maintenance tests |
| 1.7 | Correct `docs/architecture.md` and the `apps/web` claim in the integrations guide (D3, D4) | **Shared docs — coordinate.** Prefer a new file over editing while Gemini is active | Docs match code | n/a |

### Phase 2 — Backend work; coordinate with Gemini before touching shared permission files

| # | Work | Note |
|---|---|---|
| 2.1 | **Server-side maintenance enforcement** (D5): a preHandler refusing non-admin traffic while the flag is on, failing closed | New middleware file. Depends on schema Gemini is validating. Coordinate first |
| 2.2 | **Fix D2**: populate `actor_email` from the verified token | Requires the email claim to be read; coordinate with Gemini since `requireAdmin.ts` is a permission file |
| 2.3 | Announcements: **end-user read path**, read/unread state, audience targeting | Needs a new table or column → migration, so it is Gemini's file |
| 2.4 | Per-user warnings and notifications | New route + push/email wiring |
| 2.5 | Bulk suspension, account termination (soft delete), announcement delete | New routes; least-privilege and last-admin checks must extend to bulk operations |
| 2.6 | Per-user activity, devices and diagnostics views | Read-only routes over existing tables |
| 2.7 | Guard `GET /email/status` behind `requireAdmin` (D8) | One-line change in a permission-adjacent file — coordinate |
| 2.8 | About Us CMS (table + route + admin UI) | Depends on 0.2 for content |
| 2.9 | A documented, idempotent **first-admin bootstrap** and break-glass recovery procedure (§4) | Server-side; must not store a credential |

### Phase 3 — Gemini-owned; Claude consumes

Apply the two unapplied migrations; create and verify the `user-media` bucket in the dashboard; reconcile the permission findings; confirm the storage policies against the live project. **Claude must read Gemini's final validation result before modifying any of these files**, and must not apply anything remotely without separate approval.

### Phase 4 — Blocked on credentials, hardware or accounts

Configure Firebase on Render (0.5); decide and configure email (0.4); run the first real sign-in, real sign-up and real email; verify push delivery with a single test message **only with explicit owner approval** (the brief forbids mass testing); test photo upload against the live bucket. Every one of these is recorded as NOT TESTED until it actually runs.

### Phase 5 — ML platform (preconditioned on firmware)

Cannot begin until a physical glove exists and the BLE protocol is verified from real firmware. When it can begin: dataset capture with consent, a label schema, calibration anchors, a train/val/test split, honest evaluation with a confusion matrix, model versioning and rollback, an on-device runtime, and explicit unknown/ambiguous handling. **The preconditions are the deliverable now** — `docs/ble-protocol.md`'s unverified items are the checklist.

### Phase 6 — The single comprehensive regression suite

Reserved until all required screens and backend flows are complete, exactly as the brief requires. Then, in one pass: UI layout and spacing, navigation, long-scroll behaviour, every action and its state changes, guest/account flows, auth, APIs, PostgreSQL/RLS, uploads, email, notifications, announcements, maintenance mode, admin RBAC and auditing, offline/online cases, crash handling and integration boundaries.

---

## 6. What can run now, and what must wait

**Now, in parallel with Gemini (no file overlap):** everything in Phase 1. It is mobile-only. The highest-value item is **1.1**, because D1 is a truthfulness defect in shipped copy, not a missing feature.

**Coordinate first, then proceed (shared permission files or new schema):** Phase 2 items 2.1, 2.2 and 2.7 touch permission-adjacent code; 2.3, 2.4, 2.5 and 2.8 need new tables or columns, so the SQL belongs to Gemini's workstream.

**Must wait:** Phase 3 (migrations, bucket, RLS) — Gemini's, and requires the owner's separate approval to apply remotely. Phase 4 — credentials, accounts, and explicit approval for any push test. Phase 5 — hardware and firmware. Phase 6 — the end of the build.

**Never, regardless of phase:** apply a remote migration, alter live data or permissions, run `supabase db push`, commit a secret, print a secret value, ask for a credential in chat, enable billing, or redesign the Dashboard before the owner approves it.

---

## 7. Boundary with the Gemini workstream

To avoid the collision the brief warns about, this audit deliberately stopped short of:

- A consolidated effective-RLS-policy matrix for the 9 tables.
- Any judgement on whether the four core tables' default grants should be narrowed.
- Any edit to `supabase/**`, to RLS configuration, to `apps/backend/src/middleware/`, or to shared docs (`docs/supabase-setup.md`, `docs/integrations-guide.md`, `docs/remediation-report.md`).

The structural facts this report does state — which migrations exist, which tables they create, that RLS is enabled on all nine, and that the storage policies are owner-scoped — are stable and can be reconciled against Gemini's matrix when it lands. **If the two disagree, Gemini's matrix wins**, because it is the authoritative permission analysis and this is a read-only survey.

---

## 8. Summary

The product's centre of gravity is honest and unusually well defended: recognition, translation, BLE, firmware and ML are all either real-and-refusing or explicitly empty, and the app is built so it cannot display a claim it has not measured. The security model that matters most — admin authorization — is genuinely server-side, fails closed, and never trusts the client.

Four things stand between the current state and the brief:

1. **One truthfulness defect that must be fixed before anything else (D1).** The app tells a guest that signing in will not upload their data, and then uploads it.
2. **A missing server-side half.** Maintenance is client-enforced only, sign-up is unblocked server-side, and email health is public.
3. **Feature gaps in the Super Admin plane and the guest/account experience** — announcements reach no user, uploads do not exist, groups like bulk actions and About Us CMS are absent, and there is no first-admin bootstrap or break-glass path.
4. **Hardware and ML are preconditions, not work items.** No firmware exists, so the protocol is unverifiable and no dataset can be collected. Stating that plainly is the correct status; the checklist in `docs/ble-protocol.md` is what makes it actionable.

Eleven further defects (D2–D13) are recorded in §2.3. Most are minor. Two are worth naming here because they concern *claims rather than code*: `docs/architecture.md` and `docs/roadmap.md` describe a system with no database and no authentication, and one section of `docs/supabase-setup.md` asserts the media bucket is private and then retracts itself four lines later. In a codebase that is otherwise careful about exactly this distinction, a stale claim is a defect of the same kind as a false one.

Nothing was modified in producing this report — no source file, no migration, no configuration, and no existing documentation. One new file was created (`docs/implementation-audit.md`, this report, left untracked). No migration was applied, no remote service was contacted, and the working tree is otherwise clean at `32937ac`.
