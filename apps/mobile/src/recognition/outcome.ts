/**
 * What the recogniser is currently able to say.
 *
 * ## The problem this solves
 *
 * "No sign recognised" is not one state, it is several, and collapsing them is
 * how apps end up lying:
 *
 *  - the model is **unavailable** (no model exists) — a capability gap;
 *  - the input is **blocked** (no vocabulary, no glove, no frame yet, or the
 *    wrong hands for this profile's signs) — a setup gap, and the only state
 *    here that the user can actually act on;
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
 *
 * ## Which hand produced it
 *
 * `hands` is carried on the two candidate-bearing states, so the one shared
 * result panel can say *which* hand signed without the screen having a
 * left/right selection of its own. It is empty on every state that has no
 * candidate, because nothing produced them.
 */
import type { GloveSide } from '../ble/types';
import type { SensorSample } from '../sensors/types';
import type { RecognitionCandidate, RecognitionResult, Recogniser } from './index';
import { buildInput, describeBlocker, parallelInputs, type InputBlocker, type InputPlan } from './input';
import type { SignLanguageProfile } from './profiles';

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
  | {
      readonly kind: 'blocked';
      readonly blocker: InputBlocker;
      readonly reason: string;
    }
  | { readonly kind: 'idle' }
  | { readonly kind: 'no-result' }
  | {
      readonly kind: 'uncertain';
      readonly candidate: RecognitionCandidate;
      readonly profileId: string;
      readonly hands: readonly GloveSide[];
    }
  | {
      readonly kind: 'result';
      readonly candidate: RecognitionCandidate;
      readonly profileId: string;
      readonly hands: readonly GloveSide[];
    };

export const OUTCOME_HEADLINE: Record<RecognitionOutcome['kind'], string> = {
  unavailable: 'Recognition unavailable',
  blocked: 'Cannot start',
  idle: 'Waiting for a gesture',
  'no-result': 'No matching sign',
  uncertain: 'Uncertain',
  result: 'Recognised',
};

/**
 * Runs the recogniser against the plan and classifies what came back.
 *
 * `samples` carries one entry per glove, either the latest calibrated frame or
 * null. Null is the normal case while a glove is disconnected, and is `idle`
 * rather than `no-result`: nothing was evaluated, so nothing can be said about
 * a match.
 */
export function evaluateRecognition(
  recogniser: Recogniser,
  profile: SignLanguageProfile,
  plan: InputPlan,
  samples: Readonly<Record<GloveSide, SensorSample | null>>,
): RecognitionOutcome {
  if (!recogniser.isAvailable) {
    return {
      kind: 'unavailable',
      reason:
        recogniser.unavailableReason ??
        'No recognition model is available, and no reason was reported.',
    };
  }

  if (plan.kind === 'blocked') {
    return {
      kind: 'blocked',
      blocker: plan.blocker,
      reason: describeBlocker(plan.blocker, profile),
    };
  }

  const candidates = collectCandidates(recogniser, plan, samples);

  if (candidates === null) {
    // A ready plan with no sample behind it: the frame went away between the
    // plan being computed and the recogniser being asked. Nothing was
    // evaluated, so this is the same statement as `idle`.
    return { kind: 'idle' };
  }

  if (candidates.length === 0) {
    return { kind: 'no-result' };
  }

  // When two hands were evaluated independently, the stronger match is the one
  // presented. Ties resolve to `SIDES` order, which is left then right, so the
  // same pair of readings always presents the same way.
  const best = candidates.reduce((leader, candidate) =>
    candidate.result.candidate.confidence > leader.result.candidate.confidence
      ? candidate
      : leader,
  );

  return best.result.candidate.confidence >= RESULT_CONFIDENCE_THRESHOLD
    ? {
        kind: 'result',
        candidate: best.result.candidate,
        profileId: best.result.profileId,
        hands: best.sides,
      }
    : {
        kind: 'uncertain',
        candidate: best.result.candidate,
        profileId: best.result.profileId,
        hands: best.sides,
      };
}

interface Candidate {
  readonly result: RecognitionResult;
  readonly sides: readonly GloveSide[];
}

/**
 * Every candidate the recogniser produced for this plan.
 *
 * Null means "no input was actually available", which is a different answer from
 * an empty array meaning "input was evaluated and nothing matched".
 */
function collectCandidates(
  recogniser: Recogniser,
  plan: InputPlan,
  samples: Readonly<Record<GloveSide, SensorSample | null>>,
): readonly Candidate[] | null {
  if (plan.kind === 'blocked') return null;

  if (plan.mode.kind === 'parallel-single') {
    const inputs = parallelInputs(plan, samples);
    if (inputs.length === 0) return null;

    return inputs.flatMap((input) => {
      const result = recogniser.recognise(input);
      if (result === null) return [];
      const side = input.kind === 'single' ? input.side : null;
      return [{ result, sides: side === null ? [] : [side] }];
    });
  }

  const input = buildInput(plan, samples);
  if (input === null) return null;

  const result = recogniser.recognise(input);
  if (result === null) return [];

  return [
    {
      result,
      sides: input.kind === 'single' ? [input.side] : (['left', 'right'] as const).slice(),
    },
  ];
}

/** True when there is text worth offering to speak or translate. */
export function outcomeText(outcome: RecognitionOutcome): string | null {
  return outcome.kind === 'result' ? outcome.candidate.label : null;
}

/**
 * Confidence for display, or null when there is none to display.
 *
 * Deliberately returns null for `idle`, `blocked` and `no-result`. Rendering 0%
 * there would read as "the model is sure there is no sign", which is a claim
 * only a model that saw a gesture could make.
 */
export function outcomeConfidence(outcome: RecognitionOutcome): number | null {
  return outcome.kind === 'result' || outcome.kind === 'uncertain'
    ? outcome.candidate.confidence
    : null;
}

/** The hands behind a candidate, or empty when nothing produced one. */
export function outcomeHands(outcome: RecognitionOutcome): readonly GloveSide[] {
  return outcome.kind === 'result' || outcome.kind === 'uncertain' ? outcome.hands : [];
}

/** `Left hand`, `Right hand`, `Both hands`, or null when nothing produced it. */
export function outcomeHandWords(outcome: RecognitionOutcome): string | null {
  const hands = outcomeHands(outcome);
  if (hands.length === 0) return null;
  if (hands.length === 2) return 'Both hands';
  return hands[0] === 'left' ? 'Left hand' : 'Right hand';
}
