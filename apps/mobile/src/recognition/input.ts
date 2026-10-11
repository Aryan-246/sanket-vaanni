/**
 * What a sign needs in order to be recognised.
 *
 * ## The problem this file exists to solve
 *
 * The previous Dashboard asked the user to pick a hand, and then fed whatever
 * that hand was doing to the recogniser. That is wrong in two directions:
 *
 *  - **Two-handed signs.** A sign that is defined over both hands cannot be
 *    recognised from one, and a pipeline that only ever sees one hand will never
 *    be able to recognise it no matter how good the model is.
 *  - **Invented input.** Concatenating the left hand's channels onto the right
 *    hand's to "make" a two-hand sample produces a tensor that corresponds to no
 *    posture a human being can form. A model fed that would return a confident
 *    answer about nothing.
 *
 * So the shape of the recogniser's input is a **property of the vocabulary**,
 * not a choice the UI makes. This module is where that property is declared, and
 * where the app decides — from real connection state — whether it currently
 * holds the inputs a sign would need.
 *
 * ## Nothing here guesses a number
 *
 * Every function below is derived from `profile.vocabulary`, which is empty for
 * every profile in this build. An empty vocabulary means no requirement is
 * known, so no plan is ever `ready`. The app reports that rather than falling
 * back to "assume one hand".
 */
import type { GloveSide } from '../ble/types';
import type { SensorSample } from '../sensors/types';
import type { SignLanguageProfile } from './profiles';

/**
 * How many hands a sign is defined over, and which.
 *
 * `'either'` is deliberate rather than a convenience: some signs are defined on
 * "the dominant hand" regardless of which that is, and collapsing that to a
 * fixed side would be an assumption about the signer.
 */
export type HandRequirement =
  | { readonly kind: 'single'; readonly side: GloveSide | 'either' }
  | { readonly kind: 'bimanual' };

/** One entry of a profile's vocabulary. */
export interface VocabularyEntry {
  /** Stable key. Must be unique within the profile. */
  readonly signId: string;
  /** Display text, in the sign language's own written form where one exists. */
  readonly label: string;
  /** What the recogniser must be given for this sign. */
  readonly requirement: HandRequirement;
}

/**
 * What a profile's vocabulary can ask for, summarised.
 *
 * Derived from the vocabulary rather than stored beside it, so the summary
 * cannot drift from the entries it summarises.
 */
export interface InputCapability {
  /** False when the profile has no signs at all — every profile, today. */
  readonly hasVocabulary: boolean;
  /** True when at least one sign is defined over a single hand. */
  readonly singleHand: boolean;
  /** True when at least one sign is defined over both hands. */
  readonly bimanual: boolean;
  /**
   * Sides for which a single-hand sign exists. `'either'` contributes both,
   * because a sign defined on "the dominant hand" is recognisable from whichever
   * glove is wearing it.
   */
  readonly singleHandSides: readonly GloveSide[];
}

export function inputCapability(profile: SignLanguageProfile): InputCapability {
  const sides = new Set<GloveSide>();
  let singleHand = false;
  let bimanual = false;

  for (const entry of profile.vocabulary) {
    if (entry.requirement.kind === 'bimanual') {
      bimanual = true;
      continue;
    }
    singleHand = true;
    if (entry.requirement.side === 'either') {
      sides.add('left');
      sides.add('right');
    } else {
      sides.add(entry.requirement.side);
    }
  }

  return {
    hasVocabulary: profile.vocabulary.length > 0,
    singleHand,
    bimanual,
    // Ordered left-then-right rather than by insertion, so the array is stable
    // for a given vocabulary regardless of the order entries appear in.
    singleHandSides: (['left', 'right'] as const).filter((side) => sides.has(side)),
  };
}

/** The input a ready plan says the recogniser should be given. */
export type InputMode =
  | { readonly kind: 'single'; readonly side: GloveSide }
  | { readonly kind: 'bimanual' }
  /**
   * Both gloves are live and the vocabulary is single-hand only. Each hand is
   * evaluated on its own and the strongest result is presented.
   *
   * This is not the same as `bimanual`, and the distinction is the point: it
   * never merges the two hands into one input.
   */
  | { readonly kind: 'parallel-single'; readonly sides: readonly GloveSide[] };

/**
 * Why recognition cannot run.
 *
 * Typed, because each one is a different sentence to the user and a different
 * thing to fix. `'no-gloves'` is the user's to resolve by connecting a glove;
 * `'no-vocabulary'` is not theirs at all and no amount of tapping will help.
 */
export type InputBlocker =
  | 'no-vocabulary'
  | 'no-gloves'
  | 'awaiting-frames'
  | 'needs-both-hands'
  | 'unsupported-sides';

export type InputPlan =
  | {
      readonly kind: 'ready';
      readonly mode: InputMode;
      readonly connectedSides: readonly GloveSide[];
      readonly streamingSides: readonly GloveSide[];
    }
  | {
      readonly kind: 'blocked';
      readonly blocker: InputBlocker;
      readonly connectedSides: readonly GloveSide[];
      readonly streamingSides: readonly GloveSide[];
    };

/** What the app knows about each glove's ability to supply input right now. */
export interface InputAvailability {
  /** The transport reports a live connection. */
  readonly connected: Readonly<Record<GloveSide, boolean>>;
  /** A sensor frame has actually arrived — not merely a connection. */
  readonly streaming: Readonly<Record<GloveSide, boolean>>;
}

const SIDES: readonly GloveSide[] = ['left', 'right'];

/**
 * Decides what the recogniser can be given, from the vocabulary and the gloves.
 *
 * The order of the checks is the order of the user's questions: is there a
 * vocabulary at all, is anything connected, has it said anything yet, and only
 * then — do we hold the hands this profile's signs are defined over.
 */
export function planInput(
  profile: SignLanguageProfile,
  availability: InputAvailability,
): InputPlan {
  const connectedSides = SIDES.filter((side) => availability.connected[side]);
  const streamingSides = SIDES.filter((side) => availability.streaming[side]);

  const blocked = (blocker: InputBlocker): InputPlan => ({
    kind: 'blocked',
    blocker,
    connectedSides,
    streamingSides,
  });

  const capability = inputCapability(profile);
  if (!capability.hasVocabulary) return blocked('no-vocabulary');

  if (connectedSides.length === 0) return blocked('no-gloves');
  if (streamingSides.length === 0) return blocked('awaiting-frames');

  const bothStreaming = streamingSides.length === 2;

  // Bimanual first: if the vocabulary can use both hands and both are live,
  // that is the richer input and the one a two-handed sign needs.
  if (bothStreaming && capability.bimanual) {
    return { kind: 'ready', mode: { kind: 'bimanual' }, connectedSides, streamingSides };
  }

  // One hand live, and a sign defined over a single hand that this side can
  // supply.
  if (streamingSides.length === 1) {
    const side = streamingSides[0] as GloveSide;
    if (capability.singleHandSides.includes(side)) {
      return { kind: 'ready', mode: { kind: 'single', side }, connectedSides, streamingSides };
    }
    // The live hand is not one this vocabulary has single-hand signs for, and
    // the other hand is not streaming, so a two-handed sign cannot be formed.
    return blocked('needs-both-hands');
  }

  // Both hands live. If the vocabulary has both kinds, the bimanual branch above
  // already took it, so reaching here means bimanual signs do not exist and the
  // two hands must be evaluated independently.
  if (capability.singleHand) {
    const sides = SIDES.filter((side) => capability.singleHandSides.includes(side));
    if (sides.length > 0) {
      return {
        kind: 'ready',
        mode: { kind: 'parallel-single', sides },
        connectedSides,
        streamingSides,
      };
    }
  }

  return blocked('unsupported-sides');
}

/**
 * The sentence under a blocked plan's headline.
 *
 * Every branch states a fact about this build. None of them hints that holding
 * a hand still for longer would help, because in none of these states would it.
 */
export function describeBlocker(
  blocker: InputBlocker,
  profile: SignLanguageProfile,
): string {
  switch (blocker) {
    case 'no-vocabulary':
      return `${profile.name} has no defined vocabulary yet, so there is nothing for the recogniser to match against. Defining signs is a Deaf-led linguistic task, not a setting.`;
    case 'no-gloves':
      return 'No glove is connected, so there is no input to evaluate. Recognition never runs on a reading it does not have.';
    case 'awaiting-frames':
      return 'A glove is connected but has not sent a sensor frame yet.';
    case 'needs-both-hands':
      return `The signs in ${profile.name} that this build can route are defined over both hands, and only one is sending data.`;
    case 'unsupported-sides':
      return `The connected hand is not one that ${profile.name}'s vocabulary has signs for.`;
  }
}

/** Which hands a plan would feed to the recogniser. Empty when blocked. */
export function plannedSides(plan: InputPlan): readonly GloveSide[] {
  if (plan.kind === 'blocked') return [];
  switch (plan.mode.kind) {
    case 'single':
      return [plan.mode.side];
    case 'bimanual':
      return SIDES;
    case 'parallel-single':
      return plan.mode.sides;
  }
}

/**
 * The recogniser's input.
 *
 * The union is what makes the two cases impossible to confuse at the call site:
 * a caller cannot pass one sample where two are required, and cannot pass two
 * where the model expects one. There is no "pad the missing hand with zeros"
 * variant, because that input does not correspond to a real posture.
 */
export type RecognitionInput =
  | { readonly kind: 'single'; readonly side: GloveSide; readonly sample: SensorSample }
  | {
      readonly kind: 'bimanual';
      readonly left: SensorSample;
      readonly right: SensorSample;
    };

/**
 * Builds the recogniser input a ready plan describes, or null if the samples are
 * not all present.
 *
 * Returning null rather than throwing: a frame can legitimately be absent
 * between the plan being computed and this being called, and the caller's
 * correct response is to render "waiting", not to crash.
 */
export function buildInput(
  plan: InputPlan,
  samples: Readonly<Record<GloveSide, SensorSample | null>>,
): RecognitionInput | null {
  if (plan.kind === 'blocked') return null;

  switch (plan.mode.kind) {
    case 'single': {
      const sample = samples[plan.mode.side];
      return sample === null ? null : { kind: 'single', side: plan.mode.side, sample };
    }
    case 'bimanual': {
      const left = samples.left;
      const right = samples.right;
      return left === null || right === null
        ? null
        : { kind: 'bimanual', left, right };
    }
    case 'parallel-single':
      // A parallel plan is not a single input; callers iterate the sides. This
      // function therefore reports the first available one, and `parallelInputs`
      // below is what a recogniser loop should actually use.
      return null;
  }
}

/**
 * One input per hand, for a plan that evaluates hands independently.
 *
 * Separate from `buildInput` so the two cannot be accidentally interchanged: a
 * caller that wants the bimanual path calls `buildInput`, and a caller that
 * wants per-hand evaluation calls this.
 */
export function parallelInputs(
  plan: InputPlan,
  samples: Readonly<Record<GloveSide, SensorSample | null>>,
): readonly RecognitionInput[] {
  if (plan.kind === 'blocked' || plan.mode.kind !== 'parallel-single') return [];

  return plan.mode.sides.flatMap((side) => {
    const sample = samples[side];
    return sample === null ? [] : [{ kind: 'single', side, sample } as const];
  });
}
