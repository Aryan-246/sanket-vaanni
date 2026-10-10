# Testing Strategy

## Principle

Tests exist to make specific claims cheap to re-check. A test that cannot fail
meaningfully is not worth its maintenance cost, and a passing test suite is
never evidence about hardware that was not present.

**This project has an unusual honesty constraint: we have real hardware that is
not connected to CI.** Most of the system's risk lives at the boundary between
code and physical sensors. The strategy below is shaped around that.

## What each layer must prove

| Layer | Proves | Does not prove |
|---|---|---|
| Unit | Pure logic: normalisation maths, calibration transforms, frame decoding from a **recorded fixture**, profile lookup | Anything about real sensors |
| Contract | Backend request/response shapes match `packages/contracts` | Real network behaviour |
| Integration (backend) | Routes compose correctly, config loads, error paths return sane status codes | Load, security |
| Integration (mobile) | Screens render, navigation flow works, mock transport drives the UI | BLE |
| Hardware-in-the-loop | Real frames arrive, calibration is stable, recognition works on a real signer | — |

## The fixture rule

The single most important convention: **recognition, calibration and transport
decoding must be testable from recorded byte fixtures**, not from a live glove.

- When a real capture is finally taken (M2), it is stored as a fixture file with
  provenance metadata: date, gloves, signer, firmware commit, sample rate.
- Those fixtures then drive tests forever after, on any machine.
- Fixtures are recorded from hardware. **Synthetic frames must never be
  presented as fixtures of real captures** — they are labelled as generated.

## Demo Mode vs. real data in tests

The mock transport emits synthetic frames. Tests using it verify *plumbing*, not
physiology. Test names must make that obvious — e.g. "renders home screen with
mock transport" rather than "recognises hello".

## Honest metrics

Any recognition accuracy figure that appears in a doc, README or UI must state:

- the vocabulary size and **which sign language profile** it is for
- number of signers in train and in test, and whether they are disjoint
- whether it is held-out data or training data

A number without those is not reportable. **No accuracy figure exists yet** —
there is no model and no dataset. Any figure in this repository today should be
treated as absent, not as an estimate.

## Accessibility testing

Not optional, and not purely automated:

- Screen-reader pass on every primary flow (TalkBack on Android).
- Contrast and dynamic-type checks.
- Reduced-motion honoured — the intro video and any animation.
- Touch targets ≥ 48dp.

Manual, per milestone, recorded in the milestone report.

## Commands

```powershell
# Backend
cd apps\backend
npm test                 # unit + integration
npm run typecheck

# Mobile
cd apps\mobile
npm test                 # jest
npm run typecheck
npm run lint
```

## What will NOT be measured in M1

Stated plainly so no reader assumes otherwise: there is no BLE test, no
recognition test, no accuracy test, and no load test in this milestone. The
hardware is not present and the protocol is not verified.
