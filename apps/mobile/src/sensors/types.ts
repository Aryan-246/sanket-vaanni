/**
 * Physical units carried between modules.
 *
 * `RawSample` is what a transport produces: uncalibrated, un-normalised, in
 * whatever units the transport can justify.
 *
 * `SensorSample` is what the processing stage produces: calibration applied,
 * flex normalised to 0..1. Downstream code — recognition, UI — only ever sees
 * `SensorSample`, so a change in raw units cannot leak past calibration.
 */
import type { GloveSide } from '../ble/types';

export type { GloveSide };

/** The five instrumented fingers, in fixed order. Order is meaningful. */
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type Finger = (typeof FINGERS)[number];

/** Number of flex channels per glove. */
export const FLEX_CHANNEL_COUNT = FINGERS.length;

/** Ordered flex readings: thumb, index, middle, ring, pinky. */
export type FlexReading = [number, number, number, number, number];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Uncalibrated reading straight from a transport.
 *
 * Flex values are raw and their scale is transport-defined — the mock
 * transport uses 0..1, real hardware will likely use ADC counts. Nothing
 * downstream of calibration may assume a particular raw scale.
 */
export interface RawSample {
  side: GloveSide;
  timestampMs: number;
  /** Raw flex channel values, order = FINGERS. */
  flex: FlexReading;
  /** Acceleration in m/s², glove frame. */
  accel: Vec3;
  /** Angular rate in rad/s, glove frame. */
  gyro: Vec3;
}

/** A reading with calibration applied and flex normalised to 0..1. */
export interface SensorSample {
  side: GloveSide;
  timestampMs: number;
  /** 0 = relaxed/extended, 1 = fully flexed. */
  flex: FlexReading;
  accel: Vec3;
  gyro: Vec3;
}
