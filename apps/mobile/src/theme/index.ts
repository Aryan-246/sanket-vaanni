/**
 * Design tokens for Sanket Vaanni.
 *
 * Direction: premium, cinematic, minimal. The brand reference is a black
 * frame with monochrome hands and the Devanagari wordmark, so the palette is
 * near-black surfaces with high-contrast off-white type and a single signal
 * accent. No decorative colour.
 *
 * ## Colours are not here
 *
 * Colour lives in `./palette` as two complete palettes, reached through
 * `useTheme()` so that changing the theme re-renders every consumer. There is
 * deliberately **no** module-level `colors` export: a static export cannot
 * change at runtime, so importing one would silently pin a component to a
 * single theme. Making that a type error is the point.
 *
 * Geometry — spacing, radii, type scale, motion — is theme-independent and
 * lives here as plain constants, so components can use it without a hook.
 */

export { darkPalette, lightPalette, PALETTES } from './palette';
export type { Palette, ColorScheme } from './palette';

/** 4pt spacing scale. Use these rather than ad-hoc numbers. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radii = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

/**
 * Type scale. System font throughout; Android ships Noto Sans Devanagari, so
 * the संकेत वाणी wordmark renders without bundling a font.
 */
export const typography = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  /** Small caps-style labels. Pair with `letterSpacing` for the tracked look. */
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
  /**
   * The recognition result. Large enough to be read at arm's length across a
   * room, which is the actual use case for a signing conversation.
   */
  result: { fontSize: 30, lineHeight: 38, fontWeight: '700' },
  /** Tabular figures for readings that change in place. */
  reading: { fontSize: 16, lineHeight: 20, fontWeight: '600' },
} as const;

export const letterSpacing = {
  /** For the tracked, uppercase section labels used throughout the UI. */
  overline: 1.4,
  tight: -0.4,
  /** Slight negative tracking on the big result line. */
  display: -0.6,
} as const;

export const iconSize = {
  sm: 14,
  md: 18,
  lg: 22,
  xl: 28,
} as const;

/**
 * Animation timing.
 *
 * Restrained on purpose: the brief asks for purposeful motion, not decoration.
 * Anything longer than `slow` is reserved for the intro and the launch
 * sequence, which are the only places a long duration is justified.
 */
export const motion = {
  /** Touch feedback. Short enough to feel instant. */
  instant: 90,
  fast: 150,
  base: 220,
  slow: 340,
  /** Reserved for cinematic transitions. */
  cinematic: 600,
  /** How long a loading indicator must be visible before it is shown at all. */
  loadingDelay: 180,
} as const;

/** Minimum accessible touch target (Android: 48dp). */
export const MIN_TOUCH_TARGET = 48;

export const layout = {
  /** Horizontal page padding. */
  screenPadding: spacing.lg,
  /** Height of the bottom tab bar, excluding the safe-area inset. */
  tabBarHeight: 60,
  /** Content stops widening past this on tablets, rather than stretching. */
  maxContentWidth: 640,
  /** Height of the OLED preview canvas at 1x (the panel is 64px tall). */
  oledHeight: 64,
  oledWidth: 128,
} as const;

export { spacing as space };
