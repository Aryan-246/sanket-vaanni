SANKET VAANNI — RIGHT GLOVE V12 FINAL (NORMAL OLED ORIENTATION)

Matching right-hand counterpart of accepted Left Glove V11.
Same OLED orientation, converted startup video, sensor status, BLE status, minimal idle screen,
pins and BLE service/data/control UUIDs. Only device/glove identity differs.

BLE device name: SanketVaanni-Right
Telemetry glove field: right
Service UUID: 8f2a1000-7d2b-4c9a-9c4e-6b1e2f000001
Data READ/NOTIFY: 8f2a1001-7d2b-4c9a-9c4e-6b1e2f000001
Control WRITE: 8f2a1002-7d2b-4c9a-9c4e-6b1e2f000001

Keep .ino and SanketVaanni_StartupVideo.h in the same sketch folder.
Select ESP32S3 Dev Module and right glove COM port. Verify first, then upload only if Verify succeeds.

IMPORTANT: the right glove was reported to have a broken wire. With power disconnected,
repair/check that wire and continuity before relying on sensor readings. Battery-divider ratio
remains an estimate pending calibration. This generated file has not been compiled on the user's
exact Arduino board package.
