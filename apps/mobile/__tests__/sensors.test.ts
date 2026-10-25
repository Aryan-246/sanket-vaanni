/**
 * Calibration and signal processing.
 *
 * Pure logic, no React Native, no timers.
 */
import {
  applyCalibration,
  CalibrationError,
  createDemoCalibration,
  createHardwareDefaultCalibration,
} from '../src/sensors/calibration';
import { createProcessingPipeline, createSmoother, flexMagnitude } from '../src/sensors/processing';
import type { FlexReading, RawSample } from '../src/sensors/types';
import { FLEX_CHANNEL_COUNT } from '../src/sensors/types';

function rawSample(overrides: Partial<RawSample> = {}): RawSample {
  return {
    side: 'right',
    timestampMs: 1000,
    flex: [0, 0, 0, 0, 0],
    accel: { x: 0, y: 0, z: 9.81 },
    gyro: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

describe('applyCalibration', () => {
  it('maps the rest anchor to 0 and the full-flex anchor to 1', () => {
    const profile = {
      ...createDemoCalibration('right'),
      channels: Array.from({ length: FLEX_CHANNEL_COUNT }, () => ({ rest: 100, fullFlex: 300 })),
    };

    const result = applyCalibration(
      rawSample({ flex: [100, 200, 300, 150, 250] }),
      profile,
    );

    expect(result.flex).toEqual([0, 0.5, 1, 0.25, 0.75]);
  });

  it('clamps values outside the calibrated range', () => {
    const profile = {
      ...createDemoCalibration('right'),
      channels: Array.from({ length: FLEX_CHANNEL_COUNT }, () => ({ rest: 100, fullFlex: 300 })),
    };

    const result = applyCalibration(
      rawSample({ flex: [-50, 3000, 100, 300, 100] }),
      profile,
    );

    expect(result.flex).toEqual([0, 1, 0, 1, 0]);
  });

  it('handles an inverted anchor (full flex reading lower than rest)', () => {
    // Possible depending on wiring; normalising by the signed span copes.
    const profile = {
      ...createDemoCalibration('right'),
      channels: Array.from({ length: FLEX_CHANNEL_COUNT }, () => ({ rest: 300, fullFlex: 100 })),
    };

    const result = applyCalibration(rawSample({ flex: [300, 200, 100, 300, 100] }), profile);

    expect(result.flex).toEqual([0, 0.5, 1, 0, 1]);
  });

  it('rejects a sample from the wrong glove', () => {
    const profile = createDemoCalibration('left');
    expect(() => applyCalibration(rawSample({ side: 'right' }), profile)).toThrow(
      CalibrationError,
    );
  });

  it('rejects a profile whose anchors are identical', () => {
    const profile = {
      ...createDemoCalibration('right'),
      channels: Array.from({ length: FLEX_CHANNEL_COUNT }, () => ({ rest: 42, fullFlex: 42 })),
    };

    expect(() => applyCalibration(rawSample(), profile)).toThrow(/cannot be normalised/);
  });

  it('rejects a profile with the wrong number of channels', () => {
    const profile = { ...createDemoCalibration('right'), channels: [{ rest: 0, fullFlex: 1 }] };
    expect(() => applyCalibration(rawSample(), profile)).toThrow(CalibrationError);
  });

  it('leaves IMU values untouched rather than silently correcting them', () => {
    const accel = { x: 1.5, y: -2.5, z: 9.0 };
    const gyro = { x: 0.1, y: 0.2, z: 0.3 };
    const result = applyCalibration(
      rawSample({ accel, gyro }),
      createDemoCalibration('right'),
    );

    expect(result.accel).toEqual(accel);
    expect(result.gyro).toEqual(gyro);
  });
});

describe('createSmoother', () => {
  it('passes the first sample through unchanged', () => {
    const smoother = createSmoother(0.2);
    const first: FlexReading = [0.1, 0.2, 0.3, 0.4, 0.5];
    expect(smoother.push(first)).toEqual(first);
  });

  it('moves toward a step input without overshooting', () => {
    const smoother = createSmoother(0.5);
    smoother.push([0, 0, 0, 0, 0]);
    const next = smoother.push([1, 1, 1, 1, 1]);

    next.forEach((value) => {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    });
  });

  it('rejects an out-of-range alpha', () => {
    expect(() => createSmoother(0)).toThrow(RangeError);
    expect(() => createSmoother(1.5)).toThrow(RangeError);
  });

  it('resets to the initial state', () => {
    const smoother = createSmoother(0.5);
    smoother.push([1, 1, 1, 1, 1]);
    smoother.reset();
    expect(smoother.push([0.25, 0.25, 0.25, 0.25, 0.25])).toEqual([
      0.25, 0.25, 0.25, 0.25, 0.25,
    ]);
  });
});

describe('createProcessingPipeline', () => {
  it('calibrates before smoothing, so output is normalised', () => {
    const profile = {
      ...createDemoCalibration('right'),
      channels: Array.from({ length: FLEX_CHANNEL_COUNT }, () => ({ rest: 0, fullFlex: 100 })),
    };
    const pipeline = createProcessingPipeline(profile);

    const result = pipeline.process(rawSample({ flex: [50, 50, 50, 50, 50] }));

    result.flex.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    });
  });
});

describe('flexMagnitude', () => {
  it('averages the channels', () => {
    expect(flexMagnitude([0, 0.5, 1, 0, 0.5])).toBeCloseTo(0.4, 5);
  });

  it('is zero for a relaxed hand', () => {
    expect(flexMagnitude([0, 0, 0, 0, 0])).toBe(0);
  });
});

describe('createHardwareDefaultCalibration', () => {
  it('returns valid 5-channel calibration for left glove', () => {
    const profile = createHardwareDefaultCalibration('left');
    expect(profile.side).toBe('left');
    expect(profile.channels).toHaveLength(FLEX_CHANNEL_COUNT);
    profile.channels.forEach((ch) => {
      expect(ch.rest).not.toBe(ch.fullFlex);
    });
  });

  it('correctly maps Left Glove V11 real hardware rest and flex values', () => {
    const profile = createHardwareDefaultCalibration('left');

    // Rest pose ADC readings: [550, 1860, 290, 340, 1960]
    const restSample = applyCalibration(
      rawSample({ side: 'left', flex: [550, 1860, 290, 340, 1960] }),
      profile,
    );
    expect(restSample.flex).toEqual([0, 0, 0, 0, 0]);

    // Full flex pose ADC readings: [5120, 5836, 520, 1088, 990]
    const flexSample = applyCalibration(
      rawSample({ side: 'left', flex: [5120, 5836, 520, 1088, 990] }),
      profile,
    );
    expect(flexSample.flex).toEqual([1, 1, 1, 1, 1]);

    // Clamps out-of-range hardware spikes
    const clampedSample = applyCalibration(
      rawSample({ side: 'left', flex: [300, 6500, 200, 1500, 500] }),
      profile,
    );
    expect(clampedSample.flex).toEqual([0, 1, 0, 1, 1]);
  });
});

