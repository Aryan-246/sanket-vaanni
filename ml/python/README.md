# Sanket Vaanni ESP32-S3 ML Training Pipeline & Embedded Exporter

This directory contains the Python training pipeline for the **Sanket Vaanni (संकेत वाणी)** dual ESP32-S3 sign-language glove project.

## Requirements

- Python 3.10+ (Tested on Python 3.13)
- `numpy>=1.24.0`
- `scikit-learn>=1.3.0`
- `pytest>=7.0.0`

Install dependencies:
```bash
pip install -r ml/python/requirements.txt
```

---

## Architecture & Workflow

1. **Dataset Ingestion**: Accepts exported datasets in `sanketvaanni.ml.dataset` format.
2. **Strict Provenance Filtering**:
   - Only `approved` sensor windows are consumed.
   - Demo Mode / synthetic samples (`source: "simulated"`) are **strictly excluded** from training.
   - Segregates samples strictly by glove side (`left` vs `right`).
3. **99-Feature Extraction**:
   - 11 channels: Flex 0..4 (Thumb, Index, Middle, Ring, Pinky), Accel X, Y, Z, Gyro X, Y, Z.
   - 9 temporal & statistical features per channel:
     1. `mean`
     2. `std` (population standard deviation, ddof=0)
     3. `min`
     4. `max`
     5. `mean_abs_diff` (mean frame-to-frame absolute delta)
     6. `mean_first_third` (frames 0..9)
     7. `mean_mid_third` (frames 10..19)
     8. `mean_last_third` (frames 20..29)
     9. `final_minus_initial` (frame 29 - frame 0)
   - Total: 99 features per 30-frame window.
4. **Grouped Session Validation**:
   - Evaluated using `GroupKFold` on `sessionId` so windows from the same session never appear in both train and validation splits.
5. **Embedded C++ Exporter**:
   - Directly emits standalone, zero-dependency C++ headers:
     - `firmware/left/SanketModel.h`
     - `firmware/right/SanketModel.h`
   - Headers contain:
     - Ordered class labels
     - 99-element `StandardScaler` mean and scale
     - Logistic regression weights and intercepts
     - Unknown rejection score and margin thresholds
     - Inline `extractFeatures99` and `runSanketInference` functions ready for ESP32-S3 execution.

---

## Command Line Usage

### Train and Export Models:
```bash
python ml/python/train_and_export.py --dataset ml/datasets/sanket_dataset.json --language asl
```

### Supported Arguments:
- `--dataset` (required): Path to the `sanketvaanni.ml.dataset` JSON file exported from the mobile app.
- `--language`: Sign language profile ID (`asl`, `isl`, `bsl`). Default: `asl`.
- `--output-dir`: Base directory for firmware headers. Default: `firmware`.
- `--reports-dir`: Directory for evaluation reports. Default: `ml/reports`.
- `--seed`: Random seed for reproducibility. Default: `42`.
- `--min-samples-per-class`: Minimum samples required per class. Default: `3`.
- `--allow-synthetic`: Flag to allow synthetic/demo data (strictly for testing).

---

## Running Automated Tests

Run the test suite verifying dataset parsing, session splitting, feature extraction, and Python vs C++ mathematical inference parity:
```bash
pytest ml/python/test_pipeline.py
```
