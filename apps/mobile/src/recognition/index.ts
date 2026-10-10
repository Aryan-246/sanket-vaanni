/**
 * Recognition contract.
 *
 * ## There is no recogniser yet, and this module does not pretend otherwise
 *
 * Implementing recognition requires a defined vocabulary, a dataset and a
 * trained model — none of which exist. The dangerous failure mode is a
 * placeholder that returns a plausible sign with a plausible confidence,
 * because that would end up on screen as if it were real.
 *
 * So `UnimplementedRecogniser` returns `null` — "no sign" — and exposes the
 * reason. It never invents a sign and never reports a confidence.
 *
 * A confidence number may only be reported by a recogniser that is backed by a
 * real model evaluated on held-out signers. See `docs/testing-strategy.md` for
 * what any reported accuracy figure must state.
 */
import type { SensorSample } from '../sensors/types';
import type { SignLanguageProfile } from './profiles';

export interface RecognitionCandidate {
  /** Vocabulary key. Must exist in the active profile's vocabulary. */
  readonly signId: string;
  /** Display text for the sign, in the profile's own language. */
  readonly label: string;
  /**
   * Model confidence in 0..1.
   *
   * Only ever emitted by a real model. A recogniser that cannot compute this
   * honestly must return `null` from `recognise` instead.
   */
  readonly confidence: number;
}

export interface RecognitionResult {
  readonly profileId: string;
  readonly candidate: RecognitionCandidate;
  readonly timestampMs: number;
}

export interface Recogniser {
  readonly profileId: string;
  /** False while no model is loaded. The UI uses this to avoid implying capability. */
  readonly isAvailable: boolean;
  /** Human-readable explanation when `isAvailable` is false. */
  readonly unavailableReason: string | null;
  recognise(sample: SensorSample): RecognitionResult | null;
}

const NOT_IMPLEMENTED =
  'No recognition model exists yet. A vocabulary must be defined with a ' +
  'Deaf-led reviewer and a model trained and evaluated before recognition can ' +
  'report anything.';

/**
 * The recogniser used until a real model exists.
 *
 * `isAvailable` is `false`; every call returns `null`. There is no code path
 * that produces a sign or a confidence.
 */
export class UnimplementedRecogniser implements Recogniser {
  readonly profileId: string;
  readonly isAvailable = false;
  readonly unavailableReason = NOT_IMPLEMENTED;

  constructor(profile: SignLanguageProfile) {
    this.profileId = profile.id;
  }

  recognise(_sample: SensorSample): RecognitionResult | null {
    return null;
  }
}

export { DEFAULT_PROFILE_ID, findProfile, SIGN_LANGUAGE_PROFILES } from './profiles';
export type { SignLanguageProfile } from './profiles';
