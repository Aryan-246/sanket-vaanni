/**
 * Recognition and translation outcomes: the honesty contract, as arithmetic.
 *
 * Everything asserted here is a statement about what the app is *allowed to
 * say*, which is why it is a plain unit suite with no rendering. The two
 * properties that matter:
 *
 *  - "no sign" is five different situations and the classifier keeps them
 *    apart, so no screen downstream can collapse them by accident;
 *  - a confidence figure exists only when a recogniser produced one, so no
 *    default, placeholder or derived number can reach the UI.
 */
import {
  OUTCOME_HEADLINE,
  RESULT_CONFIDENCE_THRESHOLD,
  evaluateRecognition,
  outcomeConfidence,
  outcomeHands,
  outcomeHandWords,
  outcomeText,
  type RecognitionOutcome,
} from '../src/recognition/outcome';
import {
  DEFAULT_PROFILE_ID,
  findProfile,
  type RecognitionResult,
  type Recogniser,
} from '../src/recognition';
import {
  planInput,
  type HandRequirement,
  type InputAvailability,
} from '../src/recognition/input';
import type { SignLanguageProfile } from '../src/recognition/profiles';
import type { SensorSample } from '../src/sensors/types';
import {
  TRANSLATION_UNAVAILABLE_REASON,
  UnimplementedTranslator,
  evaluateTranslation,
  type Translator,
} from '../src/translation';

/* ------------------------------------------------------------------ fixtures */

const SAMPLE: SensorSample = {
  side: 'right',
  timestampMs: 1_000,
  flex: [0.1, 0.2, 0.3, 0.4, 0.5],
  accel: { x: 0, y: 0, z: 9.81 },
  gyro: { x: 0, y: 0, z: 0 },
};

/** A right hand that is both linked and reporting frames. */
const RIGHT_HAND: HandRequirement = { kind: 'single', side: 'right' };

const RIGHT_STREAMING: InputAvailability = {
  connected: { left: false, right: true },
  streaming: { left: false, right: true },
};

const SAMPLES = { left: null, right: SAMPLE };

/**
 * A profile whose vocabulary requires the given input.
 *
 * Built from a real entry so the fixture cannot drift from the shape the app
 * ships, but with a vocabulary — which is the point: the shipped profiles have
 * none, and every routing decision is derived from this field.
 */
function profileWith(
  requirement: HandRequirement,
  id: string = DEFAULT_PROFILE_ID,
): SignLanguageProfile {
  const base = findProfile(DEFAULT_PROFILE_ID)!;
  return {
    ...base,
    id,
    vocabularySize: 1,
    vocabulary: [{ signId: 'namaste', label: 'नमस्ते', requirement }],
  };
}

/** A recogniser whose availability and answer are dictated by the test. */
function recogniser(options: {
  available: boolean;
  result?: RecognitionResult | null;
  reason?: string | null;
}): Recogniser {
  return {
    profileId: 'isl',
    isAvailable: options.available,
    unavailableReason: options.reason ?? null,
    recognise: () => options.result ?? null,
  };
}

/**
 * Evaluate the way the app does: derive the plan from the vocabulary, then
 * classify.
 *
 * Going through `planInput` rather than hand-writing a plan is deliberate. A
 * hand-written plan could express a routing the real layer can never produce —
 * say, a single-hand plan for a two-handed sign — and the test would then be
 * asserting the classifier's behaviour on an impossible input.
 */
function evaluate(
  stub: Recogniser,
  options: {
    requirement?: HandRequirement;
    availability?: InputAvailability;
    samples?: Readonly<Record<'left' | 'right', SensorSample | null>>;
  } = {},
): RecognitionOutcome {
  const profile = profileWith(options.requirement ?? RIGHT_HAND);
  const availability = options.availability ?? RIGHT_STREAMING;
  return evaluateRecognition(
    stub,
    profile,
    planInput(profile, availability),
    options.samples ?? SAMPLES,
  );
}

function result(confidence: number, label = 'नमस्ते', profileId = 'isl'): RecognitionResult {
  return {
    profileId,
    candidate: { signId: 'namaste', label, confidence },
    timestampMs: 1_000,
  };
}

/* ------------------------------------------------------ the five outcomes */

describe('evaluateRecognition', () => {
  it('reports an absent model as unavailable, with the reason the model gave', () => {
    const outcome = evaluate(recogniser({ available: false, reason: 'No model has been trained.' }));

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'No model has been trained.' });
    expect(OUTCOME_HEADLINE[outcome.kind]).toBe('Recognition unavailable');
  });

  it('says so when an unavailable recogniser gave no reason, rather than inventing one', () => {
    const outcome = evaluate(recogniser({ available: false }));

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    // It does not claim to know why; it reports that nobody said.
    expect(outcome.reason).toContain('no reason was reported');
  });

  it('checks for an absent model before checking the input', () => {
    // A missing model is not a blocked input, and reporting it as one would tell
    // the user to connect a glove that would change nothing.
    const outcome = evaluate(recogniser({ available: false }), {
      availability: { connected: { left: false, right: false }, streaming: { left: false, right: false } },
    });

    expect(outcome.kind).toBe('unavailable');
  });

  it('is idle, not no-result, when a ready plan has no frame behind it', () => {
    // The distinction the brief asks for: with no reading there is nothing to
    // say about a match, and "no match" would be a claim nobody made.
    const outcome = evaluate(recogniser({ available: true, result: result(0.99) }), {
      samples: { left: null, right: null },
    });

    expect(outcome).toEqual({ kind: 'idle' });
    expect(OUTCOME_HEADLINE.idle).toBe('Waiting for a gesture');
  });

  it('separates "evaluated and matched nothing" from "never evaluated"', () => {
    const outcome = evaluate(recogniser({ available: true, result: null }));

    expect(outcome).toEqual({ kind: 'no-result' });
    expect(OUTCOME_HEADLINE['no-result']).toBe('No matching sign');
  });

  it('shows a weak match as uncertain, with the model’s own number', () => {
    const outcome = evaluate(recogniser({ available: true, result: result(0.42) }));

    expect(outcome.kind).toBe('uncertain');
    expect(outcomeConfidence(outcome)).toBe(0.42);
    // An uncertain outcome is not text worth speaking or translating.
    expect(outcomeText(outcome)).toBeNull();
  });

  it('presents a match at or above the threshold as a result', () => {
    const outcome = evaluate(
      recogniser({ available: true, result: result(RESULT_CONFIDENCE_THRESHOLD) }),
    );

    expect(outcome.kind).toBe('result');
    expect(outcomeText(outcome)).toBe('नमस्ते');
    expect(outcomeConfidence(outcome)).toBe(RESULT_CONFIDENCE_THRESHOLD);
  });

  it('names the hand a single-hand result came from', () => {
    // Which hand signed is carried on the outcome, so the one shared result
    // panel can say so without the screen having a selection of its own.
    const outcome = evaluate(recogniser({ available: true, result: result(0.9) }));

    expect(outcomeHands(outcome)).toEqual(['right']);
    expect(outcomeHandWords(outcome)).toBe('Right hand');
  });

  it('carries the profile the result was matched against', () => {
    // Vocabulary is owned per profile, so a result is meaningless without it —
    // and the profile on the outcome is the one the *recogniser* matched
    // against, not whatever the caller happened to have selected.
    const outcome = evaluate(
      recogniser({ available: true, result: result(0.9, 'नमस्ते', 'asl') }),
    );

    expect(outcome.kind === 'result' && outcome.profileId).toBe('asl');
  });
});

/* ------------------------------------------------------------- blocked input */

describe('evaluateRecognition blocked states', () => {
  it('reports an empty vocabulary as blocked rather than idle', () => {
    // The shipped profiles are all in this state. "Waiting for a gesture" would
    // tell the user to hold a sign up for a model that cannot read any.
    const empty = findProfile('bsl')!;
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: result(0.9) }),
      empty,
      planInput(empty, RIGHT_STREAMING),
      SAMPLES,
    );

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') throw new Error('unreachable');
    expect(outcome.blocker).toBe('no-vocabulary');
    expect(OUTCOME_HEADLINE.blocked).toBe('Cannot start');
    expect(outcomeConfidence(outcome)).toBeNull();
  });

  it('reports no gloves as blocked, and names that as the reason', () => {
    const outcome = evaluate(recogniser({ available: true }), {
      availability: { connected: { left: false, right: false }, streaming: { left: false, right: false } },
    });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') throw new Error('unreachable');
    expect(outcome.blocker).toBe('no-gloves');
  });

  it('blocks a two-handed sign when only one hand is streaming', () => {
    // The requirement comes from the vocabulary, not from a screen setting, so
    // one available hand cannot be stretched into a two-handed sign.
    const outcome = evaluate(recogniser({ available: true, result: result(0.9) }), {
      requirement: { kind: 'bimanual' },
    });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') throw new Error('unreachable');
    expect(outcome.blocker).toBe('needs-both-hands');
  });

  it('feeds a two-handed sign both hands, and attributes the result to both', () => {
    const outcome = evaluate(recogniser({ available: true, result: result(0.9) }), {
      requirement: { kind: 'bimanual' },
      availability: {
        connected: { left: true, right: true },
        streaming: { left: true, right: true },
      },
      samples: { left: { ...SAMPLE, side: 'left' }, right: SAMPLE },
    });

    expect(outcome.kind).toBe('result');
    expect(outcomeHands(outcome)).toEqual(['left', 'right']);
    expect(outcomeHandWords(outcome)).toBe('Both hands');
  });
});

describe('confidence is present only when measured', () => {
  const withoutConfidence: RecognitionOutcome[] = [
    { kind: 'unavailable', reason: 'none' },
    { kind: 'idle' },
    { kind: 'no-result' },
  ];

  it.each(withoutConfidence)('reports no confidence for $kind', (outcome) => {
    expect(outcomeConfidence(outcome)).toBeNull();
    expect(outcomeText(outcome)).toBeNull();
  });

  it('keeps every outcome kind in the headline table', () => {
    // A missing entry would render `undefined` in the panel's headline slot,
    // which is the sort of gap that ships as a blank line.
    for (const outcome of withoutConfidence) {
      expect(typeof OUTCOME_HEADLINE[outcome.kind]).toBe('string');
    }
    expect(typeof OUTCOME_HEADLINE.result).toBe('string');
    expect(typeof OUTCOME_HEADLINE.uncertain).toBe('string');
  });
});

/* ------------------------------------------------------------ translation */

describe('evaluateTranslation', () => {
  /** A translator that works, so the `translated` branch is reachable. */
  function stubTranslator(text = 'Hello'): Translator {
    return {
      isAvailable: true,
      unavailableReason: null,
      translate: (_source, target) => `${text} (${target})`,
    };
  }

  it('distinguishes "nothing recognised" from "recognition does not exist"', () => {
    // Two different problems with two different fixes. A single "no
    // translation" message would hide which one the user is looking at.
    const noModel = evaluateTranslation(
      new UnimplementedTranslator(),
      { kind: 'unavailable', reason: 'No model.' },
      'hi',
    );
    const noSignYet = evaluateTranslation(
      new UnimplementedTranslator(),
      { kind: 'idle' },
      'hi',
    );

    expect(noModel.kind === 'blocked' && noModel.from).toBe('no-recognition');
    expect(noSignYet.kind === 'blocked' && noSignYet.from).toBe('no-candidate');
    expect(noModel.kind === 'blocked' && noModel.reason).toContain('Recognition is unavailable');
    expect(noSignYet.kind === 'blocked' && noSignYet.reason).toContain('No phrase has been recognised');
  });

  it('blocks on an uncertain match too, because there is no phrase to translate', () => {
    const outcome = evaluate(recogniser({ available: true, result: result(0.42) }));
    const translation = evaluateTranslation(new UnimplementedTranslator(), outcome, 'hi');

    expect(translation.kind).toBe('blocked');
  });

  it('reports an unavailable translator over the phrase that exists', () => {
    const outcome = evaluate(recogniser({ available: true, result: result(0.95, 'धन्यवाद') }));
    const translation = evaluateTranslation(new UnimplementedTranslator(), outcome, 'hi');

    expect(translation.kind).toBe('unavailable');
    if (translation.kind !== 'unavailable') throw new Error('unreachable');
    expect(translation.sourceText).toBe('धन्यवाद');
    expect(translation.reason).toBe(TRANSLATION_UNAVAILABLE_REASON);
    // The apology never dresses itself up as a translation.
    expect(translation.reason).not.toContain('धन्यवाद');
  });

  it('translates when a translator is actually present', () => {
    const outcome = evaluate(recogniser({ available: true, result: result(0.95) }));
    const translation = evaluateTranslation(stubTranslator(), outcome, 'ta');

    expect(translation).toEqual({
      kind: 'translated',
      sourceText: 'नमस्ते',
      text: 'Hello (ta)',
      targetLanguageCode: 'ta',
    });
  });

  it('treats a translator that returns nothing as unavailable, not as empty text', () => {
    const silent: Translator = {
      isAvailable: true,
      unavailableReason: 'The engine returned nothing.',
      translate: () => null,
    };
    const outcome = evaluate(recogniser({ available: true, result: result(0.95) }));
    const translation = evaluateTranslation(silent, outcome, 'hi');

    expect(translation.kind).toBe('unavailable');
  });

  it('never constructs a translation string on its own', () => {
    // The shipped translator has no code path that produces text. If this ever
    // fails, something has started inventing translations.
    const translator = new UnimplementedTranslator();
    expect(translator.translate('नमस्ते', 'hi')).toBeNull();
    expect(translator.isAvailable).toBe(false);
  });
});
