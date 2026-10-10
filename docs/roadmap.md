# Roadmap

Milestones are ordered so that each one is independently demonstrable. Nothing
in a later milestone is a prerequisite for an earlier one.

## M1 — Foundation ✅ (this milestone)

- Repository skeleton, single Git repo, `.gitignore`, README, docs set.
- `apps/backend`: independent Fastify + TypeScript API, `/health`, own scripts,
  env example, test.
- `apps/mobile`: React Native 0.87.1 TypeScript app, launch flow, intro video,
  first home screen, mock transport, config-driven API base URL.
- Toolchain verified and reported.

**Explicitly not in M1:** real BLE, recognition, the web dashboard, any database.

## M2 — Verified BLE transport

Gated on the 12 open items in [`ble-protocol.md`](ble-protocol.md).

- Confirm UUIDs, frame layout, sample rate against firmware.
- Implement the real `GloveTransport` behind the existing interface.
- Pairing/reconnect handling, connection state UI, packet-loss handling.
- Replace Demo Mode with live readings once frames are demonstrably real.

**Exit criterion:** a phone displays live flex/IMU values from a physically
connected glove, and a recorded fixture from that session replays identically
offline.

## M3 — Calibration & signal processing

- Per-user, per-glove calibration flow (rest pose, full-flex pose).
- Filtering/smoothing and drift compensation for the flex channels.
- IMU orientation fusion; handling accelerometer noise during rapid signing.
- Persist calibration locally.

**Exit criterion:** the same sign produces repeatable normalised values across
two sessions with a re-calibration in between.

## M4 — Recognised vocabulary (first sign language)

Pick **one** sign language and build a real, small vocabulary. Per the
architecture, this is a *language profile*, not a global dictionary.

- Define the vocabulary with a Deaf-led reviewer — not invented in code.
- Collect a dataset (see `ml/`), train, and report honest evaluation numbers.
- Wire recognition behind the profile interface.

**Exit criterion:** honest per-sign accuracy and confusion data on held-out
signers, published as measured — including where it fails.

## M5 — Text composition & speech

- Frame sequence → words/sentences, accounting for the target language's grammar
  (sign languages are not English word-order).
- Platform TTS output, offline.
- Fingerspelling fallback for out-of-vocabulary signs.

## M6 — Local history & persistence

- On-device history of recognised phrases.
- Introduce the **database** here — the first point a requirement justifies it.
  Planned shape: SQLite on device (e.g. `op-sqlite`/`react-native-quick-sqlite`),
  chosen for offline-first operation. Backend-side storage still deferred.

## M7 — Backend value & sync

- Only now introduce backend persistence and a cloud layer.
- Vocabulary/model distribution, optional account sync, telemetry **with
  explicit consent**.
- Authentication introduced here, if at all.

## M8 — Web dashboard (`apps/web`)

Next.js + React + Tailwind. Research/administration surface: vocabulary
curation, dataset review, model comparison. Not an end-user signing surface.

## M9 — Multilingual architecture

- Multiple language profiles loaded simultaneously, selectable per user.
- Shared calibration where measurements justify it — and separate where they
  do not.

## Cross-cutting, continuous

- Accessibility (screen-reader semantics, contrast, touch targets, reduced
  motion) reviewed every milestone, not retrofitted.
- Battery and thermal budget tracked once continuous BLE streaming exists.
- Privacy review before any data leaves the device.
