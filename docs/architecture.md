# Architecture

## Shape of the system

Sanket Vaanni is split into four independently deployable pieces. The split is
chosen so that the parts with the shortest iteration cycles (mobile UI, signal
processing) never require the slowest parts (firmware, physical hardware) to be
present.

```
      ┌────────────────────────┐        ┌────────────────────────┐
      │  Left glove (ESP32-S3) │        │ Right glove (ESP32-S3) │
      │  5 flex + IMU + OLED   │        │  5 flex + IMU + OLED   │
      └───────────┬────────────┘        └───────────┬────────────┘
                  │  BLE (protocol UNVERIFIED)      │
                  └───────────────┬─────────────────┘
                                  ▼
      ┌──────────────────────────────────────────────────────────┐
      │  apps/mobile  — Android-first React Native (TypeScript)  │
      │                                                          │
      │  ┌────────────────┐   ┌───────────────────────────────┐  │
      │  │ BLE transport  │──▶│ sensor processing             │  │
      │  │ (interface)    │   │  → calibration                │  │
      │  │  ├─ real       │   │  → recognition                │  │
      │  │  └─ mock       │   │  → text composition           │  │
      │  └────────────────┘   └───────────────┬───────────────┘  │
      │                                       ▼                  │
      │        speech synthesis  ·  local storage  ·  API client │
      └───────────────────────────────────────┬──────────────────┘
                                              │  optional, REST
                                              ▼
      ┌──────────────────────────────────────────────────────────┐
      │  apps/backend — Node.js + TypeScript + Fastify           │
      │  Stateless REST API. No database yet.                    │
      └──────────────────────────────────────────────────────────┘
```

**The arrow to the backend is optional by design.** The mobile app performs
sensor processing, calibration persistence, local history and offline
translation without any network access. The backend exists for things that are
genuinely better centralised — account sync, larger vocabulary distribution,
model updates, analytics — and none of those are in this milestone.

## Why the mobile app owns signal processing

The latency budget for "sign → spoken word" is tight, and a round trip to a
server to interpret a flex-sensor frame is both slow and a hard dependency on
connectivity. Signing happens in places without reliable network. Interpretation
therefore runs on-device, and the backend must never become a prerequisite for
the core loop.

## Module boundaries (mobile)

The brief requires small, well-defined modules. The intended seams:

| Module | Responsibility | Must not know about |
|---|---|---|
| `ble/transport` | Interface: connect, disconnect, subscribe to frames | UI, recognition |
| `ble/mockTransport` | Deterministic synthetic frames for development | Real device specifics |
| `sensors/processing` | Normalise and filter raw channels | Where frames came from |
| `sensors/calibration` | Per-user, per-glove rest/range calibration | Recognition |
| `recognition` | Frame sequence → candidate sign, language-scoped | Transport, UI |
| `speech` | Text → audio | Where text came from |
| `storage` | Local persistence (history, settings, calibration) | Networking |
| `api` | Typed HTTP client for the backend | UI |

The `ble/transport` module is an **interface**, not an implementation. Real BLE
is one implementation; the mock is another. This is what lets the entire UI and
data-flow be built and tested before the firmware protocol is confirmed.

## Navigation and theming (mobile)

There is no navigation library. `app/RootNavigator` is a state machine with two
routes — `intro` and `tabs` — and four tab keys: `dashboard`, `oled`, `audit`,
`more`. Two reasons: the app has exactly four destinations that never need deep
links, and a router dependency would have to be verified against React Native
0.87.1 on the New Architecture before it could be adopted at all.

**Only the active destination is mounted.** This is a performance decision with
a test behind it (`__tests__/launch-flow.test.tsx` asserts it): four mounted
screens would keep the Dashboard's sensor subscription re-rendering while the
user reads the audit. It also means each screen's cleanup path runs on every tab
change rather than only at app exit.

The theme is a **preference**, not a platform setting. `theme/ThemeProvider`
holds the resolved scheme, `app/preferences.ts` holds the stored choice, and the
`StatusBar` belongs to the themed root rather than to `App.tsx` so that it
changes when the theme does. Dark is the default, deliberately: it is what the
first frame renders before storage has been read, so the default and the
pre-mount background agree and there is no flash.

### Which hand the app is talking about

The Dashboard has a **single** selector choosing the hand that the recognition
panel, the hand viewer and the sensor list are all showing. Two independent
selectors would let a user read the left hand's pose next to the right hand's
recognition result without noticing, which is exactly the confusion this app
cannot afford. Both gloves' *connection* state is always visible regardless of
the selection; the selector chooses what is **displayed**, never what is
**connected**.

## Language profiles

`recognition` is parameterised by a **language profile** rather than hardcoding
a dictionary. A profile owns:

- its gesture vocabulary and the sign each gesture maps to
- its calibration expectations where they differ
- its model artefact reference

Nothing in the codebase may assume ISL, ASL and BSL share gestures. A future
multilingual mode composes several profiles side by side; it does not merge
them.

## Offline-first

| Capability | Offline? |
|---|---|
| Sensor capture & processing | Yes — always on-device |
| Calibration & local history | Yes — local persistence |
| Sign recognition | Yes — on-device model |
| Speech output | Yes — platform TTS |
| Account sync, vocabulary updates | No — requires backend, deferred |

## Deliberate omissions in this milestone

Following the brief, the following are **not** built yet, and are documented in
[`roadmap.md`](roadmap.md) instead:

- No database. No ORM. No migrations.
- No authentication provider or API keys.
- No cloud hosting, CI/CD or analytics.
- No real BLE integration — the protocol is unverified.
- No gesture recognition model — the vocabulary does not exist yet.
- No navigation library — see *Navigation and theming* above.
- No 3D hand renderer — see [`hand-viewer.md`](hand-viewer.md).
- No account, login or profile of any kind. No screen offers one, and no
  credential is stored. The architecture leaves room for server-side
  authentication later by keeping `storage` and the API client separate from the
  UI; it does not anticipate it with a stub.

These are omissions, not oversights. Each is gated on a requirement that does
not yet exist.
