import asyncio
import csv
import json
import os
import sys
import time
from datetime import datetime
from typing import Dict, Optional

from bleak import BleakClient, BleakScanner

DATA_UUID = "8f2a1001-7d2b-4c9a-9c4e-6b1e2f000001"
SAMPLE_INTERVAL = 0.5
SAMPLES_PER_WORD = 250
OUTPUT_DIR = os.path.join("ml", "datasets", "raw")

FIELDS = [
    "timestamp", "sample_id", "glove", "label",
    "flex_1", "flex_2", "flex_3", "flex_4", "flex_5",
    "accel_x", "accel_y", "accel_z",
    "gyro_x", "gyro_y", "gyro_z",
    "temp_c", "pitch", "roll"
]


def parse_payload(raw: bytes) -> Optional[dict]:
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return None

    flex = data.get("flex")
    accel = data.get("accel")
    gyro = data.get("gyro")

    if not (
        isinstance(flex, list) and len(flex) == 5
        and isinstance(accel, list) and len(accel) == 3
        and isinstance(gyro, list) and len(gyro) == 3
    ):
        return None

    return {
        "glove": data.get("glove", "unknown"),
        "flex_1": flex[0], "flex_2": flex[1],
        "flex_3": flex[2], "flex_4": flex[3],
        "flex_5": flex[4],
        "accel_x": accel[0], "accel_y": accel[1],
        "accel_z": accel[2],
        "gyro_x": gyro[0], "gyro_y": gyro[1],
        "gyro_z": gyro[2],
        "temp_c": data.get("temp_c", ""),
        "pitch": data.get("pitch", ""),
        "roll": data.get("roll", ""),
    }


async def run_single_collector(device_name: str, glove_side: str):
    output_file = os.path.join(OUTPUT_DIR, f"{glove_side}_glove_dataset.csv")
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    file_exists = os.path.exists(output_file) and os.path.getsize(output_file) > 0

    print(f"\nScanning for {device_name}...")
    device = await BleakScanner.find_device_by_name(device_name, timeout=15)
    if not device:
        print(f"Could not find {device_name}. Ensure it is powered on.")
        return

    print(f"Found {device.name} ({device.address}), connecting...")
    async with BleakClient(device) as client:
        print(f"Connected to {device_name}!")
        with open(output_file, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS)
            if not file_exists:
                writer.writeheader()

            sample_id = int(time.time() * 1000)
            while True:
                label = input(f"\nEnter word/sign for {glove_side.upper()} glove (or Q to quit): ").strip()
                if label.lower() == "q":
                    break
                if not label:
                    continue

                print(f"Collecting {SAMPLES_PER_WORD} frames (0.5s interval) for '{label}' on {glove_side} glove...")
                latest = {"row": None, "updated": 0.0}

                def on_data(sender, data):
                    parsed = parse_payload(data)
                    if parsed:
                        latest["row"] = parsed
                        latest["updated"] = time.monotonic()

                await client.start_notify(DATA_UUID, on_data)
                try:
                    collected = 0
                    next_sample = time.monotonic()
                    while collected < SAMPLES_PER_WORD:
                        now = time.monotonic()
                        if latest["row"] is not None and now - latest["updated"] < 2.0:
                            row = dict(latest["row"])
                            row.update({
                                "timestamp": datetime.now().isoformat(timespec="milliseconds"),
                                "sample_id": sample_id,
                                "glove": glove_side,
                                "label": label,
                            })
                            writer.writerow(row)
                            f.flush()
                            sample_id += 1
                            collected += 1
                            print(f"\r[{glove_side.upper()}] '{label}': {collected}/{SAMPLES_PER_WORD}", end="", flush=True)
                        else:
                            print(f"\nWaiting for {device_name} telemetry...", end="", flush=True)

                        next_sample += SAMPLE_INTERVAL
                        await asyncio.sleep(max(0, next_sample - time.monotonic()))

                    print(f"\nSaved {SAMPLES_PER_WORD} frames to {output_file}!")
                finally:
                    await client.stop_notify(DATA_UUID)


async def run_both_collector():
    left_file = os.path.join(OUTPUT_DIR, "left_glove_dataset.csv")
    right_file = os.path.join(OUTPUT_DIR, "right_glove_dataset.csv")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("\nScanning for both SanketVaanni-Left and SanketVaanni-Right...")
    left_dev = await BleakScanner.find_device_by_name("SanketVaanni-Left", timeout=15)
    right_dev = await BleakScanner.find_device_by_name("SanketVaanni-Right", timeout=15)

    if not left_dev:
        print("SanketVaanni-Left not found!")
    if not right_dev:
        print("SanketVaanni-Right not found!")
    if not left_dev or not right_dev:
        print("Please ensure both gloves are powered on.")
        return

    print("Both gloves found! Connecting...")
    async with BleakClient(left_dev) as left_client, BleakClient(right_dev) as right_client:
        print("Connected to BOTH gloves simultaneously!")

        with open(left_file, "a", newline="", encoding="utf-8") as f_left, \
             open(right_file, "a", newline="", encoding="utf-8") as f_right:
            w_left = csv.DictWriter(f_left, fieldnames=FIELDS)
            w_right = csv.DictWriter(f_right, fieldnames=FIELDS)

            if not os.path.exists(left_file) or os.path.getsize(left_file) == 0:
                w_left.writeheader()
            if not os.path.exists(right_file) or os.path.getsize(right_file) == 0:
                w_right.writeheader()

            sample_id = int(time.time() * 1000)
            while True:
                label = input("\nEnter word/sign to capture on BOTH gloves (or Q to quit): ").strip()
                if label.lower() == "q":
                    break
                if not label:
                    continue

                print(f"Collecting {SAMPLES_PER_WORD} frames simultaneously for '{label}'...")
                left_latest = {"row": None, "updated": 0.0}
                right_latest = {"row": None, "updated": 0.0}

                def on_left(s, d):
                    p = parse_payload(d)
                    if p:
                        left_latest["row"] = p
                        left_latest["updated"] = time.monotonic()

                def on_right(s, d):
                    p = parse_payload(d)
                    if p:
                        right_latest["row"] = p
                        right_latest["updated"] = time.monotonic()

                await left_client.start_notify(DATA_UUID, on_left)
                await right_client.start_notify(DATA_UUID, on_right)
                try:
                    collected = 0
                    next_sample = time.monotonic()
                    while collected < SAMPLES_PER_WORD:
                        now = time.monotonic()
                        has_left = left_latest["row"] is not None and now - left_latest["updated"] < 2.0
                        has_right = right_latest["row"] is not None and now - right_latest["updated"] < 2.0

                        if has_left and has_right:
                            ts = datetime.now().isoformat(timespec="milliseconds")
                            r_l = dict(left_latest["row"])
                            r_l.update({"timestamp": ts, "sample_id": sample_id, "glove": "left", "label": label})
                            w_left.writerow(r_l)
                            f_left.flush()

                            r_r = dict(right_latest["row"])
                            r_r.update({"timestamp": ts, "sample_id": sample_id, "glove": "right", "label": label})
                            w_right.writerow(r_r)
                            f_right.flush()

                            sample_id += 1
                            collected += 1
                            print(f"\rCaptured '{label}': {collected}/{SAMPLES_PER_WORD} [Left: OK | Right: OK]", end="", flush=True)
                        else:
                            status_l = "OK" if has_left else "WAITING"
                            status_r = "OK" if has_right else "WAITING"
                            print(f"\rWaiting for stream [Left: {status_l} | Right: {status_r}]...", end="", flush=True)

                        next_sample += SAMPLE_INTERVAL
                        await asyncio.sleep(max(0, next_sample - time.monotonic()))

                    print(f"\nSaved {SAMPLES_PER_WORD} frames for both gloves!")
                finally:
                    await left_client.stop_notify(DATA_UUID)
                    await right_client.stop_notify(DATA_UUID)


def main():
    print("=" * 60)
    print("   SANKET VAANNI — BLE GLOVE DATASET COLLECTOR")
    print("=" * 60)
    print("Choose collection mode:")
    print("  1. Left Glove only  (SanketVaanni-Left  -> left_glove_dataset.csv)")
    print("  2. Right Glove only (SanketVaanni-Right -> right_glove_dataset.csv)")
    print("  3. BOTH Gloves simultaneous (Both connected -> Dual Capture)")
    print("=" * 60)
    choice = input("Enter choice (1, 2, or 3) [default: 1]: ").strip() or "1"

    if choice == "1":
        asyncio.run(run_single_collector("SanketVaanni-Left", "left"))
    elif choice == "2":
        asyncio.run(run_single_collector("SanketVaanni-Right", "right"))
    elif choice == "3":
        asyncio.run(run_both_collector())
    else:
        print("Invalid choice.")


if __name__ == "__main__":
    main()
