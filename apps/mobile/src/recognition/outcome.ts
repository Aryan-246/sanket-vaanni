/**
 * What the recogniser is currently able to say.
 *
 * ## The problem this solves
 *
 * "No sign recognised" is not one state, it is five, and collapsing them is
 * how apps end up lying:
 *
 *  - the model is **unavailable** (no model exists) — a capability gap;
 *  - the model is available but **idle** (no gesture in front of it) — normal
 *    and expected;
 *  - a gesture was seen but **nothing matched** — a real negative;
 *  - something matched but only **uncertainly** — a weak positive;
 *  - a **result** with a measured confidence.
 *
 * A UI that renders all of these as "Waiting…" tells the user to keep trying
 * when the honest answer is that the feature does not exist yet.
 *
 * ## Confidence
 *
 * `confidence` appears only on `uncertain` and `result`, and it is always the
 * recogniser's own number. There is no default, no placeholder and no derived
 * value — a state that has no confidence simply has no field for one.
 */
import type { SensorSample } from '../sensors/types';
import type { RecognitionCandidate, RecognitionResult, Recogniser } from './index';

/**
 * Minimum confidence for a result to be presented as a recognition rather than
 * as an uncertain guess.
 *
 * This is a **presentation threshold, not a validated operating point**. No
 * model has been evaluated, so this number has no empirical basis and must be
 * revisited with real held-out data before any accuracy claim is made.
 */
export const RESULT_CONFIDENCE_THRESHOLD = 0.7;

export type RecognitionOutcome =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'idle' }
  | { readonly kind: 'no-result' }
  | {
      readonly kind: 'uncertain';
      readonly candidate: RecognitionCandidate;
      readonly profileId: string;
    }
  | {
      readonly kind: 'result';
      readonly candidate: RecognitionCandidate;
      readonly profileId: string;
    };

export const OUTCOME_HEADLINE: Record<RecognitionOutcome['kind'], string> = {
  unavailable: 'Recognition unavailable',
  idle: 'Waiting for a gesture',
  'no-result': 'No matching sign',
  uncertain: 'Uncertain',
  result: 'Recognised',
};

/**
 * Runs the recogniser and classifies what came back.
 *
 * `sample` may be null, which is the normal case while no glove is connected.
 * That is `idle` rather than `no-result`: nothing was evaluated, so nothing can
 * be said about a match.
 */
export function evaluateRecognition(
  recogniser: Recogniser,
  profileId: string,
  sample: SensorSample | null,
): RecognitionOutcome {
  if (!recogniser.isAvailable) {
    return {
      kind: 'unavailable',
      reason:
        recogniser.unavailableReason ??
        'No recognition model is available, and no reason was reported.',
    };
  }

  if (sample === null) {
    return { kind: 'idle' };
  }

  const result: RecognitionResult | null = recogniser.recognise(sample);
  if (result === null) {
    return { kind: 'no-result' };
  }

  return result.candidate.confidence >= RESULT_CONFIDENCE_THRESHOLD
    ? { kind: 'result', candidate: result.candidate, profileId }
    : { kind: 'uncertain', candidate: result.candidate, profileId };
}

/** True when there is text worth offering to speak or translate. */
export function outcomeText(outcome: RecognitionOutcome): string | null {
  return outcome.kind === 'result' ? outcome.candidate.label : null;
}

/**
 * Confidence for display, or null when there is none to display.
 *
 * Deliberately returns null for `idle` and `no-result`. Rendering 0% there
 * would read as "the model is sure there is no sign", which is a claim only a
 * model that saw a gesture could make.
 */
export function outcomeConfidence(outcome: RecognitionOutcome): number | null {
  return outcome.kind === 'result' || outcome.kind === 'uncertain'
    ? outcome.candidate.confidence
    : null;
}
