/**
 * Direct vocabulary translator.
 *
 * For supported starter signs, resolves vocabulary directly into the requested target language
 * (English, Hindi, etc.) without failing or requiring an external cloud translation service.
 */
import type { Translator } from './index';

export class DirectVocabularyTranslator implements Translator {
  readonly isAvailable = true;
  readonly unavailableReason = null;

  translate(text: string, targetLanguageCode: string): string | null {
    if (!text || text.trim().length === 0) return null;
    const clean = text.trim().toUpperCase();

    // English direct pass-through
    if (targetLanguageCode.toLowerCase().startsWith('en')) {
      // Strip any bilingual slash like "नमस्ते / HELLO"
      if (clean.includes('/')) {
        const parts = clean.split('/').map((s) => s.trim());
        return parts.find((p) => /^[A-Z\s]+$/.test(p)) ?? clean;
      }
      return text;
    }

    // Hindi translation lookup for starter words
    if (targetLanguageCode.toLowerCase().startsWith('hi')) {
      const HINDI_LOOKUP: Record<string, string> = {
        'HELLO': 'नमस्ते',
        'BYE': 'अलविदा',
        'THANK YOU': 'धन्यवाद',
        'YES': 'हाँ',
        'NO': 'नहीं',
        'REST': 'विश्राम',
      };
      if (HINDI_LOOKUP[clean]) {
        return HINDI_LOOKUP[clean];
      }
      if (clean.includes('/')) {
        const parts = clean.split('/').map((s) => s.trim());
        const devanagariPart = parts.find((p) => /[\u0900-\u097F]/.test(p));
        if (devanagariPart) return devanagariPart;
      }
      return text;
    }

    return text;
  }
}
