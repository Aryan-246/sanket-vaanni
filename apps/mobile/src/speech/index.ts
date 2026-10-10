/**
 * Text-to-speech contract.
 *
 * ## Not wired to a native engine yet
 *
 * Speaking recognised signs is milestone M5. Native TTS
 * (`react-native-tts` or equivalent) is a native module, and adding one that
 * has nothing to speak would be dependency weight with no behaviour behind it.
 *
 * What matters now is that the seam exists and is honest: `isAvailable` is
 * `false` and `speak` reports why, rather than silently doing nothing or
 * faking audio.
 */

export interface SpeechOptions {
  /** BCP-47 tag, e.g. `hi-IN` or `en-IN`. */
  readonly language?: string;
  readonly rate?: number;
  readonly pitch?: number;
}

export interface Speaker {
  readonly isAvailable: boolean;
  readonly unavailableReason: string | null;
  /** Resolves when speech has been queued (not necessarily finished). */
  speak(text: string, options?: SpeechOptions): Promise<void>;
  stop(): Promise<void>;
}

const NOT_IMPLEMENTED =
  'Speech output is not wired up. There is no recognised text to speak yet, ' +
  'and no TTS engine has been added (planned for milestone M5).';

/**
 * The speaker used until TTS is added.
 *
 * Rejects rather than resolving, so a caller cannot mistake "did nothing" for
 * "spoke successfully".
 */
export class UnavailableSpeaker implements Speaker {
  readonly isAvailable = false;
  readonly unavailableReason = NOT_IMPLEMENTED;

  async speak(text: string): Promise<void> {
    throw new Error(`${NOT_IMPLEMENTED} Attempted to speak: "${text}"`);
  }

  async stop(): Promise<void> {
    // Nothing to stop — this is a no-op rather than an error, so that a caller
    // cleaning up on unmount does not have to special-case it.
  }
}

export const SPEECH_UNAVAILABLE_REASON = NOT_IMPLEMENTED;
