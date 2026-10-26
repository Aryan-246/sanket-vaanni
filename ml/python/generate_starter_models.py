"""
Generates starter baseline embedded headers (firmware/left/SanketModel.h and
firmware/right/SanketModel.h) for initial firmware flashing and compilation.
"""

import os
from train_and_export import (
    FEATURE_NAMES,
    generate_cpp_header,
)

STARTER_CLASSES = ["HELLO", "BYE", "THANK YOU", "YES", "NO", "REST"]

def create_starter_model(side: str):
    num_classes = len(STARTER_CLASSES)
    num_features = 99

    scaler_mean = [0.0] * num_features
    scaler_scale = [1.0] * num_features

    # Seed baseline weights with slight differences per class
    weights = []
    intercepts = []
    for c_idx in range(num_classes):
        # Distinct pattern for class
        w = [0.0] * num_features
        # Give specific channels distinct weights
        w[c_idx % num_features] = 1.0
        w[(c_idx * 5) % num_features] = 0.5
        weights.append(w)
        intercepts.append(0.0)

    return {
        "side": side,
        "language": "asl",
        "classes": STARTER_CLASSES,
        "scaler_mean": scaler_mean,
        "scaler_scale": scaler_scale,
        "weights": weights,
        "intercepts": intercepts,
    }

def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    left_model = create_starter_model("left")
    left_path = os.path.join(base_dir, "firmware", "left", "SanketModel.h")
    generate_cpp_header(left_model, left_path)

    right_model = create_starter_model("right")
    right_path = os.path.join(base_dir, "firmware", "right", "SanketModel.h")
    generate_cpp_header(right_model, right_path)
    print("Baseline SanketModel.h generated for left and right firmware sketches.")

if __name__ == "__main__":
    main()
