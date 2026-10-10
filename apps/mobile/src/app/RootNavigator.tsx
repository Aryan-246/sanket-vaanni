import React, { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { AppStateProvider, useAppState } from './AppState';
import { HomeScreen } from '../screens/HomeScreen';
import { IntroScreen } from '../screens/IntroScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { colors } from '../theme';

/**
 * Route set.
 *
 * The app has three destinations, so it uses an explicit state machine rather
 * than a navigation library. Navigation is the right answer once there is a
 * stack worth managing (deep links, back gestures, nested navigators); with
 * one launch gate and one modal it would be dependency weight without benefit.
 * `docs/architecture.md` records the intent to introduce React Navigation when
 * a third real destination appears.
 */
type Route = 'loading' | 'intro' | 'home' | 'settings';

export function RootNavigator(): React.JSX.Element {
  const { storage } = useAppState();
  const [route, setRoute] = useState<Route>('loading');

  // Decide the first screen exactly once, on mount.
  useEffect(() => {
    let cancelled = false;

    async function decideInitialRoute(): Promise<void> {
      let seen = false;
      let reduceMotion = false;

      try {
        seen = await storage.isIntroSeen();
      } catch {
        // Storage being unavailable must not block launch. Treat it as
        // "already seen" so the user is not shown the intro on every start.
        seen = true;
      }

      try {
        // The intro is a decorative animation. A user who has asked the system
        // to reduce motion should not be made to sit through it.
        reduceMotion = await AccessibilityInfo.isReduceMotionEnabled();
      } catch {
        reduceMotion = false;
      }

      if (cancelled) return;
      setRoute(seen || reduceMotion ? 'home' : 'intro');
    }

    decideInitialRoute().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [storage]);

  const handleIntroComplete = useCallback(() => {
    setRoute('home');
    // Persist after navigating: a storage failure must not delay the hand-off.
    storage.setIntroSeen(true).catch(() => undefined);
  }, [storage]);

  const handleReplayIntro = useCallback(() => setRoute('intro'), []);
  const handleOpenSettings = useCallback(() => setRoute('settings'), []);
  const handleCloseSettings = useCallback(() => setRoute('home'), []);

  if (route === 'loading') {
    // Same background as the app, so the first frame is not a white flash.
    return <View style={styles.splash} />;
  }

  if (route === 'intro') {
    return <IntroScreen onComplete={handleIntroComplete} />;
  }

  if (route === 'settings') {
    return <SettingsScreen onClose={handleCloseSettings} onReplayIntro={handleReplayIntro} />;
  }

  return <HomeScreen onOpenSettings={handleOpenSettings} />;
}

export interface AppProps {
  /** Injected by tests. */
  children?: never;
}

export function App(): React.JSX.Element {
  return (
    <AppStateProvider>
      <RootNavigator />
    </AppStateProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
