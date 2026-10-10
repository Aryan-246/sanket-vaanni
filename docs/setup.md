# Setup

Exact, copy-pasteable commands for Windows PowerShell. Every command below was
run on this machine; versions are the ones actually verified, not guesses.

The two applications are **independent**. You do not need the backend to run the
mobile app, and you do not need the mobile app to run the backend.

---

## 1. Prerequisites

| Tool | Verified version | Why |
|---|---|---|
| Node.js | 24.16.0 | Both apps. `>= 22.11` required for `--env-file-if-exists`. |
| npm | 11.x | Ships with Node. |
| Git | 2.x | Version control. |
| JDK | 17 (Temurin 17.0.20) | Android Gradle Plugin 8.x rejects JDK 8 and warns on 21+. |
| Android SDK | platform 37, build-tools 37.0.0, NDK 27.1.12297006 | Required only to build/run the mobile app. |

Check what you have:

```powershell
node --version
npm --version
git --version
java -version              # ideally 17.x
echo $env:JAVA_HOME        # must point at the JDK 17 folder
```

> **`java -version` and `JAVA_HOME` can disagree, and that is fine.** On the
> machine this was built on, `java -version` reports `1.8.0_503` because an old
> JDK 8 sits earlier on `PATH`, while `JAVA_HOME` points at JDK 17.0.20. Gradle
> honours `JAVA_HOME`, so the Android build succeeds regardless. **`JAVA_HOME`
> is the one that matters** — check it, not `java -version`.

If `JAVA_HOME` is unset or points at the wrong JDK, set it for the session:

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
```

> Do not change machine-wide environment variables for this project unless you
> intend to. The session-scoped form above is enough to build.

### Android SDK

Check first:

```powershell
echo $env:ANDROID_HOME
adb version
```

If those are empty, install the SDK through Android Studio, or set the path for
the session:

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path = "$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:Path"
```

Alternatively — and this is what this repo does, because `ANDROID_HOME` is not
set machine-wide here — create `apps\mobile\android\local.properties`:

```properties
sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
```

**Use forward slashes.** A `.properties` file treats `\` as an escape character,
so writing the natural Windows form `sdk.dir=C:\Users\<you>\AppData\Local\Android\Sdk`
makes Java read `\U`, `\A`, `\L` and `\S` as invalid escapes, and Gradle fails
during configuration with:

```
java.io.IOException: The filename, directory name, or volume label syntax is incorrect
  at com.android.build.gradle.internal.SdkLocator$SdkLocationSource.validateSdkPath(SdkLocator.kt:216)
```

`C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk` is the escaped equivalent and
also works; forward slashes are just harder to get wrong.

That file is gitignored and machine-specific. Never commit it.

---

## 2. Clone and install

```powershell
git clone <repository-url> "SANKET VAANNI"
cd "SANKET VAANNI"
```

There is **no root workspace tool** and no root `npm install`. `package.json`
exists only inside each app, deliberately — so neither app can break the other's
build. Install each separately:

```powershell
cd apps\mobile
npm install

cd ..\..\apps\backend
npm install
```

---

## 3. Run the backend

```powershell
cd apps\backend
Copy-Item .env.example .env      # first time only
npm run dev
```

Expected output — the service is listening on port 4000:

```
{"level":30,...,"msg":"server listening on 0.0.0.0:4000"}
```

Verify from a second terminal:

```powershell
curl.exe http://127.0.0.1:4000/health
```

Expected:

```json
{"status":"ok","service":"sanket-vaanni-backend","version":"0.1.0", ...}
```

Production-style run (compiled, no watcher):

```powershell
npm run build
npm start
```

To reach the backend from a **physical phone** on the same Wi-Fi, bind all
interfaces:

```powershell
$env:HOST = "0.0.0.0"
npm run dev
```

Then set `API_BASE_URL` in the mobile app to `http://<your-PC-LAN-IP>:4000`
(`ipconfig` → IPv4 Address), and allow Node through the Windows firewall for
private networks.

---

## 4. Run the mobile app

```powershell
cd apps\mobile
Copy-Item .env.example .env      # first time only — optional
```

Start Metro in one terminal:

```powershell
npm start
```

In a second terminal, with an emulator running or a device connected over USB
(USB debugging enabled, `adb devices` shows it):

```powershell
npm run android
```

Nothing to install it on? Build the APK only:

```powershell
cd apps\mobile\android
.\gradlew.bat assembleDebug
```

First build downloads Gradle 9.4.1 and the Android Gradle Plugin — expect
several minutes. Later builds are much faster.

The debug APK lands at:

```
apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk
```

Install it manually with:

```powershell
adb install -r apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk
```

### Faster local builds

The Gradle config builds all four ABIs (`armeabi-v7a,arm64-v8a,x86,x86_64`),
which is right for release and slow for iteration. To build fewer:

```powershell
.\gradlew.bat assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64
```

> ⚠️ **`-PreactNativeArchitectures` replaces the ABI list — it does not add to
> it.** Naming one ABI gives you an APK that only runs on that one ABI:
>
> ```powershell
> # Emulator-only APK. WILL FAIL on a physical phone:
> .\gradlew.bat assembleDebug -PreactNativeArchitectures=x86_64
> #   INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113
> ```
>
> `arm64-v8a` is the right choice for almost every physical phone (including
> 64-bit devices that also list `armeabi-v7a`); `x86_64` is the desktop
> emulator. Keep both to cover phone and emulator from one APK.

There is no `abiFilters` or `splits` block in `app/build.gradle` — the ABI set
comes solely from `reactNativeArchitectures` in `android/gradle.properties`,
which the React Native Gradle Plugin turns into `ndk.abiFilters`.

Check what an APK actually contains before shipping it anywhere:

```powershell
unzip -l app-debug.apk | Select-String "lib/"
```

Every directory under `lib/` is an ABI the APK can run on. One directory means
one supported ABI.

### Pointing the app at the backend

Edit `apps\mobile\.env`:

```properties
API_BASE_URL=http://10.0.2.2:4000
```

`10.0.2.2` is the Android emulator's alias for the host machine's loopback.
Restart Metro with a cleared cache after changing it:

```powershell
npm start -- --reset-cache
```

This is configuration, not code. No source change is needed to retarget the app
at a different backend, and the app works fully offline regardless.

---

## 5. Tests, types and lint

Each app is checked independently.

Backend:

```powershell
cd apps\backend
npm test
npm run typecheck
npm run build
```

Mobile:

```powershell
cd apps\mobile
npm test
npm run typecheck
npm run lint
```

Mobile tests run on Jest with `react-test-renderer`. They do **not** need an
emulator, the Android SDK, or a network connection.

---

## 6. Release build

A release build will not produce a shippable artifact until it is signed. The
scaffold reuses the debug keystore for `release`, which is fine for local
testing and **not acceptable for distribution**.

Generate a keystore:

```powershell
keytool -genkeypair -v `
  -keystore sanket-vaanni-release.keystore `
  -alias sanket-vaanni `
  -keyalg RSA -keysize 2048 -validity 10000
```

`keytool` prompts for the password and identity details interactively. Store the
keystore outside the repository and record the password in your own password
manager — **never in a file in this repo.**

Point Gradle at it through `~/.gradle/gradle.properties` (outside the repo, so
secrets never enter version control):

```properties
SANKET_VAANNI_UPLOAD_STORE_FILE=C:/keys/sanket-vaanni-release.keystore
SANKET_VAANNI_UPLOAD_KEY_ALIAS=sanket-vaanni
SANKET_VAANNI_UPLOAD_STORE_PASSWORD=********
SANKET_VAANNI_UPLOAD_KEY_PASSWORD=********
```

Then wire a `signingConfigs.release` block into `apps\mobile\android\app\build.gradle`
reading those properties, and build:

```powershell
cd apps\mobile\android
.\gradlew.bat assembleRelease
```

Output: `apps\mobile\android\app\build\outputs\apk\release\app-release.apk`

> Not done in this milestone. Producing a signed, distributable APK is a
> deliberate later step — no keystore exists yet, and creating one is a
> decision for the project owner, not the build.

---

## 7. Troubleshooting

**`INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries,
res=-113`** — the APK has no native library for your device's CPU. Almost
always caused by building with a single-ABI `-PreactNativeArchitectures`.
Diagnose in three commands:

```powershell
# 1. What does the phone support?
adb shell getprop ro.product.cpu.abilist      # e.g. arm64-v8a,armeabi-v7a,armeabi

# 2. What did the APK actually package?
unzip -l app-debug.apk | Select-String "lib/" # e.g. only lib/x86_64/…

# 3. Rebuild covering both the phone and the emulator
cd apps\mobile\android
.\gradlew.bat assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64
```

If step 1 lists `arm64-v8a`, build `arm64-v8a`. If the APK shows only
`lib/x86_64/`, it was built for the emulator alone.

**Red screen: "Unable to load script. Make sure you're running Metro…"** — the
debug APK loads JS from Metro, so this is expected if Metro is not running or
the device cannot reach it. Two causes, in order of likelihood:

1. **`adb reverse` was lost.** It is cleared whenever the USB link drops or the
   device reconnects, and the failure looks identical to Metro being down. If
   the app worked a moment ago, this is almost certainly it:

   ```powershell
   adb reverse tcp:8081 tcp:8081
   adb reverse --list          # must show tcp:8081
   ```

2. Metro genuinely is not running — start it with `npm start`.

This only affects **debug** builds. A release build has the bundle and assets
packaged inside the APK and needs no Metro.

**`adb: command not found` / `adb: no devices/emulators found`** — `adb` lives
in `%LOCALAPPDATA%\Android\Sdk\platform-tools` and is not always on `PATH`.
Add it for the session:

```powershell
$env:Path = "$env:LOCALAPPDATA\Android\Sdk\platform-tools;$env:Path"
adb devices
```

`npm run android` needs `adb` on `PATH`; `.\gradlew.bat assembleDebug` does not.
If you have no device, build the APK and install it later.

**`SDK location not found`** — `ANDROID_HOME` is unset and
`android\local.properties` is missing. That is the situation on the machine
this was built on, where `local.properties` is what makes the build work.
See §1.

**`Unsupported class file major version` / Gradle Java errors** — Gradle is
picking up the wrong JDK. Confirm `java -version` reports 17 and that
`JAVA_HOME` points at it, then re-run. Add `org.gradle.java.home=<jdk17 path>`
to `android\gradle.properties` to pin it permanently.

**Metro serves a stale bundle** — `npm start -- --reset-cache`.

**`adb: no devices/emulators found`** — start an emulator from Android Studio's
Device Manager, or check the USB cable and that USB debugging is enabled.

**Port 4000 already in use** — change `PORT` in `apps\backend\.env`. Backend and
mobile are independent, so this cannot affect the app.

**Intro video does not play on device** — a known, documented risk. See the
"Known risk" section of `apps\mobile\README.md`. Every failure path falls back
to the supplied poster and continues into the app; the intro can never block
startup.
