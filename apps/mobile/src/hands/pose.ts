/**
 * Hand pose — the contract between sensor data and anything that draws a hand.
 *
 * ## Why this is separate from `SensorSample`
 *
 * `SensorSample` is a measurement: five flex channels, an accelerometer and a
 * gyroscope, in whatever units the transport and calibration produced. A pose
 * is a *description of a hand*: how bent each finger is, how the wrist is
 * oriented, and whether those numbers describe a real glove or a simulation.
 *
 * Keeping them apart means the viewer can be built, unit-tested and driven from
 * simulated data long before real gloves exist, and means swapping in a real
 * recogniser or a real IMU cannot leak unlabelled hardware assumptions into the
 * renderer.
 *
 * ## What is deliberately absent
 *
 * `yaw` is typed as `null` rather than `number`, because it cannot be measured
 * on this hardware. The glove carries an MPU6050 — an accelerometer and a
 * gyroscope, **no magnetometer**. Tilt (pitch and roll) is observable, because
 * gravity gives an absolute reference. Rotation about the vertical axis is not:
 * integrating the gyroscope drifts without bound and would need a magnetometer
 * or a reference marker to correct. So the honest type says "this cannot be
 * known", rather than carrying a number that silently drifts away from truth
 * while the hand sits still.
 */
import type { GloveSide } from '../ble/types';
import type { FlexReading, SensorSample } from '../sensors/types';
import { FLEX_CHANNEL_COUNT } from '../sensors/types';

/** Where a pose came from. Never inferred at the point of display. */
export type PoseSource = 'real' | 'simulated' | 'none';

export interface WristOrientation {
  /**
   * Tilt forward/back, in radians, derived from the accelerometer.
   *
   * Uncalibrated: accelerometer bias and scale are not corrected anywhere in
   * this app yet (see `sensors/calibration.ts`), so this is an estimate from
   * raw counts, not a measurement.
   */
  readonly pitch: number | null;
  /** Tilt left/right, in radians. Same caveats as `pitch`. */
  readonly roll: number | null;
  /**
   * Rotation about the vertical axis.
   *
   * Always `null` on this hardware — see the note at the top of this file.
   * When a magnetometer or an external reference exists, this becomes a
   * `number` and every consumer already handles it.
   */
  readonly yaw: number | null;
}

export interface HandPose {
  readonly side: GloveSide;
  /** Five bends, 0 = extended, 1 = fully flexed. Order is `FINGERS`. */
  readonly fingers: FlexReading;
  readonly wrist: WristOrientation;
  readonly source: PoseSource;
  readonly timestampMs: number;
  /**
   * Model confidence in 0..1, or null.
   *
   * Null means "not measured" — never "low". A renderer must not draw a
   * confidence bar for a pose whose confidence is null, because there is no
   * number behind it.
   */
  readonly confidence: number | null;
}

/**
 * Smoothing and neutral reference for a pose stream.
 *
 * `alpha` is the EMA weight for a new sample. The defaults are tuned for the
 * viewer, not for recognition: a renderer wants to look calm, whereas a
 * classifier wants to preserve fast transitions that may be phonemic.
 */
export interface PoseSmoothing {
  readonly alpha: number;
}

export interface NeutralPose {
  readonly fingers: FlexReading;
  readonly wrist: WristOrientation;
  readonly pitchSign?: 1 | -1;
  readonly rollSign?: 1 | -1;
}

export const RESTING_POSE: NeutralPose = {
  fingers: [0, 0, 0, 0, 0],
  wrist: { pitch: 0, roll: 0, yaw: null },
  pitchSign: 1,
  rollSign: 1,
};

/**
 * Default neutral pose for each glove calibrated against observed hardware resting baseline.
 */
export function createDefaultNeutralPose(side: GloveSide): NeutralPose {
  if (side === 'left') {
    // Left glove MPU6050 inverted on dorsal strap (AccZ negative ~ -15500, roll ~ -164 deg / -2.86 rad)
    return {
      fingers: [0, 0, 0, 0, 0],
      wrist: { pitch: -0.02, roll: -2.86, yaw: null },
      pitchSign: 1,
      rollSign: 1,
    };
  }
  // Right glove MPU6050 normal on dorsal strap (AccZ positive ~ +17200, roll ~ +11.8 deg / +0.20 rad)
  return {
    fingers: [0, 0, 0, 0, 0],
    wrist: { pitch: 0.04, roll: 0.20, yaw: null },
    pitchSign: 1,
    rollSign: 1,
  };
}

export const DEFAULT_SMOOTHING: PoseSmoothing = { alpha: 0.28 };

/** A pose with no data behind it. Renders as a relaxed hand, labelled `none`. */
export function emptyPose(side: GloveSide): HandPose {
  return {
    side,
    fingers: [0, 0, 0, 0, 0],
    wrist: { pitch: null, roll: null, yaw: null },
    source: 'none',
    timestampMs: 0,
    confidence: null,
  };
}

/**
 * Estimate wrist tilt from an accelerometer reading.
 *
 * Standard gravity-referenced tilt:
 *
 *   pitch = atan2(-x, √(y² + z²))
 *   roll  = atan2(y, z)
 *
 * The axis conventions here are the *glove frame* and are **not verified**
 * against hardware — no glove has been instrumented, so the sign of each axis
 * is an assumption that must be confirmed on real hardware. When it is, this
 * function is the single place that changes.
 */
export function tiltFromAccelerometer(accel: {
  x: number;
  y: number;
  z: number;
}): { pitch: number; roll: number } {
  const { x, y, z } = accel;
  const pitch = Math.atan2(-x, Math.sqrt(y * y + z * z));
  const roll = Math.atan2(y, z);
  return { pitch, roll };
}

/**
 * Normalizes an angular difference to the range [-pi, pi].
 * Prevents discontinuity/jumps when subtracting angles near the +/-pi boundary.
 */
export function normalizeAngleDifference(angle: number, reference: number): number {
  let diff = angle - reference;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

export interface PoseMapper {
  /** Converts a sample into a pose, applying smoothing and neutral offset. */
  map(sample: SensorSample, source: PoseSource): HandPose;
  reset(): void;
}

/**
 * Builds a stateful mapper.
 *
 * Stateful because smoothing is: each pose depends on the last. The mapper is
 * therefore created per glove, and reset when a link closes so that stale
 * state from a previous session cannot bleed into a new one.
 */
export function createPoseMapper(
  side: GloveSide,
  options: { smoothing?: PoseSmoothing; neutral?: NeutralPose } = {},
): PoseMapper {
  const alpha = options.smoothing?.alpha ?? DEFAULT_SMOOTHING.alpha;
  if (!(alpha > 0 && alpha <= 1)) {
    throw new RangeError(`smoothing alpha must be in (0, 1], received ${alpha}`);
  }
  const neutral = options.neutral ?? RESTING_POSE;

  let state: FlexReading | null = null;

  return {
    map(sample, source) {
      const raw = sample.flex;

      if (state === null) {
        state = clampReading(raw, neutral.fingers);
      } else {
        const previous = state;
        state = [
          previous[0] + alpha * (raw[0] - previous[0]),
          previous[1] + alpha * (raw[1] - previous[1]),
          previous[2] + alpha * (raw[2] - previous[2]),
          previous[3] + alpha * (raw[3] - previous[3]),
          previous[4] + alpha * (raw[4] - previous[4]),
        ];
      }

      const tilt = tiltFromAccelerometer(sample.accel);
      const pitchSign = neutral.pitchSign ?? 1;
      const rollSign = neutral.rollSign ?? 1;

      return {
        side,
        fingers: state,
        wrist: {
          pitch: pitchSign * (tilt.pitch - (neutral.wrist.pitch ?? 0)),
          roll: rollSign * normalizeAngleDifference(tilt.roll, neutral.wrist.roll ?? 0),
          yaw: null,
        },
        source,
        timestampMs: sample.timestampMs,
        // No model exists, so no pose can carry a confidence.
        confidence: null,
      };
    },

    reset() {
      state = null;
    },
  };
}

function clampReading(flex: FlexReading, neutral: FlexReading): FlexReading {
  return [
    clamp01(flex[0] - neutral[0]),
    clamp01(flex[1] - neutral[1]),
    clamp01(flex[2] - neutral[2]),
    clamp01(flex[3] - neutral[3]),
    clamp01(flex[4] - neutral[4]),
  ] as FlexReading;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Number of joints the viewer is expected to articulate, for assertions. */
export const POSE_CHANNEL_COUNT = FLEX_CHANNEL_COUNT;
