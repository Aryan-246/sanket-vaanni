/**
 * Derives the orb's inputs from live app state.
 *
 * This is the only place that knows which real signals feed the orb. It exists
 * as its own module so that the wiring is auditable in one screenful: every
 * field below can be traced to something that is genuinely happening, and
 * nothing is inferred to make the orb look busier than the app is.
 */
import { useGlove, useLiveTranslation, useSpeechState } from '../../app/AppState';
import { outcomeText } from '../../recognition/outcome';
import { type OrbSignal } from './useOrbState';

/**
 * Whether a recognition pass is in flight.
 *
 * Hard-coded `false`, and that is the truthful value rather than a placeholder.
 * `UnimplementedRecogniser` returns in the same tick it is called, so no pass
 * is ever in progress for any measurable time; there is nothing to observe.
 *
 * The `recognising` state in the orb's machine exists so that a real
 * asynchronous model has somewhere to report to that already works — when one
 * lands, this constant is replaced by the model's own in-flight flag and the
 * orb starts behaving correctly with no change to the state machine.
 */
const RECOGNISING = false;

export function useOrbSignal(): OrbSignal {
  const { availability, outcome } = useLiveTranslation();
  const speech = useSpeechState();

  const left = useGlove('left');
  const right = useGlove('right');

  return {
    leftLink: left.link.kind,
    rightLink: right.link.kind,
    leftStreaming: availability.streaming.left,
    rightStreaming: availability.streaming.right,
    recognising: RECOGNISING,
    // Genuinely true only while the platform is producing audio.
    speaking: speech.isSpeaking,
    // The text the recognition panel is showing. `outcomeText` returns null when
    // there is no result, which is what makes the orb's flash fire on a real
    // change rather than on every render.
    resultText: outcomeText(outcome),
  };
}
