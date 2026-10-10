# Intro performance — measurement record

This document exists because the original complaint was that the intro looked
**rough and laggy**, and that complaint is not closed by tests passing or by
screenshots looking different. It records what was actually measured, what could
not be measured, and what is therefore still unproven.

## Conditions

| | |
|---|---|
| Device | vivo V2141 (product `2141i`) |
| OS | Android 14 (API 34) |
| Display | 1080 × 2408 @ 440 dpi (2.75×), **60 Hz active** (`mActiveModeId=3`; 60/90/120 supported) |
| Build variant | **debug**, dev bundle, `newArchEnabled=true`, Hermes, bridgeless |
| Bundle delivery | Metro over `adb reverse` (dev only — inflates every startup figure below) |
| Source clip | `apps/mobile/src/assets/intro/sanket-vaani-intro.mp4`, 2,344,975 bytes, tracked since Milestone 1, **unmodified** |

The clip was never re-encoded. `ffprobe`/`ffmpeg` are **not installed on this
machine**, so bitrate was not read from the container; the codec figures below
come from the platform's own MediaExtractor/MediaCodec reporting instead.

## Root cause of the reported roughness — found, with A/B evidence

The complaint is **not** a frame-rate problem. It is an intermittent one.

`react-native-video` gates playback on **audio focus**. In
`ReactExoplayerView.java`, `setPlayWhenReady(true)` requests audio focus and only
then calls `player.setPlayWhenReady(true)` — and if focus is not granted, it does
nothing and says nothing. The intro therefore silently refuses to play whenever
anything else holds audio focus.

Two runs, same build, same device, differing only in whether audio focus was free:

| | Run A — a WhatsApp call was active | Run B — focus free |
|---|---|---|
| Telemetry | `[intro] load { durationSec: 6.467 }`, then **`[intro] falling back — playback did not start`** 2.514 s later | `[intro] playback started { currentTime: 0.09 }`, then `[intro] revealing video` |
| Timing | 2.514 s matches `PLAYBACK_START_DEADLINE_MS = 2_500` exactly | — |
| AudioTrack | torn down from `prior state:STATE_STOPPED` — **never `STATE_ACTIVE`** | `stop … prior state:STATE_ACTIVE` after 6.157 s |
| Result | Branded fallback screen (map, wordmark, SKIP) | Video played through |

Run A's audio tracks (`VOICE_COMMUNICATION` / `AUDIO_CONTENT_TYPE_SPEECH`) are
visible in `dumpsys media.metrics` at the matching wall-clock window and in a
screenshot of the call notification.

**So the app's own fallback works correctly; what fails is video start, and only
when audio focus is contended.** This is a library-level behaviour, not an app
defect, and it is recorded rather than worked around — the fix (ducking, or
`ignoreSilentSwitch`/focus policy) needs a decision, not a patch.

## What was measured

### 1. UI frames — `dumpsys gfxinfo`

2365 frames, 53 janky (**2.24%**), 50th percentile 18 ms, 90th percentile 30 ms.

This is **Android UI frame timing only**. It says nothing about decoded video
frames, and per the brief it is *not* accepted as proof that video playback is
smooth.

### 2. Cold start — `am start -W`

`TotalTime` across runs: **1528 ms, 1731 ms, 2000 ms, 3110 ms**. Roughly 2.4 s of
that is the dev bundle load from Metro over HTTP. These are dev-build numbers and
would not apply to a release build.

### 3. Decoded video frames — `dumpsys media.metrics` (codec level)

Six full-playback sessions for `com.sanketvaani` all report the same shape:

| Field | Value |
|---|---|
| Codec | `c2.qti.avc.decoder` (hardware H.264) |
| MIME / mode | `video/avc`, `mode=video` |
| Dimensions | 1080 × 1920 |
| Profile | `8` = H.264 **High** |
| Container frame rate | **15.0 fps** (MediaExtractor's report) |
| Frames recorded | `latency.n=27` + `latency.unknown=71` = **98 frames** |
| Decode latency | avg **~0.52 ms**, max ~0.76 ms |
| `lifetimeMs` | ~9.1 s |
| Resolution changes | 1 |

**98 frames for a 6.467 s clip at 15 fps ≈ 97 expected — essentially every
frame.** Decode latency averaged half a millisecond, so the decoder was never
close to being the bottleneck.

One partial session at 21:56:49 recorded only 16 frames over a 3195 ms codec
lifetime — a run that did not play through.

### 4. Display frames — Perfetto FrameTimeline

Captured on-device to `/data/misc/perfetto-traces/intro-run.pftrace`
(67,074,260 bytes), pulled, and analysed with **Google's official Perfetto trace
processor** (`perfetto` Python package, installed into a throwaway virtualenv in
the job's temp directory). Note: this machine has no `trace_processor` on `PATH`,
and Android Studio's bundled binary is a gRPC *server* that cannot be driven as a
CLI — hence the PyPI package.

Trace window **15.10 s**, anchored to wall clock by aligning the first
`noteVideoSurfaceChanged` (t ≈ 5.51 s) with `[intro] readyForDisplay` at
22:11:03.647. Phase map:

| t (s) | Wall clock | Phase |
|---|---|---|
| 0.00 | 22:10:58.1 | trace start (before JS executes) |
| 2.73 | 22:11:00.9 | `Running "SanketVaani"` — JS bundle executes |
| 5.51 | 22:11:03.65 | video surface created; `[intro] readyForDisplay` |
| 5.62 | 22:11:03.75 | `[intro] load { durationSec: 6.467 }` |
| 5.77 | 22:11:03.90 | `[intro] playback started { currentTime: 0.078 }` |
| 6.03 | 22:11:04.17 | `[intro] revealing video` |
| ~12.24 | ~22:11:10.4 | clip's natural end |
| 13.93 | 22:11:12.07 | MediaCodec session closed (`lifetimeMs=9159`) |
| 15.10 | 22:11:13.2 | trace end |

FrameTimeline results for the app's own window
(`TX - com.sanketvaani/com.sanketvaani.MainActivity#101542`):

| Metric | Value |
|---|---|
| Buffers latched | **880** (885 counted via `onFrameAvailable - VRI[MainActivity]#0`) |
| Mean rate | **58.3 fps** |
| Inter-frame interval | min 6.4 · **p50 16.7** · p90 18.4 · p99 32.1 · max **78.8 ms** |
| Per-second counts | 55–60 frames in *every* second — no idle gap anywhere |
| `jank_tag` | No Jank 87 · Buffer Stuffing 736 · Self Jank 57 |
| `present_type` | every non-No-Jank frame is `Late Present` |
| `on_time_finish` | 774 of 880 true |

A p50 of 16.7 ms is exactly the 60 Hz vsync interval: the app's window kept up
with the display. About 1% of intervals reached 32.1 ms (one missed vsync) and
the single worst was 78.8 ms.

## What is NOT measured — stated plainly

**Video playback smoothness is not verified, and this document does not claim it
is.**

- **No video-frame presentation timing exists in the trace.** FrameTimeline
  contains only nine layers, all system UI plus the app's own window; there is
  **no `SurfaceView` layer at all**, even though the intro renders into one
  (confirmed from `react-native-video`, and from a comment in
  `IntroScreen.tsx`). The capture enabled `frame_timeline` but not the
  SurfaceFlinger layers snapshot — `__intrinsic_surfaceflinger_layer` is empty —
  so the layer list cannot be enumerated either.
- **No ExoPlayer playback session exists in `dumpsys media.metrics`.** There is
  no `{playback, …}` record for this package, so there is **no time-to-first-
  displayed-frame and no player-reported dropped-frame count**.
- The trace contains **no process or thread names**, so frames cannot be
  attributed to a specific thread.
- Container bitrate was not measured (no `ffprobe`).

The brief is explicit that `dumpsys gfxinfo`, still screenshots and changed
screenshot hashes do **not** prove video smoothness, and that if frame-drop
metrics cannot be obtained reliably the limitation must be reported rather than
papered over. That is the position here.

## A finding worth following up: continuous redraw

The app's main window latched a new buffer **every ~17 ms, for the entire 15.1 s
window** — including the ~2.7 s before JS even started, and the seconds after the
clip's natural end. There is no idle period anywhere in the trace (worst gap
78.8 ms).

That is a lot of drawing for a screen whose video lives on its own surface. It is
consistent with an always-running animation (the intro's loading state, or a live
indicator on the Dashboard), but **the trace cannot identify the producer**, and
the post-clip sample is only ~2 s — too short to distinguish a true screen rest
state from entrance animation. So this is recorded as a **measured observation
with an unverified cause**, not as a defect claim.

Settling it needs one bounded capture of the app sitting idle on the Dashboard
with no video and no navigation. That has not been done.

## Requirement 6.7 — backgrounding does not replay the intro: PASS

Cold launch → `KEYCODE_HOME` → 4 s → `am start`. Result: *"Warning: Activity not
started, intent has been delivered to currently running top-most instance"* and
**no new `[intro]` telemetry**. The intro did not replay.

The one replay observed earlier (22:25:51) followed a ~56 s background period in
which the system destroyed and recreated the activity — a new session, not a
HOME round-trip.

## Summary

| Claim | Status |
|---|---|
| Decoder produced the clip's full frame count | **Verified** (98 frames ≈ 97 expected) |
| Decoder latency was negligible | **Verified** (avg ~0.52 ms) |
| UI compositor sustained 60 Hz | **Verified** (p50 16.7 ms) |
| Root cause of intermittent non-playback identified | **Verified** (audio-focus gate, A/B) |
| Backgrounding does not replay the intro | **Verified** (PASS) |
| **Video playback is smooth** | **NOT VERIFIED — not measurable with this capture** |
| Continuous redraw is a defect | **Unverified — cause not attributable from this trace** |
