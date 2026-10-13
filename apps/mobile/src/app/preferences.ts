/**
 * User preferences that are not theme.
 *
 * Pure data and pure functions — no React, no storage, no native modules — so
 * the parsing rules can be tested directly and `storage` can import the types
 * without creating a cycle.
 *
 * Theme is deliberately **not** here. It has its own storage key and its own
 * single writer (`ThemeProvider`); carrying it in two places would invite the
 * two copies to disagree.
 */
import { DEFAULT_PROFILE_ID } from '../recognition/profiles';

/** What the user chose. `system` follows the OS setting. */
export type ThemeMode = 'system' | 'dark' | 'light';

export const THEME_MODES: readonly ThemeMode[] = ['system', 'dark', 'light'];

export interface AppPreferences {
  /** Sign-language input profile. Never merged with another language. */
  readonly signProfileId: string;
  /** BCP-47-ish code for the language recognised text is rendered/spoken in. */
  readonly targetLanguageCode: string;
  /**
   * Whether the user *wants* speech output. This is intent, not capability —
   * `speaker.isAvailable` decides whether anything can actually be spoken, and
   * the UI must report "unavailable" rather than a silent success when the two
   * disagree.
   */
  readonly voiceEnabled: boolean;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  signProfileId: DEFAULT_PROFILE_ID,
  targetLanguageCode: 'en',
  // Off by default. Turning on a feature that cannot work yet should be a
  // deliberate act, not something the user discovers was already on.
  voiceEnabled: false,
};

export interface OutputLanguage {
  readonly code: string;
  readonly name: string;
  /** Endonym, where one is in common use. */
  readonly nativeName: string | null;
  /**
   * BCP-47 tag handed to the speech engine, e.g. `hi-IN`.
   *
   * Regional rather than bare (`hi-IN`, not `hi`) because Android's voice data
   * is installed per locale, and asking for the region the app targets gets the
   * right voice instead of whatever the engine picks as a fallback.
   */
  readonly speechTag: string;
}

/**
 * Languages offered as translation *targets*.
 *
 * This is a list of output languages, not of sign languages. The two are
 * different axes and are configured separately: a user may sign ISL and read
 * Hindi, or sign ASL and read English. Nothing here implies that any sign
 * language has a vocabulary — none do.
 *
 * ## There is no `speechWired` flag any more
 *
 * There used to be, and it was `false` for every language — a build-time claim
 * that this app had no speaker. It now does, so that constant would have been a
 * lie in one direction or the other for every device. Whether a given phone can
 * actually speak a given language is a fact about *that phone's* installed voice
 * data, so it is asked of the engine at runtime
 * (`DeviceSpeaker.checkLanguage`) and reported per language, rather than
 * asserted here for all of them.
 */
export const OUTPUT_LANGUAGES: readonly OutputLanguage[] = [
  { code: 'en', name: 'English', nativeName: null, speechTag: 'en-IN' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', speechTag: 'hi-IN' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी', speechTag: 'mr-IN' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', speechTag: 'ta-IN' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', speechTag: 'bn-IN' },
];

export function findOutputLanguage(code: string): OutputLanguage | undefined {
  return OUTPUT_LANGUAGES.find((language) => language.code === code);
}

/**
 * Coerces an untrusted stored value into valid preferences.
 *
 * Every field falls back to its default independently, so one corrupt field —
 * or a preference removed in a later version — cannot discard the rest.
 */
export function parsePreferences(raw: unknown): AppPreferences {
  if (raw === null || typeof raw !== 'object') return DEFAULT_PREFERENCES;
  const record = raw as Record<string, unknown>;

  const signProfileId =
    typeof record.signProfileId === 'string' && record.signProfileId.length > 0
      ? record.signProfileId
      : DEFAULT_PREFERENCES.signProfileId;

  const targetLanguageCode =
    typeof record.targetLanguageCode === 'string' &&
    findOutputLanguage(record.targetLanguageCode) !== undefined
      ? record.targetLanguageCode
      : DEFAULT_PREFERENCES.targetLanguageCode;

  const voiceEnabled =
    typeof record.voiceEnabled === 'boolean'
      ? record.voiceEnabled
      : DEFAULT_PREFERENCES.voiceEnabled;

  return { signProfileId, targetLanguageCode, voiceEnabled };
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}
