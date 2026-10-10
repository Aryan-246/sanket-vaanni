/**
 * Sensor and glove contracts.
 *
 * ## Intentionally almost empty
 *
 * There is **no wire-format type here**, and that is deliberate. The glove
 * firmware's service UUIDs, characteristic UUIDs, frame layout, byte order,
 * sample rate and checksum are all unverified — see `docs/ble-protocol.md`.
 *
 * Writing a `GloveFrame` type with plausible-looking fields would create a
 * document that reads as authoritative while being fiction. It would then be
 * implemented against. That is exactly the failure mode this repository's
 * ground rules forbid.
 *
 * Until the protocol is confirmed, the only thing that can be stated honestly
 * is which **physical quantities** the system intends to carry — with no claim
 * about how they are encoded on the wire.
 */

/** Which glove a reading belongs to. */
export type GloveSide = 'left' | 'right';

/** The five instrumented fingers. Order is fixed and meaningful. */
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;

export type Finger = (typeof FINGERS)[number];

/**
 * A reading expressed in physical intent, not wire encoding.
 *
 * `flex` values are normalised to `0..1` (relaxed..fully flexed) **after**
 * calibration. The raw ADC counts, multiplexer channel order and ADS1115 gain
 * are transport concerns and must not appear here.
 *
 * `accel` is m/s² and `gyro` is rad/s, both in the glove's own frame of
 * reference. The IMU's full-scale range and orientation convention are
 * unverified.
 */
export interface SensorSample {
  side: GloveSide;
  /** Milliseconds, monotonic clock. Source of truth is undecided (glove vs phone). */
  timestampMs: number;
  /** Thumb, index, middle, ring, pinky — normalised after calibration. */
  flex: [number, number, number, number, number];
  accel: { x: number; y: number; z: number };
  gyro: { x: number; y: number; z: number };
}
