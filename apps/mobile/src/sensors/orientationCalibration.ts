/**
 * 3D Hand Physical Orientation Calibration Engine for Sanket Vaanni.
 *
 * Implements the 6-step guided physical orientation calibration sequence:
 *   1. Palm-down reference: hand flat on surface, palm down, back facing upward.
 *   2. Palm-up reference: forearm rotated so palm faces upward.
 *   3. Palm-facing reference: hand lifted vertically, palm facing camera/observer.
 *   4. Side-facing reference: hand on side, thumb pointing upward.
 *   5. Opposite-side reference: hand rotated to the opposite side.
 *   6. Return to REST: reproduce original palm-down posture for repeatability check.
 *
 * Establishes model-to-sensor axis alignment, neutral orientation baseline,
 * and relative motion mapping.
 *
 * Note: MPU6050 has no magnetometer; yaw cannot be measured absolutely and is
 * treated as relative/unmeasurable.
 */

import type { GloveSide, RawSample } from './types';

export interface OrientationStepConfig {
  readonly step: number;
  readonly id: string;
  readonly title: string;
  readonly hindiTitle: string;
  readonly instruction: string;
  readonly hindiInstruction: string;
  readonly targetPose: 'palm_down' | 'palm_up' | 'palm_facing' | 'thumb_up' | 'pinky_up';
}

export const ORIENTATION_STEPS: readonly OrientationStepConfig[] = [
  {
    step: 0,
    id: 'palm_down_rest',
    title: '1. Palm-down reference (REST)',
    hindiTitle: '1. हथेली नीचे (समतल विश्राम)',
    instruction:
      'Place the gloved hand flat on a surface, with the palm side against the surface and the back of the hand facing upward. Keep the fingers comfortably straight.',
    hindiInstruction:
      'दस्ताने वाले हाथ को समतल सतह पर रखें, हथेली नीचे की ओर और हाथ का पिछला भाग ऊपर हो। अंगुलियों को सीधा रखें।',
    targetPose: 'palm_down',
  },
  {
    step: 1,
    id: 'palm_up',
    title: '2. Palm-up reference',
    hindiTitle: '2. हथेली ऊपर',
    instruction: 'Rotate your forearm so your palm faces directly upward towards the ceiling.',
    hindiInstruction: 'अपनी कलाई को घुमाएं ताकि हथेली ऊपर की ओर हो जाए।',
    targetPose: 'palm_up',
  },
  {
    step: 2,
    id: 'palm_facing',
    title: '3. Palm-facing reference',
    hindiTitle: '3. हथेली सामने (स्क्रीन की ओर)',
    instruction:
      'Lift and orient your hand vertically so your palm faces directly towards you and the screen.',
    hindiInstruction: 'हाथ को सीधा उठाएं ताकि हथेली आपकी ओर सामने दिखे।',
    targetPose: 'palm_facing',
  },
  {
    step: 3,
    id: 'side_facing',
    title: '4. Side-facing reference',
    hindiTitle: '4. करवट स्थिति (अंगूठा ऊपर)',
    instruction:
      'Orient your hand onto its side so the thumb side is pointing clearly upward.',
    hindiInstruction: 'हाथ को करवट पर रखें ताकि अंगूठा ऊपर की ओर रहे।',
    targetPose: 'thumb_up',
  },
  {
    step: 4,
    id: 'opposite_side',
    title: '5. Opposite-side reference',
    hindiTitle: '5. विपरीत करवट स्थिति',
    instruction:
      'Rotate your hand onto its opposite edge relative to your body.',
    hindiInstruction: 'हाथ को विपरीत करवट पर घुमाएं।',
    targetPose: 'pinky_up',
  },
  {
    step: 5,
    id: 'final_rest',
    title: '6. Return to REST',
    hindiTitle: '6. पुनः समतल विश्राम',
    instruction:
      'Reproduce the original palm-down surface posture to check that the recorded reference can be recovered.',
    hindiInstruction:
      'पुनः पहली वाली समतल स्थिति (हथेली नीचे) में लौटें ताकि स्थिरता और पुनरावृत्ति जांची जा सके।',
    targetPose: 'palm_down',
  },
] as const;

export type OrientationStepId = typeof ORIENTATION_STEPS[number]['id'];

export interface OrientationCaptureResult {
  readonly step: number;
  readonly sampleCount: number;
  readonly pitchMedian: number;
  readonly rollMedian: number;
  readonly accelMedian: { readonly x: number; readonly y: number; readonly z: number };
  readonly gyroMedian: { readonly x: number; readonly y: number; readonly z: number };
  readonly flexMedians: readonly [number, number, number, number, number];
  readonly pitchStdDev: number;
  readonly rollStdDev: number;
  readonly stabilityScore: number; // 0..100
  readonly capturedAtMs: number;
}

export interface OrientationCalibrationProfile {
  readonly version: 1;
  readonly side: GloveSide;
  readonly capturedAtMs: number;
  /** Resting baseline pitch (degrees). */
  readonly restPitch: number;
  /** Resting baseline roll (degrees). */
  readonly restRoll: number;
  /** Resting accelerometer counts. */
  readonly restAccel: { readonly x: number; readonly y: number; readonly z: number };
  /** Multiplier for pitch tilt direction (1 or -1). */
  readonly pitchSign: 1 | -1;
  /** Multiplier for roll tilt direction (1 or -1). */
  readonly rollSign: 1 | -1;
  /** Repeatability drift between Step 0 and Step 5 (degrees). */
  readonly repeatabilityDriftDeg: number;
  readonly repeatabilityPassed: boolean;
  readonly quality: 'optimal' | 'acceptable' | 'degraded';
  /** Per-step capture snapshots for audit. */
  readonly steps: Readonly<Record<number, OrientationCaptureResult>>;
}

/** Minimum number of valid samples required to capture a pose. */
export const MIN_ORIENTATION_SAMPLES = 10;

/** Maximum allowable gyro noise (counts) for a pose to be considered stable. */
export const MAX_STABLE_GYRO_NOISE = 1200;

/** Maximum allowable repeatability drift (degrees) between step 0 and step 5. */
export const MAX_REPEATABILITY_DRIFT_DEG = 25;

/**
 * Calculates robust median and standard deviation for orientation samples.
 */
export function processOrientationSamples(
  samples: readonly RawSample[],
  step: number,
): OrientationCaptureResult | null {
  if (samples.length < MIN_ORIENTATION_SAMPLES) return null;

  const pitches: number[] = [];
  const rolls: number[] = [];
  const accX: number[] = [];
  const accY: number[] = [];
  const accZ: number[] = [];
  const gyrX: number[] = [];
  const gyrY: number[] = [];
  const gyrZ: number[] = [];
  const flexChannels: number[][] = [[], [], [], [], []];

  for (const s of samples) {
    if (s.pitch !== undefined && Number.isFinite(s.pitch)) pitches.push(s.pitch);
    if (s.roll !== undefined && Number.isFinite(s.roll)) rolls.push(s.roll);
    if (s.accel) {
      if (Number.isFinite(s.accel.x)) accX.push(s.accel.x);
      if (Number.isFinite(s.accel.y)) accY.push(s.accel.y);
      if (Number.isFinite(s.accel.z)) accZ.push(s.accel.z);
    }
    if (s.gyro) {
      if (Number.isFinite(s.gyro.x)) gyrX.push(s.gyro.x);
      if (Number.isFinite(s.gyro.y)) gyrY.push(s.gyro.y);
      if (Number.isFinite(s.gyro.z)) gyrZ.push(s.gyro.z);
    }
    for (let c = 0; c < 5; c++) {
      const val = s.flex[c];
      if (Number.isFinite(val)) flexChannels[c]?.push(val);
    }
  }

  if (pitches.length < MIN_ORIENTATION_SAMPLES || rolls.length < MIN_ORIENTATION_SAMPLES) {
    return null;
  }

  const pitchMedian = median(pitches);
  const rollMedian = median(rolls);
  const pitchStdDev = stdDev(pitches);
  const rollStdDev = stdDev(rolls);

  // Stability score based on variance during hold (lower std dev = higher stability)
  const totalVariance = pitchStdDev + rollStdDev;
  const stabilityScore = Math.max(0, Math.min(100, Math.round(100 - totalVariance * 5)));

  const flexMedians = flexChannels.map((vals) => (vals.length > 0 ? median(vals) : 0)) as [
    number,
    number,
    number,
    number,
    number,
  ];

  return {
    step,
    sampleCount: samples.length,
    pitchMedian: Math.round(pitchMedian * 100) / 100,
    rollMedian: Math.round(rollMedian * 100) / 100,
    accelMedian: {
      x: Math.round(median(accX)),
      y: Math.round(median(accY)),
      z: Math.round(median(accZ)),
    },
    gyroMedian: {
      x: Math.round(median(gyrX)),
      y: Math.round(median(gyrY)),
      z: Math.round(median(gyrZ)),
    },
    flexMedians,
    pitchStdDev: Math.round(pitchStdDev * 100) / 100,
    rollStdDev: Math.round(rollStdDev * 100) / 100,
    stabilityScore,
    capturedAtMs: Date.now(),
  };
}

/**
 * Validates the full 6-step orientation calibration dataset and builds the profile.
 */
export function buildOrientationProfile(
  side: GloveSide,
  steps: Readonly<Record<number, OrientationCaptureResult>>,
): OrientationCalibrationProfile | null {
  const step0 = steps[0]; // Palm-down REST
  const step1 = steps[1]; // Palm-up
  const step2 = steps[2]; // Palm-facing
  const step5 = steps[5]; // Final REST

  if (!step0) return null;

  const restPitch = step0.pitchMedian;
  const restRoll = step0.rollMedian;

  // Determine roll direction sign: when rotating from palm-down to palm-up (Step 1),
  // roll rotates by ~180 degrees.
  let rollSign: 1 | -1 = 1;
  if (step1) {
    let rollDiff = step1.rollMedian - restRoll;
    while (rollDiff > 180) rollDiff -= 360;
    while (rollDiff < -180) rollDiff += 360;
    // Standard positive roll rotation moves palm upward when sign is aligned
    rollSign = rollDiff >= 0 ? 1 : -1;
  }

  // Determine pitch direction sign: when lifting hand vertically to palm-facing (Step 2),
  // pitch rotates by ~80-90 degrees.
  let pitchSign: 1 | -1 = 1;
  if (step2) {
    const pitchDiff = step2.pitchMedian - restPitch;
    pitchSign = pitchDiff >= 0 ? 1 : -1;
  }

  // Calculate repeatability drift between step 0 and step 5
  let repeatabilityDriftDeg = 0;
  let repeatabilityPassed = true;
  if (step5) {
    const pDiff = Math.abs(step5.pitchMedian - step0.pitchMedian);
    let rDiff = Math.abs(step5.rollMedian - step0.rollMedian);
    while (rDiff > 180) rDiff = Math.abs(rDiff - 360);
    repeatabilityDriftDeg = Math.round(Math.sqrt(pDiff * pDiff + rDiff * rDiff) * 10) / 10;
    repeatabilityPassed = repeatabilityDriftDeg <= MAX_REPEATABILITY_DRIFT_DEG;
  }

  let quality: 'optimal' | 'acceptable' | 'degraded' = 'acceptable';
  if (repeatabilityPassed && step0.stabilityScore >= 80) {
    quality = 'optimal';
  } else if (!repeatabilityPassed || step0.stabilityScore < 50) {
    quality = 'degraded';
  }

  return {
    version: 1,
    side,
    capturedAtMs: Date.now(),
    restPitch,
    restRoll,
    restAccel: step0.accelMedian,
    pitchSign,
    rollSign,
    repeatabilityDriftDeg,
    repeatabilityPassed,
    quality,
    steps,
  };
}

/**
 * Creates factory fallback orientation profile for each glove based on known mounting.
 */
export function createDefaultOrientationProfile(side: GloveSide): OrientationCalibrationProfile {
  if (side === 'left') {
    // Left glove MPU6050 is inverted on dorsal strap (AccZ negative ~ -15500, roll ~ -179 deg)
    return {
      version: 1,
      side: 'left',
      capturedAtMs: 1792858186000,
      restPitch: -16.0,
      restRoll: -179.0,
      restAccel: { x: 300, y: -4400, z: -15500 },
      pitchSign: 1,
      rollSign: 1,
      repeatabilityDriftDeg: 1.2,
      repeatabilityPassed: true,
      quality: 'acceptable',
      steps: {},
    };
  }

  // Right glove MPU6050 is mounted normal on dorsal strap (AccZ positive ~ +17200, roll ~ +2.8 deg)
  return {
    version: 1,
    side: 'right',
    capturedAtMs: 1792858186000,
    restPitch: 12.0,
    restRoll: 2.8,
    restAccel: { x: -800, y: 3600, z: 17200 },
    pitchSign: 1,
    rollSign: 1,
    repeatabilityDriftDeg: 1.0,
    repeatabilityPassed: true,
    quality: 'acceptable',
    steps: {},
  };
}

function median(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  const copy = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(copy.length / 2);
  return copy.length % 2 === 0 ? ((copy[mid - 1] ?? 0) + (copy[mid] ?? 0)) / 2 : (copy[mid] ?? 0);
}

function stdDev(arr: readonly number[]): number {
  if (arr.length <= 1) return 0;
  const mean = arr.reduce((sum, v) => sum + v, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / arr.length;
  return Math.sqrt(variance);
}
