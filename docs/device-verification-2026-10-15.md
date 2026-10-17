# Device verification — 2026-10-15

Evidence from a real handset session. Unlike `docs/apk-verification-2026-10-15.md`,
which is about the *artefact*, this record is about *runtime behaviour on hardware*.

**The session was short and ended involuntarily.** The phone was attached from
approximately 17:20 to 17:27 local and was then disconnected (`adb devices -l`
returned an empty list and never recovered during this work). Everything below was
observed inside that window. Anything not listed here was **not** tested, and per
§7 no device verification is claimed for it.

---

## The device

| Field | Value |
|---|---|
| Serial | `1595140436001XT` |
| Model | vivo V2141 (`2141i`) |
| Manufacturer | vivo |
| Android | 14 |
| SDK | 34 |
| Security patch | 2025-03-01 |

Read from `getprop`, not assumed — this is the same handset used in the previous
milestone's device pass, and the model/Android version agree with that record.

## The state before install

`com.sanketvaani` was **already installed**, so this was an update, never a fresh
install.

| Field | Value |
|---|---|
| versionCode / versionName | 1 / 1.0 |
| Installed APK size | 143,559,246 bytes |
| Signer cert SHA-256 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |
| Embedded bundle | `assets/index.android.bundle`, 1,716,391 bytes |
| Bundle SHA-256 | `afbe8c6e1647dadf8b812d4586118a0c9431f0485ac6dd765c6ddc6e7f71ce46` |
| Bundle config | hosted backend + hosted Supabase; **no** localhost literals |

The installed bundle was 1.7 MB against this build's 2.5 MB, and contained none of
the development-only strings — consistent with a **release-mode** bundle from an
earlier commit. That is a different artefact from either APK produced today.

The signer certificate matched the debug certificate exactly, which is why an
in-place update was possible. **No uninstall was performed and no app data was
cleared**, per the directive.

## The install

```
adb install -r -d app-debug.apk
  Performing Streamed Install
  Success
```

`-r` is an update in place; `-d` permits the same-or-lower versionCode. After it,
`pm path` reported a **new** package directory, confirming replacement rather than
a no-op.

## Controlling for Metro — the check that makes the rest meaningful

A React Native debug build prefers a running Metro over its own embedded bundle,
so a device test can silently exercise Metro's output while appearing to test the
APK. Two independent facts rule that out here:

1. `adb reverse --list` was **empty** — the phone had no route to a packager on
   port 8081. (Metro *was* listening on the host; the device simply was not
   wired to it.)
2. The app confirmed it at runtime:
   `I/ReactNativeJNI: Error occurred, shutting down websocket connection:
   WebSocket exception Failed to connect to localhost/127.0.0.1:8081`
   — and it **kept running** with no `FATAL`, no `AndroidRuntime` exception and no
   red box.

So the behaviour below came from the bundle embedded in the installed APK. This
also settles a design question the APK record could only reason about: a debug APK
with JS packaged via `debuggableVariants = []` **does** start standalone with no
packager reachable.

## What was observed, screen by screen

All screens reached by real taps (`adb shell input`) through the app's own
navigation — no deep links, no direct activity starts after launch.

**1. Cold launch → Dashboard.** Rendered correctly: the `संकेत वाणी` header,
`Dashboard · ISL → English`, the two glove cards (Left/Right, "Not connected",
"Find", "Connect both"), the **3D orb rendered** in the ORB STAGE card, and the
bottom navigation (Dashboard / OLED / Textboard / History / Settings). No crash,
no blank screen, no error boundary.

Two honesty claims are visible on the device and worth recording, because they are
the product's central promise rendered on hardware rather than in a test:

- Guest banner: *"You are browsing as a guest. Everything stays on this phone, no
  server has a copy of it, and no administrator can see it. Uninstalling the app
  will remove it."*
- Below the orb: *"No recognition model is loaded, so signs cannot be read"* — the
  app does not imply it can translate when it has no model.

**2. Settings.** Scrolled through the whole page. Notable, all verified on screen:

- **NOTICES** — *"The latest notices could not be checked, and nothing from the
  last list is still live."* with the detail *"The notice check could not be
  completed (Could not find the table 'public.announcements' in the schema
  cache)"* and a "Try again" control.
- **CLOUD & ACCOUNT** — "Local only" and "Profile", both showing **Guest**.
- **NOTIFICATIONS** — *"Switched on here, but your phone is not delivering
  notifications from Sanket Vaanni. Turn them on for this app in your phone's
  settings."*
- **SPEECH OUTPUT** — *"Spoken as en-IN. No translation model exists yet, so no
  text reaches the speech engine."*; "Would speak — Nothing yet"; "Glove speaker —
  Coming soon. Needs a verified command protocol."
- **RECOGNITION** — "Models and vocabulary — **Nothing trained yet**".

This is the most valuable result of the session. The app **reported the real
backend failure to the user, by name**: the missing `public.announcements` table is
Finding 2 of `docs/integration-status-2026-10-15.md` (`PGRST205`, migrations 3 and
4 unapplied) surfacing on hardware as an honest, retryable error instead of a
fabricated success or an empty list. The push row likewise declines to claim
delivery from a stored toggle alone.

**3. ML centre (`Models and vocabulary`).** Opened by tapping the row. The
learning centre is reachable, with tabs Overview / Record / Library / Models /
Live.

- **Overview** — "WHERE FRAMES COME FROM": both hands listed as *"Right hand — Demo
  Mode (simulated) · Disconnected"* / *"Left hand — Demo Mode (simulated) ·
  Disconnected"*, each with *"No frames are arriving, so nothing can be recorded
  from this glove yet."* Plus: *"Calibration in use: version 1 (right), version 1
  (left). Every window records which calibration produced its frames, so a model
  can never be read against a different one without that being visible."* And
  *"Connecting and scanning happen on the OLED screen, which owns the link."*
- **Language/modality selectors** — Indian / American / British, and Glove /
  Photos, with the note that training only ever looks at one pair at a time.
- **Models** — the consent and threshold screen: *"Use my recordings to train —
  Off. Recording and training are separate permissions: agreeing to record is not
  agreeing to train."*; *"Train on Demo Mode motion — Off."*; *"0 confirmed windows
  across 0 signs and 0 sessions."*; *"No capture session has been recorded, so
  there is nothing to fit."*; *"Training is off because your recordings have not
  been allowed for it."*; the "Train a model now" button rendered **disabled**.

The app refuses to train without consent and without data, reports zero counts
truthfully, and offers no progress indicator it cannot back with real events. No
invented accuracy, no placeholder chart, no "trained" badge.

## What this session does *not* prove

- **No BLE behaviour.** No glove was connected; the only source shown was Demo
  Mode (simulated). The app says so itself on the Overview tab.
- **No model training, evaluation or inference.** Zero samples existed, so the
  training path was correctly refused rather than exercised.
- **No sign-in.** The app ran as Guest; no Supabase Auth identity was used.
- **No database write, no email, no push receipt.** The notices row proves the
  app *reports* a backend failure honestly; it does not prove any backend success.
- **No Admin screens.** The Admin area is gated; this session did not enter it,
  and the Admin half of the review remains outstanding.
- **Nothing after 17:27.** The device was disconnected and no further checks could
  run — the post-install permission-state verification and any longer soak were
  cut off by that disconnection and are **not** reported as done.

## Reproducing this

```sh
adb devices -l                      # confirm the handset, do not assume the model
adb reverse --list                  # MUST be empty, or the test exercises Metro
adb install -r -d <apk>
adb shell am start -n com.sanketvaani/.MainActivity
adb logcat -d | grep -E "ReactNativeJNI|AndroidRuntime|FATAL"
adb exec-out screencap -p > shot.png
```

The APK tested was built at 17:16 — see `docs/apk-verification-2026-10-15.md` for
its identity, signature and SHA-256. Note that the phone now carries the **debug**
build; the release-mode build it had before was replaced by the authorised
non-destructive update.
