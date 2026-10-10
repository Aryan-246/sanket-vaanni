# BLE Protocol — PROPOSAL, NOT YET VERIFIED

> ## ⚠️ Read this first
>
> **Nothing in this document has been confirmed against the glove firmware.**
> The service UUID, characteristic UUIDs, frame encoding, sample rate, byte
> order, checksum, and the pairing/bonding procedure are all currently
> **UNKNOWN**.
>
> This file exists to (a) state precisely what is unknown, and (b) propose an
> interface the mobile app can code against *without* pretending the hardware
> side is settled.
>
> **No UUID in this file is real.** Placeholders are written as
> `<UNVERIFIED: …>` on purpose, so that a careless copy-paste cannot turn a
> guess into a shipped constant. Do not replace a placeholder with a
> plausible-looking UUID. Replace it with a value read off the firmware.

---

## What must be verified before BLE integration begins

This is the blocking checklist. Each item is an open question for whoever owns
the firmware, and each answer must come from the firmware source or a live
scan — never from inference.

| # | Unknown | How to resolve |
|---|---|---|
| 1 | Advertised device name / name prefix for each glove | Scan with `adb`-side tooling or nRF Connect; read firmware advertising config |
| 2 | Primary service UUID | Firmware `ble_gatts` / `esp_ble_gatts_create_service` definitions |
| 3 | Notify characteristic UUID (glove → phone) | Same |
| 4 | Write characteristic UUID (phone → glove), if any | Same |
| 5 | Whether the device is bonded/encrypted, and the pairing method | Firmware security config |
| 6 | Frame layout: field order, widths, signedness, byte order | Firmware packing code |
| 7 | Sample rate and whether frames are batched | Firmware timer / loop config |
| 8 | Flex channel resolution and the ADS1115 PGA setting in use | Firmware ADC config |
| 9 | How left and right gloves are distinguished (separate devices vs one) | Firmware + hardware team |
| 10 | MTU negotiated, and whether frames exceed it | Live connection |
| 11 | Any command protocol (start/stop stream, calibrate, LED, battery) | Firmware command handler |
| 12 | Battery / status reporting | Firmware |

Until items 1–7 are answered, **no real transport implementation should be
merged.**

## What the mobile app does in the meantime

`apps/mobile` codes against a transport **interface** with two implementations:

- `MockTransport` — active now. Emits deterministic synthetic frames, labelled
  everywhere in the UI as **Demo Mode**.
- `BleTransport` — a stub whose methods throw a clearly-worded
  "protocol not yet verified" error. It is not wired to any real UUID.

Swapping in the real transport later must not require UI changes. That
constraint is the reason the interface exists.

### Left and right are two independent links

The Dashboard models each glove as its own link with its own state, and never
infers one from the other. The left glove can be connected while the right is
disconnected, scanning, connecting or unavailable, and the UI shows both at
once.

What is **not** known is how the two gloves are told apart on the wire — item 9
above. Nothing in the app assumes an answer, and the current code is written so
that it cannot:

- The side is never derived from an attribute of the device. A device id learned
  from a scan is associated with the `side` of the controller the user acted on
  (`ble/controller.ts`), not with a side read from an advertised name, service
  data, address or connection order.
- Incoming frames are discarded unless their `side` matches the controller's
  (`raw.side !== this.side`), so a transport that mislabels frames cannot
  cross-feed the other hand.
- `MockTransport` does use the ids `demo-left` and `demo-right`. Those are
  simulator bookkeeping only. They are **not** a claim about advertising names,
  advertising payloads, or any firmware convention, and must not be copied into
  a real transport.

Until item 9 is answered from the firmware, no code may assign a side on its
own. If the two gloves turn out to be a single dual-connected device, that is a
change to this model and needs to be made deliberately rather than absorbed.

## Proposed transport interface (language-agnostic)

The shape below is a design decision the app already depends on. It is
deliberately independent of the wire format.

```
interface GloveTransport {
  readonly side: 'left' | 'right'
  scan(): Promise<DiscoveredGlove[]>
  connect(deviceId: string): Promise<void>
  disconnect(): Promise<void>
  subscribe(listener: (frame: SensorFrame) => void): Unsubscribe
  readonly status: TransportStatus   // idle|scanning|connecting|connected|error
}

interface SensorFrame {
  side: 'left' | 'right'
  timestampMs: number
  flex: [number, number, number, number, number]  // thumb..pinky, normalised later
  accel: { x: number; y: number; z: number }
  gyro:  { x: number; y: number; z: number }
}
```

`SensorFrame` intentionally uses **normalised physical units** at the interface,
so the wire encoding (raw ADC counts, byte order, multiplexer channel order) is
confined to the transport implementation. If the firmware changes its packing,
only `BleTransport` changes.

## Proposed (illustrative) frame layout — DO NOT IMPLEMENT

For discussion with the firmware team only. **This is a straw man, not a spec.**
It assumes one notify characteristic carrying a fixed-width frame, which is
itself unverified (item 5/7/10 above).

| Offset | Width | Field | Status |
|---|---|---|---|
| 0 | 1 B | protocol version | `<UNVERIFIED>` — versioning scheme undecided |
| 1 | 1 B | glove side (0=left, 1=right) | `<UNVERIFIED>` — may be implied by device |
| 2 | 4 B | timestamp (ms, from glove) | `<UNVERIFIED>` — may not exist |
| 6 | 10 B | 5× flex, uint16 LE | `<UNVERIFIED>` — resolution, order, endianness |
| 16 | 6 B | accel x/y/z, int16 | `<UNVERIFIED>` — scale, range |
| 22 | 6 B | gyro x/y/z, int16 | `<UNVERIFIED>` — scale, range |
| 28 | 1 B | checksum | `<UNVERIFIED>` — algorithm, or none |
| 29 | 1 B | battery | `<UNVERIFIED>` |

Byte order is shown as little-endian because ESP32 is little-endian, **which is
an assumption and not evidence**. Do not rely on it.

## Multilingual / per-language impact

The BLE layer is language-agnostic: a glove reports hand shape and motion, not
meaning. Sign language profiles sit above recognition and are unaffected by the
wire protocol. However, **calibration** may be per-language if different signing
styles produce different flexion ranges — this is speculation and must be
measured, not assumed.

## Change control

When the protocol is finally verified:

1. Update this document with real values, citing the firmware file and line.
2. Remove the `UNVERIFIED` markers for confirmed rows; keep them for open ones.
3. Implement `BleTransport` against the verified values.
4. Add a recorded-frame fixture so the transport can be tested offline.
5. Only then remove the Demo Mode labelling from real readings.
