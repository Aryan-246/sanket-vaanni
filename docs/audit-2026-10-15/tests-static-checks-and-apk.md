# Tests, static checks and APK verification — 2026-10-15

Scope: everything in this file was run against the **working tree as it stands**, branch
`3d-hand-viewer-integration`, HEAD `32937ac`, with the uncommitted Admin-phase changes
present. Nothing was committed, pushed, deployed or reset to produce it.

**No Android device was attached during this run.** `adb devices -l` returned an empty list.
Nothing below is a physical-device result. Where a claim rests on an earlier hardware
session, it is attributed to that document rather than to this run.

---

## 1. Test suites

Two different runners are in use, and they are not interchangeable. Counts from one are not
evidence for the other.

### 1.1 Mobile — Jest

```
cd apps/mobile
npx jest
```

```
Test Suites: 54 passed, 54 total
Tests:       1027 passed, 1027 total
Snapshots:   0 total
Time:        89.884 s
Ran all test suites.
```

`apps/mobile/__tests__` on disk holds **54** test files, so the suite count and the file count
agree — no suite is being silently skipped by a `testPathIgnorePatterns` entry.

### 1.2 Backend — Vitest

```
cd apps/backend
npx vitest run
```

```
 Test Files  8 passed (8)
      Tests  171 passed (171)
   Duration  1.23s
```

`apps/backend/test` on disk holds **8** test files, matching the reported count.

### 1.3 Prior documents disagree with each other

Five earlier reports quote different test totals. This is itself a finding, recorded in
`contradictions-found.md`: a count that moves between documents without a stated reason is
not auditable. The figures above are the only ones measured against the current tree, and
they are the figures this audit stands behind.

---

## 2. Static checks

| Check | Command | Result |
|---|---|---|
| Mobile types | `cd apps/mobile && npx tsc --noEmit` | **exit 0** |
| Backend types | `cd apps/backend && npx tsc --noEmit` | **exit 0** |
| Backend build | `cd apps/backend && npm run build` | **exit 0** |
| Mobile lint | `cd apps/mobile && npx eslint .` | **4 errors, 109 warnings** |

### 2.1 The four lint errors are not from this workstream

```
src/components/orb/OrbShader.tsx
  11:10  error  'Platform' is defined but never used
  43:20  error  'accentColor' is assigned a value but never used
src/components/orb/OrbStage.tsx
  17:8   error  'AccentColorId' is defined but never used
src/theme/ThemeProvider.tsx
  22:3   error  'PALETTES' is defined but never used
```

All four are unused-import/dead-binding errors in the Stitch 3D-orb and theme layer — a
different workstream from the Admin phase. The count is **unchanged from before this audit
began** (4 and 109), and correcting them would mean editing another workstream's files, which
is out of scope here. Three lint errors that *were* introduced by this workstream
(`lastDispatch.ts` unused `Json`; `AdminScreen.tsx` unused `countAuditFilters`;
`admin-dispatch.test.ts` unused `_omitted`) were fixed, which is why the count did not rise.

`npm run build` writes to `apps/backend/dist/`, which is gitignored; `git status --porcelain`
is unaffected by it.

---

## 3. What green does not prove

Stated plainly, because a green suite is the easiest thing in this repository to over-read:

- **No live backend was exercised.** Every backend test runs against in-process fakes. The
  hosted API, its database and its SMTP/Firebase credentials were not contacted.
- **No email was sent and no push notification was delivered.** `sendPushNotification` is
  covered by a fake. Nothing in this repository has observed a real FCM receipt.
- **No BLE traffic occurred.** The transport is inert (see `ble-and-firmware-verification.md`);
  the only transport ever constructed in the app is `MockTransport`.
- **No ML inference, training or accuracy figure was produced.** There is no model and no
  vocabulary, so no metric exists to be right or wrong.
- **No accessibility technology was run.** TalkBack has never been executed against this app.
- **The tests are the tests the repository ships.** They were not weakened, deleted or
  bypassed to obtain this result, and no working integration was replaced by a mock.

---

## 4. Guard-test integrity

A suite only means something if it can fail. Two checks were run.

**4.1 No disabled tests.** Repo-wide search for `it.skip`, `describe.skip`, `it.only`, `xit`,
`xdescribe` in `apps/mobile/__tests__` returns nothing; the corresponding scan for `.skip`,
`.only`, `todo(` in `apps/backend/test` returns nothing. No test is parked.

**4.2 Mutation check.** The guard added by this audit (`latestDispatchPerAnnouncement` in
`src/admin/lastDispatch.ts`) was deliberately broken by removing the
`if (row.action !== DISPATCH_ACTION) continue;` line. **All 27 tests still passed** — the test
was vacuous, because both fixture rows carried `outcome: 'succeeded'` and the assertion could
not tell which row had won.

That is the correct thing for a mutation test to find, and it found it in my own work. The
fixture was fixed to give the non-dispatch row a distinct `outcome`/`detail`/`created_at` and
assert on those fields. Re-running the same mutation then produced **1 failure**, which is the
required result. The lesson recorded in `MEMORY.md` applies and was followed: judge a mutation
from the failure block, not from raw pass/fail output, because Jest lists passing test names
too.

---

## 5. APK artefacts

Two APKs were rebuilt from the current tree. Both builds are non-destructive: `.env.local` is
held aside so the dotenv cascade resolves `.env` (hosted values) instead of local ones, bundle
intermediates are deleted so the JS is re-embedded, and a trap restores every temporary change
on exit — including on failure.

### 5.1 Verification of the restoration

```
--- .env.local hash ---
51d25b4e5341bbe6a95a04766f97a47d3f29b5b62ac9c587b679c617d15d1936 *apps/mobile/.env.local
--- build.gradle diff vs HEAD ---
(empty)
```

The secret file is byte-identical to before the build, and the Gradle file is unchanged from
HEAD. `apps/mobile/.env.local.holdout` does not exist, so no holdout file was left behind.

### 5.2 Debug APK

| Property | Value |
|---|---|
| Path | `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` |
| Size | 146,571,403 bytes |
| SHA-256 | `eda2d7c4d0cdf213a46259b756aa540d090b73be1f47d9a1f41fb25e0f39433c` |
| Built | 21:27 |
| Gradle | `assembleDebug`, BUILD SUCCESSFUL in 1m 24s |

### 5.3 Release APK

| Property | Value |
|---|---|
| Path | `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` |
| Size | 70,683,391 bytes |
| SHA-256 | `69512622704f17f523b2f980a8b9931c74a2d1ead86a0e42b27e673fe10be18f` |
| Built | 21:31 |
| Gradle | `assembleRelease`, BUILD SUCCESSFUL in 1m 5s |
| Package | `com.sanketvaani` |
| versionCode / versionName | `1` / `1.0` |
| compileSdk / targetSdk | 37 / 36 |

The release artefact **changed** in this rebuild (previous size 70,665,851 bytes, previous hash
`a11eaf32…`). The earlier hash is superseded; the current tree produces the hash above.

### 5.4 Both APKs are signed with a public debug key — a release blocker

```
V2 Signer: certificate DN: CN=Android Debug, OU=Android, O=Unknown, ...
V2 Signer: certificate SHA-256 digest: fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
```

The release APK is a release **build type** signed with the **Android debug keystore**, whose
private key is public and shipped in every Android SDK. Anyone can sign an update to
`com.sanketvaani` that the platform will accept. Therefore:

- the release APK is **not distributable** and must not be uploaded to any store;
- `fac61745…` is the well-known AOSP debug certificate, not a project key;
- fixing this requires an owner-held release keystore, which cannot be created here — a key
  generated in this session would have to be handed to the owner, which is not how signing
  keys should change hands.

Only a **V2** signature is present; there is no V1 or V3 signature line.

### 5.5 Manifest contents of the release APK

```
uses-permission: android.permission.INTERNET
uses-permission: android.permission.RECORD_AUDIO
uses-permission: android.permission.POST_NOTIFICATIONS
uses-permission: android.permission.WAKE_LOCK
uses-permission: android.permission.ACCESS_NETWORK_STATE
uses-permission: com.google.android.c2dm.permission.RECEIVE
uses-permission: com.sanketvaani.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
```

**No Bluetooth permission of any kind.** This is independent confirmation, read from the
shipped artefact rather than the source, of the BLOCKED verdict in
`ble-and-firmware-verification.md`. `WAKE_LOCK`, `ACCESS_NETWORK_STATE` and `c2dm.RECEIVE`
arrive transitively from Firebase Messaging, not from hand-written manifest entries.

### 5.6 Embedded configuration

The bundle at `assets/index.android.bundle` (2,581,588 bytes) was extracted and read.

Hosted endpoints present:

```
https://sanket-vaanni-backend.onrender.com
https://mmovhldjwadvljxtloes.supabase.co
```

Endpoint forms scanned for and **found zero times**:

| Pattern | Occurrences |
|---|---|
| `http://127.0.0.1` | 0 |
| `://127.0.0.1` | 0 |
| `127.0.0.1:4000` | 0 |
| `127.0.0.1:54321` | 0 |
| `10.0.2.2` | 0 |
| `localhost:4000` | 0 |
| `localhost:54321` | 0 |

A bare `127.0.0.1` substring does match inside the packed asset table, but the surrounding
bytes are palette hex (`#8A5A12` and adjacent values), and every scheme-qualified or
port-qualified form is zero. It is a **false positive in packed data, not an endpoint**, and is
recorded here rather than quietly dropped.

**Conclusion:** the built artefact points at the hosted backend and the hosted Supabase
project, and contains no loopback or emulator endpoint. This is a statement about bytes in the
file; it is not evidence that the hosted services respond.

### 5.7 The new Admin strings are in the shipped bundle

Each string authored by this audit was searched for in the release bundle:

| String | Found |
|---|---|
| `Recorded: not confirmed` | yes |
| `No recent attempt` | yes |
| `History unread` | yes |
| `dispatch_announcement` | yes |

These are the durable-badge strings from `src/admin/lastDispatch.ts` and the audit action name
the console filters on. The rebuilt artefact therefore contains the work described in
`docs/admin-phase-final-report.md` and the audit-closure pass — not a stale bundle.

---

## 6. Reproducing this

```bash
# tests and static checks
cd "C:/PROJECT/SANKET VAANNI/apps/mobile" && npx tsc --noEmit && npx jest
cd "C:/PROJECT/SANKET VAANNI/apps/backend" && npx tsc --noEmit && npm run build && npx vitest run

# the APK builds (temporary changes, all reverted by an EXIT trap)
bash C:/Users/acer/.claude/jobs/93defbc8/tmp/rebuild-apk.sh
bash C:/Users/acer/.claude/jobs/93defbc8/tmp/rebuild-release-apk.sh
```

Note on the build scripts: `set -o pipefail` is required. The first attempt at the debug
rebuild reported success while Gradle had failed, because `gradlew … | tail` returns `tail`'s
exit status. Both scripts now fail loudly.

---

## 7. Device status

`adb devices -l` → empty. The `adb` binary is at
`%LOCALAPPDATA%/Android/Sdk/platform-tools/adb.exe` and is not on `PATH`.

For completeness: an earlier session on **the same day** did have a handset attached — a vivo
V2141 on Android 14, serial `1595140436001XT`, recorded in
`docs/device-verification-2026-10-15.md` and `docs/task-f-final-report.md`. That session
observed the app launching, the Dashboard, the ML centre and an honest backend-failure notice,
plus the ML centre's refusal to show an accuracy figure. It did **not** exercise:

- the Admin console,
- sign-in,
- any glove,
- TalkBack,
- the Service tab, maintenance transitions, or a bulk action with a mixed outcome.

So "the app has run on a real handset" is true, and "the Admin phase has been verified on
hardware" is **not**.
