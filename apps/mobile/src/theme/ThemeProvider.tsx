/**
 * Theme provider.
 *
 * Resolves the user's stored preference (system / dark / light) into a
 * concrete `Palette`, and re-renders every consumer when it changes.
 *
 * The preference is persisted through the same `Storage` abstraction as
 * everything else, so tests get an in-memory store and the device gets
 * AsyncStorage without either knowing about the other.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme, type ViewStyle } from 'react-native';

import { PALETTES, type ColorScheme, type Palette } from './palette';
import type { ThemeMode } from '../app/preferences';
import type { Storage } from '../storage';

export type { ThemeMode };

export interface ThemeValue {
  /** The user's stored preference. */
  readonly mode: ThemeMode;
  /** The scheme actually in effect, after resolving `system`. */
  readonly scheme: ColorScheme;
  readonly palette: Palette;
  readonly setMode: (mode: ThemeMode) => void;
  /**
   * False until the stored preference has been read. The app renders with the
   * default dark palette meanwhile, so there is never a blank frame waiting on
   * disk — the same reasoning as the launch gate in `RootNavigator`.
   */
  readonly isReady: boolean;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  storage: Storage;
  /** Overrides the initial mode; used by tests to skip the storage read. */
  initialMode?: ThemeMode;
}

export function ThemeProvider({
  children,
  storage,
  initialMode,
}: ThemeProviderProps): React.JSX.Element {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>(initialMode ?? 'dark');
  const [isReady, setIsReady] = useState(initialMode !== undefined);

  useEffect(() => {
    if (initialMode !== undefined) return;
    let cancelled = false;

    storage
      .getThemeMode()
      .then((stored) => {
        if (cancelled) return;
        if (stored !== null) setModeState(stored);
        setIsReady(true);
      })
      .catch(() => {
        // A storage failure must not block the UI. Keep the default and carry
        // on; the next successful write repairs it.
        if (!cancelled) setIsReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [storage, initialMode]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      // Fire-and-forget: the UI has already updated, and a failed write only
      // costs the user their preference on next launch, not this one.
      void storage.setThemeMode(next).catch(() => undefined);
    },
    [storage],
  );

  const scheme: ColorScheme =
    mode === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : mode;

  const value = useMemo<ThemeValue>(
    () => ({ mode, scheme, palette: PALETTES[scheme], setMode, isReady }),
    [mode, scheme, setMode, isReady],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error('useTheme must be used inside a <ThemeProvider>');
  }
  return value;
}

/**
 * Builds a StyleSheet from the active palette, memoised per palette.
 *
 * `factory` must be defined at module scope so its identity is stable; that is
 * what makes the memo actually hold across renders.
 */
export function useStyles<T>(factory: (palette: Palette) => T): T {
  const { palette } = useTheme();
  return useMemo(() => factory(palette), [factory, palette]);
}

/**
 * Shadow for an elevated surface.
 *
 * Android ignores the iOS shadow props and uses `elevation`, which cannot be
 * tinted — so the light theme gets a real elevation value and the dark theme
 * gets a softer one, since a black shadow on a near-black background is
 * invisible anyway and the border does the work instead.
 */
export function elevationStyle(
  palette: Palette,
  level: 0 | 1 | 2 = 1,
): ViewStyle {
  if (level === 0) return {};

  const isLight = palette.scheme === 'light';
  const opacity = palette.shadowOpacity * (level === 2 ? 1.6 : 1);

  return {
    shadowColor: palette.shadow,
    shadowOpacity: Math.min(1, opacity),
    shadowRadius: level === 2 ? 16 : 8,
    shadowOffset: { width: 0, height: level === 2 ? 6 : 2 },
    elevation: isLight ? (level === 2 ? 6 : 2) : level === 2 ? 4 : 1,
  };
}
