
import asyncio
import csv
import json
import os
import time
from datetime import datetime

from bleak import BleakClient, BleakScanner

DEVICE_NAME = "SanketVaanni-Right"
DATA_UUID = "8f2a1001-7d2b-4c9a-9c4e-6b1e2f000001"
SAMPLE_INTERVAL = 0.5
SAMPLES_PER_WORD = 250

OUTPUT_DIR = os.path.join("ml", "datasets", "raw")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "right_glove_dataset.csv")

FIELDS = [
    "timestamp", "sample_id", "glove", "label",
    "flex_1", "flex_2", "flex_3", "flex_4", "flex_5",
    "accel_x", "accel_y", "accel_z",
    "gyro_x", "gyro_y", "gyro_z",
    "temp_c", "pitch", "roll"
]


def parse_payload(raw):
    data = json.loads(raw.decode("utf-8"))
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


async def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    file_exists = os.path.exists(OUTPUT_FILE) and os.path.getsize(OUTPUT_FILE) > 0

    print(f"Scanning for {DEVICE_NAME}...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=20)

    if device is None:
        print("Glove not found. Turn on desktop Bluetooth and power on the glove.")
        return

    print(f"Found glove: {device.name} ({device.address})")
    print("Connecting...")

    async with BleakClient(device) as client:
        print("Connected:", client.is_connected)

        with open(OUTPUT_FILE, "a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS)
            if not file_exists:
                writer.writeheader()

            sample_id = int(time.time() * 1000)

            while True:
                label = input("\nEnter word/sign to collect (or Q to quit): ").strip()
                if label.lower() == "q":
                    break
                if not label:
                    print("Please enter a word.")
                    continue

                print(f"Collecting {SAMPLES_PER_WORD} samples for '{label}'.")
                print("Hold or perform the sign naturally while sampling.")

                latest = {"row": None, "updated": 0.0}

                def on_data(sender, data):
                    parsed = parse_payload(data)
                    if parsed is not None:
                        latest["row"] = parsed
                        latest["updated"] = time.monotonic()

                await client.start_notify(DATA_UUID, on_data)
                try:
                    collected = 0
                    next_sample = time.monotonic()

                    while collected < SAMPLES_PER_WORD:
                        now = time.monotonic()
                        if latest["row"] is not None and now - latest["updated"] < 2:
                            row = dict(latest["row"])
                            row.update({
                                "timestamp": datetime.now().isoformat(timespec="milliseconds"),
                                "sample_id": sample_id,
                                "glove": "right",
                                "label": label,
                            })
                            writer.writerow(row)
                            f.flush()
                            sample_id += 1
                            collected += 1
                            print(f"\r{label}: {collected}/{SAMPLES_PER_WORD}", end="", flush=True)
                        else:
                            print("\nWaiting for valid BLE sensor data...")

                        next_sample += SAMPLE_INTERVAL
                        await asyncio.sleep(max(0, next_sample - time.monotonic()))

                    print(f"\nSaved {SAMPLES_PER_WORD} samples for '{label}'.")
                finally:
                    await client.stop_notify(DATA_UUID)

        print(f"\nDataset saved to: {OUTPUT_FILE}")


if __name__ == "__main__":
    asyncio.run(main())
