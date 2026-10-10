# Hand viewer — the 3D asset finding

## What was asked for

The Dashboard's section D was specified as a 3D hand viewer, using a reference
model the project owner supplied: **"Female hands" by Lassi Kaukonen**, Sketchfab
model id `7304150ee9084c58b354ea173ca82f39`. The brief added two constraints that
turn out to decide the whole question:

> "A web iframe or passive screenshot is not an adequate final solution."

> "Do not silently substitute an unrelated model."

## What the asset actually is

Read from Sketchfab's own v3 API on 2026-10-10 (the authoritative source for
these fields — not a search result, not the model page's prose).

| Property | Value | Consequence |
|---|---|---|
| Licence | Standard (`st`) | Not the blocker on its own; see download, below |
| **Downloadable** | **No** — `GET /v3/models/<uid>/download` returns **HTTP 401 Unauthorized** | The asset cannot be obtained at all. A downloadable model returns a signed URL here. |
| Animations | **0** | Nothing to play back. |
| Faces / vertices | 64,656 / 32,390 | Heavier than a mobile real-time target wants, though not disqualifying. |
| Tags | `3dscan`, `photogrammetry`, `hand`, `hands`, `scan` | Identifies the production route. |
| Pipeline (author's description) | Agisoft Metashape → R3DS Wrap3 → Blender | Photogrammetry scan, **retopologised**. Wrap3 is a retopology tool: it produces clean topology, not a skeleton. |

### The two independent blockers

Either one alone is sufficient to stop, so both are recorded.

1. **It cannot be downloaded.** The download endpoint returns 401. There is no
   archive to work with, on any account plan.
2. **Even with the file, it could not articulate a hand.** It is a scan of real
   hands, retopologised into a static mesh. There is **no rig, therefore no
   finger bones, therefore nothing for a pose to drive**. Handedness is not
   defined either — it is a scan of two hands, not a left/right-labelled asset
   with a documented convention.

A rigged, downloadable hand would have satisfied the brief. This model could not
satisfy it on either count, and the brief forbids substituting an unrelated
model, so no model was substituted.

## Renderer compatibility was never established

No 3D dependency was added, and none was evaluated. The brief is explicit that
a heavyweight dependency must not be introduced before its compatibility with
React Native 0.87.1 on the New Architecture is established, and that evaluation
costs a throwaway branch plus measured frame timing on the target device. It was
not worth spending before a usable *asset* existed — the asset gate comes first,
and it failed.

## What was implemented instead

The brief anticipated this outcome and asked for the integration boundary to be
built and the remainder reported. That is what exists:

- **`src/hands/pose.ts`** — the typed pose contract. It covers independent left
  and right hands, all five finger bends per hand, wrist orientation
  (pitch/roll/yaw, with `yaw` typed `null` because the MPU6050 has no
  magnetometer and cannot observe it), a neutral calibration pose, smoothing
  parameters, and a `source` designation of `real` or `simulated`. There is no
  code path that lets a renderer invent a finger bend, and a `real` pose cannot
  be produced from simulated data.
- **`src/hands/viewer.ts`** — the boundary. It holds the findings above as typed
  values (so they are rendered in the app and asserted by tests rather than left
  as a comment nobody reads), declares the `mesh3d` renderer slot as
  **unavailable with a reason**, and states that nothing may infer availability
  from the presence of an asset.
- **`src/components/HandFigure.tsx`** — an articulated 2D figure, fifteen
  segments positioned by forward kinematics from the measured bend of each
  finger. It is labelled in the UI as **"Articulated preview"**, it is not the
  mesh renderer, and the Dashboard offers a one-tap explanation of why.

### What does not count, and was not done

Explicitly rejected, per the brief: a static image, a web iframe, a rotating
hand with no finger articulation, or a visually unrelated substitute.

## The route to a real 3D viewer

A proposal, not work that has begun. It deliberately names no version and
asserts nothing about compatibility.

1. License or author a low-poly hand with an explicit skeleton: 15 finger joints
   plus a wrist pivot, and a documented handedness convention.
2. Confirm redistribution and commercial-use rights **in writing**, and record
   the licence text alongside the asset.
3. Evaluate a native glTF renderer for RN 0.87.1 on the New Architecture in a
   throwaway branch, and record **measured** frame timing on the target device
   before adopting it.
4. Drive its bones from the existing `HandPose` contract. The bone names map to
   `FINGERS` plus the wrist; nothing else about the interface changes.
