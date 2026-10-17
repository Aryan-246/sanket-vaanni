/**
 * Model versions: which one is live, whether a candidate may become live, and
 * what the record says about itself.
 *
 * ## The gate is separate from the training
 *
 * Training produces parameters. Whether those parameters are allowed to answer
 * for a person's signing is a different question, and it is a question about
 * *evidence* rather than about loss. So the gate lives here, takes the evaluation
 * report as its input, and refuses in named ways:
 *
 * - nothing was held out, so no figure exists;
 * - a sign in the model was never tested;
 * - the held-out figure is worse than the agreement floor the user set;
 * - a sign had too few examples to have been learned at all.
 *
 * A refused model is still stored, as a `candidate`, with the reason attached.
 * Deleting it would destroy the evidence of the attempt; activating it would be
 * the failure this file exists to prevent.
 *
 * ## Activation is one step and reversible
 *
 * Activating a version retires the one before it — nothing is deleted, so
 * rolling back is re-activating a stored record rather than retraining. This is
 * what makes "failed training leaves the previous model in place" true even when
 * the training *succeeded* and its result was simply not good enough.
 *
 * ## Not a calibration
 *
 * The scores a model produces are softmax outputs from an uncalibrated linear
 * fit. Nothing here may describe them as probabilities, and the model card says
 * so in as many words.
 */
import type {
  ActivationThresholds,
  EvaluationReport,
  LabelDefinition,
  ModelRecord,
  Modality,
} from './types';

export interface ActivationInput {
  readonly model: ModelRecord;
  readonly thresholds: ActivationThresholds;
  /** Approved example counts per label, as used for training. */
  readonly perClassCounts: Readonly<Record<string, number>>;
}

export type ActivationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Whether this model may answer for real people.
 *
 * The order is deliberate: the reasons are checked from "nothing was measured"
 * towards "it was measured and is not good enough", because the first is a
 * missing step the user can complete and the last is a result they must accept.
 */
export function activationDecision(input: ActivationInput): ActivationDecision {
  const { model, thresholds, perClassCounts } = input;
  const evaluation = model.evaluation;

  if (evaluation === null) {
    return {
      allowed: false,
      reason:
        'This model has not been measured on data it did not train on, so there is nothing to judge it by.',
    };
  }

  if (evaluation.split !== 'test') {
    return {
      allowed: false,
      reason:
        'This model was only measured on its own validation split. A model goes live on the strength of the test split.',
    };
  }

  const tooThin = model.labelIds.filter(
    (labelId) => (perClassCounts[labelId] ?? 0) < thresholds.minSamplesPerClass,
  );
  if (tooThin.length > 0) {
    return {
      allowed: false,
      reason: `${tooThin.length === 1 ? 'One' : tooThin.length} of the ${model.labelIds.length} signs ${tooThin.length === 1 ? 'has' : 'have'} fewer than ${thresholds.minSamplesPerClass} confirmed examples, so the model has not seen enough of them to be trusted with them.`,
    };
  }

  const untested = evaluation.classes.filter((metric) => metric.support === 0);
  if (untested.length > 0) {
    return {
      allowed: false,
      reason: `${untested.length} sign${untested.length === 1 ? ' was' : 's were'} never held out for testing (${untested
        .map((metric) => metric.text)
        .join(', ')}), so the model's behaviour on ${untested.length === 1 ? 'it' : 'them'} is unknown.`,
    };
  }

  if (evaluation.accuracy === null) {
    return {
      allowed: false,
      reason: 'The held-out measurement produced no figure, so there is nothing to compare against the floor.',
    };
  }

  if (evaluation.accuracy < thresholds.minTestAccuracy) {
    return {
      allowed: false,
      reason: `It gets ${Math.round(evaluation.accuracy * 1000) / 10}% of held-out windows right, below the ${Math.round(
        thresholds.minTestAccuracy * 100,
      )}% you set as the minimum. More examples of the signs it confuses would help most.`,
    };
  }

  return { allowed: true };
}

/** The live model for a target, or null. */
export function activeModel(
  models: readonly ModelRecord[],
  languageId: string,
  modality: Modality,
): ModelRecord | null {
  return (
    models.find(
      (model) =>
        model.languageId === languageId &&
        model.modality === modality &&
        model.status === 'active',
    ) ?? null
  );
}

/** The next version number for a target. One-based, never reused. */
export function nextVersion(
  models: readonly ModelRecord[],
  languageId: string,
  modality: Modality,
): number {
  const versions = models
    .filter((model) => model.languageId === languageId && model.modality === modality)
    .map((model) => model.version);
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

/** Candidates for a target, newest first. */
export function candidates(
  models: readonly ModelRecord[],
  languageId: string,
  modality: Modality,
): readonly ModelRecord[] {
  return models
    .filter(
      (model) =>
        model.languageId === languageId &&
        model.modality === modality &&
        model.status !== 'active',
    )
    .sort((a, b) => b.version - a.version);
}

/**
 * What activating this version would retire, and what it could be rolled back to.
 *
 * Returned as a description rather than performed here, so the confirmation the
 * user sees can state exactly what is about to change.
 */
export interface ActivationPlan {
  readonly activate: ModelRecord;
  /** The model that stops being live, if any. */
  readonly retire: ModelRecord | null;
  /** What a rollback would restore afterwards. */
  readonly rollbackTo: ModelRecord | null;
}

export function planActivation(
  models: readonly ModelRecord[],
  target: ModelRecord,
): ActivationPlan {
  const current = activeModel(models, target.languageId, target.modality);
  const previous =
    [...models]
      .filter(
        (model) =>
          model.languageId === target.languageId &&
          model.modality === target.modality &&
          model.version < target.version,
      )
      .sort((a, b) => b.version - a.version)[0] ?? null;

  return {
    activate: target,
    retire: current !== null && current.id !== target.id ? current : null,
    rollbackTo: previous === null || previous.id === current?.id ? current : previous,
  };
}

/**
 * The versions a target keeps before the oldest candidates are dropped.
 *
 * Generic over anything that carries a version and a status, so the store can
 * prune its index of *summaries* without having to pretend they have weights.
 * The live version is never pruned, however old it is.
 */
export function pruneTarget<T extends {
  readonly id: string;
  readonly languageId: string;
  readonly modality: Modality;
  readonly version: number;
  readonly status: ModelRecord['status'];
}>(
  models: readonly T[],
  languageId: string,
  modality: Modality,
  keep: number,
): readonly T[] {
  const forTarget = models
    .filter((model) => model.languageId === languageId && model.modality === modality)
    .sort((a, b) => b.version - a.version);

  const doomed = forTarget
    .filter((model) => model.status !== 'active')
    .slice(Math.max(keep - 1, 0))
    .map((model) => model.id);

  return models.filter((model) => !doomed.includes(model.id));
}

/* --------------------------------------------------------------- the card */

export interface ModelCardLine {
  readonly label: string;
  readonly value: string;
}

export interface ModelCard {
  readonly title: string;
  readonly status: string;
  /** Why it is not live, when it is not. */
  readonly statusNote: string | null;
  readonly lines: readonly ModelCardLine[];
  /** Everything a reader must not over-read, in the app's own words. */
  readonly caveats: readonly string[];
}

const STATUS_WORDS: Record<ModelRecord['status'], string> = {
  candidate: 'Not in use',
  active: 'In use',
  retired: 'Superseded',
};

/**
 * Everything known about one model version, as rows and caveats.
 *
 * Built from the record alone — no figures are recomputed here, and nothing is
 * filled in when it is absent. A model with no evaluation shows "not measured"
 * rather than a blank or a zero.
 */
export function modelCard(
  model: ModelRecord,
  labels: readonly LabelDefinition[],
  nowMs: number,
): ModelCard {
  const textFor = (labelId: string) =>
    labels.find((label) => label.id === labelId)?.text ?? labelId;

  const lines: ModelCardLine[] = [
    { label: 'Version', value: `v${model.version}` },
    { label: 'Trained', value: relativeDay(model.trainedAtMs, nowMs) },
    { label: 'Data', value: `${model.sampleCount} windows from ${model.sessionCount} capture sessions` },
    {
      label: 'Recorded from',
      value:
        model.trainedOn.length === 0
          ? 'Nothing recorded'
          : model.trainedOn.map(describeSource).join(', '),
    },
    { label: 'Signs', value: `${model.labelIds.length}: ${model.labelIds.map(textFor).join(', ')}` },
    { label: 'Method', value: model.algorithmDetail },
    { label: 'Window pipeline', value: model.preprocessingVersion },
  ];

  const evaluation = model.evaluation;
  if (evaluation === null) {
    lines.push({ label: 'Measured on', value: 'Not measured' });
  } else {
    lines.push({
      label: 'Measured on',
      value: `${evaluation.classes.reduce((sum, metric) => sum + metric.support, 0)} held-out windows from ${evaluation.counts.testSessions} session${evaluation.counts.testSessions === 1 ? '' : 's'}`,
    });
    lines.push({
      label: 'Correct',
      value:
        evaluation.accuracy === null
          ? 'Not measured'
          : `${Math.round(evaluation.accuracy * 1000) / 10}% (${Math.round(100 / model.labelIds.length)}% would be chance)`,
    });
  }

  return {
    title: `Version ${model.version}`,
    status: STATUS_WORDS[model.status],
    statusNote: model.statusReason,
    lines,
    caveats: [...(evaluation?.caveats ?? []), ...standingCaveats(model)],
  };
}

/** Sources, described by what they are rather than by their code name. */
export function describeSource(source: string): string {
  switch (source) {
    case 'glove':
      return 'a connected glove';
    case 'simulated':
      return 'Demo Mode (simulated motion)';
    case 'imported':
      return 'an imported recording';
    case 'media':
      return 'imported photos or video';
    default:
      return source;
  }
}

/**
 * Statements that are true of any model this app can currently build.
 *
 * They are attached to every card rather than written into the screen, so a
 * reviewer reading an exported record sees them too.
 */
function standingCaveats(model: ModelRecord): string[] {
  const caveats: string[] = [];

  if (model.trainedOn.includes('simulated') && !model.trainedOn.includes('glove')) {
    caveats.push(
      'This model was fitted on simulated motion only. It recognises that simulation; it has never seen a real glove, and it must not be presented as recognising signing.',
    );
  }

  caveats.push(
    'Its scores are rankings from a linear fit, not calibrated probabilities. A score of 0.8 does not mean the sign is right four times in five.',
    'It was trained on one person’s data on one phone. Nothing here establishes that it works for anyone else.',
    'The signs are the ones you defined. They are not a published vocabulary, and no reviewer has checked them.',
  );

  return caveats;
}

/** "Today", "Yesterday", "6 days ago", then a date. */
export function relativeDay(thenMs: number, nowMs: number): string {
  const days = Math.floor((nowMs - thenMs) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(thenMs).toISOString().slice(0, 10);
}

/** The split a card's figures come from, or null when there are none. */
export function evaluatedSplit(model: ModelRecord): EvaluationReport | null {
  return model.evaluation;
}
