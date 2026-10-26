/**
 * Live inference: what the app is allowed to tell a person about their signing.
 *
 * ## The three answers
 *
 * There are exactly three things this can say, and the honest one is often the
 * second or third:
 *
 * - **A sign**, when the model's top class is clearly ahead of the rest.
 * - **Not sure**, when it is not — either the best score is low, or the top two
 *   are close together. Both are reported with the figures that produced them.
 * - **Nothing to go on**, when there is no model, no live model, a model this
 *   build cannot read, or a stream that has stopped.
 *
 * There is no fourth path that guesses. A wrong sign shown confidently is worse
 * than "not sure", because the person receiving it has no way to know.
 *
 * ## Why the thresholds are presented as thresholds and not as confidence
 *
 * `unknownScore` and `unknownMargin` are the user's own settings. They decide
 * when to *stay quiet*, and they were chosen without any calibration measurement
 * — there is no held-out reliability diagram behind them. So the score is shown
 * as "how far ahead this sign is", never as "how likely this is right", and the
 * sentences below say so where a reader will see them.
 *
 * The model is a linear fit over window statistics. It is not a translator, and
 * nothing in this file may imply that a stream of correct signs adds up to one.
 */
import { FEATURE_SPEC, predict, type Prediction } from './classifier';
import { extractFeatures } from './features';
import { buildWindow } from './window';
import { WINDOW_FRAMES, type FrameVector, type LabelDefinition, type MlSettings, type ModelRecord } from './types';
import type { SensorSample } from '../sensors/types';

/** Why the app is not naming a sign. */
export type UnknownReason =
  | 'no-model'
  /** A model exists but nothing has been activated. */
  | 'no-active-model'
  /** The active model was fitted by a different window pipeline. */
  | 'incompatible-model'
  /** Not enough motion has been collected yet. */
  | 'collecting'
  /** The stream stopped, so the buffer is stale. */
  | 'stale'
  /** The window could not be built from what arrived. */
  | 'unusable-window'
  /** The best class was not far enough ahead of the second. */
  | 'too-close'
  /** Even the best class scored below the floor. */
  | 'below-floor';

export interface ScoredLabel {
  readonly labelId: string;
  readonly text: string;
  /** The model's raw class score. A ranking, not a probability. */
  readonly score: number;
}

export type InferenceOutcome =
  | {
      readonly kind: 'sign';
      readonly label: ScoredLabel;
      readonly margin: number;
      readonly alternatives: readonly ScoredLabel[];
    }
  | {
      readonly kind: 'unknown';
      readonly reason: UnknownReason;
      /** One sentence for the screen. */
      readonly detail: string;
      /** The best guess, shown as a guess, or null when there was nothing. */
      readonly nearest: ScoredLabel | null;
      readonly margin: number | null;
      readonly alternatives: readonly ScoredLabel[];
    };

export interface InferInput {
  readonly frames: readonly FrameVector[];
  readonly model: ModelRecord | null;
  readonly labels: readonly LabelDefinition[];
  readonly settings: MlSettings;
}

/** Names a sign, says it is not sure, or says there is nothing to go on. */
export function inferFromFrames(input: InferInput): InferenceOutcome {
  const { model } = input;

  if (model === null) {
    return unknown('no-model', 'No recognition model has been trained on this phone yet.');
  }
  if (model.status !== 'active') {
    return unknown(
      'no-active-model',
      'A model has been trained but none is switched on, so nothing is recognised live.',
      model,
      input,
    );
  }
  if (model.parameters.featureSpec.version !== FEATURE_SPEC.version) {
    return unknown(
      'incompatible-model',
      `This model was fitted by a different window pipeline (${model.parameters.featureSpec.version}) and cannot be read by this build.`,
    );
  }

  if (input.frames.length < WINDOW_FRAMES) {
    return unknown(
      'collecting',
      `Collecting: ${input.frames.length} of ${WINDOW_FRAMES} frames.`,
      model,
      input,
    );
  }

  const vector = extractFeatures(input.frames);
  if (vector === null) {
    return unknown('unusable-window', 'The last window held no frames.', model, input);
  }

  const prediction = predict(model.parameters, vector);
  if (prediction === null) {
    return unknown(
      'incompatible-model',
      'This model cannot read the features this build produces.',
    );
  }

  const ranked = rank(prediction, model, input.labels);
  const best = ranked[0]!;

  if (best.score < input.settings.unknownScore) {
    return {
      kind: 'unknown',
      reason: 'below-floor',
      detail: `The closest sign scored ${format(best.score)}, below the ${format(input.settings.unknownScore)} you set as the floor.`,
      nearest: best,
      margin: prediction.margin,
      alternatives: ranked,
    };
  }

  if (prediction.margin < input.settings.unknownMargin) {
    return {
      kind: 'unknown',
      reason: 'too-close',
      detail: `Two signs scored within ${format(prediction.margin)} of each other, which is closer than the ${format(input.settings.unknownMargin)} separation you asked for.`,
      nearest: best,
      margin: prediction.margin,
      alternatives: ranked,
    };
  }

  return {
    kind: 'sign',
    label: best,
    margin: prediction.margin,
    alternatives: ranked,
  };
}

/** Builds an unknown outcome from just a reason, where no model was involved. */
function unknown(
  reason: UnknownReason,
  detail: string,
  model?: ModelRecord | null,
  input?: InferInput,
): InferenceOutcome {
  if (model == null || input === undefined) {
    return { kind: 'unknown', reason, detail, nearest: null, margin: null, alternatives: [] };
  }

  const vector = input.frames.length >= WINDOW_FRAMES ? extractFeatures(input.frames) : null;
  const prediction = vector === null ? null : predict(model.parameters, vector);
  if (prediction === null) {
    return { kind: 'unknown', reason, detail, nearest: null, margin: null, alternatives: [] };
  }

  const ranked = rank(prediction, model, input.labels);
  return {
    kind: 'unknown',
    reason,
    detail,
    nearest: ranked[0] ?? null,
    margin: prediction.margin,
    alternatives: ranked,
  };
}

/** Every class, highest first, with the user's own words for each. */
function rank(
  prediction: Prediction,
  model: ModelRecord,
  labels: readonly LabelDefinition[],
): ScoredLabel[] {
  const textFor = (labelId: string) =>
    labels.find((label) => label.id === labelId)?.text ?? labelId;

  return model.parameters.classLabelIds
    .map((labelId, index) => ({
      labelId,
      text: textFor(labelId),
      score: prediction.scores[index] ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}

function format(value: number): string {
  return `${Math.round(value * 100) / 100}`;
}

/**
 * The sentences that must appear wherever a live score is shown.
 *
 * Held here rather than written into the screen so that an exported model record
 * and the on-screen display cannot disagree about what a score means.
 */
export const SCORE_NOTE =
  'Scores rank the signs against each other. They are not probabilities, and a score of 0.8 does not mean the sign is right four times in five.';

/** Why a live reading can be wrong even when the model is right. */
export const LIVE_NOTE =
  'A model trained on one person’s data on one phone recognises that person’s hand on that phone.';

/* ------------------------------------------------------------- the buffer */

export interface InferenceState {
  readonly outcome: InferenceOutcome;
  /** Frames currently held. */
  readonly buffered: number;
  /** Whether the stream is producing. */
  readonly receiving: boolean;
}

export interface LiveInferenceDeps {
  readonly now: () => number;
  /** A stream that has produced nothing for this long is reported as stopped. */
  readonly staleAfterMs?: number;
  readonly onUpdate?: () => void;
}

const DEFAULT_STALE_MS = 2500;

/**
 * Keeps the last window's worth of frames and re-evaluates as they arrive.
 *
 * The buffer holds *samples*, not reduced frames, so that live evaluation runs
 * through exactly the same `buildWindow` resampling as training did. Evaluating
 * a raw 41-frame buffer while the model was fitted on 30 resampled frames would
 * put the live statistics on a different footing from the training ones — a
 * quiet way for live behaviour to differ from the measured behaviour.
 *
 * The buffer is count-bounded at twice the window length, which bounds both the
 * work per frame and the memory. A stream that slows down therefore produces a
 * *longer* window rather than a shorter one, and a stream that has stopped is
 * reported as stopped rather than re-evaluating the same frames forever.
 */
export class LiveInference {
  private buffer: SensorSample[] = [];
  private outcome: InferenceOutcome;
  private receiving = false;
  private lastFrameAtMs = 0;
  private disposed = false;
  private readonly deps: LiveInferenceDeps;

  constructor(deps: LiveInferenceDeps) {
    this.deps = deps;
    this.outcome = unknown('no-model', 'No recognition model has been trained on this phone yet.');
  }

  getSnapshot = (): InferenceState => ({
    outcome: this.outcome,
    buffered: this.buffer.length,
    receiving: this.receiving && !this.expired(),
  });

  /** Adds one sample to the buffer and re-evaluates. */
  push(sample: SensorSample, context: Omit<InferInput, 'frames'>): void {
    if (this.disposed) return;

    this.lastFrameAtMs = this.deps.now();
    this.receiving = true;

    // A hand swap mid-buffer would mix two gloves' frames into one window.
    const sameSide = this.buffer.length > 0 && this.buffer[0]!.side === sample.side;
    this.buffer = [...(sameSide ? this.buffer : []), sample].slice(-WINDOW_FRAMES * 2);

    this.outcome = this.evaluate(context);
    this.deps.onUpdate?.();
  }

  /** Clears the buffer, e.g. when the glove disconnects. */
  reset(context: Omit<InferInput, 'frames'>): void {
    this.buffer = [];
    this.receiving = false;
    this.lastFrameAtMs = 0;
    this.outcome = this.evaluate(context);
    this.deps.onUpdate?.();
  }

  /** Re-evaluates against a model that has just been activated or withdrawn. */
  refresh(context: Omit<InferInput, 'frames'>): void {
    this.outcome = this.evaluate(context);
    this.deps.onUpdate?.();
  }

  dispose(): void {
    this.disposed = true;
    this.buffer = [];
  }

  /**
   * Evaluates the held frames.
   *
   * A stopped stream says so instead of showing the last reading as current: a
   * frozen "sign" on screen looks exactly like a recognised sign, and the person
   * reading it has no way to tell the difference.
   */
  private evaluate(context: Omit<InferInput, 'frames'>): InferenceOutcome {
    if (this.expired()) {
      return {
        kind: 'unknown',
        reason: 'stale',
        detail: 'The glove has not sent anything recently, so the reading on screen is out of date.',
        nearest: null,
        margin: null,
        alternatives: [],
      };
    }

    const built = buildWindow(this.buffer, { frames: WINDOW_FRAMES, maxGapMs: 1500 });
    if (!built.ok) {
      return {
        kind: 'unknown',
        reason: 'unusable-window',
        detail: built.reason,
        nearest: null,
        margin: null,
        alternatives: [],
      };
    }

    return inferFromFrames({ frames: built.frames, ...context });
  }

  private expired(): boolean {
    const staleAfterMs = this.deps.staleAfterMs ?? DEFAULT_STALE_MS;
    return this.lastFrameAtMs > 0 && this.deps.now() - this.lastFrameAtMs > staleAfterMs;
  }
}
