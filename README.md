# Sanket Vaanni (संकेत वाणी)

An AI-powered smart sign-language glove system: two instrumented gloves capture
hand shape and motion, the signal is calibrated and interpreted into text, and
the result is spoken aloud.

> **Status: Milestone 1 — Foundation.** This repository currently contains the
> project skeleton, an independently runnable backend, and a mobile app shell
> with a worked mock data path. **No real glove BLE integration is implemented
> yet** — the firmware's service/characteristic UUIDs and packet format have not
> been verified (see [`docs/ble-protocol.md`](docs/ble-protocol.md)). Any reading
> shown in the app today is clearly labelled **Demo Mode** and is simulated.

---

## The problem, briefly

Sign languages are not dialects of one another. Indian Sign Language (ISL),
American Sign Language (ASL) and British Sign Language (BSL) have distinct
grammars and, in places, mutually incompatible gestures — the same hand shape
can mean different things. A single universal "gesture dictionary" is therefore
a wrong architecture, and this project does not use one. Gesture vocabulary,
calibration profiles and recognition models are **per sign language**, loaded as
separate profiles, and the platform is designed so a new sign language is added
as data rather than as a rewrite.

## Repository layout

```
sanket-vaanni/
├── apps/
│   ├── mobile/          Android-first React Native (TypeScript) application
│   ├── backend/         Independent Node.js + TypeScript + Fastify REST API
│   └── web/             Reserved for the future Next.js dashboard (not built yet)
├── packages/
│   └── contracts/       Shared API/data contracts (transport-independent)
├── firmware/
│   ├── left-glove/      Left glove firmware source area & documentation
│   └── right-glove/     Right glove firmware source area & documentation
├── ml/                  Dataset, training and evaluation documentation
├── docs/                Architecture, setup, roadmap, testing, BLE protocol
└── design-reference/    Original design references and the intro kit
```

`apps/mobile` and `apps/backend` are **separately buildable, separately
startable and separately deployable**. Each has its own `package.json`,
dependency tree, environment configuration and scripts. There is deliberately no
root-level workspace tool: `npm install` in one app must never be required for
the other to run.

## Hardware (target)

| Component | Role |
|---|---|
| ESP32-S3 | Per-glove microcontroller, BLE peripheral |
| 5× flex sensors | Thumb, index, middle, ring, pinky finger flexion |
| MPU6050 | 6-axis IMU — hand orientation and motion |
| ADS1115 | 16-bit ADC for the analog flex channels |
| CD74HC4067 | 16-channel multiplexer, fans the flex channels into the ADC |
| SSD1306 OLED | On-glove status display |

Firmware for sensor acquisition and basic connectivity has been bench-tested by
the hardware team. The final 3D-printed enclosures are not yet installed, which
is one reason the mobile app must remain useful without gloves attached.

## Getting started

See [`docs/setup.md`](docs/setup.md) for exact Windows PowerShell commands.

```powershell
# Backend (independently runnable)
cd apps\backend
npm install
npm run dev            # http://127.0.0.1:4000/health

# Mobile (separate terminal)
cd apps\mobile
npm install
npm start              # Metro bundler
npm run android        # build & install on emulator/device
```

## Documentation

| Document | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Layering, module boundaries, offline-first strategy |
| [`docs/setup.md`](docs/setup.md) | Toolchain install and run commands (Windows PowerShell) |
| [`docs/roadmap.md`](docs/roadmap.md) | Milestones, including planned database/cloud layer |
| [`docs/testing-strategy.md`](docs/testing-strategy.md) | Test pyramid and what each layer must prove |
| [`docs/ble-protocol.md`](docs/ble-protocol.md) | **Proposed** BLE contract — unverified against firmware |

## Ground rules for contributors

1. **Never fabricate hardware facts.** No invented Bluetooth UUIDs, packet
   layouts, sensor values presented as real, recognition confidences, or model
   accuracy figures. If it is not verified against the firmware or a real
   measurement, it does not go in as if it were.
2. **Demo Mode is always visible.** Simulated data is labelled in the UI.
3. **No secrets in source.** Configuration is environment-driven.
4. **No premature infrastructure.** No database, cloud service, auth provider or
   API key until a requirement justifies it.
5. **Languages are profiles.** Never assume two sign languages share a gesture.

## Licence

Not yet chosen — the repository is private during development.
