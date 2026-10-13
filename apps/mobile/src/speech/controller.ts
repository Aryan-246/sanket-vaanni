/**
 * Speech output state.
 *
 * ## Why this is a controller and not a `useState`
 *
 * "Is the app speaking right now?" is asked by three different places — the orb
 * (which needs to know to change state), the Dashboard's speech panel (which
 * shows the last spoken line), and the Textboard (which speaks newly finalised
 * captions). If each kept its own boolean they would disagree, and the orb
 * would pulse while the panel said idle.
 *
 * So the state lives here, in an observable store with one writer. Components
 * subscribe; the same shape as `GloveController`, for the same reason.
 *
 * ## The speak lifecycle is real
 *
 * `isSpeaking` is true from the moment an utterance is handed to the platform
 * until the platform reports it has finished. It is never set true because a
 * toggle was flipped, and it is never left true because a completion callback
 * went missing — that second case is handled explicitly by `speak()`, which
 * clears the flag in a `finally` block, and by the watchdog described below.
 */
import type { Speaker, SpeechOptions } from './index';

export interface SpeechState {
  /** True only while the platform is genuinely producing audio. */
  readonly isSpeaking: boolean;
  /** The text of the utterance currently in flight, if any. */
  readonly currentText: string | null;
  /** The most recent text successfully spoken, for the "last spoken" line. */
  readonly lastSpokenText: string | null;
  /** Why the last attempt failed. Cleared on the next attempt. */
  readonly lastError: string | null;
  /** Whether speech output can be used at all. Mirrors the speaker. */
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

/**
 * How long an utterance may run before it is abandoned.
 *
 * A completion callback that never arrives would otherwise pin `isSpeaking` to
 * true forever, and the orb would claim the app was talking when it was silent.
 * The ceiling is generous — this is a guard against a dead callback, not a
 * limit on speech length.
 *
 * Derived from the text length at roughly 12 characters per second, with a
 * floor and a ceiling, so a long paragraph is not cut off by a fixed constant.
 */
export function speechWatchdogMs(text: string): number {
  const estimated = (text.length / 12) * 1000;
  return Math.min(Math.max(estimated + 5000, 15000), 180000);
}

export class SpeechController {
  private readonly speaker: Speaker;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeFromSpeaker: (() => void) | null = null;
  private state: SpeechState;

  /** Serialises utterances: a new `speak` cancels the one in flight. */
  private inFlight: { text: string; token: number } | null = null;
  private token = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(speaker: Speaker) {
    this.speaker = speaker;
    this.state = {
      isSpeaking: false,
      currentText: null,
      lastSpokenText: null,
      lastError: null,
      available: speaker.isAvailable,
      unavailableReason: speaker.unavailableReason,
    };

    // The engine answers asynchronously — see `speech/nativeSpeaker.ts` — so the
    // availability shown at first render is often "still starting", and this is
    // what turns it into the real answer when the platform replies.
    if (speaker.subscribe) {
      this.unsubscribeFromSpeaker = speaker.subscribe(() => {
        this.emit({
          available: speaker.isAvailable,
          unavailableReason: speaker.unavailableReason,
          // A reason that was only ever "not started yet" should not linger once
          // the engine is up; a real failure reason is replaced by its own.
          lastError: speaker.isAvailable ? null : this.state.lastError,
        });
      });
    }
  }

  getSnapshot = (): SpeechState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(patch: Partial<SpeechState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /**
   * Speaks `text`, resolving with what actually happened.
   *
   * Returns an outcome rather than throwing, because every caller is a UI
   * handler that has to render something either way, and a rejected promise in
   * a `useEffect` is an unhandled rejection rather than a message on screen.
   */
  async speak(text: string, options?: SpeechOptions): Promise<SpeechOutcome> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: false, reason: 'Nothing to speak.' };

    if (!this.speaker.isAvailable) {
      const reason = this.speaker.unavailableReason ?? 'Speech output is not available.';
      this.emit({ lastError: reason, isSpeaking: false, currentText: null });
      return { ok: false, reason };
    }

    // Only one utterance at a time. Starting a new one stops the old, which is
    // what a user expects when new text arrives mid-sentence.
    await this.stop();

    const myToken = (this.token += 1);
    this.inFlight = { text: trimmed, token: myToken };
    this.emit({ isSpeaking: true, currentText: trimmed, lastError: null });

    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      // The platform never told us it finished. Stop claiming it is speaking,
      // and say so rather than silently going quiet.
      if (this.inFlight?.token === myToken) {
        this.inFlight = null;
        this.emit({
          isSpeaking: false,
          currentText: null,
          lastError: 'Speech did not report completion; the indicator was reset.',
        });
      }
    }, speechWatchdogMs(trimmed));

    try {
      await this.speaker.speak(trimmed, options);
      // A superseded utterance must not overwrite the state of the one that
      // replaced it.
      if (this.inFlight?.token !== myToken) return { ok: false, reason: 'Superseded.' };

      this.clearWatchdog();
      this.inFlight = null;
      this.emit({
        isSpeaking: false,
        currentText: null,
        lastSpokenText: trimmed,
      });
      return { ok: true };
    } catch (error) {
      if (this.inFlight?.token !== myToken) return { ok: false, reason: 'Superseded.' };

      this.clearWatchdog();
      this.inFlight = null;
      const reason = error instanceof Error ? error.message : 'Speech failed.';
      this.emit({ isSpeaking: false, currentText: null, lastError: reason });
      return { ok: false, reason };
    }
  }

  /** Stops any utterance in flight. Safe to call when nothing is speaking. */
  async stop(): Promise<void> {
    this.clearWatchdog();
    const had = this.inFlight !== null;
    this.inFlight = null;

    try {
      await this.speaker.stop();
    } catch {
      // Stopping is best-effort. A failure here must not leave the indicator on.
    }

    if (had) this.emit({ isSpeaking: false, currentText: null });
  }

  dispose(): void {
    this.clearWatchdog();
    this.unsubscribeFromSpeaker?.();
    this.listeners.clear();
    void this.speaker.stop().catch(() => undefined);
  }
}

export type SpeechOutcome = { ok: true } | { ok: false; reason: string };
