/**
 * Speech output implemented on the device's own engine.
 *
 * Uses Android's `TextToSpeech` through the app's native module. No network, no
 * API key, no per-word cost — which is what makes speech output possible at all
 * under a zero-budget, offline-first requirement.
 *
 * ## Why availability is asynchronous
 *
 * `TextToSpeech` is constructed asynchronously on Android, and the engine may
 * never become ready at all if the device has no TTS engine or no voice data
 * installed. So this class starts in an *unknown* state and only claims to be
 * available once the platform has said so. Until then it refuses to speak, with
 * a reason that says it is still starting rather than pretending to fail.
 *
 * That is why `Speaker` gained `subscribe`: components need to re-render when
 * the answer arrives, which can be several seconds after launch on a cold
 * device.
 */
import {
  nativeIsLanguageAvailable,
  nativeSpeak,
  nativeSpeechReady,
  nativeStopSpeaking,
  isNativeModuleAvailable,
  nativeModuleUnavailableReason,
  type LanguageAvailability,
} from '../native/SanketVaanniNative';
import type { Speaker, SpeechOptions } from './index';

/**
 * The engine's readiness, as this app models it.
 *
 * `probing` is distinct from `unavailable` on purpose: one means "not known yet",
 * the other means "known not to work". Collapsing them would make a cold start
 * read as a broken device.
 */
export type EngineReadiness = 'probing' | 'ready' | 'unavailable';

export class DeviceSpeaker implements Speaker {
  private readiness: EngineReadiness = 'probing';
  private reason: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor() {
    if (!isNativeModuleAvailable) {
      this.readiness = 'unavailable';
      this.reason =
        nativeModuleUnavailableReason ?? 'On-device speech is not available in this build.';
      return;
    }

    void nativeSpeechReady()
      .then((ready) => {
        this.readiness = ready ? 'ready' : 'unavailable';
        this.reason = ready
          ? null
          : 'This device has no text-to-speech engine, or its engine failed to start.';
        this.notify();
      })
      .catch((error: unknown) => {
        this.readiness = 'unavailable';
        this.reason = error instanceof Error ? error.message : 'Speech engine check failed.';
        this.notify();
      });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get readinessState(): EngineReadiness {
    return this.readiness;
  }

  get isAvailable(): boolean {
    return this.readiness === 'ready';
  }

  get unavailableReason(): string | null {
    if (this.readiness === 'probing') return 'The speech engine is still starting.';
    return this.reason;
  }

  async speak(text: string, options?: SpeechOptions): Promise<void> {
    if (this.readiness === 'probing') {
      // Not a failure of the text — a failure of timing. Saying so is what lets
      // the caller offer a retry rather than a fix.
      throw new Error('The speech engine is still starting. Try again in a moment.');
    }
    if (this.readiness !== 'ready') {
      throw new Error(this.reason ?? 'Speech is not available on this device.');
    }

    await nativeSpeak(text, {
      language: options?.language,
      rate: options?.rate,
      pitch: options?.pitch,
      flush: true,
    });
  }

  async stop(): Promise<void> {
    await nativeStopSpeaking();
  }

  /**
   * Whether the device can actually speak a language.
   *
   * Exposed so the language settings can say honestly which output languages
   * have a voice installed. A device with no Hindi voice must not be able to
   * look as though it would speak Hindi.
   */
  async checkLanguage(tag: string): Promise<LanguageAvailability> {
    return nativeIsLanguageAvailable(tag);
  }
}
