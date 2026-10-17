# APK verification record — 2026-10-15

Evidence for §7 of the completion directive: a fresh APK built from the current
working tree, with its identity, signature, embedded JavaScript and **embedded
configuration** verified rather than assumed.

**No device was attached during either build.** `adb devices -l` reported an empty
list both times, so nothing in this document is a device test. Installation,
updating and all on-hardware behaviour are **not verified** in this record.

---

## The two traps this record exists to avoid

An APK is easy to build and hard to trust. Two separate failure modes were hit
while producing this artefact, and both produce a file that looks finished while
being worthless.

### Trap 1 — a debug APK embeds no JavaScript

The first `assembleDebug` run reported `BUILD SUCCESSFUL in 36s` and left an APK
dated **the previous day** untouched. That was not a build failure and not a
mistake — a React Native debug APK embeds **no JavaScript at all** and expects a
running Metro server to supply it. The task was genuinely up to date, because
none of the JavaScript is an input to it.

So "the build succeeded" and "the APK contains the current source" are different
claims, and only the second one is worth anything.

### Trap 2 — an untracked `.env.local` silently overrode every hosted setting

The first APK that *did* contain a bundle contained:

```
127.0.0.1:54321     PRESENT      <-- local Supabase CLI port
127.0.0.1:4000      PRESENT      <-- local backend
sanket-vaanni-backend.onrender.com    absent
mmovhldjwadvljxtloes.supabase.co      absent
```

On a phone, `127.0.0.1` is **the phone**, so this was not a stale production
bundle — it was worse: an artefact pointing at a laptop that would not be awake.

The cause was not a cache and not a stale build. `apps/mobile/.env.local` exists
on this machine (untracked, gitignored, created 2026-10-15 12:15) and
`react-native-dotenv@5.0.0` merges it **unconditionally and with higher
precedence than `.env`**, for every profile, regardless of `BABEL_ENV`:

```js
// node_modules/react-native-dotenv/index.js
const localFilePath = options.path + '.local'          // line 89  -> ".env.local"
const fileEnv = undefObjectAssign(
  undefObjectAssign(
    undefObjectAssign(parsedFile.parsed, modeFile.parsed),  // .env  < .env.<mode>
    localFile.parsed                                        // .env.local  WINS
  ),
  modeLocalFile.parsed
)                                                      // lines 111-117
```

All three keys the app reads (`API_BASE_URL`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`) are set in **both** files, so `.env.local` won every
one of them.

This makes the comment in `apps/mobile/babel.config.js` — *"Nothing selects this
by default. An ordinary build, a release build and the test suite all resolve
exactly what they resolved before"* — **false as written**. The `local:` env block
is not what selects the local file; the plugin does that on its own. Selecting it
with `BABEL_ENV=local` appears to work, which is exactly why the real mechanism is
easy to miss. The test suite is unaffected only by luck: the `test` profile points
at `.env.test`, whose `.local` sibling (`.env.test.local`) does not exist.

## The artefact

Built by holding `.env.local` aside for the duration of the build, so the plugin's
own cascade resolved `.env` (the hosted values).

| Field | Value |
|---|---|
| Path | `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` |
| Built | 2026-10-15 17:16 local |
| Size | 143,989,758 bytes (137.3 MiB) |
| SHA-256 | `944847891b0f89cc6bd5067d48519154c4052bcb6b605ba9d6ece6e163711ed3` |
| Package | `com.sanketvaani` |
| versionCode / versionName | `1` / `1.0` |
| minSdk / targetSdk / compileSdk | 24 / 36 / 37 |
| Native ABIs | `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` |
| Signature | V2 only (v1/v3/v4 false), `CN=Android Debug, OU=Android, O=Unknown` |
| Signer cert SHA-256 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |
| Embedded JS | `assets/index.android.bundle`, 2,531,800 bytes |
| Bundle SHA-256 | `5e5ce5e815f6def11f7384a5eca8f11aa3ed829308812cb4f93ed563d7ee365a` |

Built with `hermesEnabled=true` and `newArchEnabled=true`, so the bundle is Hermes
bytecode. The signer certificate is the **same** debug certificate as the earlier
build, so an in-place `adb install -r` against an existing debug install of this
app will not be refused on signature grounds. This is still a debug artefact: it
is signed with the public Android debug keystore and is not suitable for
distribution.

## How this artefact was produced, and how that was undone

Three temporary changes were needed, and all three were reverted:

| Temporary change | Why it was needed | Revert proof |
|---|---|---|
| `debuggableVariants = []` in `android/app/build.gradle` | Stops the plugin treating the debug variant as bundle-less, so JS is actually embedded. | `git diff --stat -- android/app/build.gradle` is **empty** — byte-identical to `HEAD`. |
| `.env.local` renamed to `.env.local.holdout` | So the dotenv cascade resolved `.env` instead of the local override. | Restored; SHA-256 is `51d25b4e…d1936`, identical to the value recorded before the build. |
| Deleted `app/build/generated/assets/react/debug/index.android.bundle` and `intermediates/assets/debug/mergeDebugAssets/index.android.bundle` | **Gradle considered the bundle task `UP-TO-DATE`** on the second attempt and left the old bundle in place, because the `.env` files are Metro cache keys and *not* declared Gradle task inputs. Only the JS sources are inputs, and they had not changed. | Derived build outputs only; regenerated by the build. |

The third row is worth internalising: **changing which `.env` file is used does
not make Gradle rebuild the bundle.** The first rebuild after the hold-out ran in
33s, reported `BUILD SUCCESSFUL`, and produced a byte-identical APK still aimed at
localhost. Only deleting the intermediates forced the regenerated bundle, which is
what the URL checks below then confirmed.

## That the embedded JavaScript is the current source

Presence of a bundle is not the same claim as presence of the *right* bundle. Four
strings were traced from source files changed in this session into the embedded
bundle, and re-checked against the **rebuilt** bundle rather than assumed to have
survived:

| String in the bundle | Source |
|---|---|
| `No part of this is a cloud backup.` | `src/screens/ml/TransferSection.tsx` |
| `I am not sure what I just did` | `src/screens/ml/RecordArea.tsx` |
| `Which glove are you recording from?` | `src/screens/ml/RecordArea.tsx` |
| `Two signs scored too closely` | `src/screens/ml/LiveArea.tsx` |

One further string — the Live area's `These are thresholds, not confidences…`
note — is **not** findable by an ASCII grep, and its sibling `Nothing measured how
often` behaves the same way. Both contain an em dash, so Hermes stores them as
UTF-16 and a byte-wise search for the ASCII encoding fails.

The two directions together are the useful lesson, and they are easy to confuse:

| String | ASCII/UTF-8 | UTF-16LE | Why |
|---|---|---|---|
| `No part of this is a cloud backup.` | PRESENT | absent | Pure ASCII → Hermes stores it as one byte per character. |
| `These are thresholds, not confidences` | absent | PRESENT | Contains an em dash → Hermes stores it as UTF-16. |

So an ASCII grep reporting "missing" proves nothing on its own. Both were verified
in their actual encoding.

## Permissions actually in the built artefact

`aapt2 dump badging` reports, from the app's own manifest: `INTERNET`,
`RECORD_AUDIO`, `POST_NOTIFICATIONS`. Firebase contributes
`com.google.android.c2dm.permission.RECEIVE`; the React Native debug runtime
contributes `WAKE_LOCK`, `ACCESS_NETWORK_STATE`, `SYSTEM_ALERT_WINDOW`,
`ACCESS_LOCAL_NETWORK`, and `com.sanketvaani.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.

**There is no Bluetooth permission in this APK.** That is consistent with
`docs/glove-input-layer.md`: the app has no BLE transport implementation, no BLE
library and no BLE permission, and the built artefact confirms all three rather
than only the source doing so.

## What this record does and does not support

Supported:

- The Android project builds from the current tree on JDK 17 / Gradle 9.4.1 /
  build-tools 37.0.0.
- The current JavaScript bundles and Hermes-compiles without error — a stronger
  check than the Jest run, because the bundler resolves the real module graph from
  `index.js`.
- The APK's identity, signature, SDK levels and permission set, read from the
  artefact itself.
- The **configuration** embedded in the bundle, by URL literal, which is the check
  that caught trap 2.

Not supported:

- Any device install, upgrade, launch or runtime behaviour.
- Anything about Metro connectivity, because no device was attached to connect.
- Delivery, push, email, database or hardware behaviour of any kind.
- Any claim that the hosted backend the bundle now points at **works** — it is
  reachable, but see `docs/integration-status-2026-10-15.md` for what its database
  currently refuses.

## Before any future build or device test

1. **Metro must be stopped, or the run does not test this bundle.** React Native
   developer support loads from a running Metro in preference to the embedded
   bundle. Leaving Metro up would test Metro's output while appearing to test the
   APK — an earlier warning in §7, and still true.
2. **The signature must match the installed app.** If the copy already on the phone
   was signed with a different key, `adb install -r` will be refused. Per the
   directive that is a stop condition, not a reason to uninstall: **the existing app
   and its data must not be removed to get around a signature mismatch.**
3. **Re-check the URLs in the bundle after any rebuild.** `.env.local` is back in
   place, so the *next* build on this machine will embed localhost again unless the
   file is held aside. The check is two commands and takes seconds:

   ```sh
   # which file did the bundler actually resolve?
   grep -c "sanket-vaanni-backend.onrender.com" app/build/generated/assets/react/debug/index.android.bundle
   grep -c "127.0.0.1" app/build/generated/assets/react/debug/index.android.bundle
   ```

   A `0` on the first line and a non-zero on the second means the artefact is
   pointed at a laptop, not at the deployed backend.
