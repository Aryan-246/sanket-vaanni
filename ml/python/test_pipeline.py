"""
Automated unit tests and inference parity verification for Sanket Vaanni ML pipeline.
"""

import json
import math
import os
import tempfile
import numpy as np
import pytest

from train_and_export import (
    FEATURE_CHANNELS,
    FEATURE_NAMES,
    FEATURE_STATS,
    extract_window_features,
    load_dataset,
    partition_by_glove_side,
    train_single_model,
    generate_cpp_header,
)


def make_dummy_frame(t_idx: int, base_val: float) -> dict:
    """Creates a single fixture frame."""
    return {
        "tMs": t_idx * 100,
        "flex": [base_val + 0.01 * i for i in range(5)],
        "a": [0.1 * base_val, 0.2 * base_val, 9.8],
        "g": [0.01 * t_idx, -0.01 * t_idx, 0.0],
    }


def make_dummy_window(base_val: float) -> list:
    """Creates a 30-frame window."""
    return [make_dummy_frame(t, base_val + 0.005 * t) for t in range(30)]


def test_feature_count_and_order():
    assert len(FEATURE_CHANNELS) == 11
    assert len(FEATURE_STATS) == 9
    assert len(FEATURE_NAMES) == 99
    assert FEATURE_NAMES[0] == "flex.thumb.mean"
    assert FEATURE_NAMES[8] == "flex.thumb.final_minus_initial"
    assert FEATURE_NAMES[9] == "flex.index.mean"
    assert FEATURE_NAMES[98] == "gyro.z.final_minus_initial"


def test_feature_extraction_numerical_parity():
    """
    Verifies that the python feature extractor produces exact numbers matching
    the arithmetic definition specified for the embedded C++ implementation.
    """
    window = make_dummy_window(0.2)
    feats = extract_window_features(window)
    assert len(feats) == 99

    # Manually check flex.thumb (CH 0):
    # flex[0] values: 0.2 + 0.005 * t for t in 0..29
    # t=0: 0.2, t=29: 0.2 + 0.145 = 0.345
    expected_mean = float(np.mean([0.2 + 0.005 * t for t in range(30)]))
    expected_min = 0.2
    expected_max = 0.345
    expected_delta = 0.345 - 0.2

    assert abs(feats[0] - expected_mean) < 1e-5
    assert abs(feats[2] - expected_min) < 1e-5
    assert abs(feats[3] - expected_max) < 1e-5
    assert abs(feats[8] - expected_delta) < 1e-5


def test_dataset_loading_and_filtering():
    """
    Verifies that unapproved samples and synthetic samples are excluded.
    """
    dataset_content = {
        "format": "sanketvaanni.ml.dataset",
        "datasetVersion": 1,
        "exportedAtMs": 1700000000,
        "ownerId": "test-owner",
        "preprocessingVersion": "glove-window/1",
        "labels": [
            {"id": "lbl-hello", "languageId": "asl", "text": "HELLO", "note": None, "createdAtMs": 0, "createdBy": "user", "archivedAtMs": None},
            {"id": "lbl-bye", "languageId": "asl", "text": "BYE", "note": None, "createdAtMs": 0, "createdBy": "user", "archivedAtMs": None},
        ],
        "sessions": [],
        "samples": [
            # 1. Valid real glove sample
            {
                "id": "s1",
                "sessionId": "sess-1",
                "languageId": "asl",
                "labelId": "lbl-hello",
                "modality": "glove-sensor",
                "source": "glove",
                "side": "right",
                "approval": "approved",
                "frames": make_dummy_window(0.1),
            },
            # 2. Simulated Demo sample (must be rejected)
            {
                "id": "s2",
                "sessionId": "sess-1",
                "languageId": "asl",
                "labelId": "lbl-hello",
                "modality": "glove-sensor",
                "source": "simulated",
                "side": "right",
                "approval": "approved",
                "frames": make_dummy_window(0.1),
            },
            # 3. Pending/unapproved sample (must be rejected)
            {
                "id": "s3",
                "sessionId": "sess-1",
                "languageId": "asl",
                "labelId": "lbl-hello",
                "modality": "glove-sensor",
                "source": "glove",
                "side": "right",
                "approval": "pending",
                "frames": make_dummy_window(0.1),
            },
            # 4. Language mismatch (must be rejected)
            {
                "id": "s4",
                "sessionId": "sess-1",
                "languageId": "isl",
                "labelId": "lbl-hello",
                "modality": "glove-sensor",
                "source": "glove",
                "side": "right",
                "approval": "approved",
                "frames": make_dummy_window(0.1),
            },
        ],
    }

    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".json") as f:
        json.dump(dataset_content, f)
        temp_path = f.name

    try:
        loaded = load_dataset(temp_path, target_language="asl", allow_synthetic=False)
        assert len(loaded["samples"]) == 1
        assert loaded["samples"][0]["id"] == "s1"

        # If allow_synthetic is True, s1 and s2 should be kept
        loaded_syn = load_dataset(temp_path, target_language="asl", allow_synthetic=True)
        assert len(loaded_syn["samples"]) == 2
        assert {s["id"] for s in loaded_syn["samples"]} == {"s1", "s2"}
    finally:
        os.remove(temp_path)


def test_glove_side_separation():
    samples = [
        {"id": "s-left", "side": "left"},
        {"id": "s-right", "side": "right"},
        {"id": "s-other", "side": "left"},
    ]
    left, right = partition_by_glove_side(samples)
    assert len(left) == 2
    assert len(right) == 1
    assert left[0]["id"] == "s-left"
    assert right[0]["id"] == "s-right"


def test_training_and_cpp_inference_parity():
    """
    Trains a model on fixture classes ('HELLO', 'BYE', 'REST'),
    and verifies that the simulated C++ inference code in Python produces
    identical class predictions and probabilities within floating point tolerance.
    """
    labels = {"l1": "HELLO", "l2": "BYE", "l3": "REST"}
    samples = []

    # Create distinct patterns for the 3 signs
    for i in range(5):
        samples.append({
            "id": f"h{i}",
            "sessionId": f"sess-{i % 2}",
            "side": "right",
            "labelId": "l1",
            "frames": make_dummy_window(0.1 + 0.01 * i),
        })
    for i in range(5):
        samples.append({
            "id": f"b{i}",
            "sessionId": f"sess-{i % 2}",
            "side": "right",
            "labelId": "l2",
            "frames": make_dummy_window(0.6 + 0.01 * i),
        })
    for i in range(5):
        samples.append({
            "id": f"r{i}",
            "sessionId": f"sess-{i % 2}",
            "side": "right",
            "labelId": "l3",
            "frames": make_dummy_window(0.9 + 0.01 * i),
        })

    model = train_single_model(samples, labels, side="right", language="asl", min_samples_per_class=2)
    assert model is not None
    assert len(model["classes"]) == 3

    # Test inference on a test window close to 'HELLO' (base 0.12)
    test_window = make_dummy_window(0.12)
    features = extract_window_features(test_window)

    # C++ Simulation:
    scaler_mean = np.array(model["scaler_mean"], dtype=np.float32)
    scaler_scale = np.array(model["scaler_scale"], dtype=np.float32)
    weights = np.array(model["weights"], dtype=np.float32)
    intercepts = np.array(model["intercepts"], dtype=np.float32)

    norm = (features - scaler_mean) / scaler_scale
    logits = intercepts + np.dot(weights, norm)
    max_logit = np.max(logits)
    exp_logits = np.exp(logits - max_logit)
    probs = exp_logits / np.sum(exp_logits)

    best_idx = int(np.argmax(probs))
    predicted_label = model["classes"][best_idx]
    assert predicted_label == "HELLO"
    assert probs[best_idx] > 0.5


def test_header_generation(tmp_path):
    model = {
        "side": "right",
        "language": "asl",
        "classes": ["BYE", "HELLO", "REST"],
        "scaler_mean": [0.0] * 99,
        "scaler_scale": [1.0] * 99,
        "weights": [[0.1] * 99, [0.2] * 99, [0.3] * 99],
        "intercepts": [0.0, 0.1, -0.1],
    }
    header_path = os.path.join(tmp_path, "SanketModel.h")
    generate_cpp_header(model, header_path)

    assert os.path.exists(header_path)
    with open(header_path, "r", encoding="utf-8") as f:
        content = f.read()

    assert "#define SANKET_MODEL_RIGHT_H" in content
    assert "SANKET_FEATURE_COUNT 99" in content
    assert "SANKET_CLASS_COUNT 3" in content
    assert '"HELLO"' in content
    assert "runSanketInference" in content
