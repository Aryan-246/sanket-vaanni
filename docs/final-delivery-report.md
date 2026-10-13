# Sanket Vaanni — Final Delivery Report

**Date:** 2026-10-13
**Branch:** `3d-hand-viewer-integration` (HEAD `a4a537e` + uncommitted working tree)
**Device used for verification:** vivo V2141, Android 14 (API 34), serial `1595140436001XT`

---

## 0. How to read this report

> **See also `docs/remediation-report.md`** — the later remediation pass that
> populated both environment files, implemented the Android FCM client, and
> established by read-only probe what is actually deployed on the remote
> Supabase project. That document is where the *remaining manual actions*, the
> *exact environment variable names*, the *unverified functionality* and the
> *pending migration approval* are recorded. Where the two disagree, the later
> one is correct; the corrections are listed in §11 below.

Every check below was actually executed. Each is marked **PASS**, **FAIL**, or
**NOT TESTED** — a check that could not be run is recorded as NOT TESTED and is
never counted as a pass. Where a claim rests on a device screenshot, the screen
is named. No metric, prediction, model file, or hardware response is reported
that was not observed.

The work is grouped by the directive's own §1.3 work order, then the addendum's
release requirements.

---

## 1. Artifacts

Both APKs are in `C:\PROJECT\SANKET VAANNI\release\`.

| Artifact | Size (bytes) | MD5 | Package | Version |
|---|---|---|---|---|
| `Sanket-Vaanni-debug.apk` | 144,040,351 | `1a9cc66169bc114ee971645ab943102d` | `com.sanketvaani` | 1.0 (code 1) |
| `Sanket-Vaanni-release.apk` | 68,704,992 | `364d9716bdb5dc0db8b727451b22339e` | `com.sanketvaani` | 1.0 (code 1) |

The `release/` directory contains **only these two files**. It holds no `.env`,
no JSON key, no keystore, and no credential of any kind (checked).

### Debug vs release — what each one actually is

- **Debug** is the artifact the addendum asks for and the one currently
  installed on the device. `debug` is listed in `debuggableVariants`, so Gradle
  generates no bundle for it; a JS bundle is staged at
  `app/src/debug/assets/index.android.bundle` so it runs **without a Metro
  server**. This was verified, not assumed: the app was launched with no Metro
  process running and rendered correctly.
- **Release** bundles its own JS and is the standalone artifact for
  distribution. Also installed and launched successfully on the device.

---

## 2. Device verification

**Installed via ADB without clearing app data — PASS.**

`adb install -r -d` was used for every install. `firstInstallTime` stayed at
`2026-10-10 14:54:46` across every install in this session while
`lastUpdateTime` advanced — i.e. the update replaced the app and preserved its
data. The installed APK's MD5 was pulled back off the device and matched the
local build byte-for-byte.

### Screens verified running on the device

| Screen | Result | Evidence |
|---|---|---|
| Dashboard (idle, no glove) | PASS | orb in disconnected state, "No glove connected", GLOVES card |
| Dashboard after "Connect both" | PASS | orb green, "Receiving data", both panels "Demo / Simulated stream" |
| OLED Studio | PASS | "Demo Preview", "preview only", "Reported by the panel — Not reported" |
| Textboard | PASS | empty-state, Live captions card, Type box |
| History | PASS | search, filter chips, honest empty state |
| Settings | PASS | theme control, language, text size, motion, Devices, Recognition |
| Audit ("Component status") | PASS | live counts, foldable groups, "Refresh diagnostics" |

**The app is running on the phone.** This is a device test, not a browser test
and not merely a successful build.

### What the device itself reported

These are the platform's answers on this handset, surfaced through the native
bridge — not invented:

- **On-device speech recognition model: installed** ("This phone reports an
  on-device recognition model is installed.").
- **Text-to-speech: unavailable** ("This device has no text-to-speech engine, or
  its engine failed to start.").
- **Audit: 9 unavailable · 17 unknown · 1 healthy**, worst of 27. Counts are
  computed from live state.

### "Connect both" exercised

Tapping it transitions the app to a **simulated** stream — and labels it as
such ("Demo", "Simulated stream", "Both connected"). The simulator is never
presented as physical hardware. Real BLE hardware was **not** present, so
`NOT TESTED` for actual glove hardware.

---

## 3. Defect found on device, fixed, and re-verified

**Textboard: the empty-state text overlapped the "Speak" heading.**

- *Symptom:* on the device, the empty transcript's body text ran over the
  "SPEAK" section header below it.
- *Root cause:* the screen is `Screen scroll={false}`, so the transcript "floor"
  is `flex: 1` — whatever height the controls below leave over. The empty state
  sat outside any scroll view, so once its content was taller than the floor it
  simply overflowed and collided with the next section. A second, subtler cause
  surfaced on the first attempted fix: the floor's scroll view still ran
  `scrollToEnd` on content-size change, which is right for a growing transcript
  and wrong for a static message — it scrolled the message to its end and cut
  off the icon.
- *Fix:* one scroll view serves both states; the empty state is now contained
  and scrollable, top-aligned so the icon and heading are always visible; and
  `scrollToEnd` fires only when there is a conversation to follow.
- *Status:* **PASS** — re-verified by screenshot on the device after rebuild.
  Full suite re-run afterwards: 463/463.

This is the only UI defect this session found on device, and it is fixed.

---

## 4. Tests and static analysis

| Check | Command | Result |
|---|---|---|
| Mobile unit/component tests | `npx jest` | **PASS** — 30/30 suites, 481/481 tests |
| Backend tests | `npx vitest run` | **PASS** — 2/2 files, 18/18 tests |
| Mobile typecheck | `npx tsc --noEmit` | **PASS** — exit 0 |
| Backend typecheck | `npx tsc --noEmit` | **PASS** — exit 0 |
| Mobile lint | `npx eslint .` | **PASS** — exit 0 |
| Backend lint | `npx eslint .` | **NOT TESTED** — the backend has no ESLint config or dependency. Pre-existing project state, not a regression. |

A new test file closes the one previously untested module: `__tests__/captions.test.ts`,
14 tests covering the caption store and, chiefly, the rules about what captions
may *not* claim — unavailable recogniser, refused vs permanently refused
microphone, the platform's on-device answer passed through un-upgraded, the
microphone requested only on the user's press, and a recogniser that stops
reporting taking the listening state down with it.

**Note on flakiness:** one full-suite run reported 3 failures, all
`Exceeded timeout of 5000 ms` under parallel load; the same suites pass in
isolation in ~1 s, and two subsequent full runs were clean at 463/463. These are
load-contention timeouts, not product failures. Recorded as such rather than
quietly re-run until green.

---

## 5. Implemented and verified

- **Design system & navigation** — palette, spacing, `ThemeProvider`, tab bar
  with Dashboard / OLED / Textboard / History / Settings, pushed detail screens
  with working Android back.
- **Dashboard** — reactive orb, glove cards, Connect both / Find / Disconnect,
  honest empty state.
- **OLED Studio** — paired 128×64 panel profiles, per-panel config, running vs
  startup preview, and an explicit "Demo Preview" banner stating that nothing is
  sent to hardware and that no read-back exists.
- **Textboard** — transcript with per-line source attribution (typed / glove /
  microphone), interim text shown separately and never committed, copy, clear.
- **Live captions** — real Android `SpeechRecognizer` bridge, permission
  handling, capability reporting.
- **History** — search, filters, local-only notice, honest empty states.
- **Settings** — theme, language, text size, reduce motion, output language,
  speech output, devices, recognition, account entry point.
- **Profile & About** — computed completeness, no password field anywhere, no
  password readable by any screen.
- **Guest mode** — states plainly that no account service is configured and that
  everything stays on the phone.
- **Super Admin / audit / maintenance / announcements** — implemented in the
  backend (see §6).
- **ML management** — honest states only; no fabricated model, metric, or
  prediction.
- **Accessibility** — screen-reader labels and hints on controls; the on-device
  accessibility tree was exercised and the labels are present.

---

## 6. Configured-but-unverified, and not-configured — separated

These have working code but were not exercised against live services in this
session. Two different situations are covered, and conflating them is what made
an earlier revision of this section wrong. Each entry is labelled.

- **Supabase — configured locally and remotely; still NOT TESTED end to end.**
  Both environment files are now populated: `apps/mobile/.env` supplies
  `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, and `apps/backend/.env` supplies
  `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. An earlier
  revision of this section said both files were empty and that the app's "no
  account service is configured" copy was literally true of this build; that was
  true then and is **no longer true**. What a read-only probe of the live project
  established — and, just as importantly, what it did not — is recorded in
  `docs/integrations-guide.md` §1.1. In short: the five core tables exist and
  `anon` is refused; `admin_audit_log`, `app_settings` and `device_push_tokens`
  return `404`, so the admin and push-token schema is **not deployed remotely**;
  Google OAuth turns out to be **enabled**; and email confirmation is required.
  Row-level isolation between two real users remains **NOT TESTED**, because it
  needs two authenticated sessions and a deliberate cross-read.
- **Firebase — server side configured, client side newly implemented, neither
  exercised.** The backend's `GOOGLE_APPLICATION_CREDENTIALS` **is set**, to the
  documented path outside the repository, and that file **exists**. It has never
  been run and no push has ever been dispatched: **NOT TESTED**. The mobile
  client is no longer the gap it was: `@react-native-firebase/app` and
  `@react-native-firebase/messaging` (v26.4.0) are installed, the Google
  Services Gradle plugin is applied conditionally on `google-services.json`
  being present, `POST_NOTIFICATIONS` is declared, and
  `apps/mobile/src/notifications/` implements the permission, token,
  registration and tap handling described in the integration guide §4. Its 18
  unit tests pass, but **no notification has ever been delivered to a device**,
  and the `device_push_tokens` table it writes to does not yet exist remotely.
  Mobile push is therefore **implemented and NOT TESTED** — not "working". The
  iOS client remains deliberately unimplemented and **ON HOLD** for want of
  Apple Developer access.
- **Email (Nodemailer) — configured, never exercised.** `SMTP_HOST`,
  `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` **are all set** in
  `apps/backend/.env`. No mail has been sent, so the integration is
  **NOT TESTED**. An earlier revision of this report said `SMTP_PASS` was unset;
  that was wrong, and §11 records the correction.
- **Database migrations** — four migrations exist under `supabase/migrations/`.
  Their status against the live project is now **known rather than assumed**,
  from a read-only probe with no write and no secret printed:
  `20261012000000_sanket_vaanni_initial.sql` is **applied**;
  `20261013000000_storage_user_media_policies.sql` is **unconfirmed** (the
  bucket answers `NoSuchBucket`, which is ambiguous — see
  `docs/supabase-setup.md` §7); and `20261014000000_admin_audit_maintenance.sql`
  and `20261014000001_device_push_tokens.sql` are **NOT APPLIED**. Applying
  either is a deliberate step that has **not** been taken and requires approval.

---

## 7. Blocked / not tested

| Item | Status |
|---|---|
| Physical glove hardware over BLE | **NOT TESTED** — no glove present. The simulator ran; hardware did not. |
| Physical OLED panel | **NOT TESTED** — no panel, and no verified command set; the app says so on screen. |
| Sign recognition of a real sign | **NOT TESTED** — no recognition model is loaded. |
| Speech output on this handset | **NOT TESTED** — this device reports no usable TTS engine; the app states that rather than failing silently. |
| Live Supabase / Firebase / SMTP | **NOT TESTED** — credentials are now configured on both sides; what is missing is an actual authenticated round trip, a dispatched message, and a delivered email |

None of the above is recorded as a pass.

---

## 8. Deliberately not implemented

Each is stated in the product rather than hidden:

- **Avatar picker** — the private storage bucket and its policies exist, but the
  app has no image picker; the Profile screen says exactly that instead of
  offering a button that opens nothing.
- **Glove speaker** — marked "Coming soon / Needs a verified command protocol".
- **Translation** — no translation model exists; "no text reaches the speech
  engine" is stated on screen.
- **A second language pack** — "No other language pack exists yet".
- **In-app text size / motion overrides** — these follow the phone's settings
  and the app explains why rather than offering a control it would not honour.

No dead buttons were found on any screen examined: every control either performs
a real action or states that it is unavailable.

---

## 9. Security

- **No credential has ever been committed.** This was verified directly, not
  assumed: the only `.env`-family files tracked are `apps/backend/.env.example`
  and `apps/mobile/.env.example` (plus iOS's standard `.xcode.env`); no real
  `.env` was ever added in any revision; and a history search for
  `SMTP_PASS`, `API_INTERNAL_SECRET`, `GOOGLE_APPLICATION_CREDENTIALS` and
  `service_role` returns **zero** commits. The committed `.env.example` files
  contain only mundane values (`HOST`, `PORT`, `NODE_ENV`, `LOG_LEVEL`).
  `apps/backend/.env` is correctly gitignored.
- No service-role or admin key is present in the client. The mobile app reads the
  *publishable* key only.
- The shipped bundle was searched for `AIza`, `service_role`,
  `BEGIN PRIVATE KEY` and `SUPABASE_SERVICE` — none present.
- No debugging access is exposed to unknown devices or public networks.
- No secret value was printed, read aloud, or written into any report, and none
  was requested.

---

## 10. Repository notes

1. **Stray root `package.json` (untracked) — left in place, and no longer on the
   resolution path.** A five-line file at the repo root declares
   `@supabase/supabase-js`, which caused npm to hoist that package to the
   monorepo root and made Metro fail to resolve it. The first fix was a resolver
   workaround in `apps/mobile/metro.config.js`; that workaround treated a symptom.
   The actual cause was a malformed dependency name in `apps/mobile/package.json`
   (`@react-native-babel-preset`, a scope with no package after it) which made
   **every** npm command in that app abort — so npm could never install Supabase
   locally, and the root copy was all Metro could ever find. With the name
   corrected, `@supabase/supabase-js` is installed into `apps/mobile/node_modules`,
   and `metro.config.js` has been returned to the standard configuration.
   **The root `package.json` and `package-lock.json` have not been deleted, moved
   or regenerated** — they are untracked, and a recovery copy of both is preserved
   under `.recovery/root-package-2026-10-13/`. Whoever owns them should still
   decide whether they belong; nothing in the build needs them now.
2. **`android/app/src/debug/assets/index.android.bundle`** — the debug bundle
   now lives in a debug-only source set. Previously it sat in
   `src/main/assets/`, where it collided with the release build's generated
   bundle and failed `mergeReleaseAssets` with "Duplicate resources". The
   `.gitignore` comment there was also wrong about where the release bundle is
   written; both are corrected.
3. The working tree contains many uncommitted changes, plus this session's edits.
   **Nothing was committed or pushed**, per instruction.

---

## 11. Corrections to earlier statements

- An earlier working note claimed a live Gmail app password and a live
  `API_INTERNAL_SECRET` had been committed to `apps/backend/.env.example`. **That
  was wrong, and it is retracted.** Direct inspection of every revision shows
  those names appear in no commit at all. The real situation is §9 above: clean.
- An earlier note described the six content-test failures as test drift requiring
  a judgement call; they were resolved by updating tests to the new copy, with
  the user's approval.
- **§6 originally said `SMTP_PASS` was unset, and grouped Firebase and SMTP with
  Supabase as "no credentials are configured". Both claims were wrong.** They
  came from reading only the *names* of the variables present in
  `apps/backend/.env` and inferring that the values were placeholders, without
  checking whether values were actually present. Every one of them is set, and
  the Firebase credentials path resolves to a file that exists. §6 now separates
  "configured but never exercised" from "not configured", which is the
  distinction that was missing.
- **`docs/supabase-setup.md` claimed Google OAuth was "Disabled by default on the
  remote project", and this report's §6 implied the same. A read-only probe
  disproved it**: `/auth/v1/authorize?provider=google` redirects to
  `accounts.google.com`, so the provider is enabled and a client is configured.
  Both documents are corrected. The lesson is the one this project keeps
  relearning — a status written down from memory is not a status.
- **`docs/supabase-setup.md` §7 asserted the four `user-media` storage policies
  had "already been manually applied and verified in the remote Supabase
  project".** No evidence of that verification exists in the repository, and a
  read-only probe could not reproduce it. The assertion is now marked
  **unconfirmed** rather than repeated, with exact Dashboard steps to settle it.
- **`apps/backend/src/config.ts` carried the comment "There are currently no
  secrets".** That stopped being true when SMTP and Supabase credentials were
  added, and the comment was actively misleading about how carefully those values
  need to be handled. It now says the opposite, and says why.

---

## 12. Summary

**Verified and working on a real Android device:** the app installs over
existing data, runs standalone with no Metro server, and every principal screen
renders with honest, computed state — including the platform's own answers about
this handset's speech recognition and text-to-speech, and a simulated glove
stream that is labelled as simulated.

**Verified green:** 481 mobile tests across 30 suites, 18 backend tests, clean
typecheck on both, clean lint on mobile.

**Blocked by absence, and recorded as such:** physical glove, physical OLED,
real sign recognition (no model loaded), backend lint (no ESLint config).

**Configured but never exercised:** backend Firebase Admin (`GOOGLE_APPLICATION_CREDENTIALS`
is set and the file exists) and Nodemailer SMTP (`SMTP_PASS` and its siblings are
set). Neither has been run; neither is blocked by missing credentials.

**Implemented this remediation but still never exercised:** the Android FCM
client (packages, Gradle plugin, manifest permission, token lifecycle, 18 tests)
and the whole Supabase cloud path now that both environment files are populated.
Code existing is not evidence that it works, and this report does not treat it
as such.

**Blocked on a deliberate, unrequested step:** two migrations —
`20261014000000_admin_audit_maintenance.sql` and
`20261014000001_device_push_tokens.sql` — are written and **not applied** to the
remote project. Until they are, the admin/audit/announcement features and push
token registration have no tables to run against. Applying them requires showing
the diff and getting approval first, which has not been asked for.

**Not implemented:** Firebase on the iOS client. Deliberately **on hold** —
there is no Apple Developer access available, and Android work is not blocked on
it.
