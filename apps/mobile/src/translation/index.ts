/**
 * Translation contract.
 *
 * ## Two different languages, two different axes
 *
 * A **sign language** is the input profile: which vocabulary the glove is being
 * read against. A **target language** is how the result is written and spoken.
 * They are configured separately and are not interchangeable — a user may sign
 * ISL and read Hindi, or sign ASL and read English. There is exactly one place
 * where the two are brought together, and it is `evaluateTranslation`.
 *
 * ## There is no translator, and this module says so
 *
 * Translating between languages is not a lookup table, and sign languages are
 * not encodings of spoken ones — ISL does not have the same grammar as English
 * or Hindi, and word-for-word substitution produces something that is not a
 * sentence in either. Implementing this properly needs a model and, before that,
 * a vocabulary.
 *
 * So `UnimplementedTranslator` reports `isAvailable: false`, and every outcome it
 * can produce is either "nothing to translate" or "cannot translate, and here is
 * why". It never returns a string, and there is no code path in this file that
 * constructs one.
 */
import type { RecognitionOutcome } from '../recognition/outcome';
import { outcomeText } from '../recognition/outcome';

const NOT_IMPLEMENTED =
  'Translation is not implemented. It requires a vocabulary, a defined source ' +
  'sign language and a model — none of which exist. Substituting words between ' +
  'languages would produce text that is not a sentence in either.';

export interface Translator {
  readonly isAvailable: boolean;
  readonly unavailableReason: string | null;
  /**
   * Translates recognised text into a target language.
   *
   * Returns `null` when it cannot, which a caller must handle as a failure rather
   * than as an empty translation.
   */
  translate(text: string, targetLanguageCode: string): string | null;
}

export class UnimplementedTranslator implements Translator {
  readonly isAvailable = false;
  readonly unavailableReason = NOT_IMPLEMENTED;

  translate(_text: string, _targetLanguageCode: string): string | null {
    return null;
  }
}

export { DirectVocabularyTranslator } from './DirectVocabularyTranslator';

export type TranslationOutcome =
  /** Nothing has been recognised, so there is nothing to translate. */
  | { readonly kind: 'blocked'; readonly reason: string; readonly from: 'no-recognition' | 'no-candidate' }
  /** There is text, but no translator to produce a translation. */
  | { readonly kind: 'unavailable'; readonly sourceText: string; readonly reason: string }
  | {
      readonly kind: 'translated';
      readonly sourceText: string;
      readonly text: string;
      readonly targetLanguageCode: string;
    };

/**
 * Classifies what the translator can currently say.
 *
 * The `from` field on `blocked` is the distinction the brief asks for: "no
 * recognition available" and "no translation produced" are different problems
 * with different fixes, and a single "no translation" message would hide which
 * one the user is looking at.
 */
export function evaluateTranslation(
  translator: Translator,
  outcome: RecognitionOutcome,
  targetLanguageCode: string,
): TranslationOutcome {
  const sourceText = outcomeText(outcome);

  if (sourceText === null) {
    return {
      kind: 'blocked',
      from: outcome.kind === 'unavailable' ? 'no-recognition' : 'no-candidate',
      reason:
        outcome.kind === 'unavailable'
          ? 'Recognition is unavailable, so there is no recognised phrase to translate.'
          : 'No phrase has been recognised yet, so there is nothing to translate.',
    };
  }

  if (!translator.isAvailable) {
    return {
      kind: 'unavailable',
      sourceText,
      reason: translator.unavailableReason ?? NOT_IMPLEMENTED,
    };
  }

  const text = translator.translate(sourceText, targetLanguageCode);
  if (text === null) {
    return {
      kind: 'unavailable',
      sourceText,
      reason: translator.unavailableReason ?? 'The translator returned no text.',
    };
  }

  return { kind: 'translated', sourceText, text, targetLanguageCode };
}

export const TRANSLATION_UNAVAILABLE_REASON = NOT_IMPLEMENTED;
