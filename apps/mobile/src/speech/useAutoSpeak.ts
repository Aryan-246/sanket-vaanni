/**
 * Speaks new text automatically, when the user has asked for speech.
 *
 * ## Why this is a hook and not a button
 *
 * The speech control is a persistent switch, so turning it on is a statement
 * about how the user wants the app to behave from then on — not a request to
 * speak one particular phrase. Adding a play button next to that switch would
 * make it ambiguous which of the two does anything. So the switch means
 * "speak what I produce", and this is what makes that true.
 *
 * ## What stops it speaking
 *
 *  - The toggle being off.
 *  - There being no text (`null`), which is the case whenever nothing has been
 *    recognised. Silence is the honest result and it stays silent — there is no
 *    "no result" announcement, because that would talk over the user.
 *  - The text being identical to the last thing spoken. A re-render is not a new
 *    phrase, and re-speaking the same sentence on every render would be unusable.
 *  - The engine being unavailable, in which case `speak` reports the reason
 *    through the controller's state rather than throwing into a render.
 */
import { useEffect, useRef } from 'react';

import type { SpeechController } from './controller';

export interface AutoSpeakOptions {
  /** BCP-47 tag for the text's language. */
  readonly language?: string;
  readonly rate?: number;
}

export function useAutoSpeak(
  controller: SpeechController,
  text: string | null,
  enabled: boolean,
  options?: AutoSpeakOptions,
): void {
  /**
   * The last text this hook asked to be spoken.
   *
   * Held in a ref rather than compared against the controller's
   * `lastSpokenText`, because the two answer different questions: the controller
   * knows what the *engine* finished, and this needs to know what this hook has
   * already *asked for*. Comparing against the controller would re-ask whenever
   * an utterance failed, in a loop.
   */
  const requested = useRef<string | null>(null);

  // Toggling off should let the same text be spoken again when toggled back on.
  useEffect(() => {
    if (!enabled) requested.current = null;
  }, [enabled]);

  const language = options?.language;
  const rate = options?.rate;

  useEffect(() => {
    if (!enabled) return;
    if (text === null || text.length === 0 || text.toUpperCase() === 'REST') {
      requested.current = null;
      return;
    }
    if (requested.current === text) return;

    requested.current = text;
    void controller.speak(text, { language, rate });
  }, [controller, text, enabled, language, rate]);
}
