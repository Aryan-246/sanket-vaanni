/**
 * The learning pipeline's arithmetic and its refusals.
 *
 * Every figure asserted here is computed from the generated fixtures in
 * `mlFixtures.ts`, which are test data and not a recording of anybody signing.
 * Where an accuracy is checked, it is checked as a property — "the model learned
 * to separate these three well-separated classes", "the held-out figure is worse
 * than the training figure" — never as a number that claims to describe real
 * performance.
 */
import { buildWindow, qualityNote, MAX_GAP_MS } from '../src/ml/window';
import {
  FEATURE_SPEC,
  FEATURE_COUNT,
  extractFeatures,
  fitStandardisation,
  standardise,
  matchesSpec,
} from '../src/ml/features';
import { splitBySession, leakedSessions } from '../src/ml/split';
import { buildEvaluation } from '../src/ml/metrics';
import {
  trainModel,
  predict,
  DEFAULT_TRAINING_CONFIG,
  DESCRIPTIONS,
} from '../src/ml/classifier';
import {
  activationDecision,
  activeModel,
  nextVersion,
  planActivation,
  modelCard,
  pruneTarget,
} from '../src/ml/modelStore';
import { runTraining } from '../src/ml/training';
import { inferFromFrames, SCORE_NOTE } from '../src/ml/inference';
import { DEFAULT_ML_SETTINGS } from '../src/ml/types';
import type { EvaluationReport, ModelRecord } from '../src/ml/types';
import { makeDataset, makeLabels, makeRun, windowBetween, windowFor } from './mlFixtures';

const SIGNS = ['sign-a', 'sign-b', 'sign-c'];

/* --------------------------------------------------------------- windowing */

describe('windows', () => {
  it('resamples a run to exactly the frame count a model expects', () => {
    const built = buildWindow(makeRun('sign-a', 0, { frames: 47 }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.frames).toHaveLength(30);
  });

  it('spans the run it was given, starting at zero and ending at the end', () => {
    const built = buildWindow(makeRun('sign-a', 1_000, { frames: 40, hz: 20 }));
    if (!built.ok) throw new Error(built.reason);
    expect(built.frames[0]!.tMs).toBe(0);
    // 39 intervals at 20 Hz = 1950 ms of captured span.
    expect(built.frames.at(-1)!.tMs).toBe(1950);
  });

  it('records the real frame count rather than the resampled one', () => {
    const built = buildWindow(makeRun('sign-a', 0, { frames: 12 }));
    if (!built.ok) throw new Error(built.reason);
    expect(built.quality.frameCount).toBe(12);
    expect(built.quality.expectedFrames).toBe(30);
    expect(qualityNote(built.quality)).toMatch(/interpolated/i);
  });

  it('refuses a run too short to be a window', () => {
    const built = buildWindow(makeRun('sign-a', 0, { frames: 4 }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('too-few-frames');
  });

  it('refuses a dropout rather than interpolating across it', () => {
    const run = makeRun('sign-a', 0, { frames: 30 });
    // A 400 ms hole in the middle, longer than a window may span.
    const gapped = [
      ...run.slice(0, 12),
      ...run.slice(12).map((sample) => ({ ...sample, timestampMs: sample.timestampMs + 400 })),
    ];

    const built = buildWindow(gapped);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('gap-too-large');
    expect(450).toBeGreaterThan(MAX_GAP_MS);
  });

  it('refuses a run whose timestamps do not advance', () => {
    const run = makeRun('sign-a', 0, { frames: 20 }).map((sample) => ({
      ...sample,
      timestampMs: 500,
    }));
    const built = buildWindow(run);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe('flat-duration');
  });

  it('calls a stream where no flex channel moved frozen, not a held hand', () => {
    const run = makeRun('sign-a', 0, { frames: 30 }).map((sample) => ({
      ...sample,
      flex: [0.2, 0.2, 0.2, 0.2, 0.2] as typeof sample.flex,
    }));
    const built = buildWindow(run);
    if (!built.ok) throw new Error(built.reason);
    expect(built.quality.flatChannels).toHaveLength(5);
    expect(built.quality.ok).toBe(false);
    expect(qualityNote(built.quality)).toMatch(/stopped stream/i);
  });

  it('accepts a window where one channel is legitimately still', () => {
    const run = makeRun('sign-a', 0, { frames: 30 }).map((sample) => ({
      ...sample,
      flex: [sample.flex[0], 0.5, 0.5, 0.5, 0.5] as typeof sample.flex,
    }));
    const built = buildWindow(run);
    if (!built.ok) throw new Error(built.reason);
    expect(built.quality.flatChannels).toHaveLength(4);
    expect(built.quality.ok).toBe(true);
  });

  it('flags flex values that left the calibrated range', () => {
    const run = makeRun('sign-a', 0, { frames: 30 }).map((sample) => ({
      ...sample,
      flex: [1.6, sample.flex[1], sample.flex[2], sample.flex[3], sample.flex[4]] as typeof sample.flex,
    }));
    const built = buildWindow(run);
    if (!built.ok) throw new Error(built.reason);
    expect(built.quality.outOfRangeChannels).toEqual([0]);
    expect(built.quality.ok).toBe(false);
    expect(qualityNote(built.quality)).toMatch(/recalibrate/i);
  });

  it('orders frames by time, not by arrival', () => {
    const run = makeRun('sign-a', 0, { frames: 20 });
    const shuffled = [...run].reverse();
    const ordered = buildWindow(run);
    const fromShuffled = buildWindow(shuffled);
    if (!ordered.ok || !fromShuffled.ok) throw new Error('refused');
    expect(fromShuffled.frames).toEqual(ordered.frames);
  });
});

/* ---------------------------------------------------------------- features */

describe('features', () => {
  it('names one feature per channel and statistic, in a fixed order', () => {
    expect(FEATURE_COUNT).toBe(55);
    expect(FEATURE_SPEC.names[0]).toBe('flex.thumb.mean');
    expect(FEATURE_SPEC.names).toHaveLength(55);
    expect(new Set(FEATURE_SPEC.names).size).toBe(55);
  });

  it('is deterministic for the same window', () => {
    const frames = windowFor('sign-a');
    expect(extractFeatures(frames)).toEqual(extractFeatures(frames));
  });

  it('separates the fixture signs in feature space', () => {
    const a = extractFeatures(windowFor('sign-a'))!;
    const b = extractFeatures(windowFor('sign-b'))!;
    const distance = Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]!) ** 2, 0));
    expect(distance).toBeGreaterThan(0.3);
  });

  it('returns null for a window with no frames, rather than zeros', () => {
    // Zeros mean "every channel still at zero", which a glove can produce.
    expect(extractFeatures([])).toBeNull();
  });

  it('standardises with the mean and scale it was given, treating zero scale as one', () => {
    const vectors = [
      [1, 5, 9],
      [3, 5, 9],
    ];
    const { mean, scale } = fitStandardisation(vectors);
    expect(mean[0]).toBeCloseTo(2);
    // Population spread about the mean of 2: the two values sit one unit either
    // side, so the scale is 1 and 3 standardises to 1.
    expect(scale[0]).toBeCloseTo(1);
    // The second and third features never varied. Their scale must be 1 rather
    // than 0, or every standardised value would be NaN or infinite.
    expect(scale[1]).toBe(1);
    expect(scale[2]).toBe(1);

    const standardised = standardise([3, 5, 9], mean, scale);
    expect(standardised[0]).toBeCloseTo(1);
    expect(standardised[1]).toBe(0);
    expect(standardised[2]).toBe(0);
    expect(standardised.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('refuses a vector built for a different feature layout', () => {
    expect(matchesSpec(FEATURE_SPEC, new Array(FEATURE_COUNT).fill(0))).toBe(true);
    expect(matchesSpec(FEATURE_SPEC, [1, 2, 3])).toBe(false);
    expect(matchesSpec({ ...FEATURE_SPEC, version: 'other/9' }, [])).toBe(false);
  });
});

/* ------------------------------------------------------------------ splits */

describe('splitting', () => {
  it('keeps every session on exactly one side', () => {
    const split = splitBySession(makeDataset({ signs: SIGNS, sessions: 5, perSign: 4 }));
    expect(leakedSessions(split)).toEqual([]);
  });

  it('puts every window of a session on the same side', () => {
    const split = splitBySession(makeDataset({ signs: SIGNS, sessions: 5, perSign: 4 }));
    const sessionOf = (group: typeof split.train) => new Set(group.map((s) => s.sessionId));
    const train = sessionOf(split.train);
    for (const session of [...sessionOf(split.test), ...sessionOf(split.validation)]) {
      expect(train.has(session)).toBe(false);
    }
  });

  it('is the same split every time for the same seed', () => {
    const samples = makeDataset({ signs: SIGNS, sessions: 6, perSign: 3 });
    const first = splitBySession(samples, { testFraction: 0.3, validationFraction: 0, seed: 7 });
    const second = splitBySession(samples, { testFraction: 0.3, validationFraction: 0, seed: 7 });
    expect(second.test.map((s) => s.id)).toEqual(first.test.map((s) => s.id));
  });

  it('changes the split when the seed changes', () => {
    const samples = makeDataset({ signs: SIGNS, sessions: 6, perSign: 3 });
    const first = splitBySession(samples, { testFraction: 0.3, validationFraction: 0, seed: 1 });
    const second = splitBySession(samples, { testFraction: 0.3, validationFraction: 0, seed: 2 });
    expect(second.test.map((s) => s.id)).not.toEqual(first.test.map((s) => s.id));
  });

  it('always leaves something to train on, however large the test fraction', () => {
    const samples = makeDataset({ signs: SIGNS, sessions: 3, perSign: 2 });
    const split = splitBySession(samples, { testFraction: 0.95, validationFraction: 0, seed: 1 });
    expect(split.train.length).toBeGreaterThan(0);
    expect(leakedSessions(split)).toEqual([]);
  });

  it('never hands training an empty set, for any shape of dataset', () => {
    // The bug this pins: with a single capture session the split put the only
    // session into the test side, so a first training run failed with "there was
    // nothing labelled to train on" instead of asking for a second sitting.
    for (const sessions of [1, 2, 3, 4, 5, 9]) {
      for (const perSign of [1, 2, 7]) {
        for (const testFraction of [0, 0.1, 0.5, 0.95, 1]) {
          const samples = makeDataset({ signs: SIGNS, sessions, perSign });
          const split = splitBySession(samples, { testFraction, validationFraction: 0, seed: 1 });

          expect(split.train.length).toBeGreaterThan(0);
          expect(split.train.length + split.validation.length + split.test.length).toBe(samples.length);
          expect(leakedSessions(split)).toEqual([]);
        }
      }
    }
  });

  it('says so when a single session was held out', () => {
    /*
     * Three sittings of three windows each. The test target is therefore three
     * windows, which the first session exactly fills, so the next session cannot
     * be taken without exceeding it — exactly one sitting is held out.
     */
    const split = splitBySession(makeDataset({ signs: SIGNS, sessions: 3, perSign: 1 }));
    expect(split.counts.testSessions).toBe(1);
    expect(split.counts.train).toBeGreaterThan(0);
    expect(split.caveats.join(' ')).toMatch(/single capture session/i);
  });

  it('trains on the only session it has, and says nothing was measured', () => {
    // One sitting cannot be split without leaking, so all of it trains. The
    // split must never hand training an empty set: that would fail the run with
    // "nothing to train on" instead of telling the user to capture a second day.
    const split = splitBySession(makeDataset({ signs: SIGNS, sessions: 1, perSign: 3 }));
    expect(split.train).toHaveLength(9);
    expect(split.test).toHaveLength(0);
    expect(split.caveats.join(' ')).toMatch(/No session was held out/i);
    expect(split.caveats.join(' ')).toMatch(/a second session/i);
  });
});

/* ----------------------------------------------------------------- metrics */

describe('metrics', () => {
  const classLabelIds = ['a', 'b'];
  const labelTexts = { a: 'A', b: 'B' };
  const counts = { train: 4, validation: 0, test: 2, trainSessions: 2, testSessions: 1 };

  it('builds a confusion matrix in the model’s own class order', () => {
    const report = buildEvaluation({
      pairs: [
        { expected: 'a', predicted: 'a' },
        { expected: 'b', predicted: 'a' },
      ],
      classLabelIds,
      labelTexts,
      split: 'test',
      counts,
    });

    expect(report.confusion).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(report.accuracy).toBe(0.5);
  });

  it('reports precision as null, not zero, for a class never predicted', () => {
    const report = buildEvaluation({
      pairs: [{ expected: 'a', predicted: 'a' }],
      classLabelIds,
      labelTexts,
      split: 'test',
      counts,
    });

    const b = report.classes.find((metric) => metric.labelId === 'b')!;
    expect(b.support).toBe(0);
    expect(b.precision).toBeNull();
    expect(b.recall).toBeNull();
    expect(b.f1).toBeNull();
    expect(report.caveats.join(' ')).toMatch(/no held-out example/i);
  });

  it('reports no accuracy at all when there is nothing to measure on', () => {
    const report = buildEvaluation({
      pairs: [],
      classLabelIds,
      labelTexts,
      split: 'test',
      counts,
    });
    expect(report.accuracy).toBeNull();
    expect(report.macroF1).toBeNull();
    expect(report.caveats.join(' ')).toMatch(/no labelled example/i);
  });

  it('warns that a class measured on one example is fragile', () => {
    const report = buildEvaluation({
      pairs: [{ expected: 'a', predicted: 'a' }],
      classLabelIds,
      labelTexts,
      split: 'test',
      counts,
    });
    expect(report.caveats.join(' ')).toMatch(/single mistake changes the figure/i);
  });

  it('warns when accuracy is no better than chance', () => {
    const report = buildEvaluation({
      pairs: [
        { expected: 'a', predicted: 'b' },
        { expected: 'b', predicted: 'b' },
      ],
      classLabelIds,
      labelTexts,
      split: 'test',
      counts,
    });
    expect(report.caveats.join(' ')).toMatch(/choosing one sign at random/i);
  });

  it('excludes a prediction naming a class the model was not fitted on, and says so', () => {
    const report = buildEvaluation({
      pairs: [
        { expected: 'a', predicted: 'a' },
        { expected: 'b', predicted: 'ghost' },
      ],
      classLabelIds,
      labelTexts,
      split: 'test',
      counts,
    });
    expect(report.accuracy).toBe(1);
    expect(report.caveats.join(' ')).toMatch(/named a sign it was not trained on/i);
  });
});

/* -------------------------------------------------------------- classifier */

describe('the classifier', () => {
  const dataset = makeDataset({ signs: SIGNS, sessions: 4, perSign: 4, source: 'glove' });
  const labelIds = SIGNS;

  function vectorsFor(samples: typeof dataset): number[][] {
    return samples.map((sample) => extractFeatures(sample.frames)!);
  }

  const indexOf = new Map(labelIds.map((id, index) => [id, index]));
  const vectors = vectorsFor(dataset);
  const classIndices = dataset.map((sample) => indexOf.get(sample.labelId)!);

  it('reduces the loss as it fits, epoch by epoch, and never reports a fabricated one', () => {
    const seen: number[] = [];
    const outcome = trainModel({
      vectors,
      classIndices,
      classLabelIds: labelIds,
      config: { ...DEFAULT_TRAINING_CONFIG, epochs: 30 },
      onEpoch: (progress) => seen.push(progress.loss),
    });

    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(30);
    expect(seen.at(-1)!).toBeLessThan(seen[0]!);
    expect(seen.every((loss) => Number.isFinite(loss))).toBe(true);
  });

  it('learns to separate three well-separated fixture signs', () => {
    const outcome = trainModel({ vectors, classIndices, classLabelIds: labelIds });
    if (!outcome.ok) throw new Error(outcome.reason);

    const correct = vectors.filter((vector, index) => {
      const prediction = predict(outcome.parameters, vector);
      return prediction?.bestLabelId === dataset[index]!.labelId;
    });
    expect(correct.length).toBe(vectors.length);
    expect(outcome.history.at(-1)!.trainAccuracy).toBe(1);
  });

  it('refuses to train on a single class', () => {
    const outcome = trainModel({
      vectors,
      classIndices,
      classLabelIds: ['only-one'],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('single-class');
    expect(outcome.reason).toMatch(/nothing to tell it apart from/i);
  });

  it('refuses to train on nothing', () => {
    const outcome = trainModel({ vectors: [], classIndices: [], classLabelIds: labelIds });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('no-data');
  });

  it('returns no parameters at all when it is stopped, so nothing can overwrite a model', () => {
    const outcome = trainModel({
      vectors,
      classIndices,
      classLabelIds: labelIds,
      config: { ...DEFAULT_TRAINING_CONFIG, epochs: 500 },
      shouldStop: () => true,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('cancelled');
    expect('parameters' in outcome).toBe(false);
  });

  it('refuses a vector whose length does not match the model', () => {
    const outcome = trainModel({ vectors, classIndices, classLabelIds: labelIds });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(predict(outcome.parameters, [1, 2, 3])).toBeNull();
    expect(
      predict(
        { ...outcome.parameters, featureSpec: { ...FEATURE_SPEC, version: 'from-another-build' } },
        vectors[0]!,
      ),
    ).toBeNull();
  });

  it('scores every class, so something can be said about the alternatives', () => {
    const outcome = trainModel({ vectors, classIndices, classLabelIds: labelIds });
    if (!outcome.ok) throw new Error(outcome.reason);
    const prediction = predict(outcome.parameters, vectors[0]!)!;
    expect(prediction.scores).toHaveLength(3);
    expect(prediction.scores.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    expect(prediction.margin).toBeCloseTo(prediction.bestScore - prediction.runnerUpScore, 6);
  });

  it('describes itself as what it is, and says what it is not', () => {
    expect(DESCRIPTIONS.algorithm).toBe('softmax-linear');
    expect(DESCRIPTIONS.detail).toMatch(/no hidden layers/i);
    expect(DESCRIPTIONS.notClaimed.join(' ')).toMatch(/not a neural network/i);
    expect(DESCRIPTIONS.notClaimed.join(' ')).toMatch(/not calibrated probabilities/i);
  });
});

/* ------------------------------------------------------------- model gates */

describe('the activation gate', () => {
  const baseModel = (overrides: Partial<ModelRecord> = {}): ModelRecord => {
    const outcome = trainModel({
      vectors: makeDataset({ signs: SIGNS, sessions: 4, perSign: 4, source: 'glove' }).map(
        (sample) => extractFeatures(sample.frames)!,
      ),
      classIndices: makeDataset({ signs: SIGNS, sessions: 4, perSign: 4, source: 'glove' }).map(
        (sample) => SIGNS.indexOf(sample.labelId),
      ),
      classLabelIds: SIGNS,
      config: { ...DEFAULT_TRAINING_CONFIG, epochs: 20 },
    });
    if (!outcome.ok) throw new Error(outcome.reason);

    return {
      id: 'model-1',
      version: 1,
      languageId: 'isl',
      modality: 'glove-sensor',
      algorithm: 'softmax-linear',
      algorithmDetail: DESCRIPTIONS.name,
      trainedAtMs: 1_000,
      datasetVersion: 1,
      preprocessingVersion: 'glove-window/1',
      trainedOn: ['glove'],
      sampleCount: 48,
      sessionCount: 4,
      labelIds: SIGNS,
      parameters: outcome.parameters,
      evaluation: healthyEvaluation(),
      status: 'candidate',
      statusReason: null,
      trainingConfig: DEFAULT_TRAINING_CONFIG,
      ...overrides,
    };
  };

  function healthyEvaluation(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
    return {
      split: 'test',
      counts: { train: 30, validation: 0, test: 18, trainSessions: 3, testSessions: 1 },
      confusion: [
        [6, 0, 0],
        [0, 6, 0],
        [0, 0, 6],
      ],
      classLabels: SIGNS,
      classes: SIGNS.map((labelId) => ({
        labelId,
        text: labelId,
        support: 6,
        precision: 1,
        recall: 1,
        f1: 1,
      })),
      accuracy: 1,
      macroF1: 1,
      caveats: [],
      ...overrides,
    };
  }

  const perClass = { 'sign-a': 5, 'sign-b': 5, 'sign-c': 5 };

  it('allows a measured model that clears the floor', () => {
    const decision = activationDecision({
      model: baseModel(),
      thresholds: DEFAULT_ML_SETTINGS.activation,
      perClassCounts: perClass,
    });
    expect(decision.allowed).toBe(true);
  });

  it('refuses a model that was never measured', () => {
    const decision = activationDecision({
      model: baseModel({ evaluation: null }),
      thresholds: DEFAULT_ML_SETTINGS.activation,
      perClassCounts: perClass,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toMatch(/not been measured/i);
  });

  it('refuses a model below the accuracy floor, quoting the figure', () => {
    const decision = activationDecision({
      model: baseModel({ evaluation: healthyEvaluation({ accuracy: 0.2 }) }),
      thresholds: DEFAULT_ML_SETTINGS.activation,
      perClassCounts: perClass,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toMatch(/20%/);
    expect(decision.reason).toMatch(/below the 60%/);
  });

  it('refuses a sign that never had enough examples to be learned', () => {
    const decision = activationDecision({
      model: baseModel(),
      thresholds: DEFAULT_ML_SETTINGS.activation,
      perClassCounts: { ...perClass, 'sign-c': 1 },
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toMatch(/One of the 3 signs has fewer than 3 confirmed examples/i);
  });

  it('refuses a sign that was never held out for testing', () => {
    const evaluation = healthyEvaluation();
    const classes = evaluation.classes.map((metric) =>
      metric.labelId === 'sign-c' ? { ...metric, support: 0, precision: null, recall: null, f1: null } : metric,
    );
    const decision = activationDecision({
      model: baseModel({ evaluation: { ...evaluation, classes } }),
      thresholds: DEFAULT_ML_SETTINGS.activation,
      perClassCounts: perClass,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toMatch(/never held out for testing/i);
  });

  it('refuses a model measured only on its validation split', () => {
    const decision = activationDecision({
      model: baseModel({ evaluation: healthyEvaluation({ split: 'validation' }) }),
      thresholds: DEFAULT_ML_SETTINGS.activation,
      perClassCounts: perClass,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toMatch(/test split/i);
  });

  it('numbers a target’s versions one-based and never reuses one', () => {
    expect(nextVersion([], 'isl', 'glove-sensor')).toBe(1);
    const models = [baseModel({ version: 1, status: 'active' }), baseModel({ id: 'm2', version: 2 })];
    expect(nextVersion(models, 'isl', 'glove-sensor')).toBe(3);
  });

  it('plans activation as a swap that can be undone', () => {
    const v1 = baseModel({ version: 1, status: 'active' });
    const v2 = baseModel({ id: 'model-2', version: 2 });

    const plan = planActivation([v1, v2], v2);
    expect(plan.retire?.id).toBe('model-1');
    expect(plan.rollbackTo?.id).toBe('model-1');
  });

  it('never prunes the version that is in use', () => {
    const models = Array.from({ length: 8 }, (_, index) =>
      baseModel({ id: `m${index}`, version: index + 1, status: index === 0 ? 'active' : 'candidate' }),
    );
    const kept = pruneTarget(models, 'isl', 'glove-sensor', 3);
    expect(kept.some((model) => model.id === 'm0')).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(3);
  });

  it('finds the live version and nothing else', () => {
    const models = [baseModel({ version: 1, status: 'active' }), baseModel({ id: 'm2', version: 2 })];
    expect(activeModel(models, 'isl', 'glove-sensor')?.id).toBe('model-1');
    expect(activeModel(models, 'asl', 'glove-sensor')).toBeNull();
  });
});

/* --------------------------------------------------------------- the card */

describe('the model card', () => {
  it('says a model was not measured rather than leaving the figure blank', () => {
    const card = modelCard(
      {
        id: 'm',
        version: 2,
        languageId: 'isl',
        modality: 'glove-sensor',
        algorithm: 'softmax-linear',
        algorithmDetail: DESCRIPTIONS.name,
        trainedAtMs: Date.UTC(2026, 0, 1),
        datasetVersion: 1,
        preprocessingVersion: 'glove-window/1',
        trainedOn: ['simulated'],
        sampleCount: 12,
        sessionCount: 2,
        labelIds: ['sign-a', 'sign-b'],
        parameters: {
          kind: 'softmax-linear',
          featureSpec: FEATURE_SPEC,
          weights: [],
          biases: [],
          classLabelIds: ['sign-a', 'sign-b'],
          standardisation: { mean: [], scale: [] },
        },
        evaluation: null,
        status: 'candidate',
        statusReason: 'not measured',
        trainingConfig: DEFAULT_TRAINING_CONFIG,
      },
      makeLabels(['sign-a', 'sign-b']),
      Date.UTC(2026, 0, 3),
    );

    expect(card.lines.find((line) => line.label === 'Measured on')?.value).toBe('Not measured');
    expect(card.status).toBe('Not in use');
    expect(card.statusNote).toBe('not measured');
  });

  it('says a Demo Mode model recognises the simulation and not signing', () => {
    const card = modelCard(
      {
        id: 'm',
        version: 1,
        languageId: 'isl',
        modality: 'glove-sensor',
        algorithm: 'softmax-linear',
        algorithmDetail: DESCRIPTIONS.name,
        trainedAtMs: Date.UTC(2026, 0, 1),
        datasetVersion: 1,
        preprocessingVersion: 'glove-window/1',
        trainedOn: ['simulated'],
        sampleCount: 12,
        sessionCount: 2,
        labelIds: ['sign-a'],
        parameters: {
          kind: 'softmax-linear',
          featureSpec: FEATURE_SPEC,
          weights: [],
          biases: [],
          classLabelIds: ['sign-a'],
          standardisation: { mean: [], scale: [] },
        },
        evaluation: null,
        status: 'active',
        statusReason: null,
        trainingConfig: DEFAULT_TRAINING_CONFIG,
      },
      makeLabels(['sign-a']),
      0,
    );

    expect(card.caveats.join(' ')).toMatch(/simulated motion only/i);
    expect(card.caveats.join(' ')).toMatch(/not calibrated probabilities/i);
    expect(card.lines.find((line) => line.label === 'Recorded from')?.value).toMatch(/Demo Mode/);
  });
});

/* -------------------------------------------------------------- training */

describe('a training run', () => {
  const settings = {
    ...DEFAULT_ML_SETTINGS,
    allowCollectedDataForTraining: true,
    allowSimulatedTraining: true,
  };

  function run(samples = makeDataset({ signs: SIGNS, sessions: 4, perSign: 4, source: 'simulated' })) {
    return runTraining({
      samples,
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings,
      existingModels: [],
      nowMs: 5_000,
      newId: () => 'model-1',
      config: { ...DEFAULT_TRAINING_CONFIG, epochs: 40 },
    });
  }

  it('refuses when the user has not allowed their recordings to be used', () => {
    const outcome = runTraining({
      samples: makeDataset({ signs: SIGNS, sessions: 3, perSign: 3, source: 'glove' }),
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings: DEFAULT_ML_SETTINGS,
      existingModels: [],
      nowMs: 0,
      newId: () => 'm',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('insufficient-data');
    expect(outcome.reason).toMatch(/not allowed it|have not allowed/i);
  });

  it('refuses when nothing has been recorded, and says what to do', () => {
    const outcome = runTraining({
      samples: [],
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings,
      existingModels: [],
      nowMs: 0,
      newId: () => 'm',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/No window has been recorded yet/i);
  });

  it('refuses when a sign has too few confirmed windows', () => {
    const samples = makeDataset({ signs: SIGNS, sessions: 1, perSign: 2, source: 'glove' });
    expect(samples.length).toBe(6);

    const thin = runTraining({
      samples,
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings,
      existingModels: [],
      nowMs: 0,
      newId: () => 'm',
    });

    expect(thin.ok).toBe(false);
    if (thin.ok) return;
    expect(thin.reason).toMatch(/fewer than the 3 confirmed windows/i);
  });

  it('keeps unconfirmed windows out of the run entirely', () => {
    const mixed = [
      ...makeDataset({ signs: SIGNS, sessions: 3, perSign: 3, source: 'glove' }),
      ...makeDataset({ signs: SIGNS, sessions: 1, perSign: 5, source: 'glove', approval: 'pending' }),
    ];

    const outcome = runTraining({
      samples: mixed,
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings,
      existingModels: [],
      nowMs: 0,
      newId: () => 'm',
      config: { ...DEFAULT_TRAINING_CONFIG, epochs: 10 },
    });

    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.trainable.refused.some((refusal) => refusal.code === 'not-confirmed')).toBe(true);
    expect(outcome.trainable.samples.every((sample) => sample.approval === 'approved')).toBe(true);
  });

  it('produces a version measured on sessions it did not train on', () => {
    const outcome = run();
    if (!outcome.ok) throw new Error(outcome.reason);

    expect(outcome.model.evaluation).not.toBeNull();
    expect(outcome.model.evaluation!.split).toBe('test');
    expect(outcome.model.evaluation!.counts.testSessions).toBeGreaterThan(0);
    expect(outcome.model.sampleCount).toBe(48);
    expect(outcome.model.sessionCount).toBe(4);
  });

  it('records that the data was simulated, so the card can say so', () => {
    const outcome = run();
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.model.trainedOn).toEqual(['simulated']);
  });

  it('does not activate a model it cannot defend, and says what held it back', () => {
    const outcome = runTraining({
      samples: makeDataset({ signs: SIGNS, sessions: 1, perSign: 50, source: 'glove' }),
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings,
      existingModels: [],
      nowMs: 0,
      newId: () => 'm',
      config: { ...DEFAULT_TRAINING_CONFIG, epochs: 10 },
    });

    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.activated).toBe(false);
    expect(outcome.holdReason).toMatch(/held out|measured/i);
    expect(outcome.model.status).toBe('candidate');
    expect(outcome.model.evaluation).toBeNull();
  });

  it('reports progress it measured, not a timer', () => {
    const seen: number[] = [];
    runTraining({
      samples: makeDataset({ signs: SIGNS, sessions: 4, perSign: 4, source: 'glove' }),
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings,
      existingModels: [],
      nowMs: 0,
      newId: () => 'm',
      config: { ...DEFAULT_TRAINING_CONFIG, epochs: 25 },
      onProgress: (progress) => {
        if (progress.phase === 'fitting' && progress.loss !== null) seen.push(progress.epoch);
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)!).toBe(25);
  });

  it('stops when asked, leaving nothing to store', () => {
    const outcome = runTraining({
      samples: makeDataset({ signs: SIGNS, sessions: 4, perSign: 4, source: 'glove' }),
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings,
      existingModels: [],
      nowMs: 0,
      newId: () => 'm',
      shouldStop: () => true,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('cancelled');
    expect(outcome.reason).toMatch(/previous model is still in use/i);
  });

  it('numbers a second version after the first', () => {
    const first = run();
    if (!first.ok) throw new Error(first.reason);

    const second = runTraining({
      samples: makeDataset({ signs: SIGNS, sessions: 4, perSign: 4, source: 'glove' }),
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings,
      existingModels: [first.model],
      nowMs: 0,
      newId: () => 'model-2',
      config: { ...DEFAULT_TRAINING_CONFIG, epochs: 5 },
    });

    if (!second.ok) throw new Error(second.reason);
    expect(second.model.version).toBe(2);
  });
});

/* ------------------------------------------------------------- inference */

describe('live inference', () => {
  const settings = {
    ...DEFAULT_ML_SETTINGS,
    allowCollectedDataForTraining: true,
    allowSimulatedTraining: true,
  };

  const trained = (() => {
    const outcome = runTraining({
      samples: makeDataset({ signs: SIGNS, sessions: 6, perSign: 6, source: 'glove' }),
      languageId: 'isl',
      modality: 'glove-sensor',
      labels: makeLabels(SIGNS),
      settings,
      existingModels: [],
      nowMs: 0,
      newId: () => 'model-1',
      config: { ...DEFAULT_TRAINING_CONFIG, epochs: 60 },
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome.model;
  })();

  const labels = makeLabels(SIGNS);

  it('says there is no model rather than guessing one', () => {
    const outcome = inferFromFrames({ frames: windowFor('sign-a'), model: null, labels, settings });
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind !== 'unknown') return;
    expect(outcome.reason).toBe('no-model');
    expect(outcome.nearest).toBeNull();
  });

  it('will not recognise with a model that is not switched on', () => {
    const outcome = inferFromFrames({
      frames: windowFor('sign-a'),
      model: { ...trained, status: 'candidate' },
      labels,
      settings,
    });
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind !== 'unknown') return;
    expect(outcome.reason).toBe('no-active-model');
  });

  it('names a sign it recognises, and shows what it was chosen over', () => {
    const outcome = inferFromFrames({
      frames: windowFor('sign-b'),
      model: trained,
      labels,
      settings,
    });
    expect(outcome.kind).toBe('sign');
    if (outcome.kind !== 'sign') return;
    expect(outcome.label.labelId).toBe('sign-b');
    expect(outcome.alternatives.length).toBe(3);
    expect(outcome.alternatives[0]!.labelId).toBe('sign-b');
    expect(outcome.margin).toBeGreaterThan(0);
  });

  it('refuses to name a movement that sits between two taught signs', () => {
    // Half sign-a, half sign-b. The model must answer with one of them; the
    // honest answer is that it cannot tell, and "not sure" is not a failure.
    const outcome = inferFromFrames({
      frames: windowBetween('sign-a', 'sign-b'),
      model: trained,
      labels,
      settings,
    });

    if (outcome.kind === 'sign') {
      throw new Error(
        `named ${outcome.label.labelId} with a margin of ${outcome.margin} — the fixture no longer sits between the classes`,
      );
    }

    // Either rule may stop it, depending on the figures: the blend is unlike
    // either taught sign, so the floor usually catches it first.
    expect(['too-close', 'below-floor']).toContain(outcome.reason);
    expect(outcome.nearest).not.toBeNull();
    expect(outcome.detail).toMatch(/closest sign scored|Two signs scored within/i);
    expect(outcome.alternatives).toHaveLength(3);
  });

  it('declines on separation when the floor is not what stops it', () => {
    // With the floor switched off, the only thing that can prevent a name is the
    // gap between the top two — and a blend of two taught signs has almost none.
    const outcome = inferFromFrames({
      frames: windowBetween('sign-a', 'sign-b'),
      model: trained,
      labels,
      settings: { ...settings, unknownScore: 0 },
    });

    expect(outcome.kind).toBe('unknown');
    if (outcome.kind !== 'unknown') return;
    expect(outcome.reason).toBe('too-close');
    expect(outcome.margin).not.toBeNull();
    expect(outcome.margin!).toBeLessThan(settings.unknownMargin);
    expect(['sign-a', 'sign-b', 'sign-c']).toContain(outcome.nearest?.labelId);
    expect(outcome.detail).toMatch(/closer than the 0.1 separation you asked for/i);
  });

  it('refuses to name a sign when the best score is below the floor', () => {
    const outcome = inferFromFrames({
      frames: windowFor('sign-a'),
      model: trained,
      labels,
      settings: { ...settings, unknownScore: 0.999 },
    });
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind !== 'unknown') return;
    expect(outcome.reason).toBe('below-floor');
  });

  it('says it is still collecting rather than recognising a half window', () => {
    const frames = windowFor('sign-a').slice(0, 10);
    const outcome = inferFromFrames({ frames, model: trained, labels, settings });
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind !== 'unknown') return;
    expect(outcome.reason).toBe('collecting');
    expect(outcome.detail).toMatch(/10 of 30/);
  });

  it('writes down that a score is not a probability', () => {
    expect(SCORE_NOTE).toMatch(/not probabilities/i);
    expect(SCORE_NOTE).toMatch(/0\.8/);
  });

  it('marks a model from another pipeline as unreadable rather than scoring it', () => {
    const outcome = inferFromFrames({
      frames: windowFor('sign-a'),
      model: {
        ...trained,
        parameters: {
          ...trained.parameters,
          featureSpec: { ...FEATURE_SPEC, version: 'glove-window/0' },
        },
      },
      labels,
      settings,
    });
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind !== 'unknown') return;
    expect(outcome.reason).toBe('incompatible-model');
  });
});
