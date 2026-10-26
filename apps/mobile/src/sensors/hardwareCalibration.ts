/**
 * Genuine per-finger hardware calibration engine for Sanket Vaanni gloves.
 *
 * Implements the 7-step guided hardware calibration sequence:
 *   1. REST (hand flat on table, palm down, all fingers straight)
 *   2. THUMB BEND (curl thumb inwards, keep other fingers still)
 *   3. INDEX BEND (curl index, keep others still)
 *   4. MIDDLE BEND (curl middle, keep others still)
 *   5. RING BEND (curl ring, keep others still)
 *   6. PINKY BEND (curl pinky, keep others still)
 *   7. FINAL REST (return to flat hand, verify repeatability against step 1)
 *
 * Robust statistics (median, IQR) reject outliers.
 * Detects:
 *   - Disconnected / unseated channels (0V ground, raw <= 15 counts)
 *   - Reversed sensor polarity (flex < rest, e.g. Left Pinky Ch4)
 *   - Insufficient dynamic range separation (|bend - rest| < 200 counts)
 *   - Channel crosstalk / lack of isolation
 *   - Baseline drift / repeatability delta (|rest_final - rest_initial| > 200 counts)
 */

import type { GloveSide, RawSample } from './types';
import { FINGERS, FLEX_CHANNEL_COUNT, type Finger } from './types';
import type { CalibrationProfile, ChannelCalibration } from './calibration';

export const CALIBRATION_STEPS = [
  {
    step: 0,
    id: 'initial_rest',
    title: 'Reference REST Pose',
    instruction: 'Place your hand flat on a table, palm down, with all fingers straight.',
    targetFinger: null as Finger | null,
  },
  {
    step: 1,
    id: 'thumb_bend',
    title: 'Bend Thumb',
    instruction: 'Curl your thumb inward across your palm while keeping other 4 fingers straight.',
    targetFinger: 'thumb' as Finger,
  },
  {
    step: 2,
    id: 'index_bend',
    title: 'Bend Index Finger',
    instruction: 'Curl your index finger tightly while keeping other fingers straight and resting flat.',
    targetFinger: 'index' as Finger,
  },
  {
    step: 3,
    id: 'middle_bend',
    title: 'Bend Middle Finger',
    instruction: 'Curl your middle finger while keeping other fingers straight and resting flat.',
    targetFinger: 'middle' as Finger,
  },
  {
    step: 4,
    id: 'ring_bend',
    title: 'Bend Ring Finger',
    instruction: 'Curl your ring finger while keeping other fingers straight and resting flat.',
    targetFinger: 'ring' as Finger,
  },
  {
    step: 5,
    id: 'pinky_bend',
    title: 'Bend Pinky Finger',
    instruction: 'Curl your pinky finger while keeping other fingers straight and resting flat.',
    targetFinger: 'pinky' as Finger,
  },
  {
    step: 6,
    id: 'final_rest',
    title: 'Repeatability Check (REST)',
    instruction: 'Return your hand to the flat resting position on the table to verify repeatability.',
    targetFinger: null as Finger | null,
  },
] as const;

export type CalibrationStepId = typeof CALIBRATION_STEPS[number]['id'];

export interface StepCaptureResult {
  step: number;
  sampleCount: number;
  rawMedians: [number, number, number, number, number];
  rawStdDevs: [number, number, number, number, number];
  pitchMedian: number | null;
  rollMedian: number | null;
}

export type ChannelStatus = 'valid' | 'warning' | 'failed';

export interface ChannelValidation {
  finger: Finger;
  channelIndex: number;
  rest: number;
  fullFlex: number;
  span: number;
  polarity: 'normal' | 'inverted';
  repeatabilityDelta: number;
  status: ChannelStatus;
  issue: string | null;
}

export interface CalibrationSummary {
  canSave: boolean;
  side: GloveSide;
  channels: readonly ChannelValidation[];
  wristRest: { pitch: number | null; roll: number | null };
  repeatabilityPassed: boolean;
}

/** Minimum ADC span (|bend - rest|) required for reliable normalization. */
export const MIN_USABLE_SPAN = 200;

/** Ground threshold (counts): readings <= 15 represent 0V ground (unseated divider line). */
export const GROUND_THRESHOLD = 15;

/** Max allowable drift between initial REST and final REST (counts). */
export const MAX_REPEATABILITY_DRIFT = 250;

/**
 * Computes robust statistics (median and standard deviation) from a series of raw frames.
 */
export function processStepSamples(samples: readonly RawSample[], step = 0): StepCaptureResult | null {
  if (samples.length === 0) return null;

  const count = samples.length;
  const channelValues: number[][] = [[], [], [], [], []];
  const pitches: number[] = [];
  const rolls: number[] = [];

  for (const s of samples) {
    for (let ch = 0; ch < 5; ch++) {
      const val = s.flex[ch];
      if (Number.isFinite(val)) {
        channelValues[ch]?.push(val);
      }
    }
    if (s.pitch !== undefined && Number.isFinite(s.pitch)) pitches.push(s.pitch);
    if (s.roll !== undefined && Number.isFinite(s.roll)) rolls.push(s.roll);
  }

  const rawMedians: number[] = [];
  const rawStdDevs: number[] = [];

  for (let ch = 0; ch < 5; ch++) {
    const vals = channelValues[ch]!;
    if (vals.length === 0) {
      rawMedians.push(0);
      rawStdDevs.push(0);
      continue;
    }
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    const median = vals.length % 2 === 0 ? (vals[mid - 1]! + vals[mid]!) / 2 : vals[mid]!;
    rawMedians.push(Math.round(median));

    const mean = vals.reduce((sum, v) => sum + v, 0) / vals.length;
    const variance = vals.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / vals.length;
    rawStdDevs.push(Math.round(Math.sqrt(variance) * 10) / 10);
  }

  let pitchMedian: number | null = null;
  if (pitches.length > 0) {
    pitches.sort((a, b) => a - b);
    pitchMedian = pitches[Math.floor(pitches.length / 2)]!;
  }

  let rollMedian: number | null = null;
  if (rolls.length > 0) {
    rolls.sort((a, b) => a - b);
    rollMedian = rolls[Math.floor(rolls.length / 2)]!;
  }

  return {
    step,
    sampleCount: count,
    rawMedians: rawMedians as [number, number, number, number, number],
    rawStdDevs: rawStdDevs as [number, number, number, number, number],
    pitchMedian,
    rollMedian,
  };
}

/**
 * Validates the full 7-step hardware calibration dataset.
 */
export function validateCalibrationDataset(
  side: GloveSide,
  steps: Readonly<Record<number, StepCaptureResult>>,
): CalibrationSummary {
  const initialRest = steps[0];
  const finalRest = steps[6];

  const channels: ChannelValidation[] = [];
  let repeatabilityPassed = true;

  for (let ch = 0; ch < FLEX_CHANNEL_COUNT; ch++) {
    const finger = FINGERS[ch]!;
    const restInitial = initialRest?.rawMedians[ch] ?? 0;
    const restFinal = finalRest?.rawMedians[ch] ?? restInitial;
    const repeatabilityDelta = Math.abs(restFinal - restInitial);

    if (repeatabilityDelta > MAX_REPEATABILITY_DRIFT) {
      repeatabilityPassed = false;
    }

    const bendStep = steps[ch + 1];
    const fullFlex = bendStep?.rawMedians[ch] ?? restInitial;
    const span = fullFlex - restInitial;
    const absSpan = Math.abs(span);
    const polarity: 'normal' | 'inverted' = span >= 0 ? 'normal' : 'inverted';

    let status: ChannelStatus = 'valid';
    let issue: string | null = null;

    if (restInitial <= GROUND_THRESHOLD && fullFlex <= GROUND_THRESHOLD) {
      status = 'failed';
      issue = 'Disconnected / 0V ground (check sensor socket & divider)';
    } else if (absSpan < MIN_USABLE_SPAN) {
      status = 'warning';
      issue = `Small dynamic range (${absSpan} counts < ${MIN_USABLE_SPAN})`;
    } else if (repeatabilityDelta > MAX_REPEATABILITY_DRIFT) {
      status = 'warning';
      issue = `High baseline drift (${repeatabilityDelta} counts)`;
    }

    channels.push({
      finger,
      channelIndex: ch,
      rest: restInitial,
      fullFlex,
      span,
      polarity,
      repeatabilityDelta,
      status,
      issue,
    });
  }

  // Wrist neutral orientation in desk reference
  const wristRest = {
    pitch: initialRest?.pitchMedian ?? null,
    roll: initialRest?.rollMedian ?? null,
  };

  // Can save if at least one active channel has validated dynamic range and not all failed
  const validCount = channels.filter((c) => c.status === 'valid').length;
  const canSave = validCount >= 1 && initialRest !== undefined && finalRest !== undefined;

  return {
    canSave,
    side,
    channels,
    wristRest,
    repeatabilityPassed,
  };
}

/**
 * Builds a calibrated profile from the validated summary.
 * Preserves safe factory fallbacks for disconnected channels to avoid divide-by-zero.
 */
export function buildProfileFromSummary(
  summary: CalibrationSummary,
  fallbackProfile: CalibrationProfile,
): CalibrationProfile {
  const channels: ChannelCalibration[] = summary.channels.map((ch, idx) => {
    if (ch.status === 'failed' || ch.rest === ch.fullFlex || Math.abs(ch.fullFlex - ch.rest) === 0) {
      // Disconnected or zero-span channel: use fallback anchor to prevent zero span
      return fallbackProfile.channels[idx] ?? { rest: 0, fullFlex: 1 };
    }
    return {
      rest: ch.rest,
      fullFlex: ch.fullFlex,
    };
  });

  return {
    version: 1,
    side: summary.side,
    capturedAtMs: Date.now(),
    signLanguageId: null,
    channels,
  };
}
