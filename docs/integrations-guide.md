# Sanket Vaanni — Comprehensive System Integrations & Architecture Guide

This document details the configuration, implementation status, security boundaries, and operational procedures across all external integrations in the Sanket Vaanni ecosystem.

---

## 1. Integration Matrix & Implementation Status

**Read the three status columns separately.** An earlier revision of this table
had a single "Implementation Status" column, which collapsed three genuinely
different facts into one word: *code written*, *provider set up on the remote
side*, and *the thing having actually been run once against the real service*.
A row reading "Configured" could mean any of the three — which is how a document
ends up claiming a working push notification that has never been sent.

| Service / Subsystem | Purpose & Role | Code | Provider | Tested | Where Credentials Live |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Supabase Auth** | User authentication, session tokens, password recovery | **Implemented** | **Configured** — live project `mmovhldjwadvljxtloes`; publishable key in `apps/mobile/.env` | **NOT TESTED** | Client publishable key only, in `apps/mobile/.env` |
| **Supabase PostgreSQL & RLS** | Cloud data storage: profiles, preferences, calibrations, OLED layouts | **Implemented** | **Partially verified** — read-only probe confirms the five core tables exist remotely and that `anon` is denied; see §1.1 | **NOT TESTED** — no authenticated session has been exercised | RLS enforced by `auth.uid()` on every table (`supabase/migrations/`) |
| **Supabase Storage** | Private bucket `user-media` for user uploads | **Implemented** | **UNRESOLVED** — the publishable key cannot see the bucket, and that answer is ambiguous; see §1.1 | **NOT TESTED** — no live two-user isolation test has been run | Folder-restricted policy `<auth.uid()>/...` (`supabase/migrations/`) |
| **Google OAuth (Supabase)** | Social login provider | **Implemented** — the client opens the native browser | **Configured** — verified read-only: `/auth/v1/authorize?provider=google` answers `302` to `accounts.google.com` | **NOT TESTED** — no sign-in has been performed | Google client ID and secret live in the Supabase Dashboard and are never in this repo |
| **Native Deep Linking** | `sanketvaani://auth-callback` password reset / OAuth return | **Implemented** — Android intent filter present | **UNVERIFIED** — the redirect URL must be registered under Authentication → URL Configuration | **NOT TESTED** | None |
| **Firebase Admin SDK** | Server-side FCM dispatch | **Implemented** — `apps/backend/src/services/firebase.ts` | **Configured** — `GOOGLE_APPLICATION_CREDENTIALS` set; the service-account file exists outside the repo | **NOT TESTED** — no message has ever been dispatched | Service-account JSON at `C:\SanketVaanni-Secrets\`, outside the repository |
| **Firebase Web Push (VAPID)** | Browser push for the research dashboard | **Template only** | **NOT CONFIGURED** | **NOT TESTED** | Reserved for Milestone M8; `NEXT_PUBLIC_FIREBASE_VAPID_KEY` in `apps/web/.env.local` |
| **Android Firebase (FCM) — client** | Device registration token, permission, message receipt | **Implemented** — see §4 | **Configured** — `google-services.json` present and now consumed by Gradle | **NOT TESTED** — pending the final verification phase | `apps/mobile/android/app/google-services.json` (gitignored) |
| **iOS Firebase (APNs/FCM)** | Apple client push registration | **NOT IMPLEMENTED** — no messaging code and no pods entry | **ON HOLD** — no Apple Developer account is available | **NOT TESTED** | `GoogleService-Info.plist` is present but inert |
| **Nodemailer (Gmail SMTP)** | Backend transactional email: alerts, welcome, reports | **Implemented** — `apps/backend/src/services/email.ts` | **Configured** — `SMTP_*` variables set in `apps/backend/.env` | **NOT TESTED** — no mail has been sent | Gmail App Password in `apps/backend/.env` (gitignored) |

**No row in this table is a claim that the integration works.** Every `Tested`
cell reads `NOT TESTED` until the final verification phase has run, and that
phase can only test what a credential, a device and a network permit.

### 1.1 What a read-only probe of the live project actually established

These results come from `GET`/`HEAD` requests only, made against
`mmovhldjwadvljxtloes.supabase.co` using the mobile app's **publishable** key.
No write, no migration, no `db push`, no data change, and no secret value was
printed. The distinction that matters throughout is between `404` (*the object is
not there*) and `401`/`403` (*it is there and you may not have it*).

| Probe | Answer | What it establishes |
| :--- | :--- | :--- |
| `GET /rest/v1/profiles?select=*` | `401`, code `42501` "permission denied" | The table **exists** remotely; `anon` holds no privilege on it |
| Same for `user_preferences`, `calibration_profiles`, `oled_profiles`, `user_history` | `401`, code `42501` | All five core tables **exist**; `anon` is denied on all of them |
| `GET /rest/v1/admin_audit_log`, `/app_settings` | `404` | These tables **do not exist** remotely |
| `GET /rest/v1/device_push_tokens` | `404` | This table **does not exist** remotely |
| `GET /auth/v1/settings` | `200` | `mailer_autoconfirm: false`; providers enabled: `email`, `google`; everything else disabled |
| `GET /auth/v1/authorize?provider=google` | `302` → `accounts.google.com` | Google OAuth **is wired up**, not merely "documented" |
| `GET /storage/v1/bucket/user-media` | `400` `NoSuchBucket` | **Ambiguous** — see below |

**Findings that change what this project believed about itself:**

1. **Google OAuth is enabled.** `docs/supabase-setup.md` §5 states that Google
   OAuth is "Disabled by default on the remote project". That is false: the
   authorize endpoint redirects to Google, which means a client is configured.
   The document has been corrected.
2. **The administration schema is not deployed.** `admin_audit_log` and
   `app_settings` return `404`. The Super Admin, audit, maintenance and
   announcement features therefore have working code and **no database to run
   against** — the backend's admin API will fail against the live project until
   `supabase/migrations/20261014000000_admin_audit_maintenance.sql` is applied.
3. **The push token table is not deployed.** `device_push_tokens` returns `404`,
   so `20261014000001_device_push_tokens.sql` is confirmed unapplied. The client
   code will report a registration failure until it is applied.
4. **Email confirmation is required** (`mailer_autoconfirm: false`). A newly
   created account cannot sign in until it confirms its address, so the final
   verification phase depends on mail actually being deliverable to the test
   mailbox. This is a dependency, not a defect.

**Two things this probe does *not* establish, and must not be read as
establishing:**

- **Row-level isolation between two users is unverified.** All the probe proves
  is that an *unauthenticated* caller is refused. Whether user A can read user
  B's row requires two authenticated sessions and a deliberate cross-read, which
  has not been attempted. RLS is *enforced*; its *correctness* is untested.
- **The `user-media` bucket's existence is unresolved.** Supabase Storage answers
  `NoSuchBucket` both when a bucket is genuinely absent and when the calling role
  cannot see it in `storage.buckets`. Those two situations are indistinguishable
  from outside, so this document does not claim either. Distinguishing them needs
  the Dashboard, and the steps are in `docs/supabase-setup.md` §7.

---

## 2. Supabase Auth, PostgreSQL & Storage Architecture

### Architectural Principles:
1. **Single Source of Identity:** Supabase Auth is the **sole** user authentication system. Firebase Authentication is **not** used.
2. **Offline-First Resilience:** Core gesture recognition, BLE communication, flex sensor processing, 3D hand visualizer, and OLED studio run completely offline without network access.
3. **Multi-Tenant User Isolation:**
   - 100% of user data tables (`profiles`, `user_preferences`, `calibration_profiles`, `oled_profiles`, `user_history`) enforce Row Level Security: `auth.uid() = user_id`.
   - `user-media` Storage bucket is private; owner isolation policy enforces `(storage.foldername(name))[1] = auth.uid()::text`.
   - Account deletion RPC (`delete_user_account()`) securely cascades deletes without exposing service-role keys.

### Authentication & Confirmation Emails:
- Signup confirmation, password reset links, and email change verification are dispatched directly by **Supabase Auth**.
- If custom Gmail SMTP is desired for Supabase Auth emails:
  1. Open Supabase Dashboard > Authentication > SMTP Settings.
  2. Enable Custom SMTP:
     - Sender Email: `sanketvaani.auth@gmail.com`
     - Sender Name: `Sanket Vaanni`
     - Host: `smtp.gmail.com`
     - Port: `465` (SSL)
     - Username: `sanketvaani.auth@gmail.com`
     - Password: `<your-gmail-app-password>`

---

## 3. Nodemailer — Backend Transactional Email Service

### Separation of Concerns:
- **Supabase Auth** handles identity confirmation and recovery.
- **Nodemailer** (`apps/backend/src/services/email.ts`) handles application events:
  1. **Security Alerts** (`POST /email/send-security-alert`): Account device changes, abnormal activity alerts.
  2. **Onboarding / Welcome** (`POST /email/send-welcome`): Introduces newly registered users to BLE glove pairing, calibration, and 3D visualizer features.
  3. **Transactional Reports** (`POST /email/send`): Practice session exports, sign summary metrics.

### Configuration (`apps/backend/.env`):
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=sanketvaani.auth@gmail.com
SMTP_PASS=your_16_character_app_password
SMTP_FROM="Sanket Vaanni <sanketvaani.auth@gmail.com>"
API_INTERNAL_SECRET=your_backend_api_secret_here
```

### Authorization:
- Endpoints (`/email/send*` and `/notifications/send*`) require authorization via `Authorization: Bearer <API_INTERNAL_SECRET>` or `x-api-key: <API_INTERNAL_SECRET>`.
- In production, dispatch is rejected with `503` if `API_INTERNAL_SECRET` is unset.

---

## 4. Firebase Admin SDK & FCM Push Notifications

### Server-Side Firebase Admin (`apps/backend`):
- Initialized safely as a singleton via [apps/backend/src/services/firebase.ts](file:///C:/PROJECT/SANKET%20VAANNI/apps/backend/src/services/firebase.ts).
- Private Key Location: `C:\SanketVaanni-Secrets\sanket-vaanni-firebase-adminsdk-fbsvc-85a1db480a.json`.
- Environment Variable: `GOOGLE_APPLICATION_CREDENTIALS` in `apps/backend/.env`.
- Graceful Fallback: The backend boots normally even if credentials are not configured, exposing status at `GET /notifications/status`.

### Firebase Web Push (`apps/web`):
- Reserved for Milestone M8 Next.js Dashboard.
- **VAPID Public Key:** `BIGRH2t2swsLDMvusWekItzBJUvpBv0-w_QXtaXJC8PlpXDW9HX3GBuRxb1cYAipsy1NalxpNhLra2YJ7VBb-dw`
- Variable Name: `NEXT_PUBLIC_FIREBASE_VAPID_KEY` in `apps/web/.env.local`.
- Service Worker: `firebase-messaging-sw.js` in `apps/web/public/` (requires HTTPS in production).

### Mobile App Firebase — Android client (`apps/mobile`):
**Code implemented.** The client push integration exists and is wired end to end
on the Android side:

- **Packages:** `@react-native-firebase/app` and `@react-native-firebase/messaging`
  (both v26.4.0) are declared in `apps/mobile/package.json` and installed. The
  modular API is used, not the deprecated namespaced one.
- **Gradle:** `com.google.gms:google-services:4.4.4` is on the buildscript
  classpath in `apps/mobile/android/build.gradle`. This plugin cannot be
  autolinked — it has no native module — so it is added explicitly.
- **Plugin application:** `apps/mobile/android/app/build.gradle` applies the
  plugin **only if** `google-services.json` exists, and logs a warning otherwise.
  The plugin hard-fails the build when the file is missing, and the file is
  gitignored, so an unconditional `apply` would break every fresh clone.
- **Permission:** `POST_NOTIFICATIONS` is declared in `AndroidManifest.xml`. It
  is requested at runtime on Android 13+, and only when the user switches
  notifications on — never at startup.
- **Registration:** `apps/mobile/src/notifications/` holds the integration.
  `messaging.ts` is the only file that touches the Firebase SDK and degrades to a
  reported "unavailable" state when the build has no Firebase app or the device
  has no Google Play services. `controller.ts` owns the state machine —
  permission, token, and which account that token is registered against — and
  `register.ts` performs the Supabase write.
- **Token lifecycle:** a token is written to `public.device_push_tokens` through
  the `register_device_push_token` function. It is released **before** sign-out,
  because once the session is dropped the delete policy matches nothing. Token
  refresh re-registers; foreground messages, notification taps and cold-start
  notifications are all handled.
- **Server authorization:** the row is keyed by the device token and owned by
  `auth.uid()`. RLS lets a user see and delete only their own rows, and the
  claiming function is `SECURITY DEFINER` precisely because RLS correctly forbids
  one user from deleting another user's row.
- **Migration:** `supabase/migrations/20261014000001_device_push_tokens.sql` is
  written but **not applied**. Applying it to the remote project requires
  approval and has not been requested.

**Provider configured.** `apps/mobile/android/app/google-services.json` is
present (Package: `com.sanketvaani`) and is now consumed by the build rather
than sitting inert in the tree.

**Function: NOT TESTED.** No notification has been delivered to any device. The
unit tests in `apps/mobile/__tests__/push.test.ts` drive the controller against a
fake bridge; that is a test of the state machine, not a delivery test, and this
document records it as no more than that.

**iOS — ON HOLD.** No Apple Developer access is available at present, so the
Apple client is deliberately not being built. `GoogleService-Info.plist` is in
the tree but no messaging code and no pods entry reference it, which is why the
matrix row above reads "NOT IMPLEMENTED" rather than "Configured". Android work
is not blocked on this.

Both service files are ignored by `.gitignore`; they are configuration, not
secrets, but they identify the project and do not belong in the repository.

---

## 5. Security & Secret Boundaries

1. **Client Bundles:** Never contain service-role keys, Firebase service account JSON, SMTP passwords, or database connection strings.
2. **Git Version Control:** `.gitignore` blocks `.env`, `.env.*` (except `.env.example`), `*.keystore`, `*.jks`, `google-services.json`, `GoogleService-Info.plist`.
3. **Zero Secret Printing:** Logs, responses, and test outputs mask or suppress credential contents.
