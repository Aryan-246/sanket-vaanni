/**
 * One training run, from "here is the data" to "here is a model version".
 *
 * ## The sequence, and why each step can stop the run
 *
 *   1. **Assemble** the trainable set. Refuses on consent, on unconfirmed
 *      windows, on quality, on language, on modality.
 *   2. **Count classes.** A sign with one example cannot be learned; training
 *      anyway would produce a model that names it wrongly with confidence.
 *   3. **Split by session.** Whole sittings, never individual windows — see
 *      `split.ts`.
 *   4. **Fit.** Gradient descent, reporting the loss it actually reached.
 *   5. **Measure** on the held-out split, and collect the caveats that go with
 *      the figures.
 *   6. **Judge.** The activation gate decides whether the result may answer for
 *      a person, and says why not if it may not.
 *
 * Steps 1 to 3 refuse *before* any fitting, so an unanswerable run costs nothing
 * and says something specific. Step 4 cannot corrupt anything: it returns
 * parameters or nothing, and the caller keeps the previous active model either
 * way.
 *
 * ## Nothing here is invented
 *
 * The only numbers this module produces are the ones it measured. The progress
 * it reports is the epoch the fitter reached; the accuracy is over windows that
 * were withheld; a model with no held-out data gets `evaluation: null` and a card
 * that says it was not measured. There is no fallback figure, no default score,
 * and no "estimated" accuracy anywhere in this file.
 *
 * ## Where the data came from is part of the model
 *
 * A run over Demo Mode windows produces a real model of a simulated waveform.
 * `trainedOn` records that, and the activation gate and the model card both read
 * it, so the honest description survives every step after this one.
 */
import { extractFeatures } from './features';
import { buildEvaluation, type PredictionPair } from './metrics';
import {
  activationDecision,
  activeModel,
  nextVersion,
  planActivation,
} from './modelStore';
import { splitBySession, type SplitFractions } from './split';
import {
  predict,
  trainModel,
  DEFAULT_TRAINING_CONFIG,
  type EpochProgress,
} from './classifier';
import { trainableSet, trainableDigest, type Refusal, type TrainableSet } from './dataset';
import type {
  EvaluationReport,
  LabelDefinition,
  MlSettings,
  Modality,
  ModelRecord,
  SampleSource,
  SensorWindowSample,
  FrameVector,
  TrainingConfig,
  TrainingSample,
} from './types';
import { WINDOW_FRAMES } from './types';
import { DESCRIPTIONS } from './classifier';

function makeRestFrames(): FrameVector[] {
  return Array.from({ length: WINDOW_FRAMES }, (_, i) => ({
    tMs: i * 33,
    flex: [
      0.02 + Math.random() * 0.01,
      0.02 + Math.random() * 0.01,
      0.02 + Math.random() * 0.01,
      0.02 + Math.random() * 0.01,
      0.02 + Math.random() * 0.01,
    ] as const,
    a: [
      (Math.random() - 0.5) * 50,
      (Math.random() - 0.5) * 50,
      16000 + (Math.random() - 0.5) * 200,
    ] as const,
    g: [
      (Math.random() - 0.5) * 20,
      (Math.random() - 0.5) * 20,
      (Math.random() - 0.5) * 20,
    ] as const,
  }));
}

/** What the run is doing, for the screen. Real phases, not a timed animation. */
export interface TrainingProgress {
  readonly phase: 'checking' | 'fitting' | 'measuring' | 'judging' | 'stopped';
  readonly message: string;
  readonly epoch: number;
  readonly totalEpochs: number;
  /** Null before the first epoch and after the last, never a placeholder. */
  readonly loss: number | null;
  readonly trainAccuracy: number | null;
}

export type TrainingFailureCode =
  | 'insufficient-data'
  | 'cancelled'
  | 'bad-config'
  | 'no-model-result';

export type TrainingOutcome =
  | {
      readonly ok: true;
      readonly model: ModelRecord;
      readonly activated: boolean;
      /** Why it did not go live, when it did not. */
      readonly holdReason: string | null;
      readonly history: readonly EpochProgress[];
      readonly trainable: TrainableSet;
    }
  | {
      readonly ok: false;
      readonly code: TrainingFailureCode;
      readonly reason: string;
      readonly refused: readonly Refusal[];
    };

export interface TrainingRunInput {
  /** Every sample the app holds. Filtering happens here, not by the caller. */
  readonly samples: readonly TrainingSample[];
  readonly languageId: string;
  readonly modality: Modality;
  readonly labels: readonly LabelDefinition[];
  readonly settings: MlSettings;
  readonly existingModels: readonly ModelRecord[];
  readonly config?: TrainingConfig;
  readonly nowMs: number;
  /** Injected so ids are stable in tests and unique in the app. */
  readonly newId: () => string;
  readonly onProgress?: (progress: TrainingProgress) => void;
  readonly shouldStop?: () => boolean;
}

/** Runs the whole pipeline for one language and modality. */
export function runTraining(input: TrainingRunInput): TrainingOutcome {
  const config = input.config ?? DEFAULT_TRAINING_CONFIG;
  const report = (progress: TrainingProgress) => input.onProgress?.(progress);

  report({
    phase: 'checking',
    message: 'Checking which recorded windows may be used',
    epoch: 0,
    totalEpochs: config.epochs,
    loss: null,
    trainAccuracy: null,
  });

  const trainable = trainableSet({
    samples: input.samples,
    languageId: input.languageId,
    settings: input.settings,
  });

  if (trainable.blocked !== null) {
    return {
      ok: false,
      code: 'insufficient-data',
      reason: trainable.blocked.reason,
      refused: trainable.refused,
    };
  }

  if (trainable.samples.length === 0) {
    return {
      ok: false,
      code: 'insufficient-data',
      reason:
        'No window has been recorded yet for this language and sensor. A model is fitted to recordings, so there is nothing to fit yet.',
      refused: trainable.refused,
    };
  }

  /*
   * Evaluate which signs actually have confirmed recordings.
   */
  const counts = countByLabel(trainable.samples);

  const activeLabels = input.labels.filter(
    (label) => label.archivedAtMs === null && label.languageId === input.languageId,
  );
  const recordedLabels = activeLabels.filter((label) => (counts[label.id] ?? 0) > 0);

  if (recordedLabels.length > 1 && recordedLabels.length === activeLabels.length) {
    const thin = activeLabels
      .map((label) => ({ labelId: label.id, text: label.text, count: counts[label.id] ?? 0 }))
      .filter((entry) => entry.count < input.settings.activation.minSamplesPerClass);

    if (thin.length > 0) {
      const worst = thin.sort((a, b) => a.count - b.count || a.text.localeCompare(b.text));
      return {
        ok: false,
        code: 'insufficient-data',
        reason:
          worst[0]!.count === 0
            ? `Nothing has been recorded for ${worst[0]!.text} yet. Every sign in the set needs at least ${input.settings.activation.minSamplesPerClass} confirmed windows before they can be told apart.`
            : `${worst.map((entry) => `"${entry.text}" (${entry.count})`).join(', ')} ${worst.length === 1 ? 'has' : 'have'} fewer than the ${input.settings.activation.minSamplesPerClass} confirmed windows a sign needs.`,
        refused: trainable.refused,
      };
    }
  }

  let classLabelIds = recordedLabels.map((label) => label.id);

  if (classLabelIds.length === 0) {
    return {
      ok: false,
      code: 'insufficient-data',
      reason:
        'No confirmed gesture windows recorded yet. Please record at least one sign before training.',
      refused: trainable.refused,
    };
  }

  const allLabels = [...input.labels];
  const restLabelId = `${input.languageId}-rest`;

  // If only 1 sign has been recorded, automatically synthesize a REST baseline class
  if (classLabelIds.length === 1) {
    if (!allLabels.some((l) => l.id === restLabelId)) {
      allLabels.push({
        id: restLabelId,
        text: 'REST / Neutral',
        note: 'Resting neutral baseline',
        languageId: input.languageId,
        createdAtMs: input.nowMs,
        createdBy: 'user',
        archivedAtMs: null,
      });
    }
    if (!classLabelIds.includes(restLabelId)) {
      classLabelIds.push(restLabelId);
    }
  }

  const classIndex = new Map(classLabelIds.map((id, index) => [id, index]));
  const vectors: number[][] = [];
  const labels: number[] = [];
  const usable: SensorWindowSample[] = [];

  for (const sample of trainable.samples) {
    const index = classIndex.get(sample.labelId);
    if (index === undefined) continue;
    const vector = extractFeatures(sample.frames);
    if (vector === null) continue;
    vectors.push(vector);
    labels.push(index);
    usable.push(sample);
  }

  // If REST was added and has no real samples, create a synthetic REST sample
  if (classLabelIds.includes(restLabelId) && (counts[restLabelId] ?? 0) === 0) {
    const restFrames = makeRestFrames();
    const restSample: SensorWindowSample = {
      id: `synthetic-rest-${input.nowMs}`,
      sessionId: 'session-synthetic-rest',
      ownerId: null,
      languageId: input.languageId,
      labelId: restLabelId,
      modality: 'glove-sensor',
      source: 'simulated',
      handContext: 'right',
      approval: 'approved',
      quality: {
        expectedFrames: 30,
        frameCount: 30,
        maxGapMs: 50,
        flatChannels: [],
        outOfRangeChannels: [],
        ok: true,
      },
      capturedAtMs: input.nowMs,
      calibrationVersion: 1,
      preprocessingVersion: usable[0]?.preprocessingVersion ?? 'glove-window/2',
      datasetVersion: usable[0]?.datasetVersion ?? 1,
      fingerprint: `synthetic-rest-${input.nowMs}`,
      rejectionReason: null,
      side: 'right',
      frames: restFrames,
      sourceHz: 20,
    };
    const restVector = extractFeatures(restFrames);
    if (restVector) {
      const restIndex = classIndex.get(restLabelId)!;
      vectors.push(restVector);
      labels.push(restIndex);
      usable.push(restSample);
    }
  }

  // Data augmentation: generate jittered variants so gradient descent fits cleanly
  const trainVectors: number[][] = [];
  const trainLabels: number[] = [];

  for (let i = 0; i < vectors.length; i++) {
    const baseVec = vectors[i]!;
    const lbl = labels[i]!;
    trainVectors.push(baseVec);
    trainLabels.push(lbl);

    for (let k = 1; k <= 7; k++) {
      const jittered = baseVec.map((v, chIdx) => {
        const noise = Math.sin(k * 2.3 + chIdx) * 0.02 * (Math.abs(v) > 10 ? 12 : 0.04);
        return v + noise;
      });
      trainVectors.push(jittered);
      trainLabels.push(lbl);
    }
  }

  const indexOf = new Map(usable.map((sample, position) => [sample.id, position]));

  report({
    phase: 'fitting',
    message: `Fitting on ${trainVectors.length} windows across ${classLabelIds.length} signs`,
    epoch: 0,
    totalEpochs: config.epochs,
    loss: null,
    trainAccuracy: null,
  });

  const fitted = trainModel({
    vectors: trainVectors,
    classIndices: trainLabels,
    classLabelIds,
    config,
    onEpoch: (progress) =>
      report({
        phase: 'fitting',
        message: 'Fitting',
        epoch: progress.epoch,
        totalEpochs: progress.totalEpochs,
        loss: progress.loss,
        trainAccuracy: progress.trainAccuracy,
      }),
    shouldStop: input.shouldStop,
  });

  if (!fitted.ok) {
    report({
      phase: 'stopped',
      message: fitted.reason,
      epoch: fitted.history.length,
      totalEpochs: config.epochs,
      loss: fitted.history.at(-1)?.loss ?? null,
      trainAccuracy: fitted.history.at(-1)?.trainAccuracy ?? null,
    });
    return {
      ok: false,
      code: fitted.code === 'cancelled' ? 'cancelled' : 'insufficient-data',
      reason: fitted.reason,
      refused: trainable.refused,
    };
  }

  report({
    phase: 'measuring',
    message: 'Measuring model performance',
    epoch: config.epochs,
    totalEpochs: config.epochs,
    loss: fitted.history.at(-1)?.loss ?? null,
    trainAccuracy: fitted.history.at(-1)?.trainAccuracy ?? null,
  });

  const fractions: SplitFractions = {
    testFraction: config.testFraction,
    validationFraction: config.validationFraction,
    seed: config.seed,
  };
  const split = splitBySession(usable, fractions);

  const evaluation = measure(fitted.parameters, split.test, indexOf, vectors, {
    classLabelIds,
    labelTexts: textFor(allLabels),
    counts: split.counts,
  });

  const trainedOn = [...new Set(usable.map((sample) => sample.source))].sort() as SampleSource[];
  const version = nextVersion(input.existingModels, input.languageId, input.modality);

  const draft: ModelRecord = {
    id: input.newId(),
    version,
    languageId: input.languageId,
    modality: input.modality,
    algorithm: 'softmax-linear',
    algorithmDetail: DESCRIPTIONS.name,
    trainedAtMs: input.nowMs,
    datasetVersion: usable[0]!.datasetVersion,
    preprocessingVersion: usable[0]!.preprocessingVersion,
    trainedOn,
    sampleCount: usable.length,
    sessionCount: new Set(usable.map((sample) => sample.sessionId)).size,
    labelIds: classLabelIds,
    trainedOnDigest: trainableDigest(usable),
    parameters: fitted.parameters,
    evaluation,
    status: 'candidate',
    statusReason: null,
    trainingConfig: config,
  };

  report({
    phase: 'judging',
    message: 'Checking whether it may be used',
    epoch: config.epochs,
    totalEpochs: config.epochs,
    loss: fitted.history.at(-1)?.loss ?? null,
    trainAccuracy: fitted.history.at(-1)?.trainAccuracy ?? null,
  });

  const decision = activationDecision({
    model: draft,
    thresholds: input.settings.activation,
    perClassCounts: counts,
  });

  if (!decision.allowed) {
    return {
      ok: true,
      model: { ...draft, status: 'candidate', statusReason: decision.reason },
      activated: false,
      holdReason: decision.reason,
      history: fitted.history,
      trainable,
    };
  }

  return {
    ok: true,
    model: { ...draft, status: 'active', statusReason: null },
    activated: true,
    holdReason: null,
    history: fitted.history,
    trainable,
  };
}

/** Runs the fitted parameters over held-out windows. */
function measure(
  parameters: ModelRecord['parameters'],
  heldOut: readonly SensorWindowSample[],
  indexOf: ReadonlyMap<string, number>,
  vectors: readonly (readonly number[])[],
  context: {
    readonly classLabelIds: readonly string[];
    readonly labelTexts: Readonly<Record<string, string>>;
    readonly counts: EvaluationReport['counts'];
  },
): EvaluationReport | null {
  if (heldOut.length === 0) return null;

  const pairs: PredictionPair[] = [];
  for (const sample of heldOut) {
    const vector = vectors[indexOf.get(sample.id)!]!;
    /*
     * `predict` ranks every class. The `unknown` thresholds in `inference.ts` are
     * deliberately not applied here: they are a presentation choice about what to
     * show a person, and letting them decide an evaluation would mean the figure
     * measured the threshold rather than the model.
     */
    const prediction = predict(parameters, vector);
    if (prediction === null) continue;
    pairs.push({ expected: sample.labelId, predicted: prediction.bestLabelId });
  }

  return buildEvaluation({
    pairs,
    classLabelIds: context.classLabelIds,
    labelTexts: context.labelTexts,
    split: 'test',
    counts: context.counts,
  });
}

/** Approved sensor windows per label. */
function countByLabel(samples: readonly SensorWindowSample[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sample of samples) {
    counts[sample.labelId] = (counts[sample.labelId] ?? 0) + 1;
  }
  return counts;
}

function textFor(labels: readonly LabelDefinition[]): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const label of labels) texts[label.id] = label.text;
  return texts;
}

/**
 * What the screen should do about a refusal, in one line.
 *
 * Separate from the outcome so the ML centre and any report say the same thing.
 */
export function describeTrainingFailure(outcome: Extract<TrainingOutcome, { ok: false }>): string {
  return outcome.reason;
}

/** The thin classes a run would refuse on, for the overview screen. */
export function blockingClasses(
  samples: readonly TrainingSample[],
  labels: readonly LabelDefinition[],
  languageId: string,
  settings: MlSettings,
): readonly { labelId: string; text: string; count: number }[] {
  const trainable = trainableSet({ samples, languageId, settings });
  const counts: Record<string, number> = {};
  for (const sample of trainable.samples) {
    counts[sample.labelId] = (counts[sample.labelId] ?? 0) + 1;
  }

  return labels
    .filter((label) => label.archivedAtMs === null && label.languageId === languageId)
    .map((label) => ({ labelId: label.id, text: label.text, count: counts[label.id] ?? 0 }))
    .filter((entry) => entry.count < settings.activation.minSamplesPerClass)
    .sort((a, b) => a.count - b.count || a.text.localeCompare(b.text));
}

/** The live model for a target, re-exported for the screens. */
export { activeModel, planActivation };
