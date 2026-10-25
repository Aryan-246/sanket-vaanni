/**
 * The app's own native module.
 *
 * `SanketVaanniNative` is registered in `MainApplication.kt` and implemented in
 * `android/app/src/main/java/com/sanketvaani/native/SanketVaanniModule.kt`. It
 * provides on-device text-to-speech and the system clipboard — two platform
 * classes that need no third-party dependency and no network.
 *
 * ## Absent is a normal state, not an error
 *
 * This module does not exist on iOS, and does not exist in Jest. Every access
 * goes through the guards below, which return an explicit "not present" answer
 * rather than throwing. Callers are required to handle that answer — the
 * speaker reports itself unavailable rather than silently doing nothing, which
 * is what keeps a toggle from appearing to work while nothing happens.
 */
import { NativeModules, Platform } from 'react-native';

export interface SpeakOptions {
  /** BCP-47 tag, e.g. `hi-IN`. */
  language?: string;
  rate?: number;
  pitch?: number;
  /** Interrupt anything already speaking. Defaults to true. */
  flush?: boolean;
}

export interface LanguageAvailability {
  readonly available: boolean;
  readonly resolvedTag?: string;
  readonly engineDefaultTag?: string;
  readonly reason?: string;
}

/**
 * What the installed package actually is.
 *
 * Read from the Android package manager, so it cannot disagree with the APK on
 * the device the way a hand-maintained constant can.
 */
export interface BuildInfo {
  readonly packageName: string;
  readonly versionName: string;
  readonly versionCode: number;
  readonly androidRelease: string;
  readonly androidSdk: number;
  readonly manufacturer: string;
  readonly model: string;
}

/** One reading of the recogniser's state. */
export interface TranscriptSnapshot {
  readonly isListening: boolean;
  /** Words the recogniser is still revising. Replaced, not appended to. */
  readonly partial: string;
  /** The settled transcript for the current utterance. */
  readonly finalText: string;
  /** A message to show the user, or null. */
  readonly error: string | null;
  /** Android's own error code, or null. */
  readonly errorCode: number | null;
  /**
   * Increments each time the microphone opens.
   *
   * So a caller can tell "the session I started" from "a session that has since
   * ended and been restarted", and not attribute a stale transcript to itself.
   */
  readonly sessionId: number;
}

interface SanketVaanniNativeShape {
  isAvailable(): Promise<boolean>;
  reinitialize?(): Promise<boolean>;
  isLanguageAvailable(tag: string): Promise<LanguageAvailability>;
  /** Resolves when the platform reports the utterance finished. */
  speak(text: string, options?: SpeakOptions | null): Promise<void>;
  stop(): Promise<void>;
  isSpeaking(): Promise<boolean>;
  setClipboard(text: string): Promise<boolean>;
  getClipboard(): Promise<string | null>;
  getBuildInfo(): Promise<BuildInfo>;

  isRecognitionAvailable(): Promise<boolean>;
  hasOnDeviceRecognition(): Promise<boolean | null>;
  startRecognition(languageTag: string | null, preferOffline: boolean): Promise<void>;
  stopRecognition(): Promise<void>;
  getTranscript(): Promise<TranscriptSnapshot>;
  clearTranscript(): Promise<void>;
}

const native = (NativeModules as Record<string, unknown>).SanketVaanniNative as
  | SanketVaanniNativeShape
  | undefined;

/** True when the module is registered on this platform and this build. */
export const isNativeModuleAvailable = native !== undefined && native !== null;

/** Why the module is not present, phrased for display. Null when it is present. */
export const nativeModuleUnavailableReason: string | null = isNativeModuleAvailable
  ? null
  : Platform.OS === 'android'
    ? 'The device capabilities module is not registered in this build.'
    : 'On-device speech and clipboard are implemented for Android only in this build.';

function requireNative(): SanketVaanniNativeShape | null {
  return native ?? null;
}

/**
 * Whether the platform speech engine finished initialising.
 *
 * Asynchronous because `TextToSpeech` construction is asynchronous on Android —
 * the engine is created in the background and may never become ready if the
 * device has no TTS engine installed at all. Resolving `false` is the correct
 * answer in that case, and the UI reports it.
 */
export async function nativeSpeechReady(): Promise<boolean> {
  const module = requireNative();
  if (!module) return false;
  try {
    return await module.isAvailable();
  } catch {
    return false;
  }
}

export async function nativeReinitializeSpeech(): Promise<boolean> {
  const module = requireNative();
  if (!module) return false;
  try {
    if (typeof module.reinitialize === 'function') {
      return await module.reinitialize();
    }
    return await module.isAvailable();
  } catch {
    return false;
  }
}

export async function nativeIsLanguageAvailable(tag: string): Promise<LanguageAvailability> {
  const module = requireNative();
  if (!module) return { available: false, reason: 'Device capabilities module not present.' };
  try {
    return await module.isLanguageAvailable(tag);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'Language check failed.',
    };
  }
}

export async function nativeSpeak(text: string, options?: SpeakOptions): Promise<void> {
  const module = requireNative();
  if (!module) throw new Error('Device capabilities module not present.');
  await module.speak(text, options ?? null);
}

export async function nativeStopSpeaking(): Promise<void> {
  const module = requireNative();
  if (!module) return;
  await module.stop();
}

export async function nativeIsSpeaking(): Promise<boolean> {
  const module = requireNative();
  if (!module) return false;
  try {
    return await module.isSpeaking();
  } catch {
    return false;
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  const module = requireNative();
  if (!module) return false;
  try {
    return await module.setClipboard(text);
  } catch {
    return false;
  }
}

export async function readClipboard(): Promise<string | null> {
  const module = requireNative();
  if (!module) return null;
  try {
    return await module.getClipboard();
  } catch {
    return null;
  }
}

/**
 * The installed package's identity, or null when the module is not present.
 *
 * Null rather than a guessed value: a caller that cannot read the real version
 * strings must say so, not invent plausible ones.
 */
export async function nativeBuildInfo(): Promise<BuildInfo | null> {
  const module = requireNative();
  if (!module) return null;
  try {
    return await module.getBuildInfo();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- captions */

/** Whether a speech recognition service exists on this device at all. */
export async function nativeRecognitionAvailable(): Promise<boolean> {
  const module = requireNative();
  if (!module) return false;
  try {
    return await module.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/**
 * Whether the phone has an on-device recognition model.
 *
 * `null` means the platform could not be asked — either the API does not exist
 * on this Android version or no recogniser is installed. Callers must render
 * that as "unknown", never as "yes".
 */
export async function nativeOnDeviceRecognition(): Promise<boolean | null> {
  const module = requireNative();
  if (!module) return null;
  try {
    return await module.hasOnDeviceRecognition();
  } catch {
    return null;
  }
}

/**
 * Opens the microphone.
 *
 * `preferOffline` is a request, not a guarantee — see the note in
 * `SpeechRecognizerBridge.kt`. Nothing in this app may claim captions ran
 * locally on the strength of having asked for it.
 */
export async function nativeStartRecognition(
  languageTag: string | null,
  preferOffline: boolean,
): Promise<void> {
  const module = requireNative();
  if (!module) throw new Error('Device capabilities module not present.');
  await module.startRecognition(languageTag, preferOffline);
}

export async function nativeStopRecognition(): Promise<void> {
  const module = requireNative();
  if (!module) return;
  await module.stopRecognition();
}

/** The recogniser's state right now. Never throws; a failure reads as idle. */
export async function nativeTranscript(): Promise<TranscriptSnapshot | null> {
  const module = requireNative();
  if (!module) return null;
  try {
    return await module.getTranscript();
  } catch {
    return null;
  }
}

export async function nativeClearTranscript(): Promise<void> {
  const module = requireNative();
  if (!module) return;
  try {
    await module.clearTranscript();
  } catch {
    // Clearing a transcript that is already empty is not a failure worth
    // reporting to anyone.
  }
}
