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

function assertUsable(profile: CalibrationProfile): void {
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
    normalise(raw.flex[0], profile.channels[0] as ChannelCalibration),
    normalise(raw.flex[1], profile.channels[1] as ChannelCalibration),
    normalise(raw.flex[2], profile.channels[2] as ChannelCalibration),
    normalise(raw.flex[3], profile.channels[3] as ChannelCalibration),
    normalise(raw.flex[4], profile.channels[4] as ChannelCalibration),
  ];

  return {
    side: raw.side,
    timestampMs: raw.timestampMs,
    flex,
    // The IMU needs its own calibration (bias/scale), which is not implemented.
    // Values pass through unchanged rather than being silently "corrected".
    accel: raw.accel,
    gyro: raw.gyro,
  };
}
