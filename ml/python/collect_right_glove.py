import csv
import re
import time
from datetime import datetime
from pathlib import Path

import serial
from serial.tools import list_ports

# RIGHT GLOVE SETTINGS
PORT = "COM5"
BAUD_RATE = 115200
TARGET_EXAMPLES = 250
SECONDS_PER_EXAMPLE = 0.5  # 500 milliseconds

OUTPUT_DIR = Path("ml/datasets/raw")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ONE SHARED DATASET FOR ALL WORDS
DATASET_FILE = OUTPUT_DIR / "right_glove_dataset.csv"

COLUMNS = [
    "label",
    "example_id",
    "timestamp",
    "flex_1",
    "flex_2",
    "flex_3",
    "flex_4",
    "flex_5",
    "raw_line",
]


def find_glove_port():
    for port in list_ports.comports():
        description = (port.description or "").lower()
        if "ch343" in description or "usb-serial" in description:
            return port.device
    return PORT


def parse_flex(line):
    match = re.search(r"FLEX\s*=\s*([^\r\n]+)", line)

    if not match:
        return None

    values = match.group(1).strip().split(",")

    if len(values) != 5:
        return None

    try:
        return [float(value.strip()) for value in values]
    except ValueError:
        return None


def prepare_dataset():
    """
    Create the shared CSV once.
    On first creation, import rows from existing right_*.csv files.
    """
    if DATASET_FILE.exists() and DATASET_FILE.stat().st_size > 0:
        print(f"Using existing shared dataset: {DATASET_FILE}")
        return

    old_files = [
        path
        for path in sorted(OUTPUT_DIR.glob("right_*.csv"))
        if path.name != DATASET_FILE.name
    ]

    imported_rows = 0

    with DATASET_FILE.open(
        "w", newline="", encoding="utf-8"
    ) as dataset:
        writer = csv.DictWriter(dataset, fieldnames=COLUMNS)
        writer.writeheader()

        for old_file in old_files:
            try:
                with old_file.open(
                    "r", newline="", encoding="utf-8"
                ) as source:
                    reader = csv.DictReader(source)

                    if not reader.fieldnames:
                        continue

                    for row_number, row in enumerate(reader, start=1):
                        flex_values = [
                            row.get(f"flex_{i}", "")
                            for i in range(1, 6)
                        ]

                        # Skip rows that do not contain all five flex values.
                        if any(value in (None, "") for value in flex_values):
                            continue

                        label = (row.get("label") or "").strip().upper()

                        if not label:
                            parts = old_file.stem.split("_")
                            label = parts[1].upper() if len(parts) > 1 else "UNKNOWN"

                        old_id = row.get("example_id") or str(row_number)

                        writer.writerow({
                            "label": label,
                            "example_id": f"import_{old_file.stem}_{old_id}",
                            "timestamp": row.get("timestamp")
                            or datetime.now().isoformat(timespec="milliseconds"),
                            "flex_1": flex_values[0],
                            "flex_2": flex_values[1],
                            "flex_3": flex_values[2],
                            "flex_4": flex_values[3],
                            "flex_5": flex_values[4],
                            "raw_line": row.get("raw_line", ""),
                        })

                        imported_rows += 1

    print(f"\nCreated shared dataset: {DATASET_FILE}")
    print(f"Existing sensor rows imported: {imported_rows}")


def collect_word(glove, writer, dataset, label):
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    saved_examples = 0

    print(f"\nWord: {label}")
    print(f"Target: {TARGET_EXAMPLES} examples")
    print("Each example: 500 milliseconds")
    print("Keep performing the sign while recording.")
    print("Starting in 3 seconds...\n")

    time.sleep(3)
    glove.reset_input_buffer()

    while saved_examples < TARGET_EXAMPLES:
        example_number = saved_examples + 1
        deadline = time.monotonic() + SECONDS_PER_EXAMPLE

        latest_flex = None
        latest_line = ""

        # Read sensor lines for this 500 ms interval.
        while time.monotonic() < deadline:
            raw = glove.readline()

            if not raw:
                continue

            line = raw.decode("utf-8", errors="replace").strip()
            flex = parse_flex(line)

            if flex is not None:
                latest_flex = flex
                latest_line = line

        # Save one reading for this interval.
        if latest_flex is None:
            print(
                f"No valid reading for example {example_number}; "
                "retrying."
            )
            continue

        writer.writerow({
            "label": label,
            "example_id": f"{label}_{session_id}_{example_number:03d}",
            "timestamp": datetime.now().isoformat(
                timespec="milliseconds"
            ),
            "flex_1": latest_flex[0],
            "flex_2": latest_flex[1],
            "flex_3": latest_flex[2],
            "flex_4": latest_flex[3],
            "flex_5": latest_flex[4],
            "raw_line": latest_line,
        })

        saved_examples += 1

        if saved_examples % 10 == 0 or saved_examples == TARGET_EXAMPLES:
            dataset.flush()
            print(f"{label}: {saved_examples}/{TARGET_EXAMPLES} examples saved")

    dataset.flush()

    print(f"\nFinished collecting {label}!")
    print(f"Examples saved: {saved_examples}/{TARGET_EXAMPLES}")
    print(f"Shared dataset: {DATASET_FILE.resolve()}")


def main():
    prepare_dataset()
    port = find_glove_port()

    print("\n=== RIGHT GLOVE DATA COLLECTOR ===")
    print(f"Serial port: {port}")
    print(f"Shared CSV: {DATASET_FILE.resolve()}")
    print(f"Examples per word: {TARGET_EXAMPLES}")
    print("Capture interval: 500 milliseconds")
    print("\nAt the word prompt, type a label such as HELLO or THANK_YOU.")
    print("Type Q at the word prompt to quit.\n")

    try:
        with serial.Serial(
            port, BAUD_RATE, timeout=0.1
        ) as glove:
            time.sleep(2)
            glove.reset_input_buffer()

            with DATASET_FILE.open(
                "a", newline="", encoding="utf-8"
            ) as dataset:
                writer = csv.DictWriter(
                    dataset, fieldnames=COLUMNS
                )

                while True:
                    label = input(
                        "\nEnter word/sign label (or Q to quit): "
                    ).strip().upper()

                    if label == "Q":
                        break

                    if not label or not re.fullmatch(r"[A-Z0-9_-]+", label):
                        print(
                            "Invalid label. Use letters, numbers, "
                            "underscores, or hyphens."
                        )
                        continue

                    collect_word(glove, writer, dataset, label)

                    choice = input(
                        "\nPress ENTER to collect another word, "
                        "or type Q to quit: "
                    ).strip().lower()

                    if choice == "q":
                        break

        print("\nCollector closed.")
        print(f"All collected words are stored in:\n{DATASET_FILE.resolve()}")

    except serial.SerialException as exc:
        print(f"\nSerial connection error: {exc}")
        print("Check the glove connection and close other apps using the port.")

    except KeyboardInterrupt:
        print("\nStopped. The saved rows remain in the shared dataset.")
        print(f"Dataset: {DATASET_FILE.resolve()}")


if __name__ == "__main__":
    main()