# Sanket Vaanni — Supabase Integration & Architecture Guide

## 1. Overview & Architecture

Sanket Vaanni integrates with Supabase (`mmovhldjwadvljxtloes`) using an **offline-first** design. The mobile application operates fully without an active internet connection or Supabase project access. When a user connects and signs in, data synchronizes securely with Row Level Security (RLS) policies enforcing complete multi-tenant user isolation.

### Key Principles:
- **Offline-First Resilience**: All core functions (Dashboard, 3D hand viewer, OLED Studio, glove telemetry, local storage) operate without network dependencies.
- **₹0 Budget (Free Tier)**: Designed within standard Supabase Free Tier quotas without requiring paid addons or edge compute.
- **Client Security**: Uses the Supabase Publishable Key only. No `service_role`, secret keys, or database passwords are ever bundled in the mobile application.
- **Multi-Tenant Isolation**: RLS is strictly enabled on 100% of exposed tables (`profiles`, `user_preferences`, `calibration_profiles`, `oled_profiles`, `user_history`). Every operation validates against `auth.uid()`.
- **User-Isolated Storage**: Local AsyncStorage caches are keyed by `userId` to prevent data leakage during account switching.

---

## 2. Environment Configuration

The mobile app loads configuration from `apps/mobile/.env` through **`react-native-dotenv`**, a Babel plugin configured in `apps/mobile/babel.config.js`, and reads it in `apps/mobile/src/config/env.ts` via the virtual module `@env`.

> **This is a build-time mechanism, not a runtime one.** The plugin substitutes each variable's value directly into the JavaScript bundle as it is compiled. Two consequences follow, and both have caused real confusion in this project:
>
> 1. **Editing `.env` alone changes nothing.** A running app keeps the values it was bundled with. Development needs a Metro restart with `--reset-cache`; an APK needs to be rebuilt, because the value is already baked into the bundle on the phone.
> 2. **Nothing read this way is secret.** The values are readable in the shipped bundle by anyone who cares to look. Only the publishable key belongs here.
>
> `react-native-config` is **not** used by this project and is not installed. Earlier revisions of this document said it was, which sent at least one debugging session looking at the wrong tool.

### Tracked Template (`apps/mobile/.env.example`)
```bash
# Supabase Configuration
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_<your-key>
```

### Local Environment (`apps/mobile/.env` - Gitignored)
Add your project credentials directly to `apps/mobile/.env`:
```bash
SUPABASE_URL=https://mmovhldjwadvljxtloes.supabase.co
SUPABASE_PUBLISHABLE_KEY=<your-publishable-key>
```
*Note: `.env` is explicitly ignored by Git in `apps/mobile/.gitignore`.*

The backend reads its own separate `apps/backend/.env` — see `docs/final-delivery-report.md`. **Backend variables are never visible to the mobile app**, and the mobile `.env` is never visible to the backend. They are two different files read by two different processes at two different times.

---

## 3. Database Schema & Migration

The version-controlled SQL migration is located at:
`supabase/migrations/20261012000000_sanket_vaanni_initial.sql`

### Tables:
1. `public.profiles`: User identity linked to `auth.users(id)` with cascading delete.
2. `public.user_preferences`: Theme, target translation language, sign profile ID, and voice settings.
3. `public.calibration_profiles`: Per-hand (`left` / `right`) 5-finger flex and IMU calibration bounds.
4. `public.oled_profiles`: Glove display layout, line configurations, and invert settings.
5. `public.user_history`: Sign session recognition events and performance metrics.

### Automated Triggers & RPCs:
- `on_auth_user_created`: Automatically creates a `public.profiles` row when a user signs up.
- `update_timestamp()`: Automatically sets `updated_at = NOW()` on record modifications.
- `delete_user_account()`: Security-definer function enabling users to delete their own account and cloud records securely without exposing an admin key to the client.

### What is actually applied on the remote project

Established by read-only probe (see the integration guide §1.1); no write was
made and no secret was printed.

| Migration | Remote status | Evidence |
| :--- | :--- | :--- |
| `20261012000000_sanket_vaanni_initial.sql` | **Applied** | `profiles`, `user_preferences`, `calibration_profiles`, `oled_profiles`, `user_history` all answer `401 / 42501` (exist, denied) rather than `404` |
| `20261013000000_storage_user_media_policies.sql` | **Unconfirmed** | The bucket returns `NoSuchBucket`, which is ambiguous — see §7 |
| `20261014000000_admin_audit_maintenance.sql` | **NOT APPLIED** | `admin_audit_log` and `app_settings` both answer `404` |
| `20261014000001_device_push_tokens.sql` | **NOT APPLIED** | `device_push_tokens` answers `404` |

The second and third rows are the reason the Super Admin, audit, maintenance,
announcement and push-registration features will fail against the live project
even though their code is complete. Applying them is a separate, deliberate step
and requires approval first.

### Applying Migrations to Remote Supabase

To apply the migration to the remote Supabase project (`mmovhldjwadvljxtloes`):

#### Method A: Supabase Dashboard SQL Editor (Recommended - ₹0 / Zero Secret Exposure)
1. Open the [Supabase Dashboard](https://supabase.com/dashboard/project/mmovhldjwadvljxtloes).
2. Navigate to **SQL Editor**.
3. Create a **New query**.
4. Copy the entire contents of `supabase/migrations/20261012000000_sanket_vaanni_initial.sql`.
5. Click **Run** to execute the migration.

#### Method B: Supabase CLI (Local machine with CLI login)
```bash
# From workspace root
npx supabase login
npx supabase link --project-ref mmovhldjwadvljxtloes
npx supabase db push
```

---

## 4. Row Level Security (RLS) Policies

All public tables have RLS explicitly enabled:
`ALTER TABLE public.<table_name> ENABLE ROW LEVEL SECURITY;`

| Table | Policy Name | Permitted Roles | Condition |
| :--- | :--- | :--- | :--- |
| `profiles` | Users can view own profile | `authenticated` | `auth.uid() = id` |
| `profiles` | Users can update own profile | `authenticated` | `auth.uid() = id` |
| `user_preferences` | Users can manage own preferences | `authenticated` | `auth.uid() = user_id` |
| `calibration_profiles` | Users can manage own calibrations | `authenticated` | `auth.uid() = user_id` |
| `oled_profiles` | Users can manage own oled profiles | `authenticated` | `auth.uid() = user_id` |
| `user_history` | Users can manage own history | `authenticated` | `auth.uid() = user_id` |

*Result: Users cannot read, insert, update, or delete records belonging to any other user.*

---

## 5. Authentication & Deep Linking Setup

### Auth Providers
- **Email / Password**: Active. `GET /auth/v1/settings` reports the `email`
  provider enabled and `mailer_autoconfirm: false`, so **a new account must
  confirm its address before it can sign in**.
- **Google OAuth**: **Enabled on the remote project.** Verified read-only:
  `GET /auth/v1/authorize?provider=google` answers `302` and redirects to
  `accounts.google.com`. An earlier revision of this document said Google was
  "disabled by default on the remote project"; a read-only probe disproved that,
  and the correction is recorded here rather than in a footnote. The Google
  client ID and secret live in the Supabase Dashboard and are not in this
  repository. Whether the round trip *completes* — returning to
  `sanketvaani://auth-callback` with a usable session — is **NOT TESTED**; that
  requires the redirect URL below to be registered and a real sign-in to be
  attempted.

### Deep Linking for Password Recovery
The app uses the custom scheme `sanketvaani://auth-callback` for native redirection.
1. In Supabase Dashboard, go to **Authentication > URL Configuration**.
2. Under **Redirect URLs**, add:
   ```text
   sanketvaani://auth-callback
   ```
3. **This has not been verified, and it should be confirmed by eye.** A
   read-only attempt to test it failed to produce evidence either way:
   `/auth/v1/authorize` returned `302` to Google for `sanketvaani://auth-callback`
   **and** for a deliberately bogus control scheme `notarealscheme://nope-callback`,
   identically. Supabase does not consult the allow-list at the authorize step,
   so this probe cannot distinguish a registered URL from an unregistered one.
   The allow-list can only be read from the Dashboard. Until someone looks, treat
   password-recovery and OAuth returns as **unverified**.
4. Android Manifest configuration has been applied in `apps/mobile/android/app/src/main/AndroidManifest.xml`:
   ```xml
   <intent-filter>
       <action android:name="android.intent.action.VIEW" />
       <category android:name="android.intent.category.DEFAULT" />
       <category android:name="android.intent.category.BROWSABLE" />
       <data android:scheme="sanketvaani" android:host="auth-callback" />
   </intent-filter>
   ```

---

## 6. Sync & Conflict Resolution

- **Preferences**: Remote vs local conflict resolution uses `updatedAtMs` vs `updated_at`. The newer timestamp wins.
- **OLED Profiles**: Profiles are upserted with unique constraints on `(user_id, name)`. Remote changes merge into local storage.
- **Account Switching**: Switching users invalidates previous user sync state without clearing local hardware calibrations.
- **Offline Mode**: If network is disconnected or Supabase is unreachable, sync transitions to `error` / `offline` and retains all pending local edits without data loss.

---

## 7. Storage Security Policies (`user-media` Bucket)

### Bucket Configuration
- **Bucket ID**: `user-media`
- **Visibility**: **Private** (`public = false`). Direct unauthenticated HTTP downloads are rejected.

### Remote Status vs. Source Control

- **Uncertain: the bucket could not be confirmed from outside.** A read-only
  probe with the app's publishable key asked the Storage API for `user-media`
  and received `400 NoSuchBucket`. That answer is **ambiguous**: Supabase Storage
  returns exactly the same error when a bucket is genuinely absent *and* when the
  calling role has no `SELECT` on `storage.buckets`. The two cases cannot be told
  apart without the Dashboard. An earlier revision of this section asserted the
  four policies below had "already been manually applied and verified in the
  remote Supabase project"; nothing in this repository records that evidence, a
  read-only probe could not reproduce it, and it is therefore restated here as
  **unconfirmed** rather than deleted or repeated.

  To settle it, in the Dashboard for project `mmovhldjwadvljxtloes`:

  1. **Storage → Buckets.** Does a bucket named exactly `user-media` appear, and
     is it marked **Private**? If it does not exist, create it as private
     (public access must stay off).
  2. If it exists, open **Storage → Policies** and select the `user-media`
     bucket. Confirm four policies are listed — `user_media_select_own_folder`,
     `user_media_insert_own_folder`, `user_media_update_own_folder`,
     `user_media_delete_own_folder` — each restricted to the `authenticated`
     role, with the check
     `bucket_id = 'user-media' AND (storage.foldername(name))[1] = (auth.uid())::text`.
  3. If any is missing, open **SQL Editor** and run
     `supabase/migrations/20261013000000_storage_user_media_policies.sql`. It is
     idempotent by construction (see below), so running it where the policies
     already exist is safe.

- **Source Control Migration**: `supabase/migrations/20261013000000_storage_user_media_policies.sql`
  records these exact policies in the repository. It uses
  `DROP POLICY IF EXISTS ...` before each `CREATE POLICY`, so it is duplicate-safe
  if executed against an environment where the policies already exist.

### Storage Path Requirements
All client upload and access paths in `user-media` **must** begin with the authenticated user's UUID:
```text
<auth.uid()>/<filename>
# Example:
123e4567-e89b-12d3-a456-426614174000/photo.jpg
```

Policy enforcement rule:
```sql
bucket_id = 'user-media' AND (storage.foldername(name))[1] = (auth.uid())::text
```
- **Root-level uploads** (e.g. `photo.jpg` without a folder) yield `NULL` for `foldername(name)[1]` and are rejected.
- **Cross-user uploads** (e.g. attempting to upload into another user's folder) do not match `auth.uid()::text` and are rejected with 403 Forbidden.
- **Public / Anonymous access** is completely blocked (`TO authenticated` only).

### Remaining Security Verification
- **Live Two-User Storage Test**: While the policy definitions are mathematically sound and tested locally, verifying that User B cannot download or overwrite User A's file via live API calls against the remote `user-media` bucket remains pending an end-to-end two-user test.

