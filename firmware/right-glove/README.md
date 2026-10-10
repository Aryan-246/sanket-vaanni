# firmware/right-glove

Reserved for the right glove's ESP32-S3 firmware.

**This directory is empty on purpose.** See `firmware/left-glove/README.md` for
the full rationale and the list of things a real firmware must document before
the mobile app's BLE layer can be written.

Note that the right glove is the one the mobile app's demo simulator currently
models (`new MockTransport('right')`), but that is a UI default, not a claim
about the hardware. Nothing is known yet about how, or whether, the two gloves
differ.
