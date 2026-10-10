/**
 * Design tokens for Sanket Vaanni.
 *
 * Direction: premium, cinematic, minimal. The brand reference is a black
 * frame with monochrome hands and the Devanagari wordmark, so the palette is
 * near-black surfaces with high-contrast off-white type and a single signal
 * accent. No decorative colour.
 *
 * Accessibility is a constraint here, not a finishing touch:
 *  - `textPrimary` on `background` is well above the WCAG AA 4.5:1 threshold.
 *  - `accent` is used for large text, icons and borders, never for body copy
 *    at small sizes.
 *  - Nothing relies on colour alone to convey state — every status also has a
 *    label.
 */

export const colors = {
  /** App background. Near-black, not pure black, to avoid OLED smear. */
  background: '#050506',
  /** Default card/section surface. */
  surface: '#0E0E11',
  /** Raised surface — sheets, active rows. */
  surfaceRaised: '#16161B',
  /** Hairline separators and card borders. */
  border: '#26262E',
  /** Stronger border for focused/active elements. */
  borderStrong: '#3A3A46',

  /** Primary body and heading colour. ~18:1 on `background`. */
  textPrimary: '#F5F5F7',
  /** Secondary copy — labels, captions. ~7:1 on `background`. */
  textSecondary: '#A1A1AA',
  /** De-emphasised copy. Large text only. */
  textMuted: '#6B6B76',

  /** Signal accent. Used for emphasis, active state and focus. */
  accent: '#4FD1C5',
  /** Text/icon colour that sits on top of `accent`. */
  onAccent: '#04211E',

  /** Demo Mode / simulated data. Deliberately distinct from `accent`. */
  demo: '#F2B45C',
  demoSurface: '#2A2113',

  /** Semantic states. Always paired with a text label. */
  success: '#5FD68A',
  warning: '#F2B45C',
  danger: '#F07171',
} as const;

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
} as const;

export const letterSpacing = {
  /** For the tracked, uppercase section labels used throughout the UI. */
  overline: 1.4,
  tight: -0.4,
} as const;

/** Minimum accessible touch target (Android: 48dp). */
export const MIN_TOUCH_TARGET = 48;

export const theme = {
  colors,
  spacing,
  radii,
  typography,
  letterSpacing,
  MIN_TOUCH_TARGET,
} as const;

export type Theme = typeof theme;
