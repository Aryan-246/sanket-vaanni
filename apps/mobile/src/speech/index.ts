/**
 * Text-to-speech contract.
 *
 * ## Now wired to the device's own engine
 *
 * `DeviceSpeaker` speaks through Android's built-in `TextToSpeech`, reached
 * through the app's own native module. It needs no network, no API key and no
 * third-party dependency, which is what makes speech output affordable under
 * the project's zero-budget and offline-first constraints.
 *
 * `UnavailableSpeaker` remains for the platforms and builds where that engine
 * is genuinely absent — iOS today, and any Android device with no TTS engine
 * installed. It is not a placeholder: it is the correct implementation of
 * "this cannot be done here", and it reports why rather than doing nothing
 * quietly.
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
  /**
   * Speaks `text`.
   *
   * Resolves when the platform has **finished** producing the audio, not when
   * the utterance was queued. That distinction is what lets the UI show a
   * truthful "speaking" indicator: a promise that resolves on queueing would
   * make the indicator clear while the phone was still talking.
   *
   * Rejects if the text could not be spoken at all.
   */
  speak(text: string, options?: SpeechOptions): Promise<void>;
  stop(): Promise<void>;
  /**
   * Notifies when `isAvailable` changes.
   *
   * Optional, because a speaker whose availability is known at construction —
   * `UnavailableSpeaker` — has nothing to announce. A speaker that has to ask
   * the platform does, because the answer arrives after the first render.
   */
  subscribe?(listener: () => void): () => void;
  probe?(forceReinit?: boolean): Promise<boolean>;
}

const NOT_IMPLEMENTED =
  'Speech output is not available on this platform in this build. Recognised ' +
  'text can still be read on screen and copied.';

/**
 * The speaker for platforms with no on-device engine.
 *
 * Rejects rather than resolving, so a caller cannot mistake "did nothing" for
 * "spoke successfully".
 */
export class UnavailableSpeaker implements Speaker {
  readonly isAvailable = false;
  readonly unavailableReason = NOT_IMPLEMENTED;

  async probe(): Promise<boolean> {
    return false;
  }

  async speak(text: string): Promise<void> {
    throw new Error(`${NOT_IMPLEMENTED} Attempted to speak: "${text}"`);
  }

  async stop(): Promise<void> {
    // Nothing to stop — this is a no-op rather than an error, so that a caller
    // cleaning up on unmount does not have to special-case it.
  }
}

export const SPEECH_UNAVAILABLE_REASON = NOT_IMPLEMENTED;

export {
  SpeechController,
  speechWatchdogMs,
  type SpeechOutcome,
  type SpeechState,
} from './controller';
export { DeviceSpeaker, type EngineReadiness } from './nativeSpeaker';
