/**
 * Live values for the OLED panel.
 *
 * The studio previews what the *panel* would show, so these strings are written
 * the way firmware would write them: short, uppercase, no prose. They are
 * derived from real link state and real recognition outcome, which is what makes
 * the preview worth looking at — it is not a mock-up of a reading, it is the
 * actual reading rendered small.
 *
 * ## Battery is always null, deliberately
 *
 * No battery percentage has ever been reported to this app. The firmware's
 * telemetry frame does not exist yet, and even the pack's presence is an
 * assumption about the hardware. So `batteryText` is `null` and the panel shows
 * `--`. A full battery glyph would be a claim about a component nobody has
 * measured.
 */
import type { GloveSnapshot } from '../ble/controller';
import { isSimulatedLink } from '../ble/link';
import type { RecognitionOutcome } from '../recognition/outcome';
import type { OledValues } from './layout';

/**
 * Short enough to fit on any line the panel can draw.
 *
 * The widest is `NO LINK` at seven characters, and a double-height line — the
 * narrowest the layout allows — holds ten, so no status can be truncated by the
 * panel however the row is styled.
 */
const STATUS_SHORT: Record<string, string> = {
  idle: 'NO LINK',
  nearby: 'FOUND',
  scanning: 'SCAN',
  connecting: 'CONN',
  disconnected: 'CLOSED',
  unavailable: 'N/A',
  error: 'ERR',
};

export function oledValuesFrom(
  glove: GloveSnapshot,
  outcome: RecognitionOutcome,
): OledValues {
  const { link } = glove;

  let statusText: string;
  if (link.kind === 'connected') {
    // The panel must carry the same warning the screen does. A glove whose
    // readings are simulated should say so on its own display.
    statusText = isSimulatedLink(link) ? 'DEMO' : 'LINKED';
  } else {
    statusText = STATUS_SHORT[link.kind] ?? 'NO LINK';
  }

  return {
    // Only a presented result reaches the panel. An uncertain candidate is not
    // text the user has been shown, so putting it on the display would be
    // presenting a guess as a result.
    recognisedText: outcome.kind === 'result' ? outcome.candidate.label : null,
    statusText,
    batteryText: null,
  };
}
