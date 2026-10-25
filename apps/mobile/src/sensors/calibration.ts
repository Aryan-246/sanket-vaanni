/**
 * Per-glove calibration.
 *
 * Flex sensors vary between units and between wearers, so raw channel values
 * are meaningless until anchored to two observed poses: a relaxed hand and a
 * fully flexed finger. Calibration records those anchors so raw values can be
 * normalised to 0..1.
 *
 * ## Status
 *
 * The *mechanism* is implemented and tested against synthetic anchors. The
 * *capture flow* — the guided rest/flex poses — arrives in milestone M3, and
 * real anchors can only be captured with gloves in hand.
 *
 * ## Language association
 *
 * Whether calibration should be per-sign-language (because different signing
 * styles produce different flexion ranges) is an **open question**. It is not
 * assumed here: a profile carries an optional `signLanguageId`, and nothing
 * branches on it. Measuring this needs real signers.
 */
import type { FlexReading, GloveSide, RawSample, SensorSample } from './types';
import { FLEX_CHANNEL_COUNT } from './types';

/** Raw anchor values for one flex channel. */
export interface ChannelCalibration {
  /** Raw value observed with the finger relaxed. */
  readonly rest: number;
  /** Raw value observed with the finger fully flexed. */
  readonly fullFlex: number;
}

export interface CalibrationProfile {
  readonly version: 1;
  readonly side: GloveSide;
  /** When the anchors were captured, epoch ms. */
  readonly capturedAtMs: number;
  /**
   * Optional association. `null` means the profile applies regardless of
   * language, which is the current default because the question is unmeasured.
   */
  readonly signLanguageId: string | null;
  /** Exactly `FLEX_CHANNEL_COUNT` entries, in FINGERS order. */
  readonly channels: readonly ChannelCalibration[];
}

export class CalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibrationError';
  }
}

/**
 * A neutral profile for the demo transport, whose raw flex values are already
 * 0..1 by construction.
 *
 * This is NOT a usable calibration for real hardware — real ADC values will
 * need a real capture. The name says so to make misuse obvious.
 */
export function createDemoCalibration(side: GloveSide): CalibrationProfile {
  return {
    version: 1,
    side,
    capturedAtMs: 0,
    signLanguageId: null,
    channels: Array.from({ length: FLEX_CHANNEL_COUNT }, () => ({
      rest: 0,
      fullFlex: 1,
    })),
  };
}

/**
 * Hardware factory calibration anchors measured empirically on Left Glove V11
 * (ESP32-S3 + ADS1115 + CD74HC4051 multiplexer, 283 continuous live telemetry
 * samples across rest, fist, and isolated finger flexion).
 *
 * Ch0 (Thumb):  rest=1800, fullFlex=5120 (positive span +3320)
 * Ch1 (Index):  rest=1860, fullFlex=5836 (positive span +3976)
 * Ch2 (Middle): rest=290,  fullFlex=780  (positive span +490)
 * Ch3 (Ring):   rest=340,  fullFlex=1088 (positive span +748)
 * Ch4 (Pinky):  rest=1960, fullFlex=990  (inverted span -970)
 */
export function createHardwareDefaultCalibration(side: GloveSide): CalibrationProfile {
  if (side === 'left') {
    return {
      version: 1,
      side: 'left',
      capturedAtMs: 1792858186000,
      signLanguageId: null,
      channels: [
        { rest: 550,  fullFlex: 5120 }, // Thumb (Ch0: relaxed rest 550, flat table 5040, clench 5120)
        { rest: 1860, fullFlex: 5836 }, // Index (Ch1: rest 1860, clench 5836)
        { rest: 290,  fullFlex: 520 },  // Middle (Ch2: rest 290, isolated curl 520, clench 780)
        { rest: 340,  fullFlex: 1088 }, // Ring (Ch3: rest 340, curl/clench 1088)
        { rest: 1960, fullFlex: 990 },  // Pinky (Ch4: inverted wiring, rest 1960, curl 990)
      ],
    };
  }
  return {
    version: 1,
    side: 'right',
    capturedAtMs: 1792858186000,
    signLanguageId: null,
    channels: [
      { rest: 2085, fullFlex: 5120 }, // Thumb (Ch0: rest ~2085, clench ~5120)
      { rest: 2885, fullFlex: 5800 }, // Index (Ch1: rest ~2885, clench ~5800)
      { rest: 3390, fullFlex: 5800 }, // Middle (Ch2: rest ~3390, clench ~5800)
      { rest: 4914, fullFlex: 6200 }, // Ring (Ch3: rest ~4914, clench ~6200)
      { rest: 3342, fullFlex: 5200 }, // Pinky (Ch4: rest ~3342, clench ~5200)
    ],
  };
}

export function isCalibrationUsable(profile: CalibrationProfile | null | undefined): boolean {
  if (!profile || !Array.isArray(profile.channels) || profile.channels.length !== FLEX_CHANNEL_COUNT) {
    return false;
  }
  return profile.channels.every(
    (channel) =>
      channel &&
      typeof channel.rest === 'number' &&
      typeof channel.fullFlex === 'number' &&
      Number.isFinite(channel.rest) &&
      Number.isFinite(channel.fullFlex) &&
      channel.fullFlex !== channel.rest,
  );
}

export function assertUsable(profile: CalibrationProfile): void {
  if (profile.channels.length !== FLEX_CHANNEL_COUNT) {
    throw new CalibrationError(
      `Calibration must have ${FLEX_CHANNEL_COUNT} channels, got ${profile.channels.length}`,
    );
  }
  profile.channels.forEach((channel, index) => {
    if (channel.fullFlex === channel.rest) {
      throw new CalibrationError(
        `Channel ${index} has identical rest and full-flex anchors ` +
          `(${channel.rest}); it cannot be normalised. Re-capture the pose.`,
      );
    }
  });
}

function normalise(value: number, channel: ChannelCalibration): number {
  const span = channel.fullFlex - channel.rest;
  if (span === 0) return 0;
  const ratio = (value - channel.rest) / span;
  const clamped = Math.min(1, Math.max(0, ratio));
  // The anchor could have been captured inverted (full flex reading lower than
  // rest), which is possible depending on wiring. Normalising by the signed
  // span handles that without a special case.
  return Number.isFinite(clamped) ? clamped : 0;
}

/** Applies calibration, producing a normalised sample. */
export function applyCalibration(
  raw: RawSample,
  profile: CalibrationProfile,
): SensorSample {
  if (raw.side !== profile.side) {
    throw new CalibrationError(
      `Calibration is for the ${profile.side} glove but the sample is from the ${raw.side} glove`,
    );
  }
  assertUsable(profile);

  const flex: FlexReading = [
    normalise(raw.flex[0], profile.channels[0]),
    normalise(raw.flex[1], profile.channels[1]),
    normalise(raw.flex[2], profile.channels[2]),
    normalise(raw.flex[3], profile.channels[3]),
    normalise(raw.flex[4], profile.channels[4]),
  ];

  return {
    side: raw.side,
    timestampMs: raw.timestampMs,
    flex,
    // The IMU needs its own calibration (bias/scale), which is not implemented.
    // Values pass through unchanged rather than being silently "corrected".
    accel: raw.accel,
    gyro: raw.gyro,
    battery_v: raw.battery_v,
    battery_pin_v: raw.battery_pin_v,
    battery_pct: raw.battery_pct,
    imu_temp_c: raw.imu_temp_c,
    pitch: raw.pitch,
    roll: raw.roll,
  };
}
