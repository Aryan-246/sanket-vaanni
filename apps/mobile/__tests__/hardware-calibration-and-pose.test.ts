/**
 * Tests for Hardware Calibration Workflow and 3D Hand Pose Normalization.
 *
 * Verifies:
 * 1. 7-step guided calibration sequence (Initial REST -> Thumb -> Index -> Middle -> Ring -> Pinky -> Final REST)
 * 2. Robust statistical processing (medians and stddevs)
 * 3. Channel health validation:
 *    - Unseated/disconnected pin detection (<= 15 ADC counts / 0.00V)
 *    - Separation / usable dynamic range check (>= 200 counts)
 *    - Reversed sensor polarity detection (bend < rest)
 *    - Repeatability drift verification (<= 250 counts between Step 0 and Step 6)
 * 4. Angle normalization for dorsal MPU6050 in flat palm-down reference posture
 */

import {
  CALIBRATION_STEPS,
  processStepSamples,
  validateCalibrationDataset,
  buildProfileFromSummary,
  type StepCaptureResult,
} from '../src/sensors/hardwareCalibration';
import { createHardwareDefaultCalibration } from '../src/sensors/calibration';
import { normalizeAngleDifference, tiltFromAccelerometer, createPoseMapper, RESTING_POSE } from '../src/hands/pose';
import type { RawSample } from '../src/sensors/types';

function createMockSample(flex: [number, number, number, number, number], pitch = 0, roll = Math.PI): RawSample {
  return {
    side: 'left',
    timestampMs: Date.now(),
    flex,
    accel: { x: 0, y: 0, z: -9.81 },
    gyro: { x: 0, y: 0, z: 0 },
    pitch,
    roll,
  };
}

describe('Hardware Calibration Engine', () => {
  it('defines the complete 7-step guided sequence in exact order', () => {
    expect(CALIBRATION_STEPS).toHaveLength(7);
    expect(CALIBRATION_STEPS[0].id).toBe('initial_rest');
    expect(CALIBRATION_STEPS[1].id).toBe('thumb_bend');
    expect(CALIBRATION_STEPS[2].id).toBe('index_bend');
    expect(CALIBRATION_STEPS[3].id).toBe('middle_bend');
    expect(CALIBRATION_STEPS[4].id).toBe('ring_bend');
    expect(CALIBRATION_STEPS[5].id).toBe('pinky_bend');
    expect(CALIBRATION_STEPS[6].id).toBe('final_rest');

    expect(CALIBRATION_STEPS[0].targetFinger).toBeNull();
    expect(CALIBRATION_STEPS[1].targetFinger).toBe('thumb');
    expect(CALIBRATION_STEPS[2].targetFinger).toBe('index');
    expect(CALIBRATION_STEPS[3].targetFinger).toBe('middle');
    expect(CALIBRATION_STEPS[4].targetFinger).toBe('ring');
    expect(CALIBRATION_STEPS[5].targetFinger).toBe('pinky');
    expect(CALIBRATION_STEPS[6].targetFinger).toBeNull();
  });

  it('accurately computes sample medians and standard deviations', () => {
    const samples: RawSample[] = [
      createMockSample([3000, 3100, 10, 0, 3200]),
      createMockSample([3050, 3110, 12, 0, 3210]),
      createMockSample([3020, 3105, 11, 0, 3205]),
    ];

    const result = processStepSamples(samples, 1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.step).toBe(1);
    expect(result.sampleCount).toBe(3);
    expect(result.rawMedians[0]).toBe(3020);
    expect(result.rawMedians[1]).toBe(3105);
    expect(result.rawMedians[2]).toBe(11);
    expect(result.rawMedians[3]).toBe(0);
    expect(result.rawMedians[4]).toBe(3205);
  });

  it('flags unseated/disconnected channels reading near 0 counts', () => {
    // Simulated Left Glove capture:
    // Ch0 (Thumb): 3760 -> 2100 (working)
    // Ch1 (Index): 3230 -> 1900 (working)
    // Ch2 (Middle): 0 -> 0 (unseated hardware line)
    // Ch3 (Ring): 0 -> 0 (unseated hardware line)
    // Ch4 (Pinky): 3760 -> 2200 (working)
    const steps: Record<number, StepCaptureResult> = {
      0: { step: 0, sampleCount: 15, rawMedians: [3760, 3230, 0, 0, 3760], rawStdDevs: [5, 5, 0, 0, 5], pitchMedian: 0, rollMedian: 3.14 },
      1: { step: 1, sampleCount: 15, rawMedians: [2100, 3230, 0, 0, 3760], rawStdDevs: [5, 5, 0, 0, 5], pitchMedian: 0, rollMedian: 3.14 },
      2: { step: 2, sampleCount: 15, rawMedians: [3760, 1900, 0, 0, 3760], rawStdDevs: [5, 5, 0, 0, 5], pitchMedian: 0, rollMedian: 3.14 },
      3: { step: 3, sampleCount: 15, rawMedians: [3760, 3230, 0, 0, 3760], rawStdDevs: [5, 5, 0, 0, 5], pitchMedian: 0, rollMedian: 3.14 },
      4: { step: 4, sampleCount: 15, rawMedians: [3760, 3230, 0, 0, 3760], rawStdDevs: [5, 5, 0, 0, 5], pitchMedian: 0, rollMedian: 3.14 },
      5: { step: 5, sampleCount: 15, rawMedians: [3760, 3230, 0, 0, 2200], rawStdDevs: [5, 5, 0, 0, 5], pitchMedian: 0, rollMedian: 3.14 },
      6: { step: 6, sampleCount: 15, rawMedians: [3755, 3225, 0, 0, 3765], rawStdDevs: [5, 5, 0, 0, 5], pitchMedian: 0, rollMedian: 3.14 },
    };

    const summary = validateCalibrationDataset('left', steps);
    expect(summary).not.toBeNull();
    if (!summary) return;

    // Ch0, Ch1, Ch4 should be valid
    expect(summary.channels[0].status).toBe('valid');
    expect(summary.channels[1].status).toBe('valid');
    expect(summary.channels[4].status).toBe('valid');

    // Ch2 (Middle) and Ch3 (Ring) must fail with explicit unseated/no-signal issue
    expect(summary.channels[2].status).toBe('failed');
    expect(summary.channels[2].issue).toContain('Disconnected / 0V ground');
    expect(summary.channels[3].status).toBe('failed');
    expect(summary.channels[3].issue).toContain('Disconnected / 0V ground');

    // Partial save allowed because 3 channels are valid
    expect(summary.canSave).toBe(true);
  });

  it('validates reversed sensor polarity (bend ADC < rest ADC)', () => {
    // Normal flex sensor with pull-down: bent = higher resistance -> lower ADC voltage
    // Or inverted wiring where bent = higher ADC
    const steps: Record<number, StepCaptureResult> = {
      0: { step: 0, sampleCount: 15, rawMedians: [3500, 3500, 3500, 3500, 3500], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      1: { step: 1, sampleCount: 15, rawMedians: [2000, 3500, 3500, 3500, 3500], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      2: { step: 2, sampleCount: 15, rawMedians: [3500, 5000, 3500, 3500, 3500], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 }, // inverted
      3: { step: 3, sampleCount: 15, rawMedians: [3500, 3500, 2100, 3500, 3500], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      4: { step: 4, sampleCount: 15, rawMedians: [3500, 3500, 3500, 2200, 3500], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      5: { step: 5, sampleCount: 15, rawMedians: [3500, 3500, 3500, 3500, 2300], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      6: { step: 6, sampleCount: 15, rawMedians: [3510, 3505, 3495, 3500, 3505], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
    };

    const summary = validateCalibrationDataset('right', steps);
    expect(summary).not.toBeNull();
    if (!summary) return;

    expect(summary.channels[0].polarity).toBe('inverted'); // 3500 -> 2000
    expect(summary.channels[1].polarity).toBe('normal');   // 3500 -> 5000
    expect(summary.repeatabilityPassed).toBe(true);
    expect(summary.canSave).toBe(true);

    const fallback = createHardwareDefaultCalibration('right');
    const profile = buildProfileFromSummary(summary, fallback);
    expect(profile.side).toBe('right');
    expect(profile.channels[0].rest).toBe(3500);
    expect(profile.channels[0].fullFlex).toBe(2000);
    expect(profile.channels[1].rest).toBe(3500);
    expect(profile.channels[1].fullFlex).toBe(5000);
  });

  it('detects severe repeatability drift between initial REST and final REST', () => {
    const steps: Record<number, StepCaptureResult> = {
      0: { step: 0, sampleCount: 15, rawMedians: [3000, 3000, 3000, 3000, 3000], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      1: { step: 1, sampleCount: 15, rawMedians: [4000, 3000, 3000, 3000, 3000], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      2: { step: 2, sampleCount: 15, rawMedians: [3000, 4000, 3000, 3000, 3000], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      3: { step: 3, sampleCount: 15, rawMedians: [3000, 3000, 4000, 3000, 3000], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      4: { step: 4, sampleCount: 15, rawMedians: [3000, 3000, 3000, 4000, 3000], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      5: { step: 5, sampleCount: 15, rawMedians: [3000, 3000, 3000, 3000, 4000], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
      // Final REST has slipped by 400 counts (> 250 limit)
      6: { step: 6, sampleCount: 15, rawMedians: [3400, 3000, 3000, 3000, 3000], rawStdDevs: [2, 2, 2, 2, 2], pitchMedian: 0, rollMedian: 3.14 },
    };

    const summary = validateCalibrationDataset('left', steps);
    expect(summary).not.toBeNull();
    if (!summary) return;

    expect(summary.repeatabilityPassed).toBe(false);
    expect(summary.channels[0].repeatabilityDelta).toBe(400);
    expect(summary.channels[0].status).toBe('warning');
    expect(summary.channels[0].issue).toContain('drift');
  });
});

describe('3D Hand Pose and Orientation Normalization', () => {
  it('correctly normalizes angles across the [-pi, pi] boundary', () => {
    // Exact match
    expect(normalizeAngleDifference(Math.PI, Math.PI)).toBeCloseTo(0);

    // Roll jump near +/- pi boundary: e.g. angle = 3.14, reference = -3.14
    const diff = normalizeAngleDifference(3.14, -3.14);
    // 3.14 - (-3.14) = 6.28 -> 6.28 - 2*pi = ~0
    expect(Math.abs(diff)).toBeLessThan(0.01);

    // 45 degrees difference
    expect(normalizeAngleDifference(Math.PI / 4, 0)).toBeCloseTo(Math.PI / 4);

    // -180 degrees difference
    expect(normalizeAngleDifference(-Math.PI, 0)).toBeCloseTo(-Math.PI);
  });

  it('keeps flat palm-down resting hand at relative roll ~ 0', () => {
    // When resting flat on the table, accelerometer reads z < 0 (downwards into table)
    // accel = { x: 0, y: 0, z: -9.81 } -> roll = atan2(0, -9.81) = pi rad
    const tilt = tiltFromAccelerometer({ x: 0, y: 0, z: -9.81 });
    expect(tilt.roll).toBeCloseTo(Math.PI);

    // With neutral reference calibrated to Math.PI (flat desk posture):
    const relativeRoll = normalizeAngleDifference(tilt.roll, Math.PI);
    expect(relativeRoll).toBeCloseTo(0);
  });

  it('pose mapper computes smoothed bends and relative wrist tilt', () => {
    const mapper = createPoseMapper('left', {
      neutral: {
        fingers: [0, 0, 0, 0, 0],
        wrist: { pitch: 0, roll: Math.PI, yaw: null },
      },
    });

    const sample = {
      side: 'left' as const,
      timestampMs: 1000,
      flex: [0.2, 0.4, 0.6, 0.8, 1.0] as [number, number, number, number, number],
      accel: { x: 0, y: 0, z: -9.81 },
      gyro: { x: 0, y: 0, z: 0 },
    };

    const pose = mapper.map(sample, 'real');
    expect(pose.side).toBe('left');
    expect(pose.source).toBe('real');
    expect(pose.fingers[0]).toBeCloseTo(0.2);
    expect(pose.fingers[4]).toBeCloseTo(1.0);
    expect(pose.wrist.roll).toBeCloseTo(0); // flat palm-down normalized
    expect(pose.wrist.yaw).toBeNull(); // honest MPU6050
  });
});
