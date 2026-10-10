# Runtime smoke test

First real run of the app on hardware.

## First run — already executed

A first run was performed on a physical device (vivo V2141, arm64-v8a,
**Android 14 / API 34**) while installing the rebuilt APK. Results, with
evidence:

> **Correction.** Earlier revisions of this file said "Android 16 / API 36".
> That was wrong. `adb shell getprop ro.build.version.sdk` returns **34** and
> `ro.build.version.release` returns **14**. A second, more thorough run was
> made later on the same handset; its results are recorded in
> "Second run — intro and startup" near the end of this file.

| Area | Outcome | Evidence |
|---|---|---|
| Install | **Pass** | `adb install -r` → `Success` |
| App launch | **Pass** | Process running; no `AndroidRuntime` exception |
| Intro video | **Pass** | `MediaCodec` active; 6 frames with different hashes |
| Intro audio | **Pass** | ExoPlayer held audio focus, `gain: GAIN`, `USAGE_MEDIA` |
| Skip control | **Pass** | Visible in captured frames after playback started |
| Intro → Home | **Pass** | Home screen reached, intro not replayed |
| Home screen | **Pass** | Demo Mode badge, 5 flex channels, "Not implemented" |
| No fabricated sign/confidence | **Pass** | No sign name or percentage rendered |
| Crash-free | **Pass** | No fatal exceptions in `logcat` |

**Not yet exercised:** the playback-error fallback (§4), rotation, backgrounding,
battery/heat over time, and TalkBack. Treat the sections below as still open —
re-run them and fill in the Result columns.

---

Treat every step below as unverified unless the table above says otherwise.
Record actual observed behaviour, including failures. A failed step that is
written down honestly is worth more than a passing step that was assumed.

---

## 0. Before you start

Build and install the debug APK (see `docs/setup.md`):

```powershell
$env:Path = "$env:LOCALAPPDATA\Android\Sdk\platform-tools;$env:Path"
cd "C:\PROJECT\SANKET VAANNI\apps\mobile"
adb devices                      # must list your phone as "device", not "unauthorized"
npm start                        # terminal 1 — leave running
npm run android                  # terminal 2
```

Start a log capture in a third terminal **before** launching, so a crash is
recorded rather than missed:

```powershell
adb logcat -c
adb logcat *:S ReactNative:V ReactNativeJS:V AndroidRuntime:E Video:V > smoke.log
```

On a crash, `AndroidRuntime` gives the Java stack trace and `ReactNativeJS`
gives the JS error — those two lines are the whole diagnosis.

If a step fails, capture and keep `smoke.log`. Do not clear it between steps.

**Test on a clean install the first time**, so the intro plays:

```powershell
adb uninstall com.sanketvaani
npm run android
```

---

## 1. App launch — first run

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Launch from the app drawer | App opens; no white flash before content | |
| 1.2 | Observe immediately after splash | Intro animation begins, not the Home screen | |
| 1.3 | Watch for red box / error screen | None | |
| 1.4 | Watch for a blank black screen with no video | **Possible known failure** — see §2 | |

**1.4 is the step most likely to fail.** See §2 before recording it.

## 2. Intro video and audio — the highest-risk step

`react-native-video` 6.19.3 supports the New Architecture **only via the interop
layer**, and its official documentation states it **does not support Bridgeless
Mode**. This project runs RN 0.87.1 with `newArchEnabled=true`, which is
bridgeless. The library's own PR #4616 notes the `Video` component is not
registered in `RCTThirdPartyComponentsProvider` and that this "should also fix
crashes on React Native 0.80+".

So: the APK compiling proves nothing about playback. It must be observed.

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | Does the video render? | Full-screen animation, hands / broken ring / Hindi title | |
| 2.2 | Is it letterboxed against black, not stretched? | `resizeMode: contain` | |
| 2.3 | Is there audio? | Soundtrack plays, unmuted | |
| 2.4 | Do the loading dots animate? | Movement visible | |
| 2.5 | Does it play to the end and enter the app? | Home screen appears | |
| 2.6 | Total duration | Clip is **6.467 s**; app enters within ~10 s | |

**If 2.1 fails** (black screen, no video, or a crash), that is the known
bridgeless risk and it is a real finding — record it with the `smoke.log` lines.
The app is designed to survive it: after the watchdog the poster appears and the
app continues. Confirm §3 then decides the fix (see §8, risk A).

## 3. Skip control

| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | On first frame | Skip control is **not** visible yet | |
| 3.2 | After ~0.7 s | Skip control is revealed | |
| 3.3 | Tap it | Immediately enters the app | |
| 3.4 | Tap it twice quickly | Enters the app once, no double navigation | |
| 3.5 | With TalkBack on | Skip is announced and reachable | |

## 4. Playback-error fallback

This is the safety net for §2. To force it, use airplane mode — the video is
bundled locally so this only proves the failure path, not file access:

| # | Step | Expected | Result |
|---|---|---|---|
| 4.1 | Force a video failure (see note below) | Intro is replaced by the supplied poster | |
| 4.2 | Then | The wordmark is visible over it | |
| 4.3 | After ~1.4 s | App continues to Home automatically | |
| 4.4 | Entire failure path | Never shows an error screen, never hangs, never returns to the intro | |

> Forcing a failure without changing code is awkward. The practicable options
> are: rotate the device or background the app mid-intro (exercises the stall
> path), or temporarily rename the asset in a throwaway local build. **Do not
> delete or modify the supplied video** — it must stay byte-identical. If you
> cannot force it, record 4.1–4.4 as *not exercised on device*; the Jest suite
> covers this path with fake timers, but that is not the same as the device.

## 5. Home screen

| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | Layout | Wordmark and sensor channels render; nothing clipped or overlapping | |
| 5.2 | **Demo Mode badge** | Clearly visible, states data is simulated | |
| 5.3 | Flex channel bars | Animate from simulated data | |
| 5.4 | Recognised sign area | Reads **"Not implemented"** — no sign is shown | |
| 5.5 | Confidence figure | **None anywhere.** No percentage, no "confidence" | |
| 5.6 | Bluetooth wording | States no Bluetooth is in use | |
| 5.7 | Frame rate | Smooth; no visible stutter with the 20 Hz display | |
| 5.8 | Battery/heat after ~5 min | No unusual drain or warmth | |

**5.4 and 5.5 are correctness gates, not cosmetic ones.** If any sign name or
confidence percentage appears, stop and report it — that is a fabricated result
and a milestone-1 regression.

## 6. Navigation

| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | Open Settings | Opens; back returns to Home | |
| 6.2 | Replay intro from Settings | Intro plays again | |
| 6.3 | Finish it | Returns to Home, does **not** loop the intro | |
| 6.4 | Hardware back button | Behaves sensibly from each screen; no dead ends | |
| 6.5 | Press Home, then return to the app | Back where you were — intro is **not** replayed | |
| 6.6 | Dismiss from Recents, then launch | Intro **plays again** | |
| 6.7 | Force-stop, then launch | Intro **plays again** | |

6.5–6.7 together are the launch-gating requirement, and the distinction is the
whole specification: the intro is keyed on the lifetime of the JavaScript
context (`src/app/launchSession.ts`), not on a persisted `hasSeenIntro` flag.
Pressing Home keeps the process alive, so coming back does not restart the
intro. Dismissing from Recents and force-stopping both destroy the process, so
the intro plays again.

An earlier revision of this checklist said a relaunch "goes **straight to
Home** — intro is not replayed". That was the opposite of the requirement, and
it described the bug the gating module exists to fix: with a persisted flag the
intro disappears permanently after one run.

## 7. Crash-free exit and lifecycle

| # | Step | Expected | Result |
|---|---|---|---|
| 7.1 | Background the app for ~1 min, return | Restores, does not crash | |
| 7.2 | Rotate the device | No crash (portrait is the target layout) | |
| 7.3 | Force-stop and relaunch | Clean start | |
| 7.4 | Exit via back from Home | No crash, no ANR | |
| 7.5 | Check the log | No unhandled `AndroidRuntime` exceptions | |
| 7.6 | App size on device | Release **40.3 MB**; debug **132.5 MB** (it packages all four ABIs). Measured, not estimated | |

## 8. Known risks ranked

**A. Intro video under bridgeless (highest).** Documented incompatibility; see §2.
**Observed working** on the target handset — see "Second run" below. The
incompatibility is real and upstream, but it did not manifest for a
straightforward local-file `<Video>` here. Other devices, other media and future
RN releases may differ.

**B. GIF-style smoothness of the intro.** Only a concern if 2.1 passes but looks
wrong — that would be a decoding/performance issue, not a compatibility one.

If **A** fails, the options are, in order of preference:

- **Option 1 — ship the poster.** Accept the documented failure, since the
  fallback already handles it gracefully and the app is fully usable. Cheapest,
  no new dependency.
- **Option 2 — upgrade to v7** (`7.0.0-beta.12`), which has *full* New
  Architecture support. Requires adding `react-native-nitro-modules` and moving
  to a beta. This is the maintained long-term path.
- **Option 3 — pre-render to a frame sequence** and play it with `Animated`.
  No video dependency at all, but a much larger asset and real design work.

Do not start any of these until the failure is actually observed and the log
confirms the cause.

## Second run — intro and startup

A focused run on the intro and launch experience. Same handset.

**Device and build, read rather than assumed:**

| Fact | Value |
|---|---|
| Device | vivo V2141, `ro.product.cpu.abilist=arm64-v8a,armeabi-v7a,armeabi` |
| Android | **14 / API 34** (`ro.build.version.sdk=34`) |
| Build | `assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64` |
| APK | 40,332,130 bytes, sha256 `69db35a6…831dd8a8b2` — hashed back off the device to confirm the installed copy matches |

**The intro asset is the supplied original, unmodified.** Verified by hash
against the kit: video `cce5afa6…`, poster `0c5f9e00…`. The clip is 1080×1920
H.264 (`avc1`), 97 frames at 15.0 fps, **6.467 s**, 2,344,975 bytes (~2901 kbps);
audio AAC (`mp4a`) 44100 Hz. It is packaged as `res/fr.mp4` and is genuinely
local — in release `Image.resolveAssetSource` returns a *resource name*
(`src_assets_intro_sanketvaaniintro`), not a URL, so nothing is fetched at
runtime.

**Playback callbacks, in order, from `adb logcat` (tag `ReactNativeJS`):**

```
readyForDisplay                       ← ExoPlayer STATE_READY: prepared, not painted
load { durationSec: 6.467 … }
playback started { currentTime: 0.089 }   ← playhead moving, ~250 ms after load
revealing video                           ← poster dissolve begins
```

**Observed on screen**, by phase-staggered screenshots (on-device `screencap`
costs ~780 ms, so repeated cold launches are staggered to sample the window):

| Approx. time | Screen |
|---|---|
| 0.6 s | launcher's own window-open animation — not the app |
| 0.8–1.5 s | **branded splash poster** over black, correctly letterboxed |
| ~2.1 s | mid-crossfade: poster dimming, video content appearing beneath |
| ~3 s onward | video playing; Skip revealed |

No black frame at any sampled point, and status/navigation bars were hidden for
the cinematic and restored on entering Home.

| # | Scenario | Result |
|---|---|---|
| 1 | Cold launch from the icon → intro | **Pass** |
| 2 | Skip → Home exactly once | **Pass** |
| 3 | Playback completion → Home exactly once | **Pass** — no fallback fired; Home stable at ~8.5 s and ~12 s |
| 4 | Settings → Replay intro → Home | **Pass** |
| 5 | Press Home, return → intro not replayed | **Pass** — task id unchanged (`t6991`) |
| 6 | Dismiss from Recents, launch → intro plays | **Pass** — task id changed `t6991`→`t6992` |
| 7 | Force-stop, launch → intro plays | **Pass** |
| 8 | Playback failure → safe fallback to Home | **Pass, but only under an injected fault** (see below) |
| 9 | No loop, crash or stuck blank screen | **Pass** on the runs observed — no `FATAL EXCEPTION`, no ANR, one intro per launch |

**Scenario 8 was exercised with a deliberately broken source, not a natural
failure.** The video source was temporarily pointed at a non-existent asset in a
throwaway build. `ExoPlaybackException: Source error` →
`ERROR_CODE_IO_FILE_NOT_FOUND`, the branded poster held, and the app reached Home
without trapping the user. That build was discarded; the shipped code uses the
real asset. Because the fault was injected, this is a check of the recovery path,
**not** an end-to-end natural reproduction.

**Known limitation — media suppressed during a call.** With the phone in a call
(`Mode: MODE_IN_CALL`, telecom holding `GAIN_TRANSIENT` with `LOCK` on ringtone
usage, and `muted player piids due to call/ring`), the clip loaded and then sat at
frame 0: react-native-video pauses the player on audio-focus loss. A bounded
`PLAYBACK_START_DEADLINE_MS` (2500 ms, armed from `onLoad`) now releases the user
to the branded poster instead of leaving them on a still frame. **This has not
been re-verified on the shipping build while a call is actually active** — the
call ended before that could be measured.

**Not measured: animation smoothness / frame rate.** The evidence above is
screenshots, which cannot measure frame rate or dropped frames. The changes made
for playback cost (a memoised player subtree, no `progressUpdateInterval`, no
per-progress React state) are structural rather than measured, and the original
"looks rough" symptom is **not** confirmed fixed by measurement.



Fill in the Result column and keep it with the project. State plainly which
steps were exercised and which were not reached — a step that was never run is
not a pass. If the run was partial, say so.

Do not describe the intro as working, or Bluetooth as functional, on the basis
of this checklist. Bluetooth is not implemented; `docs/ble-protocol.md` still
governs that, and it is marked **PROPOSAL, NOT YET VERIFIED**.
