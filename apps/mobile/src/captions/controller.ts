/**
 * Live captions.
 *
 * ## What this is
 *
 * One place that holds the running conversation — what the microphone heard,
 * what the glove produced, and what the user typed — each tagged with where it
 * came from. Three inputs, one transcript, and the provenance never collapses:
 * a line of text on screen always says which of the three produced it, because
 * a caption the user cannot attribute is a caption they cannot trust.
 *
 * ## Audio is never stored
 *
 * The microphone path hands audio to the phone's own speech recogniser and
 * receives text back. Nothing in this project writes audio anywhere, and there
 * is no buffer to leak, because there is no buffer — the recogniser owns the
 * audio for the duration of the utterance and this module only ever sees the
 * words.
 *
 * ## What it will not claim
 *
 * `EXTRA_PREFER_OFFLINE` is passed through, and the resulting transcript is not
 * labelled "offline". Android's recogniser frequently ignores that preference
 * and streams to the vendor's servers, and this module has no way to tell which
 * happened. `onDeviceModel` reports the platform's own answer to whether an
 * on-device model exists — `null` when the platform cannot be asked — and the
 * UI is required to present it as the phone's claim rather than as a guarantee.
 */
import { PermissionsAndroid, Platform } from 'react-native';

import {
  isNativeModuleAvailable,
  nativeClearTranscript,
  nativeOnDeviceRecognition,
  nativeRecognitionAvailable,
  nativeStartRecognition,
  nativeStopRecognition,
  nativeTranscript,
} from '../native/SanketVaanniNative';

/** Which of the three inputs produced a line of text. */
export type CaptionSource = 'microphone' | 'glove' | 'typed';

/** One line of the conversation. */
export interface CaptionLine {
  readonly id: string;
  readonly text: string;
  readonly source: CaptionSource;
  readonly atMs: number;
}

export type MicrophonePermission = 'unknown' | 'granted' | 'denied' | 'blocked';

export type CaptionsListeningState = 'idle' | 'starting' | 'listening' | 'denied' | 'error';

export interface CaptionsState {
  /** Whether the microphone is open right now. */
  readonly isListening: boolean;
  readonly listening: CaptionsListeningState;
  /** Settled lines, oldest first. */
  readonly lines: readonly CaptionLine[];
  /** The words the recogniser is still revising. Not yet a line. */
  readonly interim: string;
  readonly permission: MicrophonePermission;
  /** A recognition service exists on this device. */
  readonly recognitionAvailable: boolean;
  /**
   * The platform's answer to whether an on-device model exists.
   *
   * Null when the platform cannot be asked — Android below 12, no recogniser
   * installed, or the native module absent from the build.
   */
  readonly onDeviceModel: boolean | null;
  /** Why captions cannot run, when they cannot. Null when they can. */
  readonly unavailableReason: string | null;
  /** A message for the user about the last failure, or null. */
  readonly error: string | null;
}

const INITIAL: CaptionsState = {
  isListening: false,
  listening: 'idle',
  lines: [],
  interim: '',
  permission: 'unknown',
  recognitionAvailable: false,
  onDeviceModel: null,
  unavailableReason: null,
  error: null,
};

/**
 * How often the recogniser's state is read while the microphone is open.
 *
 * A local bridge read, not a network call. Fast enough that interim words
 * appear while they are still being said, slow enough that a long utterance
 * does not cost a frame per word.
 */
export const POLL_INTERVAL_MS = 150;

/** How long a line may be before it is not a caption any more. */
export const MAX_CAPTION_LENGTH = 500;

/** How many lines are kept. Matches the history limit so the two agree. */
export const MAX_CAPTION_LINES = 200;

let lineCounter = 0;

function makeLine(text: string, source: CaptionSource): CaptionLine {
  lineCounter += 1;
  return {
    id: `line-${Date.now().toString(36)}-${lineCounter.toString(36)}`,
    text: text.trim().slice(0, MAX_CAPTION_LENGTH),
    source,
    atMs: Date.now(),
  };
}

/**
 * The caption store.
 *
 * Single writer, like the speech controller: only this class mutates state, and
 * every mutation goes through `emit`, so there is exactly one path to the
 * screen and no way for two sources to interleave into an impossible state.
 */
export class CaptionsController {
  private state: CaptionsState = INITIAL;
  private readonly listeners = new Set<(state: CaptionsState) => void>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** The final text already turned into a line, so it is not added twice. */
  private committedFinal = '';
  private sessionId = 0;

  constructor() {
    /*
     * Availability is asked once at construction rather than on every render.
     * It is a fact about the device and the installed package, neither of which
     * changes while the app is running.
     */
    if (!isNativeModuleAvailable) {
      this.state = {
        ...INITIAL,
        recognitionAvailable: false,
        unavailableReason:
          Platform.OS === 'android'
            ? 'The device capabilities module is not registered in this build, so the microphone cannot be opened.'
            : 'Live captions are implemented for Android only in this build.',
      };
      return;
    }

    void this.probe();
  }

  private async probe(): Promise<void> {
    const [available, onDevice] = await Promise.all([
      nativeRecognitionAvailable(),
      nativeOnDeviceRecognition(),
    ]);

    this.emit({
      recognitionAvailable: available,
      onDeviceModel: onDevice,
      unavailableReason: available
        ? null
        : 'This device has no speech recognition service installed, so it cannot turn speech into text.',
    });
  }

  getSnapshot = (): CaptionsState => this.state;

  subscribe = (listener: (state: CaptionsState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Opens the microphone.
   *
   * Resolves when the microphone is actually open, or throws with a reason the
   * user can read. The permission is requested *here* and nowhere else — never
   * at launch — so a user who does not want captions is never asked for the
   * microphone at all.
   */
  async start(options: { languageTag?: string | null; preferOffline?: boolean } = {}): Promise<void> {
    if (this.state.isListening) return;

    if (!this.state.recognitionAvailable) {
      const reason =
        this.state.unavailableReason ?? 'Speech recognition is not available on this device.';
      this.emit({ listening: 'error', error: reason });
      throw new Error(reason);
    }

    this.emit({ listening: 'starting', error: null });

    const permission = await this.requestMicrophone();
    if (permission !== 'granted') {
      this.emit({
        listening: 'denied',
        permission,
        isListening: false,
        error:
          permission === 'blocked'
            ? 'Microphone access was declined permanently. Captions stay off until it is allowed in Settings.'
            : 'Microphone access was declined, so captions cannot run.',
      });
      return;
    }

    try {
      await nativeStartRecognition(options.languageTag ?? null, options.preferOffline ?? true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The recogniser could not be started.';
      this.emit({ listening: 'error', isListening: false, error: message });
      throw error;
    }

    this.committedFinal = '';
    this.emit({ listening: 'listening', isListening: true, permission: 'granted', error: null });
    this.beginPolling();
  }

  /** Closes the microphone. Safe to call when it is already closed. */
  async stop(): Promise<void> {
    this.stopPolling();
    await nativeStopRecognition();
    this.emit({ isListening: false, listening: 'idle', interim: '' });
  }

  /**
   * Adds a line from the glove.
   *
   * Separate from the microphone path because the two have different
   * reliability stories: a glove line is a reading the hardware produced, and a
   * microphone line is a service's best guess. They share a transcript but not
   * an origin.
   */
  addGloveLine(text: string): void {
    this.addLine(text, 'glove');
  }

  /** Adds a line the user typed. */
  addTypedLine(text: string): void {
    this.addLine(text, 'typed');
  }

  /** Empties the transcript. Does not close the microphone. */
  async clear(): Promise<void> {
    this.committedFinal = '';
    await nativeClearTranscript();
    this.emit({ lines: [], interim: '', error: null });
  }

  /**
   * Replaces the transcript wholesale.
   *
   * Used when a synced account replaces the local one, so the screen shows one
   * body of text rather than a merge of two.
   */
  replaceLines(lines: readonly CaptionLine[]): void {
    this.emit({ lines: lines.slice(-MAX_CAPTION_LINES) });
  }

  dispose(): void {
    this.stopPolling();
  }

  /* ------------------------------------------------------------- private */

  private addLine(text: string, source: CaptionSource): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const next = [...this.state.lines, makeLine(trimmed, source)];
    this.emit({ lines: next.slice(-MAX_CAPTION_LINES) });
  }

  private beginPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * One read of the recogniser.
   *
   * Three things can happen: words are still being revised, the utterance has
   * settled, or the platform reported a failure. The third case stops the poll
   * — a recogniser that has errored will not recover by being asked again, and
   * a timer that outlives the microphone is a battery cost with no purpose.
   */
  private async tick(): Promise<void> {
    const snapshot = await nativeTranscript();
    if (snapshot === null) {
      this.stopPolling();
      this.emit({
        isListening: false,
        listening: 'error',
        error: 'The recogniser stopped reporting. Captions are off.',
      });
      return;
    }

    // A session that restarted underneath us is a different utterance; adopt it
    // rather than attributing its words to the previous one.
    if (snapshot.sessionId !== this.sessionId) {
      this.sessionId = snapshot.sessionId;
      this.committedFinal = '';
    }

    const finalText = snapshot.finalText.trim();

    if (snapshot.error !== null) {
      /*
       * A partial that never became final is still shown. The user said
       * something, the service heard most of it and then failed; keeping the
       * part that arrived is more useful than discarding their words, and the
       * error line tells them the rest is missing.
       */
      if (finalText.length > 0 && finalText !== this.committedFinal) {
        this.committedFinal = finalText;
        this.addLine(finalText, 'microphone');
      }
      this.stopPolling();
      this.emit({
        isListening: false,
        listening: 'error',
        interim: '',
        error: snapshot.error,
      });
      return;
    }

    if (finalText.length > 0 && finalText !== this.committedFinal) {
      this.committedFinal = finalText;
      this.addLine(finalText, 'microphone');
      this.emit({ interim: '' });
    } else if (snapshot.partial !== this.state.interim) {
      this.emit({ interim: snapshot.partial });
    }

    if (!snapshot.isListening) {
      this.stopPolling();
      this.emit({ isListening: false, listening: 'idle', interim: '' });
    }
  }

  /**
   * Asks for the microphone.
   *
   * `never_ask_again` is mapped to `blocked` rather than `denied`, because the
   * two need different messages: one user can retry, the other has to change a
   * system setting, and telling them to "try again" would be a lie.
   */
  private async requestMicrophone(): Promise<MicrophonePermission> {
    if (Platform.OS !== 'android') return 'denied';
    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Live captions',
          message:
            'Sanket Vaanni needs the microphone to turn speech into text on screen. The audio is not recorded or kept.',
          buttonPositive: 'Allow',
          buttonNegative: 'Not now',
        },
      );
      if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked';
      return 'denied';
    } catch {
      return 'denied';
    }
  }

  private emit(patch: Partial<CaptionsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
