#!/usr/bin/env python3
"""
Sanket Vaanni — Machine Learning Training & Embedded C++ Exporter
=================================================================
Trains separate Left and Right glove gesture recognition models using scikit-learn
from dataset exports in 'sanketvaanni.ml.dataset' format.

Exports embedded C++ inference headers:
  - firmware/left/SanketModel.h
  - firmware/right/SanketModel.h

Features:
  - 11 channels (flex 0..4, accel x,y,z, gyro x,y,z)
  - 9 statistical and temporal features per channel:
      1. mean
      2. std (population standard deviation, ddof=0)
      3. min
      4. max
      5. mean_abs_diff (frame-to-frame change)
      6. mean_first_third (frames 0..9)
      7. mean_mid_third (frames 10..19)
      8. mean_last_third (frames 20..29)
      9. final_minus_initial (frame 29 - frame 0)
    Total: 99 features per 30-frame window.

Pipeline:
  StandardScaler -> LogisticRegression (L-BFGS)

Splitting:
  Session-grouped splitting (GroupKFold by sessionId) to prevent data leakage.
"""

import argparse
import datetime
import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

FEATURE_VERSION = "glove-window/99-v1"
WINDOW_FRAMES = 30
CHANNEL_COUNT = 11

FEATURE_CHANNELS = [
    "flex.thumb",
    "flex.index",
    "flex.middle",
    "flex.ring",
    "flex.pinky",
    "accel.x",
    "accel.y",
    "accel.z",
    "gyro.x",
    "gyro.y",
    "gyro.z",
]

FEATURE_STATS = [
    "mean",
    "std",
    "min",
    "max",
    "mean_abs_diff",
    "mean_first_third",
    "mean_mid_third",
    "mean_last_third",
    "final_minus_initial",
]

FEATURE_NAMES = [f"{ch}.{st}" for ch in FEATURE_CHANNELS for st in FEATURE_STATS]
assert len(FEATURE_NAMES) == 99, f"Expected 99 features, got {len(FEATURE_NAMES)}"


def extract_window_features(frames: List[Dict[str, Any]]) -> np.ndarray:
    """
    Extracts 99 deterministic features from a window of 30 frames.
    Frames must each contain:
      - 'flex': 5 numbers [0..1]
      - 'a': 3 numbers [ax, ay, az]
      - 'g': 3 numbers [gx, gy, gz]
    """
    if len(frames) != WINDOW_FRAMES:
        # Interpolate / resample if frame count differs
        indices = np.linspace(0, len(frames) - 1, WINDOW_FRAMES)
        resampled = []
        for idx in indices:
            low = int(np.floor(idx))
            high = min(low + 1, len(frames) - 1)
            weight = idx - low
            f_low = frames[low]
            f_high = frames[high]
            flex = [
                (1.0 - weight) * f_low["flex"][i] + weight * f_high["flex"][i]
                for i in range(5)
            ]
            a = [
                (1.0 - weight) * f_low["a"][i] + weight * f_high["a"][i]
                for i in range(3)
            ]
            g = [
                (1.0 - weight) * f_low["g"][i] + weight * f_high["g"][i]
                for i in range(3)
            ]
            resampled.append({"flex": flex, "a": a, "g": g})
        frames = resampled

    # Extract 11 channels of 30 frames each
    channels = np.zeros((CHANNEL_COUNT, WINDOW_FRAMES), dtype=np.float32)
    for t, frame in enumerate(frames):
        channels[0:5, t] = frame["flex"]
        channels[5:8, t] = frame["a"]
        channels[8:11, t] = frame["g"]

    features = np.zeros(99, dtype=np.float32)
    feat_idx = 0
    for ch in range(CHANNEL_COUNT):
        x = channels[ch]
        # 1. mean
        m = float(np.mean(x))
        features[feat_idx] = m
        feat_idx += 1

        # 2. std (population ddof=0)
        s = float(np.std(x, ddof=0))
        features[feat_idx] = s
        feat_idx += 1

        # 3. min
        features[feat_idx] = float(np.min(x))
        feat_idx += 1

        # 4. max
        features[feat_idx] = float(np.max(x))
        feat_idx += 1

        # 5. mean_abs_diff
        diffs = np.abs(np.diff(x))
        features[feat_idx] = float(np.mean(diffs)) if len(diffs) > 0 else 0.0
        feat_idx += 1

        # 6. mean_first_third (frames 0..9)
        features[feat_idx] = float(np.mean(x[0:10]))
        feat_idx += 1

        # 7. mean_mid_third (frames 10..19)
        features[feat_idx] = float(np.mean(x[10:20]))
        feat_idx += 1

        # 8. mean_last_third (frames 20..29)
        features[feat_idx] = float(np.mean(x[20:30]))
        feat_idx += 1

        # 9. final_minus_initial
        features[feat_idx] = float(x[-1] - x[0])
        feat_idx += 1

    return features


def load_dataset(dataset_path: str, target_language: str, allow_synthetic: bool = False) -> Dict[str, Any]:
    """
    Loads and validates a Sanket Vaanni dataset file.
    """
    if not os.path.exists(dataset_path):
        raise FileNotFoundError(f"Dataset file does not exist: {dataset_path}")

    with open(dataset_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if data.get("format") != "sanketvaanni.ml.dataset":
        raise ValueError(f"Invalid format: {data.get('format')}, expected 'sanketvaanni.ml.dataset'")

    labels = {lbl["id"]: lbl["text"] for lbl in data.get("labels", [])}
    samples = data.get("samples", [])
    print(f"Loaded dataset: {len(samples)} total samples, {len(labels)} label definitions.")

    # Filter samples
    filtered_samples = []
    skipped_stats = {"unapproved": 0, "synthetic": 0, "lang_mismatch": 0, "not_sensor": 0}

    for s in samples:
        if s.get("modality") != "glove-sensor":
            skipped_stats["not_sensor"] += 1
            continue
        if s.get("languageId", "").lower() != target_language.lower():
            skipped_stats["lang_mismatch"] += 1
            continue
        if s.get("approval") != "approved":
            skipped_stats["unapproved"] += 1
            continue
        if not allow_synthetic and s.get("source") != "glove":
            skipped_stats["synthetic"] += 1
            continue
        filtered_samples.append(s)

    print(f"Filtered samples for language '{target_language}': {len(filtered_samples)} kept.")
    print(f"Skipped samples breakdown: {skipped_stats}")
    return {"labels": labels, "samples": filtered_samples, "metadata": data}


def partition_by_glove_side(samples: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Separates samples strictly by glove side ('left' vs 'right').
    """
    left_samples = [s for s in samples if s.get("side") == "left"]
    right_samples = [s for s in samples if s.get("side") == "right"]
    return left_samples, right_samples


def check_sensor_health(samples: List[Dict[str, Any]], side: str) -> List[str]:
    """
    Audits samples for flat/dead channels and reports warnings honestly.
    """
    warnings = []
    if not samples:
        return ["No samples available to audit sensor health."]

    flex_variances = [[] for _ in range(5)]
    for s in samples:
        frames = s.get("frames", [])
        for ch in range(5):
            vals = [f["flex"][ch] for f in frames if "flex" in f and len(f["flex"]) > ch]
            if vals:
                flex_variances[ch].append(float(np.var(vals)))

    channel_names = ["Thumb", "Index", "Middle", "Ring", "Pinky"]
    for ch in range(5):
        mean_var = float(np.mean(flex_variances[ch])) if flex_variances[ch] else 0.0
        if mean_var < 1e-5:
            warnings.append(
                f"{side.upper()} glove {channel_names[ch]} channel (CH{ch}) has near-zero variance ({mean_var:.6f}). "
                f"Channel is likely degraded or uncalibrated."
            )

    return warnings


def train_single_model(
    samples: List[Dict[str, Any]],
    label_map: Dict[str, str],
    side: str,
    language: str,
    seed: int = 42,
    min_samples_per_class: int = 3,
) -> Optional[Dict[str, Any]]:
    """
    Trains a StandardScaler + LogisticRegression model on a single glove's samples.
    """
    if not samples:
        print(f"\n[WARNING] No {side} glove samples found. Cannot train {side} model.")
        return None

    # Audit sensor health
    health_warnings = check_sensor_health(samples, side)
    for hw in health_warnings:
        print(f"[{side.upper()} SENSOR WARNING] {hw}")

    # Build feature matrix X, labels y, and sessions groups
    X_list = []
    y_list = []
    session_list = []

    for s in samples:
        lbl_id = s.get("labelId")
        lbl_text = label_map.get(lbl_id, lbl_id)
        feats = extract_window_features(s.get("frames", []))
        X_list.append(feats)
        y_list.append(lbl_text)
        session_list.append(s.get("sessionId", "session-unknown"))

    X = np.array(X_list, dtype=np.float32)
    y = np.array(y_list)
    groups = np.array(session_list)

    unique_classes, counts = np.unique(y, return_counts=True)
    class_counts = dict(zip(unique_classes, counts))
    print(f"\n[{side.upper()} MODEL] Classes and sample counts:")
    for c, cnt in class_counts.items():
        print(f"  - {c}: {cnt} samples")

    # Check minimum class requirements
    insufficient = [c for c, cnt in class_counts.items() if cnt < min_samples_per_class]
    if insufficient:
        print(f"[{side.upper()} WARNING] Classes with fewer than {min_samples_per_class} samples: {insufficient}")

    if len(unique_classes) < 2:
        print(f"[{side.upper()} ERROR] Need at least 2 distinct classes to train a classifier. Found: {len(unique_classes)}")
        return None

    # Session-grouped evaluation
    unique_sessions = np.unique(groups)
    evaluation_report = {}
    if len(unique_sessions) >= 2:
        n_splits = min(3, len(unique_sessions))
        gkf = GroupKFold(n_splits=n_splits)
        y_true_all = []
        y_pred_all = []
        for train_idx, val_idx in gkf.split(X, y, groups):
            scaler = StandardScaler()
            X_train = scaler.fit_transform(X[train_idx])
            X_val = scaler.transform(X[val_idx])

            clf = LogisticRegression(C=1.0, max_iter=1000, random_state=seed, solver="lbfgs")
            clf.fit(X_train, y[train_idx])
            preds = clf.predict(X_val)
            y_true_all.extend(y[val_idx])
            y_pred_all.extend(preds)

        acc = float(accuracy_score(y_true_all, y_pred_all))
        rep = classification_report(y_true_all, y_pred_all, output_dict=True, zero_division=0)
        cm = confusion_matrix(y_true_all, y_pred_all, labels=sorted(unique_classes)).tolist()
        evaluation_report = {
            "validation_accuracy": acc,
            "session_count": int(len(unique_sessions)),
            "per_class": rep,
            "confusion_matrix": cm,
            "classes": sorted(unique_classes.tolist()),
            "caveats": health_warnings,
        }
        print(f"[{side.upper()} EVALUATION] GroupKFold ({n_splits} splits) Validation Accuracy: {acc * 100:.1f}%")
    else:
        evaluation_report = {
            "validation_accuracy": None,
            "session_count": 1,
            "caveats": health_warnings + ["Dataset has only 1 session; held-out evaluation is not statistically meaningful."],
        }
        print(f"[{side.upper()} EVALUATION] Single session present; training without cross-validation split.")

    # Final fit on all data
    final_scaler = StandardScaler()
    X_scaled = final_scaler.fit_transform(X)
    final_clf = LogisticRegression(C=1.0, max_iter=1000, random_state=seed, solver="lbfgs")
    final_clf.fit(X_scaled, y)

    # Scikit-learn LogisticRegression coef_ shape:
    # If binary: shape is (1, n_features) -> we expand to (2, n_features) for consistent C++ multi-class evaluation
    classes = final_clf.classes_.tolist()
    coef = final_clf.coef_
    intercept = final_clf.intercept_

    if len(classes) == 2:
        # Binary: class 0 has -coef/2, class 1 has +coef/2
        weights = np.vstack([-coef / 2.0, coef / 2.0])
        intercepts = np.array([-intercept[0] / 2.0, intercept[0] / 2.0])
    else:
        weights = coef
        intercepts = intercept

    return {
        "side": side,
        "language": language,
        "classes": classes,
        "feature_version": FEATURE_VERSION,
        "scaler_mean": final_scaler.mean_.tolist(),
        "scaler_scale": final_scaler.scale_.tolist(),
        "weights": weights.tolist(),
        "intercepts": intercepts.tolist(),
        "evaluation": evaluation_report,
        "sample_count": len(samples),
        "session_count": len(unique_sessions),
        "class_counts": class_counts,
        "health_warnings": health_warnings,
    }


def generate_cpp_header(model_data: Dict[str, Any], output_path: str):
    """
    Generates embedded C++ header 'SanketModel.h' for ESP32-S3 firmware.
    """
    side = model_data["side"]
    side_upper = side.upper()
    language = model_data["language"]
    classes = model_data["classes"]
    num_classes = len(classes)
    scaler_mean = model_data["scaler_mean"]
    scaler_scale = model_data["scaler_scale"]
    weights = model_data["weights"]
    intercepts = model_data["intercepts"]
    model_version = "1.0.0"

    header_lines = [
        f"// ============================================================================",
        f"// SANKET VAANNI EMBEDDED ML MODEL HEADER — {side_upper} GLOVE",
        f"// Auto-generated by ml/python/train_and_export.py on {datetime.date.today()}",
        f"// Language: {language.upper()} | Classes: {num_classes} | Features: 99",
        f"// ============================================================================",
        f"#ifndef SANKET_MODEL_{side_upper}_H",
        f"#define SANKET_MODEL_{side_upper}_H",
        "",
        "#include <stdint.h>",
        "#include <math.h>",
        "#include <string.h>",
        "",
        f'#define SANKET_MODEL_SIDE "{side}"',
        f'#define SANKET_MODEL_VERSION "{model_version}"',
        f'#define SANKET_FEATURE_VERSION "{FEATURE_VERSION}"',
        f"#define SANKET_WINDOW_FRAMES 30",
        f"#define SANKET_CHANNEL_COUNT 11",
        f"#define SANKET_FEATURE_COUNT 99",
        f"#define SANKET_CLASS_COUNT {num_classes}",
        "",
        f"// Unknown score and margin thresholds",
        f"static const float SANKET_UNKNOWN_SCORE_THRESHOLD = 0.45f;",
        f"static const float SANKET_UNKNOWN_MARGIN_THRESHOLD = 0.08f;",
        "",
        f"// Calibration Configuration for {side_upper} Glove",
        f"#define SANKET_CALIBRATION_VERSION 1",
    ]

    if side == "left":
        header_lines.extend([
            f"static const int SANKET_CALIB_REST[5]     = {{ 550, 1860, 290, 340, 1960 }};",
            f"static const int SANKET_CALIB_FULLFLEX[5] = {{ 5120, 5836, 520, 1088, 990 }};",
        ])
    else:
        header_lines.extend([
            f"static const int SANKET_CALIB_REST[5]     = {{ 2085, 2885, 3390, 4914, 3342 }};",
            f"static const int SANKET_CALIB_FULLFLEX[5] = {{ 5120, 5800, 5800, 6200, 5200 }};",
        ])

    header_lines.extend([
        "",
        "inline float normaliseFlexChannel(int raw, int rest, int fullFlex) {",
        "  int span = fullFlex - rest;",
        "  if (span == 0) return 0.0f;",
        "  float ratio = (float)(raw - rest) / (float)span;",
        "  if (ratio < 0.0f) ratio = 0.0f;",
        "  if (ratio > 1.0f) ratio = 1.0f;",
        "  return ratio;",
        "}",
        "",
        f"// Vocabulary Class Labels",
        f"static const char* SANKET_CLASS_LABELS[SANKET_CLASS_COUNT] = {{",
    ])
    for c in classes:
        header_lines.append(f'  "{c}",')
    header_lines.append("};")
    header_lines.append("")

    # Scaler mean
    header_lines.append(f"// StandardScaler Mean (99 features)")
    header_lines.append(f"static const float SANKET_SCALER_MEAN[SANKET_FEATURE_COUNT] = {{")
    for i, m in enumerate(scaler_mean):
        header_lines.append(f"  {m:.7f}f, // [{i}] {FEATURE_NAMES[i]}")
    header_lines.append("};")
    header_lines.append("")

    # Scaler scale
    header_lines.append(f"// StandardScaler Scale (99 features)")
    header_lines.append(f"static const float SANKET_SCALER_SCALE[SANKET_FEATURE_COUNT] = {{")
    for i, s in enumerate(scaler_scale):
        val = s if abs(s) > 1e-9 else 1.0
        header_lines.append(f"  {val:.7f}f, // [{i}] {FEATURE_NAMES[i]}")
    header_lines.append("};")
    header_lines.append("")

    # Weights
    header_lines.append(f"// Logistic Regression Weights [{num_classes}][99]")
    header_lines.append(f"static const float SANKET_WEIGHTS[SANKET_CLASS_COUNT][SANKET_FEATURE_COUNT] = {{")
    for c_idx in range(num_classes):
        header_lines.append(f"  {{ // Class {c_idx}: {classes[c_idx]}")
        for f_idx in range(99):
            w = weights[c_idx][f_idx]
            header_lines.append(f"    {w:.7f}f,")
        header_lines.append("  },")
    header_lines.append("};")
    header_lines.append("")

    # Intercepts
    header_lines.append(f"// Logistic Regression Intercepts [{num_classes}]")
    header_lines.append(f"static const float SANKET_INTERCEPTS[SANKET_CLASS_COUNT] = {{")
    for c_idx in range(num_classes):
        header_lines.append(f"  {intercepts[c_idx]:.7f}f, // {classes[c_idx]}")
    header_lines.append("};")
    header_lines.append("")

    # Embedded Inference Helper Implementation
    header_lines.extend([
        "// ----------------------------------------------------------------------------",
        "// Embedded C++ Feature Extractor & Inference Engine",
        "// ----------------------------------------------------------------------------",
        "struct SanketPrediction {",
        "  char label[32];",
        "  float score;",
        "  float margin;",
        "  bool is_valid;",
        "  bool is_unknown;",
        "};",
        "",
        "inline void extractFeatures99(const float window[30][11], float out[99]) {",
        "  int feat_idx = 0;",
        "  for (int ch = 0; ch < 11; ch++) {",
        "    float sum = 0.0f;",
        "    float min_v = window[0][ch];",
        "    float max_v = window[0][ch];",
        "    float diff_sum = 0.0f;",
        "    float third1_sum = 0.0f;",
        "    float third2_sum = 0.0f;",
        "    float third3_sum = 0.0f;",
        "",
        "    for (int t = 0; t < 30; t++) {",
        "      float v = window[t][ch];",
        "      sum += v;",
        "      if (v < min_v) min_v = v;",
        "      if (v > max_v) max_v = v;",
        "      if (t > 0) diff_sum += fabsf(v - window[t - 1][ch]);",
        "      if (t < 10) third1_sum += v;",
        "      else if (t < 20) third2_sum += v;",
        "      else third3_sum += v;",
        "    }",
        "",
        "    float mean_v = sum / 30.0f;",
        "    float var_sum = 0.0f;",
        "    for (int t = 0; t < 30; t++) {",
        "      float d = window[t][ch] - mean_v;",
        "      var_sum += d * d;",
        "    }",
        "    float std_v = sqrtf(var_sum / 30.0f);",
        "",
        "    out[feat_idx++] = mean_v;",
        "    out[feat_idx++] = std_v;",
        "    out[feat_idx++] = min_v;",
        "    out[feat_idx++] = max_v;",
        "    out[feat_idx++] = diff_sum / 29.0f;",
        "    out[feat_idx++] = third1_sum / 10.0f;",
        "    out[feat_idx++] = third2_sum / 10.0f;",
        "    out[feat_idx++] = third3_sum / 10.0f;",
        "    out[feat_idx++] = window[29][ch] - window[0][ch];",
        "  }",
        "}",
        "",
        "inline SanketPrediction runSanketInference(const float features[99]) {",
        "  SanketPrediction res;",
        "  res.is_valid = false;",
        "  res.is_unknown = true;",
        "  res.score = 0.0f;",
        "  res.margin = 0.0f;",
        '  strncpy(res.label, "UNKNOWN", sizeof(res.label));',
        "",
        "  // 1. Standardise features",
        "  float norm[99];",
        "  for (int i = 0; i < 99; i++) {",
        "    norm[i] = (features[i] - SANKET_SCALER_MEAN[i]) / SANKET_SCALER_SCALE[i];",
        "  }",
        "",
        "  // 2. Compute logits",
        f"  float logits[{num_classes}];",
        f"  float max_logit = -1e9f;",
        f"  for (int c = 0; c < SANKET_CLASS_COUNT; c++) {{",
        "    float sum = SANKET_INTERCEPTS[c];",
        "    for (int f = 0; f < 99; f++) {",
        "      sum += SANKET_WEIGHTS[c][f] * norm[f];",
        "    }",
        "    logits[c] = sum;",
        "    if (sum > max_logit) max_logit = sum;",
        "  }",
        "",
        "  // 3. Softmax probabilities",
        f"  float exp_sum = 0.0f;",
        f"  float probs[{num_classes}];",
        f"  for (int c = 0; c < SANKET_CLASS_COUNT; c++) {{",
        "    probs[c] = expf(logits[c] - max_logit);",
        "    exp_sum += probs[c];",
        "  }",
        f"  for (int c = 0; c < SANKET_CLASS_COUNT; c++) {{",
        "    probs[c] /= (exp_sum > 0.0f ? exp_sum : 1.0f);",
        "  }",
        "",
        "  // 4. Determine best and second-best",
        "  int best_idx = 0;",
        "  float best_p = probs[0];",
        f"  for (int c = 1; c < SANKET_CLASS_COUNT; c++) {{",
        "    if (probs[c] > best_p) {",
        "      best_p = probs[c];",
        "      best_idx = c;",
        "    }",
        "  }",
        "",
        "  float second_p = 0.0f;",
        f"  for (int c = 0; c < SANKET_CLASS_COUNT; c++) {{",
        "    if (c != best_idx && probs[c] > second_p) {",
        "      second_p = probs[c];",
        "    }",
        "  }",
        "",
        "  res.score = best_p;",
        "  res.margin = best_p - second_p;",
        "",
        "  // 5. Unknown rejection threshold",
        "  if (res.score >= SANKET_UNKNOWN_SCORE_THRESHOLD && res.margin >= SANKET_UNKNOWN_MARGIN_THRESHOLD) {",
        "    res.is_valid = true;",
        "    res.is_unknown = false;",
        "    strncpy(res.label, SANKET_CLASS_LABELS[best_idx], sizeof(res.label) - 1);",
        "    res.label[sizeof(res.label) - 1] = '\\0';",
        "  } else {",
        "    res.is_valid = false;",
        "    res.is_unknown = true;",
        '    strncpy(res.label, "UNKNOWN", sizeof(res.label));',
        "  }",
        "  return res;",
        "}",
        "",
        f"#endif // SANKET_MODEL_{side_upper}_H",
    ])

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(header_lines) + "\n")
    print(f"Generated C++ Header: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Train and export Sanket Vaanni ESP32-S3 ML models")
    parser.add_argument("--dataset", type=str, required=True, help="Path to sanketvaanni.ml.dataset JSON file")
    parser.add_argument("--language", type=str, default="asl", help="Sign language profile (isl, asl, bsl)")
    parser.add_argument("--output-dir", type=str, default="firmware", help="Base directory for firmware headers")
    parser.add_argument("--reports-dir", type=str, default="ml/reports", help="Directory for evaluation reports")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--min-samples-per-class", type=int, default=3, help="Minimum samples required per class")
    parser.add_argument("--allow-synthetic", action="store_true", help="Allow synthetic/demo data (testing only)")

    args = parser.parse_args()

    print("=" * 70)
    print("SANKET VAANNI — ESP32-S3 ML TRAINING & EMBEDDED EXPORTER")
    print(f"Dataset:  {args.dataset}")
    print(f"Language: {args.language}")
    print(f"Seed:     {args.seed}")
    print("=" * 70)

    dataset_info = load_dataset(args.dataset, args.language, allow_synthetic=args.allow_synthetic)
    labels = dataset_info["labels"]
    samples = dataset_info["samples"]

    left_samples, right_samples = partition_by_glove_side(samples)
    print(f"\nPartitioned: {len(left_samples)} Left samples, {len(right_samples)} Right samples.")

    os.makedirs(args.reports_dir, exist_ok=True)

    # 1. Train Left Model
    left_model = train_single_model(
        left_samples,
        labels,
        side="left",
        language=args.language,
        seed=args.seed,
        min_samples_per_class=args.min_samples_per_class,
    )
    if left_model:
        left_header_path = os.path.join(args.output_dir, "left", "SanketModel.h")
        generate_cpp_header(left_model, left_header_path)
        with open(os.path.join(args.reports_dir, "left_model_report.json"), "w", encoding="utf-8") as f:
            json.dump(left_model["evaluation"], f, indent=2)

    # 2. Train Right Model
    right_model = train_single_model(
        right_samples,
        labels,
        side="right",
        language=args.language,
        seed=args.seed,
        min_samples_per_class=args.min_samples_per_class,
    )
    if right_model:
        right_header_path = os.path.join(args.output_dir, "right", "SanketModel.h")
        generate_cpp_header(right_model, right_header_path)
        with open(os.path.join(args.reports_dir, "right_model_report.json"), "w", encoding="utf-8") as f:
            json.dump(right_model["evaluation"], f, indent=2)

    print("\nTraining and Export complete.")


if __name__ == "__main__":
    main()
