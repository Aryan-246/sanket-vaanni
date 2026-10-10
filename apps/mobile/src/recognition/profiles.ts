/**
 * Sign-language vocabulary profiles.
 *
 * ## The rule this file exists to enforce
 *
 * Sign languages are not dialects of one another. ISL, ASL and BSL have
 * distinct grammars and, in places, mutually incompatible gestures — a hand
 * shape that means one thing in ISL may be meaningless or offensive in ASL.
 * There is therefore **no shared gesture dictionary**, and there must never be
 * one. Vocabulary is owned per profile.
 *
 * ## Status: no vocabulary exists
 *
 * All profiles below are `planned` with `vocabularySize: 0`. No signs have been
 * defined, because defining them is a Deaf-led linguistic task, not a coding
 * task, and no dataset or model exists. Any sign list appearing in this
 * repository before that work is done should be treated as fiction.
 */

export type ProfileStatus = 'planned' | 'in-progress' | 'available';

export interface SignLanguageProfile {
  /** Stable identifier, e.g. `isl`. Used as a storage and API key. */
  readonly id: string;
  /** English name. */
  readonly name: string;
  /** Endonym where one is in common use, e.g. `भारतीय सांकेतिक भाषा`. */
  readonly nativeName: string | null;
  /**
   * ISO 639 code(s) associated with the language, where one exists. Sign
   * languages are frequently not covered by ISO 639, so this is often null.
   */
  readonly languageCode: string | null;
  readonly status: ProfileStatus;
  /**
   * Number of signs the profile can currently recognise. Zero everywhere —
   * deliberately. This number must only ever come from a real, evaluated
   * vocabulary.
   */
  readonly vocabularySize: number;
}

/**
 * Profiles the architecture is designed to support.
 *
 * Presence here is a statement of intent, not of capability.
 */
export const SIGN_LANGUAGE_PROFILES: readonly SignLanguageProfile[] = [
  {
    id: 'isl',
    name: 'Indian Sign Language',
    nativeName: 'भारतीय सांकेतिक भाषा',
    languageCode: null,
    status: 'planned',
    vocabularySize: 0,
  },
  {
    id: 'asl',
    name: 'American Sign Language',
    nativeName: null,
    languageCode: 'ase',
    status: 'planned',
    vocabularySize: 0,
  },
  {
    id: 'bsl',
    name: 'British Sign Language',
    nativeName: null,
    languageCode: 'bfi',
    status: 'planned',
    vocabularySize: 0,
  },
];

export const DEFAULT_PROFILE_ID = 'isl';

export function findProfile(id: string): SignLanguageProfile | undefined {
  return SIGN_LANGUAGE_PROFILES.find((profile) => profile.id === id);
}
