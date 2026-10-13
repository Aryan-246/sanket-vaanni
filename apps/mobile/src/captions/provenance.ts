/**
 * Provenance presentation.
 *
 * ## Why this is one table and not three `if` chains
 *
 * Every line in the transcript carries the same badge, derived from the same
 * two lookups, so a glove line cannot end up looking like a microphone line by
 * accident. Adding a fourth source becomes a type error until it has been
 * given a label and a tone here.
 *
 * The tones are semantic, not decorative: `success` for a reading the hardware
 * produced, `demo` for a service's guess, `neutral` for something a person
 * typed themselves. A user glancing at the colour should be able to tell
 * whether the phone heard them or the glove told them.
 */
import type { BadgeTone } from '../components/Badge';
import type { CaptionSource } from './controller';

/** What the badge says. Short: it sits inline, ahead of the text. */
export const SOURCE_LABEL: Record<CaptionSource, string> = {
  glove: 'Glove',
  microphone: 'Heard',
  typed: 'Typed',
};

/**
 * The badge tone.
 *
 * Typed as `BadgeTone` rather than as a literal union, so that renaming a tone
 * in the design system breaks here at compile time instead of silently
 * rendering an unstyled chip.
 */
export const SOURCE_TONE: Record<CaptionSource, BadgeTone> = {
  glove: 'success',
  microphone: 'demo',
  typed: 'neutral',
};

/**
 * The longer explanation, for a screen reader or an expanded row.
 *
 * A sighted user infers the difference from the badge; a screen-reader user
 * gets nothing from a two-word chip unless it is spelled out.
 */
export const SOURCE_DESCRIPTION: Record<CaptionSource, string> = {
  glove: 'Read from the glove hardware.',
  microphone: 'Transcribed from the microphone by this phone’s speech recogniser.',
  typed: 'Typed by hand.',
};
