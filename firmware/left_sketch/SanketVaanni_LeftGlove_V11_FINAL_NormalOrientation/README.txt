SANKET VAANNI — LEFT GLOVE V11 FINAL (NORMAL OLED ORIENTATION)

This version changes ONLY OLED rotation relative to V10:
- display.setRotation(0) — normal orientation instead of 180-degree flip.
- Sensor, BLE, startup frames, status screens, battery estimate and final layout are unchanged.
- BLE name remains SanketVaanni-Left.

Files:
- SanketVaanni_LeftGlove_V11_FINAL_NormalOrientation.ino
- SanketVaanni_StartupVideo.h

Extract ZIP; keep both files in the same folder. Open the V11 .ino. Select ESP32S3 Dev Module
and the correct COM port. Verify first; upload only if Verify succeeds.

The display orientation still needs a real-device check after upload. Battery percentage's
divider factor is still a provisional estimate, not calibrated against a multimeter.
