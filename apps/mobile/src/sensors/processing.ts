/**
 * Signal processing between raw transport output and recognition.
 *
 * Kept pure and dependency-free so it can be unit-tested without React Native
 * or hardware.
 */
import { applyCalibration, type CalibrationProfile } from './calibration';
import type { FlexReading, RawSample, SensorSample } from './types';
import { FLEX_CHANNEL_COUNT } from './types';

/**
 * Exponential moving average, one state slot per flex channel.
 *
 * Flex sensors are electrically noisy; recognition is far more sensitive to
 * jitter than to a few tens of milliseconds of lag. The default alpha
 * corresponds to roughly a 5-sample time constant at 20 Hz.
 *
 * This is a smoothing filter, not a model of the sensor. It makes no claim
 * about noise characteristics — those must be measured on real hardware.
 */
export interface Smoother {
  push(flex: FlexReading): FlexReading;
  reset(): void;
}

export function createSmoother(alpha = 0.2): Smoother {
  if (!(alpha > 0 && alpha <= 1)) {
    throw new RangeError(`alpha must be in (0, 1], received ${alpha}`);
  }
  let state: FlexReading | null = null;

  return {
    push(flex) {
      if (state === null) {
        state = [flex[0], flex[1], flex[2], flex[3], flex[4]];
        return state;
      }
      const next: FlexReading = [
        state[0] + alpha * (flex[0] - state[0]),
        state[1] + alpha * (flex[1] - state[1]),
        state[2] + alpha * (flex[2] - state[2]),
        state[3] + alpha * (flex[3] - state[3]),
        state[4] + alpha * (flex[4] - state[4]),
      ];
      state = next;
      return next;
    },
    reset() {
      state = null;
    },
  };
}

/**
 * Turns a raw transport sample into a smoothed, normalised sample.
 *
 * Order matters and is deliberate: calibrate first, then smooth. Smoothing raw
 * values would make the filter's behaviour depend on the raw scale, so the
 * same alpha would mean different things across transports and calibrations.
 */
export function createProcessingPipeline(profile: CalibrationProfile): {
  process(raw: RawSample): SensorSample;
  reset(): void;
} {
  const smoother = createSmoother();

  return {
    process(raw: RawSample): SensorSample {
      const calibrated = applyCalibration(raw, profile);
      return { ...calibrated, flex: smoother.push(calibrated.flex) };
    },
    reset(): void {
      smoother.reset();
    },
  };
}

/**
 * Mean absolute channel value. Used by the UI to render an activity indicator.
 * Not a gesture feature and not an input to recognition.
 */
export function flexMagnitude(flex: FlexReading): number {
  let total = 0;
  for (let i = 0; i < FLEX_CHANNEL_COUNT; i += 1) {
    total += flex[i] ?? 0;
  }
  return total / FLEX_CHANNEL_COUNT;
}
