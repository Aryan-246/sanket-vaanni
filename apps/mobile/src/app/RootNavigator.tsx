import React, { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { AppStateProvider } from './AppState';
import { sessionIntro, type IntroSession } from './launchSession';
import { HomeScreen } from '../screens/HomeScreen';
import { IntroScreen } from '../screens/IntroScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

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
type Route = 'intro' | 'home' | 'settings';

export interface RootNavigatorProps {
  /**
   * Injected by tests to get an isolated session per case. The app always uses
   * the process-lifetime singleton — see `launchSession.ts`.
   */
  introSession?: IntroSession;
}

export function RootNavigator({
  introSession = sessionIntro,
}: RootNavigatorProps): React.JSX.Element {
  /**
   * Decided once, synchronously, from process-lifetime state.
   *
   * There is deliberately no `loading` route. The previous implementation
   * awaited AsyncStorage and `isReduceMotionEnabled` before choosing, which
   * meant React mounted an empty black view first — a guaranteed blank frame
   * on every launch, and the start of the black gap this replaces. Both values
   * are now resolved without blocking the first render.
   */
  const [route, setRoute] = useState<Route>(() =>
    introSession.shouldPlayIntro() ? 'intro' : 'home',
  );

  /** Idempotent hand-off: whichever path fires first wins. */
  const finishIntro = useCallback(() => {
    introSession.markIntroPlayed();
    setRoute('home');
  }, [introSession]);

  /**
   * Honour the system "reduce motion" setting.
   *
   * The intro is a decorative animation, so a user who has asked for reduced
   * motion should not be made to sit through it. This is checked *after* the
   * first render rather than before it, so it never delays the first frame —
   * the worst case is one black frame instead of a blank loading screen.
   *
   * `shouldPlayIntro()` guards against a deliberate replay from Settings: once
   * the launch intro has been marked played, this no longer short-circuits, so
   * the user who explicitly asked to watch it gets to watch it.
   */
  useEffect(() => {
    if (route !== 'intro') return;
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((reduceMotion) => {
        if (!cancelled && reduceMotion && introSession.shouldPlayIntro()) {
          finishIntro();
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [route, finishIntro, introSession]);

  const handleOpenSettings = useCallback(() => setRoute('settings'), []);
  const handleCloseSettings = useCallback(() => setRoute('home'), []);

  /**
   * Replay is an explicit user action, so it bypasses the session gate
   * entirely — including on a launch where the intro already played.
   */
  const handleReplayIntro = useCallback(() => setRoute('intro'), []);

  if (route === 'intro') {
    return <IntroScreen onComplete={finishIntro} />;
  }

  if (route === 'settings') {
    return <SettingsScreen onClose={handleCloseSettings} onReplayIntro={handleReplayIntro} />;
  }

  return <HomeScreen onOpenSettings={handleOpenSettings} />;
}

export function App(): React.JSX.Element {
  return (
    <AppStateProvider>
      <RootNavigator />
    </AppStateProvider>
  );
}
