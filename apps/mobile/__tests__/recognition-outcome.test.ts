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
  outcomeText,
  type RecognitionOutcome,
} from '../src/recognition/outcome';
import type {
  RecognitionResult,
  Recogniser,
} from '../src/recognition';
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

function result(confidence: number, label = 'नमस्ते'): RecognitionResult {
  return {
    profileId: 'isl',
    candidate: { signId: 'namaste', label, confidence },
    timestampMs: 1_000,
  };
}

/* ------------------------------------------------------ the five outcomes */

describe('evaluateRecognition', () => {
  it('reports an absent model as unavailable, with the reason the model gave', () => {
    const outcome = evaluateRecognition(
      recogniser({ available: false, reason: 'No model has been trained.' }),
      'isl',
      SAMPLE,
    );

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'No model has been trained.' });
    expect(OUTCOME_HEADLINE[outcome.kind]).toBe('Recognition unavailable');
  });

  it('says so when an unavailable recogniser gave no reason, rather than inventing one', () => {
    const outcome = evaluateRecognition(recogniser({ available: false }), 'isl', SAMPLE);

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    // It does not claim to know why; it reports that nobody said.
    expect(outcome.reason).toContain('no reason was reported');
  });

  it('is idle, not no-result, when no frame has been evaluated', () => {
    // The distinction the brief asks for: with no reading there is nothing to
    // say about a match, and "no match" would be a claim nobody made.
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: result(0.99) }),
      'isl',
      null,
    );

    expect(outcome).toEqual({ kind: 'idle' });
    expect(OUTCOME_HEADLINE.idle).toBe('Waiting for a gesture');
  });

  it('separates "evaluated and matched nothing" from "never evaluated"', () => {
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: null }),
      'isl',
      SAMPLE,
    );

    expect(outcome).toEqual({ kind: 'no-result' });
    expect(OUTCOME_HEADLINE['no-result']).toBe('No matching sign');
  });

  it('shows a weak match as uncertain, with the model’s own number', () => {
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: result(0.42) }),
      'isl',
      SAMPLE,
    );

    expect(outcome.kind).toBe('uncertain');
    expect(outcomeConfidence(outcome)).toBe(0.42);
    // An uncertain outcome is not text worth speaking or translating.
    expect(outcomeText(outcome)).toBeNull();
  });

  it('presents a match at or above the threshold as a result', () => {
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: result(RESULT_CONFIDENCE_THRESHOLD) }),
      'isl',
      SAMPLE,
    );

    expect(outcome.kind).toBe('result');
    expect(outcomeText(outcome)).toBe('नमस्ते');
    expect(outcomeConfidence(outcome)).toBe(RESULT_CONFIDENCE_THRESHOLD);
  });

  it('carries the profile the result was matched against', () => {
    // Vocabulary is owned per profile, so a result is meaningless without it.
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: result(0.9) }),
      'asl',
      SAMPLE,
    );

    expect(outcome.kind === 'result' && outcome.profileId).toBe('asl');
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
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: result(0.42) }),
      'isl',
      SAMPLE,
    );
    const translation = evaluateTranslation(new UnimplementedTranslator(), outcome, 'hi');

    expect(translation.kind).toBe('blocked');
  });

  it('reports an unavailable translator over the phrase that exists', () => {
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: result(0.95, 'धन्यवाद') }),
      'isl',
      SAMPLE,
    );
    const translation = evaluateTranslation(new UnimplementedTranslator(), outcome, 'hi');

    expect(translation.kind).toBe('unavailable');
    if (translation.kind !== 'unavailable') throw new Error('unreachable');
    expect(translation.sourceText).toBe('धन्यवाद');
    expect(translation.reason).toBe(TRANSLATION_UNAVAILABLE_REASON);
    // The apology never dresses itself up as a translation.
    expect(translation.reason).not.toContain('धन्यवाद');
  });

  it('translates when a translator is actually present', () => {
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: result(0.95) }),
      'isl',
      SAMPLE,
    );
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
    const outcome = evaluateRecognition(
      recogniser({ available: true, result: result(0.95) }),
      'isl',
      SAMPLE,
    );
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
