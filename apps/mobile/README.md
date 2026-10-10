# Sanket Vaanni — Mobile (Android-first)

React Native 0.87.1 + TypeScript. Android-first; iOS is present but untested.

This application is **independently buildable, startable and deployable**. It
has its own `package.json`, dependency tree, `.env` and scripts. It shares no
tooling with `apps/backend` and does not require it to run — sensor processing,
calibration, history and configuration all work offline.

> **Status: foundation build.** No glove Bluetooth, no gesture recognition and
> no speech. Readings on the home screen are produced by a built-in simulator
> and labelled **Demo Mode**. See `docs/ble-protocol.md`.

## Requirements

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 24.16.0 | `engines` requires ≥ 22.11.0 |
| JDK | 17 | `JAVA_HOME` must point at 17, not 8 |
| Android SDK | platform 37, build-tools 37.0.0, NDK 27.1.12297006 | `ANDROID_HOME` or `android/local.properties` |
| npm | 11.x | |

## Setup

```powershell
cd apps\mobile
npm install
Copy-Item .env.example .env      # optional — see Configuration below
```

If `ANDROID_HOME` is not set, create `android\local.properties`:

```properties
sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
```

Use **forward slashes**, as above. A `.properties` file treats `\` as an escape
character, so the natural Windows form
`sdk.dir=C:\Users\...\Sdk` produces
`IOException: The filename, directory name, or volume label syntax is incorrect`
during Gradle configuration. `C\:\\Users\\...` also works; forward slashes are
less error-prone.

(That file is gitignored and must not be committed.)

## Run

Metro bundler:

```powershell
npm start
```

Build and install on a running emulator or connected device:

```powershell
npm run android
```

With no emulator available, build the APK without installing:

```powershell
cd android
.\gradlew.bat assembleDebug
```

Limit architectures to speed up a local build (the default builds all four):

```powershell
.\gradlew.bat assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64
```

> **This flag replaces the ABI list, it does not add to it.** Passing a single
> ABI produces an emulator-only APK. Installing one on a physical phone fails
> with:
>
> ```
> INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113
> ```
>
> The listed ABIs are the *only* ones packaged under `lib/`. Most phones are
> `arm64-v8a`; most desktop emulators are `x86_64`. Keep **both** unless you
> know which single target you are building for. To confirm what you actually
> built:
>
> ```powershell
> unzip -l app-debug.apk | Select-String "lib/"
> ```
>
> Omit the flag entirely for a universal APK covering all four ABIs.

Release APK:

```powershell
cd android
.\gradlew.bat assembleRelease
```

> A release build needs a signing config. The default `android/app/build.gradle`
> uses the debug keystore for release, which is **not** suitable for
> distribution. See `docs/setup.md` for the keystore steps before shipping.

## Scripts

| Script | Purpose |
|---|---|
| `npm start` | Metro bundler |
| `npm run android` | Build + install debug on device/emulator |
| `npm test` | Jest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

## Configuration

The backend URL is configuration, never hardcoded. Set it in `apps/mobile/.env`:

```properties
API_BASE_URL=http://10.0.2.2:4000
```

| Target | Value |
|---|---|
| Android emulator | `http://10.0.2.2:4000` (host loopback alias) |
| Physical device | `http://<host-LAN-IP>:4000` — and run the backend with `HOST=0.0.0.0` |
| iOS simulator | `http://127.0.0.1:4000` |

Changing this requires a Metro restart, not a code change:

```powershell
npm start -- --reset-cache
```

If unset, development falls back to the emulator default. **The app works fully
offline either way** — the backend is not on the critical path.

## Structure

```
apps/mobile/
├── App.tsx                     entry: providers + status bar
├── index.js                    AppRegistry registration
└── src/
    ├── app/
    │   ├── RootNavigator.tsx   launch gate: intro → home → settings
    │   └── AppState.tsx        provider wiring transport/storage/processing
    ├── ble/
    │   ├── types.ts            GloveTransport interface  ← the seam
    │   ├── mockTransport.ts    Demo Mode simulator
    │   └── bleTransport.ts     real BLE — throws, protocol unverified
    ├── sensors/
    │   ├── types.ts            RawSample / SensorSample
    │   ├── calibration.ts      anchor capture + normalisation
    │   └── processing.ts       calibrate → smooth
    ├── recognition/            contracts + language profiles (no model)
    ├── speech/                 TTS contract (not wired)
    ├── storage/                AsyncStorage + in-memory impl
    ├── api/client.ts           typed backend client, offline-safe
    ├── config/env.ts           API_BASE_URL resolution
    ├── screens/                Intro, Home, Settings
    ├── components/             AppText, Card, ActionButton, Badge, FlexBar…
    ├── theme/                  colour, spacing, type tokens
    └── assets/intro/           intro video + poster (copied unmodified)
```

### The transport seam

`ble/types.ts` defines `GloveTransport`. `MockTransport` and `BleTransport`
implement it. The UI depends only on the interface, so replacing the mock with
real hardware — once the protocol is verified — changes no screen.

`BleTransport` deliberately throws. It is **not** stubbed with plausible UUIDs.

## The intro

Plays the supplied `sanket-vaani-intro.mp4` (copied byte-for-byte from
`design-reference/`, never regenerated) once on first launch, then enters the
app. Implemented natively with `react-native-video` — the supplied web
`<video>`/`<div>` component is a design reference only and none of its markup or
CSS is used.

Guarantees:

- **Never traps the user.** Completion, skip, playback error, and a 15 s
  watchdog stall all route into the app. Verified by test.
- **Accessible skip**, revealed after playback starts.
- **Replayable** from Settings.
- **Reduced motion respected** — if the OS reports reduced motion the intro is
  skipped entirely.
- **Failures degrade to the supplied poster** plus the wordmark, not an error
  or a black screen.

### Video player on RN 0.87 — risk resolved by measurement

**Status: verified working on one physical device. See the caveat below.**

The concern was real. `react-native-video` v6 (`6.19.3`) documents Old
Architecture plus New Architecture **via the interop layer**, and its docs state
it *"does not support Bridgeless Mode"*. RN 0.87 is New-Architecture-by-default
and bridgeless (`android/gradle.properties` → `newArchEnabled=true`), and v6
ships no `codegenConfig` and no Fabric component sources — its only view manager
is a legacy Paper `ReactExoplayerViewManager`. That is why the APK compiling was
never evidence that playback worked.

It was then measured on real hardware (vivo V2141, arm64-v8a, Android 16 /
API 36), and **playback works**:

- `ReactNativeJS: Running "SanketVaani" with {"fabric":true}` — Fabric active
- `MediaCodec` and `BufferQueueProducer` activity — hardware decoder ran
- Six screenshots across the intro all had **different** hashes — frames were
  animating, not a static poster
- `ReactExoplayerView$OnAudioFocusChangedListener` held audio focus with
  `gain: GAIN`, `loss: none`, `usage=USAGE_MEDIA` — soundtrack played, unmuted

**Caveat: this is one device and one Android version.** The documented
limitation is a genuine upstream constraint, not a mistake in their docs — it
simply did not manifest for a straightforward local-file `<Video>` here. Other
devices, other media, or future RN releases may behave differently.

If it does fail elsewhere, the maintained path is **v7**
(`7.0.0-beta.12`, full New Architecture), which additionally requires
`react-native-nitro-modules`. Every failure path still degrades to the poster
and continues, so a failure degrades the first-launch experience — it does not
break the app.

## Known limitations

- No Bluetooth. No permissions are declared because none are used.
- No gesture vocabulary exists — `src/recognition/profiles.ts` lists ISL, ASL
  and BSL as `planned` with `vocabularySize: 0`.
- No speech engine.
- Calibration is wired and tested but there is no guided capture UI yet, and no
  real anchors have been captured (needs gloves in hand).
- iOS has not been built or tested.
