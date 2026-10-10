/**
 * Colour palettes.
 *
 * Two complete palettes with identical keys, so a component never has to ask
 * which theme it is in — it reads a token and gets a value that is already
 * correct for the active scheme.
 *
 * ## Why the accent differs between themes
 *
 * The dark accent (`#4FD1C5`) is a light, luminous teal chosen to glow against
 * near-black. On white it has roughly 1.9:1 contrast — unusable for text. The
 * light theme therefore uses a *darker* teal of the same hue rather than
 * reusing the dark value, which is the mistake that makes most "light themes"
 * look like a washed-out inversion. The hue is the brand; the lightness is a
 * function of the surface it sits on.
 *
 * ## Contrast
 *
 * Measured against the surface each token is actually used on:
 *  - dark:  textPrimary ~18:1, textSecondary ~7:1, accent ~10.9:1 on background
 *  - light: textPrimary ~17:1, textSecondary ~7.4:1, accent ~5.2:1 on surface
 * All meet WCAG AA for body text. `textMuted` is deliberately below AA and is
 * documented as large-text/decorative only in both palettes.
 */

export type ColorScheme = 'dark' | 'light';

export interface Palette {
  readonly scheme: ColorScheme;
  /** Status bar content colour that contrasts with `background`. */
  readonly statusBarStyle: 'light-content' | 'dark-content';

  /** App background. */
  readonly background: string;
  /** Default card/section surface. */
  readonly surface: string;
  /** Raised surface — sheets, active rows, floating panels. */
  readonly surfaceRaised: string;
  /** Recessed surface — preview canvases, progress tracks, wells. */
  readonly surfaceSunken: string;

  /** Hairline separators and card borders. */
  readonly border: string;
  /** Stronger border for focused/active elements. */
  readonly borderStrong: string;

  /** Primary body and heading colour. */
  readonly textPrimary: string;
  /** Secondary copy — labels, captions. */
  readonly textSecondary: string;
  /** De-emphasised copy. Large text and decoration only, not body copy. */
  readonly textMuted: string;
  /** Text/icon colour on `surfaceSunken`. */
  readonly textOnSunken: string;

  /** Signal accent. Emphasis, active state, focus. */
  readonly accent: string;
  /** Text/icon colour that sits on top of `accent`. */
  readonly onAccent: string;
  /** Low-saturation accent wash for selected rows and tinted chips. */
  readonly accentSurface: string;
  /** Accent at low opacity, for glows and underlines. */
  readonly accentDim: string;

  /** Demo Mode / simulated data. Deliberately distinct from `accent`. */
  readonly demo: string;
  readonly demoSurface: string;

  /** Semantic states. Always paired with a text label, never colour alone. */
  readonly success: string;
  readonly successSurface: string;
  readonly warning: string;
  readonly warningSurface: string;
  readonly danger: string;
  readonly dangerSurface: string;
  /** Neutral "we do not know" state. Never rendered as a success or failure. */
  readonly unknown: string;
  readonly unknownSurface: string;

  /** Modal backdrop. */
  readonly scrim: string;
  /** Shadow colour for elevated surfaces. */
  readonly shadow: string;
  /** Shadow opacity at elevation level 1; level 2 adds ~60%. */
  readonly shadowOpacity: number;
}

export const darkPalette: Palette = {
  scheme: 'dark',
  statusBarStyle: 'light-content',

  background: '#050506',
  surface: '#0E0E11',
  surfaceRaised: '#16161B',
  surfaceSunken: '#08080A',

  border: '#26262E',
  borderStrong: '#3A3A46',

  textPrimary: '#F5F5F7',
  textSecondary: '#A1A1AA',
  textMuted: '#6B6B76',
  textOnSunken: '#8A8A95',

  accent: '#4FD1C5',
  onAccent: '#04211E',
  accentSurface: '#0D2624',
  accentDim: '#1E4F4A',

  demo: '#F2B45C',
  demoSurface: '#2A2113',

  success: '#5FD68A',
  successSurface: '#102418',
  warning: '#F2B45C',
  warningSurface: '#2A2113',
  danger: '#F07171',
  dangerSurface: '#2A1414',
  unknown: '#8A8A95',
  unknownSurface: '#17171C',

  scrim: 'rgba(0, 0, 0, 0.66)',
  shadow: '#000000',
  shadowOpacity: 0.5,
};

export const lightPalette: Palette = {
  scheme: 'light',
  statusBarStyle: 'dark-content',

  background: '#F4F4F6',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#E9E9EE',

  border: '#E1E1E8',
  borderStrong: '#C7C7D1',

  textPrimary: '#0F0F13',
  textSecondary: '#55555F',
  textMuted: '#8A8A95',
  textOnSunken: '#55555F',

  // Darker than the dark-theme accent on purpose — see the note above.
  accent: '#0B7A70',
  onAccent: '#FFFFFF',
  accentSurface: '#E2F2F0',
  accentDim: '#9FD6D0',

  demo: '#8A5A12',
  demoSurface: '#FBF1DF',

  success: '#146B3A',
  successSurface: '#E3F3E9',
  warning: '#8A5A12',
  warningSurface: '#FBF1DF',
  danger: '#A32B22',
  dangerSurface: '#FBE9E7',
  unknown: '#6E6E78',
  unknownSurface: '#EDEDF1',

  scrim: 'rgba(16, 16, 20, 0.42)',
  shadow: '#0F0F13',
  shadowOpacity: 0.1,
};

export const PALETTES: Record<ColorScheme, Palette> = {
  dark: darkPalette,
  light: lightPalette,
};
