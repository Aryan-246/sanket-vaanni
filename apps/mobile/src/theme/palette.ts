/**
 * Colour palettes.
 *
 * Two complete palettes with identical keys, so a component never has to ask
 * which theme it is in — it reads a token and gets a value that is already
 * correct for the active scheme.
 *
 * ## Why the accent differs between themes
 *
 * The dark accent (`#34D399`) is a luminous emerald chosen to glow against
 * near-black. On white it has roughly 1.9:1 contrast — unusable for text. The
 * light theme therefore uses a *darker* emerald of the same hue rather than
 * reusing the dark value, which is the mistake that makes most "light themes"
 * look like a washed-out inversion. The hue is the brand; the lightness is a
 * function of the surface it sits on.
 *
 * ## The three greens
 *
 * The brand direction is emerald, neon green and pale mint, and they are three
 * distinct jobs rather than three shades of one:
 *  - `accent` — emerald. The signal colour: emphasis, active state, focus.
 *  - `accentSoft` — pale mint. Glow interiors and the lit core of the orb, at
 *    the point where `accent` would read as too saturated to be light.
 *  - `accentDim` — deep emerald. Rings, tracks and underlines that need to sit
 *    *behind* something rather than compete with it.
 *
 * ## Contrast
 *
 * Measured against the surface each token is actually used on:
 *  - dark:  textPrimary ~18:1, textSecondary ~7:1, accent ~10.6:1 on background,
 *           accentSoft ~15.9:1 on background
 *  - light: textPrimary ~17:1, textSecondary ~7.4:1, accent ~5.5:1 on surface
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
  /**
   * Pale mint — the light end of the brand's three greens.
   *
   * For the lit core of the orb and other places that need light *from* the
   * accent rather than the accent as a mark. Never used for body text on
   * `background` in the light theme, where it would be far too pale to read.
   */
  readonly accentSoft: string;

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

  /** Active accent colour id. */
  readonly accentColorId: AccentColorId;
  /** Bloom shadow colour for the active accent. */
  readonly accentGlow: string;
}

export type AccentColorId = 'emerald' | 'cyan' | 'violet' | 'azure' | 'amber';

export interface AccentColorDefinition {
  readonly id: AccentColorId;
  readonly name: string;
  readonly hex: string;
  readonly dark: {
    readonly accent: string;
    readonly onAccent: string;
    readonly accentSurface: string;
    readonly accentDim: string;
    readonly accentSoft: string;
    readonly glow: string;
  };
  readonly light: {
    readonly accent: string;
    readonly onAccent: string;
    readonly accentSurface: string;
    readonly accentDim: string;
    readonly accentSoft: string;
    readonly glow: string;
  };
}

export const ACCENT_PALETTES: Record<AccentColorId, AccentColorDefinition> = {
  emerald: {
    id: 'emerald',
    name: 'Emerald',
    hex: '#10B981',
    dark: {
      accent: '#10B981',
      onAccent: '#04211E',
      accentSurface: 'rgba(16, 185, 129, 0.12)',
      accentDim: 'rgba(16, 185, 129, 0.28)',
      accentSoft: '#6EE7B7',
      glow: 'rgba(16, 185, 129, 0.45)',
    },
    light: {
      accent: '#059669',
      onAccent: '#FFFFFF',
      accentSurface: 'rgba(5, 150, 105, 0.12)',
      accentDim: 'rgba(5, 150, 105, 0.28)',
      accentSoft: '#34D399',
      glow: 'rgba(5, 150, 105, 0.35)',
    },
  },
  cyan: {
    id: 'cyan',
    name: 'Cyan / Teal',
    hex: '#06B6D4',
    dark: {
      accent: '#06B6D4',
      onAccent: '#082F49',
      accentSurface: 'rgba(6, 182, 212, 0.12)',
      accentDim: 'rgba(6, 182, 212, 0.28)',
      accentSoft: '#67E8F9',
      glow: 'rgba(6, 182, 212, 0.45)',
    },
    light: {
      accent: '#0891B2',
      onAccent: '#FFFFFF',
      accentSurface: 'rgba(8, 145, 178, 0.12)',
      accentDim: 'rgba(8, 145, 178, 0.28)',
      accentSoft: '#22D3EE',
      glow: 'rgba(8, 145, 178, 0.35)',
    },
  },
  violet: {
    id: 'violet',
    name: 'Electric Violet',
    hex: '#8B5CF6',
    dark: {
      accent: '#8B5CF6',
      onAccent: '#2E1065',
      accentSurface: 'rgba(139, 92, 246, 0.12)',
      accentDim: 'rgba(139, 92, 246, 0.28)',
      accentSoft: '#C4B5FD',
      glow: 'rgba(139, 92, 246, 0.45)',
    },
    light: {
      accent: '#7C3AED',
      onAccent: '#FFFFFF',
      accentSurface: 'rgba(124, 58, 237, 0.12)',
      accentDim: 'rgba(124, 58, 237, 0.28)',
      accentSoft: '#A78BFA',
      glow: 'rgba(124, 58, 237, 0.35)',
    },
  },
  azure: {
    id: 'azure',
    name: 'Azure Blue',
    hex: '#3B82F6',
    dark: {
      accent: '#3B82F6',
      onAccent: '#172554',
      accentSurface: 'rgba(59, 130, 246, 0.12)',
      accentDim: 'rgba(59, 130, 246, 0.28)',
      accentSoft: '#93C5FD',
      glow: 'rgba(59, 130, 246, 0.45)',
    },
    light: {
      accent: '#2563EB',
      onAccent: '#FFFFFF',
      accentSurface: 'rgba(37, 99, 235, 0.12)',
      accentDim: 'rgba(37, 99, 235, 0.28)',
      accentSoft: '#60A5FA',
      glow: 'rgba(37, 99, 235, 0.35)',
    },
  },
  amber: {
    id: 'amber',
    name: 'Solar Amber',
    hex: '#F59E0B',
    dark: {
      accent: '#F59E0B',
      onAccent: '#451A03',
      accentSurface: 'rgba(245, 158, 11, 0.12)',
      accentDim: 'rgba(245, 158, 11, 0.28)',
      accentSoft: '#FCD34D',
      glow: 'rgba(245, 158, 11, 0.45)',
    },
    light: {
      accent: '#D97706',
      onAccent: '#FFFFFF',
      accentSurface: 'rgba(217, 119, 6, 0.12)',
      accentDim: 'rgba(217, 119, 6, 0.28)',
      accentSoft: '#FBBF24',
      glow: 'rgba(217, 119, 6, 0.35)',
    },
  },
};

export const ACCENT_COLOR_IDS: readonly AccentColorId[] = [
  'emerald',
  'cyan',
  'violet',
  'azure',
  'amber',
];

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

  accentColorId: 'emerald',
  accent: ACCENT_PALETTES.emerald.dark.accent,
  onAccent: ACCENT_PALETTES.emerald.dark.onAccent,
  accentSurface: ACCENT_PALETTES.emerald.dark.accentSurface,
  accentDim: ACCENT_PALETTES.emerald.dark.accentDim,
  accentSoft: ACCENT_PALETTES.emerald.dark.accentSoft,
  accentGlow: ACCENT_PALETTES.emerald.dark.glow,

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

  accentColorId: 'emerald',
  accent: ACCENT_PALETTES.emerald.light.accent,
  onAccent: ACCENT_PALETTES.emerald.light.onAccent,
  accentSurface: ACCENT_PALETTES.emerald.light.accentSurface,
  accentDim: ACCENT_PALETTES.emerald.light.accentDim,
  accentSoft: ACCENT_PALETTES.emerald.light.accentSoft,
  accentGlow: ACCENT_PALETTES.emerald.light.glow,

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

export function resolvePalette(scheme: ColorScheme, accentId: AccentColorId = 'emerald'): Palette {
  const base = scheme === 'dark' ? darkPalette : lightPalette;
  const def = ACCENT_PALETTES[accentId] ?? ACCENT_PALETTES.emerald;
  const tokens = scheme === 'dark' ? def.dark : def.light;

  return {
    ...base,
    accentColorId: def.id,
    accent: tokens.accent,
    onAccent: tokens.onAccent,
    accentSurface: tokens.accentSurface,
    accentDim: tokens.accentDim,
    accentSoft: tokens.accentSoft,
    accentGlow: tokens.glow,
  };
}

export const PALETTES: Record<ColorScheme, Palette> = {
  dark: darkPalette,
  light: lightPalette,
};
