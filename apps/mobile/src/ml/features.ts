/**
 * Turning a window of frames into the fixed vector a model is fitted to.
 *
 * ## Why statistics and not the raw frames
 *
 * The simplest honest thing that can consume a window is a fixed-length summary
 * of it. A raw 30×11 window is 330 numbers; a *statistical* summary is 55, and
 * — more importantly — it does not care where in the window a movement happened,
 * so a sign held slightly longer than last time still lands in the same region
 * of feature space. That is exactly the property a small dataset needs, and it
 * is why this is a reasonable first model rather than a compromise.
 *
 * The cost is real and belongs in the model card: a *sequence* of different hand
 * shapes that happens to have the same per-channel statistics as another will be
 * confused, because the order of frames is thrown away. `DESCRIPTIONS` below
 * says so in the words the UI shows. Nothing here should be described as deep
 * learning, a neural network, or a translation engine — it is a linear model
 * over hand-written summary statistics, and it is named after what it is.
 *
 * ## Why five statistics
 *
 * - `mean` — where the channel sat, i.e. the pose.
 * - `std` — how much it moved, i.e. whether the hand was held or travelling.
 * - `min` / `max` — the extremes, which is what distinguishes two poses that
 *   have the same average flexion (a curl that passes through a position is not
 *   the same sign as a held one at that position).
 * - `motion` — mean absolute frame-to-frame change, which catches a channel that
 *   travelled a lot without spreading far.
 *
 * `range` (max − min) is deliberately absent: it is a linear combination of two
 * features already present, and adding it would make the weight matrix harder to
 * read without adding information.
 */
import type { FeatureSpec, FrameVector } from './types';
import { PREPROCESSING_VERSION } from './types';

/** Bumped when the feature order or definition changes. Travels with models. */
export const FEATURE_SPEC_VERSION = PREPROCESSING_VERSION;

/** The channels a window contributes, in this order. */
export const FEATURE_CHANNELS: readonly string[] = [
  'flex.thumb',
  'flex.index',
  'flex.middle',
  'flex.ring',
  'flex.pinky',
  'accel.x',
  'accel.y',
  'accel.z',
  'gyro.x',
  'gyro.y',
  'gyro.z',
];

/** The statistics computed per channel, in this order. */
export const FEATURE_STATS: readonly string[] = ['mean', 'std', 'min', 'max', 'motion'];

/** One channel's values across a window, in channel-major order. */
function readChannels(frames: readonly FrameVector[]): number[][] {
  const channels: number[][] = FEATURE_CHANNELS.map(() => []);
  for (const frame of frames) {
    const values = [
      frame.flex[0], frame.flex[1], frame.flex[2], frame.flex[3], frame.flex[4],
      frame.a[0], frame.a[1], frame.a[2],
      frame.g[0], frame.g[1], frame.g[2],
    ];
    for (let channel = 0; channel < channels.length; channel += 1) {
      channels[channel]!.push(values[channel]!);
    }
  }
  return channels;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Population standard deviation, the same definition the window checks use. */
function std(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) * (value - average))));
}

/** Mean absolute frame-to-frame change. Zero for a one-frame window. */
function motion(values: readonly number[]): number {
  if (values.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < values.length; index += 1) {
    total += Math.abs(values[index]! - values[index - 1]!);
  }
  return total / (values.length - 1);
}

/**
 * The layout every model in this app is fitted to.
 *
 * Ordered channel-major so that a human reading the weight matrix sees all five
 * flex statistics together, which is what makes a fitted model inspectable
 * rather than an opaque blob of 55 numbers.
 */
export const FEATURE_SPEC: FeatureSpec = {
  version: FEATURE_SPEC_VERSION,
  mode: 'glove-flex-imu-stats',
  names: FEATURE_CHANNELS.flatMap((channel) =>
    FEATURE_STATS.map((stat) => `${channel}.${stat}`),
  ),
};

/** How many numbers a feature vector holds. */
export const FEATURE_COUNT = FEATURE_SPEC.names.length;

/**
 * A window's feature vector, or null when the window has no frames.
 *
 * Null rather than a vector of zeros: zeros are a valid feature vector meaning
 * "every channel perfectly still at zero", which is a reading a glove can
 * genuinely produce, and returning them for an empty window would make the two
 * indistinguishable downstream.
 */
export function extractFeatures(frames: readonly FrameVector[]): number[] | null {
  if (frames.length === 0) return null;

  const channels = readChannels(frames);
  const vector: number[] = [];

  for (const values of channels) {
    vector.push(mean(values));
    vector.push(std(values));
    vector.push(Math.min(...values));
    vector.push(Math.max(...values));
    vector.push(motion(values));
  }

  return vector;
}

/**
 * Applies the mean/scale a model was fitted with.
 *
 * A scale of zero would divide by nothing, so it is treated as one: a channel
 * that never varied has no spread to normalise and its standardised value is
 * legitimately zero. Models store the pair they used, so standardisation is
 * reproducible from the record alone.
 */
export function standardise(
  vector: readonly number[],
  meanValues: readonly number[],
  scaleValues: readonly number[],
): number[] {
  return vector.map((value, index) => {
    const scale = scaleValues[index] ?? 1;
    const centre = meanValues[index] ?? 0;
    return (value - centre) / (scale === 0 ? 1 : scale);
  });
}

/** Mean and spread of each feature across a set of vectors, for fitting. */
export function fitStandardisation(
  vectors: readonly (readonly number[])[],
): { mean: number[]; scale: number[] } {
  if (vectors.length === 0) {
    return { mean: new Array<number>(FEATURE_COUNT).fill(0), scale: new Array<number>(FEATURE_COUNT).fill(1) };
  }

  const meanValues = new Array<number>(FEATURE_COUNT).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < FEATURE_COUNT; index += 1) {
      meanValues[index] += vector[index] ?? 0;
    }
  }
  for (let index = 0; index < FEATURE_COUNT; index += 1) {
    meanValues[index] /= vectors.length;
  }

  const scaleValues = new Array<number>(FEATURE_COUNT).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < FEATURE_COUNT; index += 1) {
      const deviation = (vector[index] ?? 0) - meanValues[index]!;
      scaleValues[index] += deviation * deviation;
    }
  }
  for (let index = 0; index < FEATURE_COUNT; index += 1) {
    const variance = scaleValues[index]! / vectors.length;
    const spread = Math.sqrt(variance);
    // A feature identical in every sample carries no signal; 1 leaves it at zero.
    scaleValues[index] = spread < 1e-9 ? 1 : spread;
  }

  return { mean: meanValues, scale: scaleValues };
}

/** Whether a vector can be consumed by a model with this spec. */
export function matchesSpec(spec: FeatureSpec, vector: readonly number[]): boolean {
  return spec.version === FEATURE_SPEC_VERSION && vector.length === spec.names.length;
}

/**
 * What the feature set means, in sentences the model card shows.
 *
 * Kept beside the definition so that changing the feature set and forgetting to
 * update its description is a single edit rather than two files that can drift.
 */
export const FEATURE_DESCRIPTION = {
  summary:
    'Each window is reduced to 55 numbers: five statistics (average, spread, minimum, maximum and amount of movement) for each of the five flex channels and all six motion axes.',
  limitation:
    'Because the window is summarised rather than read in order, two different sequences of hand shapes with the same summary are indistinguishable to this model. It is a linear classifier over these statistics — not a neural network, and not a translation engine.',
  offline: 'Fitting and prediction run entirely on the phone, with no network access and no external service.',
} as const;
