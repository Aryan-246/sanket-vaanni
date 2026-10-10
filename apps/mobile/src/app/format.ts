/**
 * Presentation formatting.
 *
 * Pure string functions, kept out of components so that the exact wording of a
 * reading can be asserted in a test — which is how "no fabricated value" stops
 * being a review comment and becomes a checked property.
 */

/**
 * An elapsed time, at a scale a person can read.
 *
 * Deliberately not a live-ticking string: callers pass two timestamps and get a
 * value for *that* render. A self-updating "3 s ago" would need its own timer on
 * every screen that shows one, which is exactly the kind of background work the
 * brief rules out. Readings refresh when their data does, which is when the
 * number is worth re-reading anyway.
 */
export function formatAge(nowMs: number, thenMs: number): string {
  const age = Math.max(0, nowMs - thenMs);
  if (age < 1000) return `${Math.round(age)} ms ago`;
  if (age < 60_000) return `${(age / 1000).toFixed(1)} s ago`;
  const minutes = Math.round(age / 60_000);
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

/**
 * A calibrated reading as a percentage.
 *
 * Only ever used for values that are genuinely 0..1 measurements — a flex
 * channel's calibrated bend. A model confidence is never rendered as a
 * percentage here, because `outcomeConfidence` returns null when there is none
 * and the UI shows the absence instead of a number.
 */
export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** A duration in ms, for the OLED animation control. */
export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** `left` / `right` as a display word. */
export function sideWord(side: 'left' | 'right'): string {
  return side === 'left' ? 'Left' : 'Right';
}
