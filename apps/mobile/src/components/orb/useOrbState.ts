/**
 * The orb's state machine.
 *
 * ## Why a state machine rather than a spinner
 *
 * The reference composition has one luminous element at its centre. The point
 * of it is that it is *legible*: a user glancing at the phone should be able to
 * tell, without reading anything, whether the glove is connected, whether data
 * is arriving, and whether the app is talking. That only works if each state
 * means one specific thing and nothing else.
 *
 * ## The rule this file is built around
 *
 * **Every transition is caused by a real event.** The orb never enters
 * `recognising` because time passed, never enters `speaking` because the user
 * enabled the toggle, and never enters `receiving` because a device is
 * connected. Each of those has a separate, checkable input:
 *
 *  - `receiving`   ← a calibrated frame is actually streaming
 *  - `recognising` ← the recogniser reports a pass genuinely in progress
 *  - `speaking`    ← the speaker reports audio genuinely being produced
 *
 * ## Consequence: one state is currently unreachable
 *
 * There is no model, so `recognising` never fires. That state is implemented
 * because the machine must be correct the moment one lands — but until then the
 * orb will not show it, and that is the intended behaviour rather than a bug to
 * paper over. A dashboard that lit up "recognising" while the recogniser was
 * returning `unavailable` would be lying about the single most important thing
 * on the screen.
 *
 * `speaking` *is* reachable: speech output runs on the device's own engine, and
 * that state is driven by the platform reporting audio in progress.
 */
import { useEffect, useRef, useState } from 'react';

import type { LinkKind } from '../../ble/link';

export type OrbState =
  /** Nothing connected, or no capability to be in any later state. */
  | 'idle'
  /** A scan or a connection attempt is genuinely in progress. */
  | 'connecting'
  /** Connected, but no frames have arrived yet. */
  | 'ready'
  /** Frames are arriving. */
  | 'receiving'
  /** A recognition pass is genuinely in progress. */
  | 'recognising'
  /** The recognised text just changed. Transient. */
  | 'text-updating'
  /** Audio is genuinely being produced. */
  | 'speaking'
  /** A glove reported a transport error. */
  | 'error';

/**
 * How long the `text-updating` flash lasts.
 *
 * Long enough to be noticed when the user's eyes are on their hands rather than
 * the screen, short enough that it does not delay the return to `receiving` —
 * which is the state that actually matters, because it is the one that says
 * "keep signing, I can see you".
 */
export const TEXT_UPDATE_HOLD_MS = 900;

export interface OrbSignal {
  readonly leftLink: LinkKind;
  readonly rightLink: LinkKind;
  readonly leftStreaming: boolean;
  readonly rightStreaming: boolean;
  /** True only when a recognition pass is genuinely running. */
  readonly recognising: boolean;
  /** True only when audio is genuinely being produced. */
  readonly speaking: boolean;
  /** The current recognised text, or null when there is none. */
  readonly resultText: string | null;
}

/**
 * Resolves the orb state from the signals, ignoring the `text-updating` flash.
 *
 * Pure and exported so the precedence can be tested directly, without a
 * renderer and without waiting on timers. Precedence is a judgement about what
 * matters most when two things are true at once, so it is worth stating
 * explicitly:
 *
 *  1. **error** — something is wrong; a user needs to know before anything else.
 *  2. **speaking** — the app is producing sound; that is the most
 *     externally-visible thing it can be doing.
 *  3. **recognising** — a pass is in flight and the answer is imminent.
 *  4. **receiving** — data is arriving. The steady state during use.
 *  5. **connecting** — an attempt is in progress.
 *  6. **ready** — connected, quiet. Waiting for the user to sign.
 *  7. **idle** — nothing at all.
 */
export function resolveOrbState(signal: OrbSignal): OrbState {
  const links = [signal.leftLink, signal.rightLink];

  if (links.includes('error')) return 'error';
  if (signal.speaking) return 'speaking';
  if (signal.recognising) return 'recognising';
  if (signal.leftStreaming || signal.rightStreaming) return 'receiving';
  if (links.includes('scanning') || links.includes('connecting')) return 'connecting';
  if (links.includes('connected')) return 'ready';
  return 'idle';
}

/**
 * The orb state as the component consumes it, including the text flash.
 *
 * The flash is layered on top of the resolved state rather than being part of
 * `resolveOrbState`, because it is the only state that depends on *history*
 * rather than on the current signals — everything else is a pure function of
 * what is true right now.
 */
export function useOrbState(signal: OrbSignal): OrbState {
  const resolved = resolveOrbState(signal);
  const [flashing, setFlashing] = useState(false);
  const previousText = useRef<string | null>(signal.resultText);

  useEffect(() => {
    const next = signal.resultText;
    const changed = next !== previousText.current;
    previousText.current = next;

    // Only a change *to* text flashes. Text disappearing is not new
    // information for the user to look at — it is the absence of it — and
    // flashing on every clear would make the orb pulse whenever a glove went
    // quiet.
    if (!changed || next === null || next.length === 0) return;

    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), TEXT_UPDATE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [signal.resultText]);

  // The flash outranks the steady states but not the ones that describe
  // something more urgent happening right now.
  if (flashing && (resolved === 'receiving' || resolved === 'ready')) {
    return 'text-updating';
  }

  return resolved;
}
