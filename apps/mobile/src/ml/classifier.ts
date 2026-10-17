/**
 * The classifier: multinomial logistic regression, trained on the phone.
 *
 * ## What this is, in plain words
 *
 * One weighted sum per sign. Each weight says how strongly one of the 55 window
 * statistics pushes towards one sign, and the softmax turns those sums into a
 * ranking. Training is gradient descent on the cross-entropy loss, full-batch,
 * for a fixed number of epochs. That is the whole model.
 *
 * It is **not** a neural network, **not** deep learning, and **not** a
 * translation engine. It has no hidden layers, so it can only draw straight
 * boundaries between signs in feature space; two signs whose statistics overlap
 * in a way that needs a curved boundary will be confused forever, no matter how
 * much data arrives. `DESCRIPTIONS` says this in the words the model card shows,
 * and the model record carries the algorithm name `softmax-linear` so nothing
 * downstream can quietly relabel it.
 *
 * ## Why this rather than something more capable
 *
 * It trains in well under a second on a handset for a few hundred windows, runs
 * with no dependency, produces a weight matrix a human can read, is
 * deterministic, and its output is *honestly* describable. A larger model on the
 * same data would produce a better-looking number and a worse-founded claim. The
 * roadmap's real recognition work needs a Deaf-led vocabulary first; this is what
 * can be built truthfully before that exists.
 *
 * ## Cancellation and failure
 *
 * A run checks `shouldStop()` between epochs and, when asked to stop, returns
 * **no parameters at all**. There is deliberately no half-trained model to save:
 * the caller's previous active model stays active, which is the required
 * behaviour when training is interrupted, runs out of memory, or is dismissed.
 * Progress reported through `onEpoch` is measured — the loss is the loss that
 * epoch actually reached.
 */
import {
  FEATURE_COUNT,
  FEATURE_DESCRIPTION,
  extractFeatures,
  fitStandardisation,
  standardise,
} from './features';
import type { FeatureSpec, FrameVector, ModelParameters, TrainingConfig } from './types';
import { FEATURE_SPEC } from './features';

/** Default fitting settings, stored with each model that used them. */
export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  epochs: 120,
  learningRate: 0.5,
  l2: 0.001,
  testFraction: 0.3,
  validationFraction: 0,
  splitKey: 'sessionId',
  seed: 1,
};

/** One measured point of a run. The chart is drawn from these, not from a timer. */
export interface EpochProgress {
  readonly epoch: number;
  readonly totalEpochs: number;
  /** Cross-entropy plus L2 penalty, as computed at the end of this epoch. */
  readonly loss: number;
  /** Fraction of the training set the current weights get right. */
  readonly trainAccuracy: number;
}

export type TrainFailure = 'no-data' | 'single-class' | 'bad-config' | 'cancelled';

export type TrainOutcome =
  | {
      readonly ok: true;
      readonly parameters: ModelParameters;
      readonly history: readonly EpochProgress[];
      readonly config: TrainingConfig;
    }
  | {
      readonly ok: false;
      readonly code: TrainFailure;
      readonly reason: string;
      /** Whatever had been measured before the run stopped. Empty on refusal. */
      readonly history: readonly EpochProgress[];
    };

export interface TrainInput {
  /** Feature vectors, one per example, all the same length. */
  readonly vectors: readonly (readonly number[])[];
  /** Class index per example, in `0..classCount-1`. */
  readonly classIndices: readonly number[];
  readonly classLabelIds: readonly string[];
  readonly config?: TrainingConfig;
  readonly onEpoch?: (progress: EpochProgress) => void;
  /** Polled between epochs. Returning true abandons the run. */
  readonly shouldStop?: () => boolean;
}

/** Softmax over logits, shifted for numerical stability. */
function softmax(logits: readonly number[]): number[] {
  const largest = Math.max(...logits);
  const exponentials = logits.map((logit) => Math.exp(logit - largest));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    // Degenerate logits (all -Infinity) become a uniform distribution rather
    // than NaN, so a diverged run reports a bad loss instead of crashing.
    return logits.map(() => 1 / logits.length);
  }
  return exponentials.map((value) => value / total);
}

/** Raw class scores for one standardised vector. */
function logitsFor(
  weights: readonly (readonly number[])[],
  biases: readonly number[],
  vector: readonly number[],
): number[] {
  return weights.map((row, index) => {
    let total = biases[index] ?? 0;
    for (let feature = 0; feature < vector.length; feature += 1) {
      total += (row[feature] ?? 0) * (vector[feature] ?? 0);
    }
    return total;
  });
}

/**
 * Fits a model, calling back once per epoch with the loss it reached.
 *
 * Nothing is written anywhere by this function. It returns parameters or a
 * failure; persisting them and deciding whether they may go live are separate
 * steps with their own rules (`modelStore.ts`, `training.ts`).
 */
export function trainModel(input: TrainInput): TrainOutcome {
  const config = input.config ?? DEFAULT_TRAINING_CONFIG;
  const history: EpochProgress[] = [];

  if (input.vectors.length === 0 || input.classIndices.length !== input.vectors.length) {
    return {
      ok: false,
      code: 'no-data',
      reason: 'There was nothing labelled to train on.',
      history,
    };
  }

  const classCount = input.classLabelIds.length;
  if (classCount < 2) {
    return {
      ok: false,
      code: 'single-class',
      reason:
        classCount === 1
          ? 'Only one sign has examples, so there is nothing to tell it apart from. Add at least one more sign.'
          : 'No sign has examples yet.',
      history,
    };
  }

  const malformed = input.vectors.some((vector) => vector.length !== FEATURE_COUNT);
  if (malformed || config.epochs < 1 || config.learningRate <= 0) {
    return {
      ok: false,
      code: 'bad-config',
      reason: 'The training settings or the window features do not match what this build expects.',
      history,
    };
  }

  const { mean, scale } = fitStandardisation(input.vectors);
  const standardised = input.vectors.map((vector) => standardise(vector, mean, scale));

  const weights: number[][] = Array.from({ length: classCount }, () =>
    new Array<number>(FEATURE_COUNT).fill(0),
  );
  const biases: number[] = new Array<number>(classCount).fill(0);

  for (let epoch = 1; epoch <= config.epochs; epoch += 1) {
    if (input.shouldStop?.() === true) {
      return {
        ok: false,
        code: 'cancelled',
        reason: 'Training was stopped before it finished, so the previous model is still in use.',
        history,
      };
    }

    const weightGradients: number[][] = Array.from({ length: classCount }, () =>
      new Array<number>(FEATURE_COUNT).fill(0),
    );
    const biasGradients: number[] = new Array<number>(classCount).fill(0);

    let loss = 0;
    let correct = 0;

    for (let example = 0; example < standardised.length; example += 1) {
      const vector = standardised[example]!;
      const actual = input.classIndices[example]!;
      const probabilities = softmax(logitsFor(weights, biases, vector));

      const chosen = probabilities[actual] ?? 0;
      // Clamped away from zero only to keep log() finite; a confidently wrong
      // model then shows a large loss rather than Infinity.
      loss -= Math.log(Math.max(chosen, 1e-12));

      let best = 0;
      for (let index = 1; index < probabilities.length; index += 1) {
        if (probabilities[index]! > probabilities[best]!) best = index;
      }
      if (best === actual) correct += 1;

      for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        const error = (probabilities[classIndex] ?? 0) - (classIndex === actual ? 1 : 0);
        const row = weightGradients[classIndex]!;
        for (let feature = 0; feature < FEATURE_COUNT; feature += 1) {
          row[feature] += error * (vector[feature] ?? 0);
        }
        biasGradients[classIndex] += error;
      }
    }

    const count = standardised.length;
    let penalty = 0;
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      const row = weights[classIndex]!;
      for (let feature = 0; feature < FEATURE_COUNT; feature += 1) {
        const weight = row[feature]!;
        penalty += weight * weight;
      }
    }
    penalty = (config.l2 / 2) * penalty;

    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      const row = weights[classIndex]!;
      const gradientRow = weightGradients[classIndex]!;
      for (let feature = 0; feature < FEATURE_COUNT; feature += 1) {
        const gradient = gradientRow[feature]! / count + config.l2 * row[feature]!;
        row[feature] = row[feature]! - config.learningRate * gradient;
      }
      biases[classIndex] = biases[classIndex]! - config.learningRate * (biasGradients[classIndex]! / count);
    }

    const progress: EpochProgress = {
      epoch,
      totalEpochs: config.epochs,
      loss: loss / count + penalty,
      trainAccuracy: correct / count,
    };
    history.push(progress);
    input.onEpoch?.(progress);
  }

  const parameters: ModelParameters = {
    kind: 'softmax-linear',
    featureSpec: FEATURE_SPEC,
    weights: weights.map((row) => [...row]),
    biases: [...biases],
    classLabelIds: [...input.classLabelIds],
    standardisation: { mean, scale },
  };

  return { ok: true, parameters, history, config };
}

/** One prediction from fitted parameters. */
export interface Prediction {
  /** Class scores in `classLabelIds` order. Sum to 1 by construction. */
  readonly scores: readonly number[];
  /** Index of the highest score. */
  readonly bestIndex: number;
  readonly bestLabelId: string;
  readonly bestScore: number;
  /** Highest score outside the best class; 0 when there is only one class. */
  readonly runnerUpScore: number;
  /** `bestScore - runnerUpScore`. */
  readonly margin: number;
}

/**
 * Scores one feature vector.
 *
 * Returns null when the vector cannot belong to this model — a different feature
 * layout, or a length that does not match. Refusing is the point: silently
 * padding or truncating would produce a confident answer from mangled input.
 */
export function predict(
  parameters: ModelParameters,
  vector: readonly number[],
): Prediction | null {
  if (parameters.featureSpec.version !== FEATURE_SPEC.version) return null;
  if (vector.length !== parameters.featureSpec.names.length) return null;
  if (parameters.classLabelIds.length === 0) return null;

  const standardised = standardise(
    vector,
    parameters.standardisation.mean,
    parameters.standardisation.scale,
  );
  const scores = softmax(logitsFor(parameters.weights, parameters.biases, standardised));

  let bestIndex = 0;
  let runnerUp = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index]! > scores[bestIndex]!) {
      runnerUp = scores[bestIndex]!;
      bestIndex = index;
    } else if (scores[index]! > runnerUp) {
      runnerUp = scores[index]!;
    }
  }

  return {
    scores,
    bestIndex,
    bestLabelId: parameters.classLabelIds[bestIndex]!,
    bestScore: scores[bestIndex]!,
    runnerUpScore: runnerUp,
    margin: scores[bestIndex]! - runnerUp,
  };
}

/** Convenience: features straight from a window, or null if it has no frames. */
export function featuresForWindow(frames: readonly FrameVector[]): number[] | null {
  return extractFeatures(frames);
}

/**
 * How the algorithm is described wherever a person can read it.
 *
 * One source, so the model card, the export file and the report cannot disagree
 * about what was trained.
 */
export const DESCRIPTIONS = {
  name: 'Multinomial logistic regression (softmax over linear scores)',
  algorithm: 'softmax-linear',
  detail:
    'A linear classifier over 55 window statistics, fitted by gradient descent. It has no hidden layers and cannot learn curved boundaries between signs.',
  limitation: FEATURE_DESCRIPTION.limitation,
  offline: FEATURE_DESCRIPTION.offline,
  notClaimed: [
    'Not a neural network and not deep learning.',
    'Not a sign language translator.',
    'Its scores are rankings, not calibrated probabilities.',
  ],
} as const;

/** The feature layout, re-exported so callers need only this file. */
export { FEATURE_SPEC };

/** True when these parameters came from this build's feature pipeline. */
export function isCompatible(spec: FeatureSpec): boolean {
  return spec.version === FEATURE_SPEC.version && spec.names.length === FEATURE_COUNT;
}
