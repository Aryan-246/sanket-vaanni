# firmware/left-glove

Reserved for the left glove's ESP32-S3 firmware.

**This directory is empty on purpose.** No firmware has been supplied in this
workspace, and nothing here will be invented to fill the gap — a plausible-
looking but fabricated firmware would be worse than none, because the mobile
app's BLE layer would then be written against a protocol that does not exist.

## What goes here, when it exists

The left glove's firmware source, plus a build/flash README covering:

- board and toolchain versions (ESP32-S3, Arduino-ESP32 or ESP-IDF, which one)
- the sensor map: 5 flex channels → CD74HC4067 mux channels → ADS1115 input
- I²C wiring for the ADS1115 and the MPU6050
- OLED (SSD1306) usage, if the glove itself displays anything
- BLE service and characteristic UUIDs, advertisement payload, connection
  parameters, MTU and framing
- how a frame is packed, its byte order, its sample rate, and its checksum

That list is exactly the set of unknowns recorded in `docs/ble-protocol.md`,
which is marked **PROPOSAL, NOT YET VERIFIED**. Once the real firmware exists,
that document should be rewritten from the source, not from the proposal.

## Why left and right are separate

They are separate boards, flashed separately, and may differ in pin mapping or
sensor orientation. Keeping them in separate directories prevents a change to
one hand from silently altering the other.

Neither directory implies the other. If the two gloves end up sharing code,
that shared code should move to a common directory at that point — not be
guessed at now.
