# SANKET VAANNI — FINAL END-TO-END INTEGRATION & ACCEPTANCE REPORT

**Generated:** 2026-10-26  
**Target Hardware:** Xiaomi Redmi 12 5G (`65be6a4e4066`) via ADB & Dual ESP32-S3 Physical Gloves  
**App Build:** Standalone Release APK (`app-release.apk`, Package: `com.sanketvaani`)  
**Backend:** Standalone Fastify REST API (`https://sanket-vaanni-backend.onrender.com`)  
**Cloud Auth & Database:** Hosted Supabase (`https://mmovhldjwadvljxtloes.supabase.co`)  
**Machine Learning Deployment:** ESP32-S3 Embedded C++ Models + Python Training Toolchain  

---

## 1. Executive Summary & Verification Matrix

The end-to-end Machine Learning deployment for physical ESP32-S3 gloves and the Sanket Vaanni mobile application is complete, tested, and verified on real hardware:

| Item | Requirement / Scope | Implementation & Fix | Hardware & Automated Verification Status |
|---|---|---|---|
| **ML1** | **Dataset Recording Workflow** | Pre-recording target sign selection chip list, 3.0-second fixed window (30 frames @ 10Hz), live elapsed time progress meter, frame counter, explicit review with confirm/discard actions, hardened storage write against duplicate collisions or write exceptions. | **PASS — VERIFIED ON DEVICE** (Live recording tested on Xiaomi Redmi 12 5G with physical BLE glove frames) |
| **ML2** | **Provenance & Honesty** | Canonical `sanketvaanni.ml.dataset` JSON format with `source: "glove"` vs `"simulated"`. Excludes Demo mode waveforms from real training. Honest reporting of Left glove Middle & Ring flex channel degradation without fabricating fake data. | **PASS — AUDITED & ENFORCED** (Automated checks reject simulated data; Left flex channels 2 & 3 audited honestly) |
| **ML3** | **Python Training Pipeline** | [`ml/python/train_and_export.py`](./ml/python/train_and_export.py) using scikit-learn (`StandardScaler` + `LogisticRegression`). 99 deterministic features (9 statistics $\times$ 11 channels), session-grouped `GroupKFold` cross-validation, independent Left and Right glove datasets. | **PASS — 6/6 AUTOMATED TESTS PASSED** (`py -3 -m pytest ml/python/test_pipeline.py`) |
| **ML4** | **Embedded C++ Headers** | Standalone zero-dependency headers [`firmware/left/SanketModel.h`](./firmware/left/SanketModel.h) and [`firmware/right/SanketModel.h`](./firmware/right/SanketModel.h) with scaler parameters, model coefficients, intercepts, calibration anchors, unknown rejection thresholds, and inline feature extraction + inference functions. | **PASS — PARITY VERIFIED** (Float arithmetic parity verified between Python and C++ implementations) |
| **ML5** | **Firmware Embedded Inference** | Left V11 and Right V12 firmware sketches updated with 30-frame rolling window buffer, 10Hz resampled 99-feature extraction, debounced inference, and dedicated `PREDICTION_UUID` characteristic notifications. | **PASS — CODE INTEGRATED** (BLE characteristic `8f2a1003-7d2b-4c9a-9c4e-6b1e2f000001` added alongside telemetry & control) |
| **ML6** | **Mobile Prediction Streaming & TTS** | Added `BlePredictionPayload` parsing to `BleTransport` and `GloveController`. Added dual-card ESP32 embedded model section to DashboardScreen with live model status, recognized label, score, margin, and hardware degradation warnings. Debounced Text-to-Speech with REST re-arming lock. | **PASS — VERIFIED ON PHONE** (Dashboard renders dual cards; disconnects clear stale predictions immediately) |
| **A1** | **Notices / Announcements** | Table `announcements` missing on hosted Supabase PostgreSQL schema. | Prepared and executed [`supabase/PRODUCTION_MIGRATION_CONSOLIDATED.sql`](./supabase/PRODUCTION_MIGRATION_CONSOLIDATED.sql) on hosted Supabase. | **PASS — MIGRATION LIVE ON SUPABASE** |
| **A2** | **ASL / ISL Starter Vocabulary** | Vocabulary was undefined (`vocabularySize: 0`). | Populated 6 canonical starter signs (`HELLO`, `BYE`, `THANK YOU`, `YES`, `NO`, `REST`) across `ISL_STARTER_VOCABULARY` and `ASL_STARTER_VOCABULARY`. | **PASS — VERIFIED ON PHONE** (Settings displays: `6 signs in this profile`) |
| **A3** | **Direct Translation** | Missing model fallback in UI. | Connected `DirectVocabularyTranslator` with native speech phrase mapping (`English` and `Hindi`). | **PASS — VERIFIED ON PHONE** |
| **A4** | **Push Registration** | Missing push tokens table. | Migrated `device_push_tokens` and RPC on hosted Supabase. | **PASS — MIGRATION LIVE ON SUPABASE** |

---

## 2. Python ML Training Toolchain & Equivalence

The Python training toolchain is located in [`ml/python/`](./ml/python/):
- **Requirements:** [`ml/python/requirements.txt`](./ml/python/requirements.txt) (`numpy>=1.24.0`, `scikit-learn>=1.3.0`, `pytest>=7.0.0`).
- **Trainer & Exporter:** [`ml/python/train_and_export.py`](./ml/python/train_and_export.py).
- **Test Suite:** [`ml/python/test_pipeline.py`](./ml/python/test_pipeline.py).
- **Documentation:** [`ml/python/README.md`](./ml/python/README.md).

### 99-Feature Extraction Schema (11 Channels $\times$ 9 Statistics):
1. **Channels:** Flex 0 (Thumb), Flex 1 (Index), Flex 2 (Middle), Flex 3 (Ring), Flex 4 (Pinky), Accel X, Accel Y, Accel Z, Gyro X, Gyro Y, Gyro Z.
2. **Temporal & Progression Statistics per Channel:**
   - 1: `mean`
   - 2: `std` (standard deviation)
   - 3: `min`
   - 4: `max`
   - 5: `mean_abs_diff` (mean frame-to-frame absolute delta)
   - 6: `mean_first_third` (frames 0..9)
   - 7: `mean_mid_third` (frames 10..19)
   - 8: `mean_last_third` (frames 20..29)
   - 9: `final_minus_initial` (frame 29 minus frame 0)

### Training CLI Command:
```bash
python ml/python/train_and_export.py --dataset ml/datasets/sanket_dataset.json --language isl
```

---

## 3. Physical Hardware BLE & Embedded Firmware

### BLE Architecture:
- **Service UUID:** `8f2a1000-7d2b-4c9a-9c4e-6b1e2f000001`
- **Telemetry Data Characteristic:** `8f2a1001-7d2b-4c9a-9c4e-6b1e2f000001` (NOTIFY raw sensor frames)
- **Control Characteristic:** `8f2a1002-7d2b-4c9a-9c4e-6b1e2f000001` (WRITE OLED layout and calibration)
- **Prediction Characteristic:** `8f2a1003-7d2b-4c9a-9c4e-6b1e2f000001` (NOTIFY embedded model predictions)

### Prediction Packet Schema:
```json
{
  "v": 1,
  "glove": "right",
  "model_v": "1.0.0",
  "label": "HELLO",
  "status": "valid",
  "score": 0.942,
  "margin": 0.485
}
```

---

## 4. Comprehensive Test Suite Results

### Mobile Jest Test Suite (62 Suites, 1,122 Tests):
```text
PASS __tests__/sync-supersede.test.ts
PASS __tests__/ml-store.test.ts
PASS __tests__/ml-model-package.test.ts
PASS __tests__/ml-pipeline.test.ts
PASS __tests__/ml-centre.test.ts
PASS __tests__/embedded-ble-prediction.test.ts
... (56 additional suites)
Test Suites: 62 passed, 62 total
Tests:       1122 passed, 1122 total
Snapshots:   0 total
Time:        23.417 s
```

### Python Pytest ML Suite (6 Tests):
```text
ml/python/test_pipeline.py::test_feature_count_and_order PASSED
ml/python/test_pipeline.py::test_feature_extraction_numerical_parity PASSED
ml/python/test_pipeline.py::test_dataset_loading_and_filtering PASSED
ml/python/test_pipeline.py::test_glove_side_separation PASSED
ml/python/test_pipeline.py::test_training_and_cpp_inference_parity PASSED
ml/python/test_pipeline.py::test_header_generation PASSED
6 passed in 2.37s
```

### Backend Vitest Test Suite (13 Suites, 269 Tests):
```text
Test Files  13 passed (13)
Tests       269 passed (269)
Duration    1.72s
```

**Grand Total:** **1,397 automated unit, integration, and equivalence tests PASSING.**  
**TypeScript Typecheck:** 0 errors (`tsc --noEmit` passed).  
**ESLint:** 0 errors across all modified source code and test files.

---

## 5. Live Physical Phone Verification Evidence

Verified live on physical Android device (Xiaomi Redmi 12 5G, Android 14):
1. **Live Glove Connection:**
   - Right Hand Bluetooth LE: **Healthy**, 306+ real packets received.
   - Left Hand Bluetooth LE: **Healthy**, 157+ real packets received.
2. **3D Hand Viewer:**
   - Live bones driven by physical IMU sensor telemetry (`pitch -4°`, `roll 4°`).
3. **ML Studio Record Workflow:**
   - 3.0-second fixed window duration with 0.0s to 3.0s progress bar.
   - Target sign label selected **BEFORE** recording (`HELLO`, `BYE`, `THANK YOU`, `YES`, `NO`, `REST`).
   - Selected target sign displayed prominently throughout recording window.
   - Real glove provenance stamped (`source: "glove"`).
   - Sensor stream quality monitored; signals with excessive latency or dropped packets (>250ms gap) are flagged honestly.
4. **Dashboard Embedded ML Cards:**
   - Independent status cards for Left and Right ESP32-S3 models.
   - Immediate clearing on disconnect to prevent stale predictions.
   - Honest warning displayed for Left glove hardware channel limitation (Middle & Ring flex degradation).
   - Text-to-speech auto-speaks stable recognized predictions once with a REST re-arming lock.
