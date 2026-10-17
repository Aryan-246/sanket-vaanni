/**
 * Measuring a model on data it did not train on — and saying what the numbers
 * do not cover.
 *
 * ## Null is not zero
 *
 * A class the model never predicted has undefined precision. Printing 0% for it
 * would be a claim — "it got every one of these wrong" — about a measurement
 * that was never made. Every figure here is therefore `number | null`, and the
 * null case is carried through to the screen as "not measured" rather than as a
 * zero. The same rule applies to overall accuracy on an empty evaluation set.
 *
 * ## The caveats are part of the result, not decoration
 *
 * Three held-out examples of a class, all from one sitting, produce a recall
 * figure that moves by 33 points on a single mistake and says more about that
 * sitting than about the sign. That is not a reason to withhold the figure; it
 * is a reason to print the support next to it and the caveat underneath. The
 * list is computed here, beside the arithmetic, so it cannot drift away from it.
 */
import type { ClassMetric, EvaluationReport } from './types';

/** One held-out example and what the model did with it. */
export interface PredictionPair {
  /** The label the user confirmed. */
  readonly expected: string;
  /** The class the model ranked highest. */
  readonly predicted: string;
}

export interface BuildEvaluationInput {
  readonly pairs: readonly PredictionPair[];
  /** Every class the model was fitted on, in the model's own order. */
  readonly classLabelIds: readonly string[];
  /** Display text per class. Missing ids fall back to the id itself. */
  readonly labelTexts: Readonly<Record<string, string>>;
  readonly split: 'test' | 'validation';
  readonly counts: EvaluationReport['counts'];
}

/**
 * Builds the evaluation report.
 *
 * Predictions naming a class the model was not fitted on are excluded from the
 * matrix and counted in a caveat instead: the matrix's rows and columns are the
 * model's classes, and putting a foreign label in one would make the row sums
 * stop equalling the support.
 */
export function buildEvaluation(input: BuildEvaluationInput): EvaluationReport {
  const { pairs, classLabelIds, labelTexts, split, counts } = input;
  const classIndex = new Map(classLabelIds.map((id, index) => [id, index]));

  const size = classLabelIds.length;
  const confusion: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  let excluded = 0;

  for (const pair of pairs) {
    const actual = classIndex.get(pair.expected);
    const predicted = classIndex.get(pair.predicted);
    if (actual === undefined || predicted === undefined) {
      excluded += 1;
      continue;
    }
    confusion[actual]![predicted] += 1;
  }

  const scored = pairs.length - excluded;

  const classes: ClassMetric[] = classLabelIds.map((labelId, index) => {
    const row = confusion[index]!;
    const support = row.reduce((sum, value) => sum + value, 0);
    const truePositive = row[index]!;

    let predictedTotal = 0;
    for (let other = 0; other < size; other += 1) predictedTotal += confusion[other]![index]!;

    const precision = predictedTotal === 0 ? null : truePositive / predictedTotal;
    const recall = support === 0 ? null : truePositive / support;
    const f1 =
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall);

    return { labelId, text: labelTexts[labelId] ?? labelId, support, precision, recall, f1 };
  });

  let correct = 0;
  for (let index = 0; index < size; index += 1) correct += confusion[index]![index]!;
  const accuracy = scored === 0 ? null : correct / scored;

  const measured = classes.map((metric) => metric.f1).filter((f1): f1 is number => f1 !== null);
  const macroF1 =
    measured.length === 0 ? null : measured.reduce((sum, f1) => sum + f1, 0) / measured.length;

  const caveats = collectCaveats({
    classes,
    accuracy,
    scored,
    excluded,
    classCount: size,
    counts,
    split,
  });

  return {
    split,
    counts,
    confusion,
    classLabels: [...classLabelIds],
    classes,
    accuracy,
    macroF1,
    caveats,
  };
}

interface CaveatInput {
  readonly classes: readonly ClassMetric[];
  readonly accuracy: number | null;
  readonly scored: number;
  readonly excluded: number;
  readonly classCount: number;
  readonly counts: EvaluationReport['counts'];
  readonly split: 'test' | 'validation';
}

function collectCaveats(input: CaveatInput): string[] {
  const caveats: string[] = [];

  if (input.scored === 0) {
    caveats.push('No labelled example was available to measure against, so no figure is reported at all.');
    return caveats;
  }

  const unseen = input.classes.filter((metric) => metric.support === 0);
  if (unseen.length > 0) {
    caveats.push(
      `${unseen.length} of the ${input.classCount} signs have no held-out example (${unseen
        .map((metric) => metric.text)
        .join(', ')}). Their precision, recall and F1 are not reported, because they were not measured.`,
    );
  }

  const thin = input.classes.filter((metric) => metric.support > 0 && metric.support < 3);
  for (const metric of thin) {
    caveats.push(
      `"${metric.text}" was measured on ${metric.support} held-out example${metric.support === 1 ? '' : 's'}, so a single mistake changes the figure a great deal.`,
    );
  }

  const supports = input.classes.map((metric) => metric.support).filter((support) => support > 0);
  if (supports.length > 1) {
    const largest = Math.max(...supports);
    const smallest = Math.min(...supports);
    if (largest >= smallest * 3) {
      caveats.push(
        'The signs are unevenly represented in the held-out data, so overall accuracy is dominated by the most common sign. The per-sign rows above are the fairer comparison.',
      );
    }
  }

  if (input.accuracy !== null && input.classCount > 1 && input.accuracy <= 1 / input.classCount) {
    caveats.push(
      `Overall accuracy is no better than the ${Math.round(100 / input.classCount)}% that choosing one sign at random would give.`,
    );
  }

  if (input.counts.testSessions <= 1) {
    caveats.push(
      'Every held-out example came from the same capture session. The model has never been tested against a different sitting.',
    );
  }

  if (input.excluded > 0) {
    caveats.push(
      `${input.excluded} held-out example${input.excluded === 1 ? '' : 's'} were left out of these figures because the model named a sign it was not trained on.`,
    );
  }

  return caveats;
}

/**
 * Overall accuracy as a sentence, or a plain statement that it was not measured.
 *
 * Used by the model card so that "accuracy" is never printed without its
 * denominator next to it.
 */
export function describeAccuracy(report: EvaluationReport): string {
  if (report.accuracy === null) {
    return 'Not measured: there was no held-out data to measure on.';
  }
  return `${Math.round(report.accuracy * 1000) / 10}% of ${report.classes.reduce((sum, metric) => sum + metric.support, 0)} held-out windows.`;
}
