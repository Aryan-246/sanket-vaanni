# Runtime smoke test

First real run of the app on hardware. Nothing below has been executed yet —
no device or emulator existed on the machine where milestone 1 was built, so the
app has been compiled and unit-tested but **never actually run**.

Treat every line here as unverified until a human runs it and writes down what
happened. Record actual observed behaviour, including failures. A failed step
that is written down honestly is worth more than a passing step that was
assumed.

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
| 2.6 | Total duration | Intro is ~13 s; app enters within 15 s | |

**If 2.1 fails** (black screen, no video, or a crash), that is the known
bridgeless risk and it is a real finding — record it with the `smoke.log` lines.
The app is designed to survive it: after the watchdog the poster appears and the
app continues. Confirm §3 then decides the fix (see §8, Option B).

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
| 6.5 | Relaunch the app | Goes **straight to Home** — intro is not replayed | |
| 6.6 | Relaunch after 6.1–6.3 | Same: Home, not intro | |

6.5 is the "plays once on first launch" requirement.

## 7. Crash-free exit and lifecycle

| # | Step | Expected | Result |
|---|---|---|---|
| 7.1 | Background the app for ~1 min, return | Restores, does not crash | |
| 7.2 | Rotate the device | No crash (portrait is the target layout) | |
| 7.3 | Force-stop and relaunch | Clean start | |
| 7.4 | Exit via back from Home | No crash, no ANR | |
| 7.5 | Check the log | No unhandled `AndroidRuntime` exceptions | |
| 7.6 | App size on device | ~44 MB APK; install is unremarkable | |

## 8. Known risks ranked

**A. Intro video under bridgeless (highest).** Documented incompatibility; see §2.
Not yet observed either way.

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

## 9. Recording results

Fill in the Result column and keep it with the project. State plainly which
steps were exercised and which were not reached — a step that was never run is
not a pass. If the run was partial, say so.

Do not describe the intro as working, or Bluetooth as functional, on the basis
of this checklist. Bluetooth is not implemented; `docs/ble-protocol.md` still
governs that, and it is marked **PROPOSAL, NOT YET VERIFIED**.
