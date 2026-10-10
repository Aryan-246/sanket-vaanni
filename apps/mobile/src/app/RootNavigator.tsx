import React, { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, BackHandler, StatusBar, StyleSheet, View } from 'react-native';

import { AppStateProvider } from './AppState';
import { sessionIntro, type IntroSession } from './launchSession';
import { TabBar, type TabKey } from '../components/TabBar';
import { AuditScreen } from '../screens/AuditScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { IntroScreen } from '../screens/IntroScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { OledScreen } from '../screens/OledScreen';
import type { Storage } from '../storage';
import type { GloveTransport } from '../ble/types';
import { ThemeProvider, useTheme } from '../theme/ThemeProvider';
import { useAppState } from './AppState';

/**
 * Route set.
 *
 * Two routes, not five. The four destinations are *tabs* within one route, and
 * keeping them out of the route machine is what stops the tab bar from being
 * unmounted and rebuilt on every switch — and what makes "return to Dashboard"
 * a state change rather than a navigation.
 *
 * Still no navigation library. The app has one launch gate and one tab set,
 * with no deep links, no nested stacks and no back-stack to model. Adding a
 * router would be dependency weight for behaviour this file expresses in
 * twenty lines — but `docs/architecture.md` records that the intent flips the
 * moment a detail screen appears, because that is when a real stack exists.
 */
type Route = 'intro' | 'tabs';

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
    introSession.shouldPlayIntro() ? 'intro' : 'tabs',
  );
  const [tab, setTab] = useState<TabKey>('dashboard');

  /** Idempotent hand-off: whichever path fires first wins. */
  const finishIntro = useCallback(() => {
    introSession.markIntroPlayed();
    setRoute('tabs');
  }, [introSession]);

  /**
   * Honour the system "reduce motion" setting.
   *
   * The intro is a decorative animation, so a user who has asked for reduced
   * motion should not be made to sit through it. This is checked *after* the
   * first render rather than before it, so it never delays the first frame —
   * the worst case is one black frame instead of a blank loading screen.
   *
   * `shouldPlayIntro()` guards against a deliberate replay: once the launch
   * intro has been marked played, this no longer short-circuits, so the user
   * who explicitly asked to watch it gets to watch it.
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

  /**
   * Android back returns to the Dashboard from any other tab.
   *
   * Registered only when it would do something, so back on the Dashboard still
   * reaches the OS and leaves the app rather than being swallowed by a handler
   * that has nothing to do.
   */
  useEffect(() => {
    if (route !== 'tabs' || tab === 'dashboard') return;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setTab('dashboard');
      return true;
    });

    return () => subscription.remove();
  }, [route, tab]);

  /**
   * Replay is an explicit user action, so it bypasses the session gate
   * entirely — including on a launch where the intro already played. It also
   * returns to the Dashboard, so the intro does not overlay whichever tab the
   * user happened to be on.
   */
  const handleReplayIntro = useCallback(() => {
    setTab('dashboard');
    setRoute('intro');
  }, []);

  if (route === 'intro') {
    return <IntroScreen onComplete={finishIntro} />;
  }

  return (
    <View style={styles.tabs}>
      {/*
        Only the active tab is mounted. This is the performance decision, and
        it is deliberate: four mounted screens would mean the Dashboard's 12 Hz
        sensor subscription kept re-rendering while the user was reading the
        audit page. Nothing important is lost — the OLED editor and every
        preference persist as they are edited, so switching tabs discards no
        user work, only scroll position.
      */}
      <View style={styles.screen}>
        {tab === 'dashboard' && <DashboardScreen onOpenSettings={() => setTab('more')} />}
        {tab === 'oled' && <OledScreen />}
        {tab === 'audit' && <AuditScreen />}
        {tab === 'more' && (
          <MoreScreen onReplayIntro={handleReplayIntro} onOpenOled={() => setTab('oled')} />
        )}
      </View>

      <TabBar active={tab} onSelect={setTab} />
    </View>
  );
}

/**
 * Root of the themed application.
 *
 * The status bar style and the root background both come from the palette, and
 * both live here — one place that reacts to a theme change, rather than every
 * screen remembering to set its own.
 */
function ThemedRoot({ introSession }: { introSession?: IntroSession }): React.JSX.Element {
  const { palette } = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: palette.background }]}>
      <StatusBar barStyle={palette.statusBarStyle} />
      <RootNavigator introSession={introSession} />
    </View>
  );
}

/**
 * Injections for `App`.
 *
 * Every field is optional and every default is the real one, so the shipped app
 * calls `App()` with nothing and behaves exactly as before. They exist so a test
 * can render *this* tree — the same providers, the same themed root, the same
 * status bar — rather than reassembling a lookalike and testing that instead.
 */
export interface AppProps {
  introSession?: IntroSession;
  storage?: Storage;
  transport?: GloveTransport;
  leftTransport?: GloveTransport;
}

/** The application root: state, then theme, then navigation. */
export function App({
  introSession,
  storage,
  transport,
  leftTransport,
}: AppProps = {}): React.JSX.Element {
  return (
    <AppStateProvider storage={storage} transport={transport} leftTransport={leftTransport}>
      <ThemeGate introSession={introSession} />
    </AppStateProvider>
  );
}

/**
 * Bridges the storage instance from app state into the theme provider.
 *
 * A tiny component rather than putting `ThemeProvider` outside
 * `AppStateProvider`: the theme preference is stored through the same
 * `Storage` abstraction as everything else, and the app-state provider is what
 * decides which implementation that is (AsyncStorage on device, in-memory in
 * tests).
 */
function ThemeGate({ introSession }: { introSession?: IntroSession }): React.JSX.Element {
  const { storage } = useAppState();
  return (
    <ThemeProvider storage={storage}>
      <ThemedRoot introSession={introSession} />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  tabs: {
    flex: 1,
  },
  screen: {
    flex: 1,
  },
});
