/**
 * Turning a continuous glove stream into windows a model can consume.
 *
 * ## Why resampling rather than "take 30 frames"
 *
 * A window has to mean the same thing in every sample, or the dataset is a
 * collection of differently-shaped measurements wearing a uniform label. The
 * Demo Mode transport emits at a fixed 20 Hz, but a real glove's notification
 * rate depends on connection parameters and on how busy the phone is, so a
 * 30-frame window captured at whatever rate the packets happened to arrive at
 * would cover an unknown duration — and two recordings of the same sign would
 * disagree in time even when they agree in shape.
 *
 * Resampling to a fixed frame count over the window's own duration fixes the
 * *shape* of the window instead of its frame rate: 30 points spanning however
 * long the capture lasted. Linear interpolation between real frames invents no
 * values that were not already on the line between two measurements, and the
 * quality record keeps the true frame count and the largest gap so a thinly
 * sampled window is visible rather than silently smoothed.
 *
 * ## What is refused rather than repaired
 *
 * A window with too few frames, a gap where the connection dropped, or flex
 * values outside 0..1 after calibration is refused, with a reason. Interpolating
 * across a dropout would produce a window that looks continuous and is not —
 * the exact artefact that teaches a model something the glove never did.
 */
import type { SensorSample } from '../sensors/types';
import { FLEX_CHANNEL_COUNT } from '../sensors/types';
import {
  WINDOW_FRAMES,
  type FrameVector,
  type SampleQuality,
} from './types';

/** Fewest real frames a window may be built from. */
export const MIN_SOURCE_FRAMES = 8;

/** Largest gap between consecutive frames before the window is refused, ms. */
export const MAX_GAP_MS = 250;

/** A channel whose spread is below this never moved, to three decimals. */
const FLAT_SPREAD = 1e-3;

/** Flex values are clamped by calibration, so a small overshoot is tolerated. */
const RANGE_TOLERANCE = 0.01;

/** Why a window could not be built. Stable codes, so callers can switch on them. */
export type WindowFailure =
  | 'too-few-frames'
  | 'flat-duration'
  | 'gap-too-large';

export type WindowBuild =
  | {
      readonly ok: true;
      readonly frames: readonly FrameVector[];
      readonly quality: SampleQuality;
    }
  | {
      readonly ok: false;
      readonly code: WindowFailure;
      /** A sentence for the user, in the same voice as the rest of the app. */
      readonly reason: string;
    };

/** Linear interpolation of one channel at a fractional position. */
function interpolate(values: readonly number[], position: number): number {
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, values.length - 1);
  if (lower === upper) return values[lower] ?? 0;
  const weight = position - lower;
  return (values[lower] ?? 0) * (1 - weight) + (values[upper] ?? 0) * weight;
}

/** Population standard deviation. Zero for a single value. */
function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Builds one fixed-length window from a run of calibrated samples.
 *
 * The samples are not required to be sorted or evenly spaced; they are sorted
 * here so that the result depends on when each frame happened rather than on
 * the order a subscriber happened to see them in.
 */
export function buildWindow(
  samples: readonly SensorSample[],
  options: { readonly frames?: number; readonly maxGapMs?: number } = {},
): WindowBuild {
  const targetFrames = options.frames ?? WINDOW_FRAMES;
  const maxGapMs = options.maxGapMs ?? MAX_GAP_MS;

  if (samples.length < MIN_SOURCE_FRAMES) {
    return {
      ok: false,
      code: 'too-few-frames',
      reason: `A window needs at least ${MIN_SOURCE_FRAMES} readings and this capture produced ${samples.length}.`,
    };
  }

  const ordered = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);
  const startMs = ordered[0]!.timestampMs;
  const endMs = ordered[ordered.length - 1]!.timestampMs;
  const spanMs = endMs - startMs;

  if (spanMs <= 0) {
    return {
      ok: false,
      code: 'flat-duration',
      reason: 'Every reading carried the same timestamp, so the window has no duration to describe.',
    };
  }

  let observedMaxGap = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = ordered[index]!.timestampMs - ordered[index - 1]!.timestampMs;
    if (gap > observedMaxGap) observedMaxGap = gap;
  }

  if (observedMaxGap > maxGapMs) {
    return {
      ok: false,
      code: 'gap-too-large',
      reason: `The stream stopped for ${Math.round(observedMaxGap)} ms while this was being recorded, which is longer than the ${maxGapMs} ms a window can span.`,
    };
  }

  /*
   * Channel-major arrays, because resampling reads each channel independently
   * and rebuilding them per frame in the loop below would be the same work
   * several times over.
   */
  const channelCount = FLEX_CHANNEL_COUNT + 6;
  const channelValues: number[][] = Array.from({ length: channelCount }, () => []);

  for (const sample of ordered) {
    const channels = [
      sample.flex[0], sample.flex[1], sample.flex[2], sample.flex[3], sample.flex[4],
      sample.accel.x, sample.accel.y, sample.accel.z,
      sample.gyro.x, sample.gyro.y, sample.gyro.z,
    ];
    for (let channel = 0; channel < channelCount; channel += 1) {
      channelValues[channel]!.push(channels[channel]!);
    }
  }

  const frames: FrameVector[] = [];
  for (let index = 0; index < targetFrames; index += 1) {
    // The last frame lands exactly on the end, so the window covers the span
    // rather than stopping one step short of it.
    const tMs = (spanMs * index) / (targetFrames - 1);
    const position = (tMs / spanMs) * (ordered.length - 1);
    const read = (channel: number) => interpolate(channelValues[channel]!, position);

    frames.push({
      tMs: Math.round(tMs),
      flex: [read(0), read(1), read(2), read(3), read(4)],
      a: [read(5), read(6), read(7)],
      g: [read(8), read(9), read(10)],
    });
  }

  const flatChannels: number[] = [];
  const outOfRangeChannels: number[] = [];
  for (let channel = 0; channel < FLEX_CHANNEL_COUNT; channel += 1) {
    const values = channelValues[channel]!;
    if (spread(values) < FLAT_SPREAD) flatChannels.push(channel);
    if (values.some((value) => value < -RANGE_TOLERANCE || value > 1 + RANGE_TOLERANCE)) {
      outOfRangeChannels.push(channel);
    }
  }

  /*
   * Every flex channel dead flat is not a still hand — it is a stream that is
   * not moving at all, which is what a frozen sensor or a stuck mux channel
   * looks like. One or two flat channels is an ordinary static pose.
   */
  const frozen = flatChannels.length === FLEX_CHANNEL_COUNT;

  const quality: SampleQuality = {
    expectedFrames: targetFrames,
    frameCount: ordered.length,
    maxGapMs: Math.round(observedMaxGap),
    flatChannels,
    outOfRangeChannels,
    ok: !frozen && outOfRangeChannels.length === 0,
  };

  return { ok: true, frames, quality };
}

/**
 * How a window's quality reads to a person, or null when there is nothing to
 * say. Kept here rather than in a screen so the wording is testable.
 */
export function qualityNote(quality: SampleQuality): string | null {
  if (quality.outOfRangeChannels.length > 0) {
    return `${quality.outOfRangeChannels.length} flex channel${quality.outOfRangeChannels.length === 1 ? '' : 's'} left the calibrated range. Recalibrate the glove before recording more.`;
  }
  if (quality.flatChannels.length === FLEX_CHANNEL_COUNT) {
    return 'No flex channel changed at all during this window, which is what a stopped stream looks like rather than a held hand.';
  }
  if (quality.frameCount < WINDOW_FRAMES) {
    return `${quality.frameCount} readings were spread across the window. The shape is right; the detail between them is interpolated.`;
  }
  return null;
}
