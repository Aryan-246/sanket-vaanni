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

import type { VocabularyEntry } from './input';

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
   *
   * Kept as its own field rather than read from `vocabulary.length` because the
   * two are not the same claim: a profile may have signs *defined* that no model
   * has been trained on, and only the trained ones are recognisable. A test
   * asserts `vocabularySize <= vocabulary.length` so the pair cannot drift into
   * contradiction.
   */
  readonly vocabularySize: number;
  /**
   * The signs this profile defines, with the input each one requires.
   *
   * Empty for every profile today, which is why nothing is recognisable and why
   * `planInput` never returns `ready`. It is here now so that the moment a
   * Deaf-led vocabulary exists, the input routing is already typed and has a
   * place to be declared — rather than being retrofitted onto a pipeline that
   * assumed one hand.
   */
  readonly vocabulary: readonly VocabularyEntry[];
}

/**
 * Profiles the architecture is designed to support.
 *
 * Presence here is a statement of intent, not of capability.
 */
export const ASL_STARTER_VOCABULARY: readonly VocabularyEntry[] = [
  {
    signId: 'asl-hello',
    label: 'HELLO',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'asl-bye',
    label: 'BYE',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'asl-thank-you',
    label: 'THANK YOU',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'asl-yes',
    label: 'YES',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'asl-no',
    label: 'NO',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'asl-rest',
    label: 'REST',
    requirement: { kind: 'single', side: 'either' },
  },
];

export const ISL_STARTER_VOCABULARY: readonly VocabularyEntry[] = [
  {
    signId: 'isl-hello',
    label: 'नमस्ते / HELLO',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'isl-bye',
    label: 'अलविदा / BYE',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'isl-thank-you',
    label: 'धन्यवाद / THANK YOU',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'isl-yes',
    label: 'हाँ / YES',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'isl-no',
    label: 'नहीं / NO',
    requirement: { kind: 'single', side: 'either' },
  },
  {
    signId: 'isl-rest',
    label: 'विश्राम / REST',
    requirement: { kind: 'single', side: 'either' },
  },
];

export const SIGN_LANGUAGE_PROFILES: readonly SignLanguageProfile[] = [
  {
    id: 'isl',
    name: 'Indian Sign Language',
    nativeName: 'भारतीय सांकेतिक भाषा',
    languageCode: null,
    status: 'in-progress',
    vocabularySize: ISL_STARTER_VOCABULARY.length,
    vocabulary: ISL_STARTER_VOCABULARY,
  },
  {
    id: 'asl',
    name: 'American Sign Language',
    nativeName: null,
    languageCode: 'ase',
    status: 'in-progress',
    vocabularySize: ASL_STARTER_VOCABULARY.length,
    vocabulary: ASL_STARTER_VOCABULARY,
  },
  {
    id: 'bsl',
    name: 'British Sign Language',
    nativeName: null,
    languageCode: 'bfi',
    status: 'planned',
    vocabularySize: 0,
    vocabulary: [],
  },
];

export const DEFAULT_PROFILE_ID = 'isl';

export function findProfile(id: string): SignLanguageProfile | undefined {
  return SIGN_LANGUAGE_PROFILES.find((profile) => profile.id === id);
}
