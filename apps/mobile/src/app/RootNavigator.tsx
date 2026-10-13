import React, { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, BackHandler, StatusBar, StyleSheet, View } from 'react-native';

import { AccountProvider, useAccount } from '../account/AccountProvider';
import { AppStateProvider } from './AppState';
import { sessionIntro, type IntroSession } from './launchSession';
import { TabBar, type TabKey } from '../components/TabBar';
import { AccountSheet } from '../components/AccountSheet';
import { AboutScreen } from '../screens/AboutScreen';
import { AdminScreen } from '../screens/AdminScreen';
import { AuditScreen } from '../screens/AuditScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { IntroScreen } from '../screens/IntroScreen';
import { MaintenanceScreen } from '../screens/MaintenanceScreen';
import { MlScreen } from '../screens/MlScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { OledScreen } from '../screens/OledScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { TextboardScreen } from '../screens/TextboardScreen';
import type { Storage } from '../storage';
import type { GloveTransport } from '../ble/types';
import { setupAuthDeepLinking } from '../supabase/linking';
import { ThemeProvider, useTheme } from '../theme/ThemeProvider';
import { useAppState, useMaintenanceState } from './AppState';

/**
 * Route set.
 *
 * Two top-level routes, one tab set, and a single level of detail screens.
 *
 * ## Why there is now a real stack
 *
 * This file used to say that a navigation library would only be worth its
 * weight "the moment a detail screen appears, because that is when a real stack
 * exists". Detail screens have now appeared — Profile, About Us, the audit
 * readout, model management — so the question is worth answering rather than
 * deferring again.
 *
 * The answer is still that a library is not needed, because this is a stack of
 * depth *one*: every detail screen is pushed from a tab and popped back to it,
 * there is no deep nesting, no tabs-inside-a-detail, and no route parameters
 * beyond which screen to show. That is `DetailKey | null`. What a library would
 * add is a URL model and history integration, neither of which this app has a
 * consumer for yet.
 *
 * ## Only the active screen is mounted
 *
 * Deliberately preserved. The Dashboard subscribes to a sensor stream; keeping
 * five screens mounted would mean that subscription kept re-rendering while the
 * user was reading the audit page. Every screen here persists its own work as it
 * is edited, so switching discards no user work — only scroll position.
 */
type Route = 'intro' | 'tabs';

/** A screen pushed over the tabs. Depth one; back always returns to a tab. */
export type DetailKey = 'audit' | 'profile' | 'about' | 'admin' | 'ml';

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
  const [detail, setDetail] = useState<DetailKey | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [recoveryRequested, setRecoveryRequested] = useState(false);

  const { isAdmin, isReady } = useAccount();
  const { maintenance } = useAppState();
  const maintenanceState = useMaintenanceState();

  /** Listen for auth deep link callbacks (e.g. password recovery) */
  useEffect(() => {
    const cleanup = setupAuthDeepLinking(() => {
      setRoute('tabs');
      setDetail('profile');
      setAccountOpen(true);
      setRecoveryRequested(true);
    });
    return cleanup;
  }, []);

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
   * The Admin entry is only offered once the profile has actually loaded.
   *
   * `isAdmin` is false while the profile is still being fetched, which is the
   * safe direction — briefly hiding a screen from an administrator is a
   * cosmetic problem, whereas briefly showing it to everybody is not.
   */
  const canOpenAdmin = isReady && isAdmin;

  const openDetail = useCallback((key: DetailKey) => setDetail(key), []);
  const closeDetail = useCallback(() => setDetail(null), []);

  /**
   * Android back.
   *
   * Order matters and mirrors what the user sees: a pushed screen pops first, an
   * open sheet closes next, and only then does back from a non-Dashboard tab
   * return to the Dashboard. When none of those applies the handler is not
   * registered at all, so back on the Dashboard still reaches the OS and leaves
   * the app rather than being swallowed by a handler with nothing to do.
   */
  useEffect(() => {
    const hasDetail = detail !== null;
    const hasSheet = accountOpen;
    if (route !== 'tabs' || (!hasDetail && !hasSheet && tab === 'dashboard')) return;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (accountOpen) {
        setAccountOpen(false);
        return true;
      }
      if (detail !== null) {
        setDetail(null);
        return true;
      }
      setTab('dashboard');
      return true;
    });

    return () => subscription.remove();
  }, [route, tab, detail, accountOpen]);

  /**
   * Replay is an explicit user action, so it bypasses the session gate
   * entirely — including on a launch where the intro already played. It also
   * returns to the Dashboard, so the intro does not overlay whichever tab the
   * user happened to be on.
   */
  const handleReplayIntro = useCallback(() => {
    setTab('dashboard');
    setDetail(null);
    setRoute('intro');
  }, []);

  /**
   * Maintenance.
   *
   * ## Who it blocks
   *
   * Everyone whose account is not an active administrator. The exemption is not
   * a hole in the rule: an operator who closes the app has to be able to reopen
   * it, and a maintenance mode that can only be lifted from a database console
   * is a mode nobody would dare turn on. It is safe because every administration
   * request re-reads the role from the database, so the exemption grants nothing
   * the backend would not grant anyway.
   *
   * ## Why it is applied after every hook, and before the intro
   *
   * After every hook, because a conditional return that skips a hook would
   * change the order hooks run in — the one thing React does not tolerate. And
   * before the intro, because a persisted session must not bypass maintenance
   * and neither should a launch that would otherwise play the animation.
   */
  const maintenanceOn = maintenanceState.status === 'on';
  const adminExempt = isReady && isAdmin;

  /**
   * An exempt administrator is taken straight to the console.
   *
   * The one useful thing to do while the app is closed is open it again, and
   * making an administrator hunt for the screen that does that would waste the
   * exemption. This runs on the transition into the exempt state only, so an
   * administrator who then closes the console is not dragged back into it.
   */
  useEffect(() => {
    if (maintenanceOn && adminExempt) setDetail('admin');
  }, [maintenanceOn, adminExempt]);

  if (maintenanceOn && !adminExempt) {
    return (
      <View style={styles.tabs}>
        <View style={styles.screen}>
          <MaintenanceScreen
            state={maintenanceState}
            onRecheck={() => {
              void maintenance.refresh();
            }}
            onOpenAdminSignIn={() => setAccountOpen(true)}
          />
        </View>
        {/*
          The sheet is mounted here, and only here, because its administrator
          entry is the way out. Guarded by the same rule as everything else:
          signing in as an ordinary account closes the sheet and leaves the user
          exactly where they were.
        */}
        <AccountSheet
          visible={accountOpen}
          onClose={() => setAccountOpen(false)}
          maintenanceOn
        />
      </View>
    );
  }

  if (route === 'intro') {
    return <IntroScreen onComplete={finishIntro} />;
  }

  return (
    <View style={styles.tabs}>
      <View style={styles.screen}>
        {detail === 'audit' && <AuditScreen onClose={closeDetail} />}
        {detail === 'profile' && <ProfileScreen onClose={closeDetail} />}
        {detail === 'about' && <AboutScreen onClose={closeDetail} />}
        {detail === 'ml' && <MlScreen onClose={closeDetail} />}
        {detail === 'admin' && <AdminScreen onClose={closeDetail} />}

        {detail === null && (
          <>
            {tab === 'dashboard' && (
              <DashboardScreen
                onOpenSettings={() => setTab('more')}
                onOpenAccount={() => setAccountOpen(true)}
                onOpenTextboard={() => setTab('textboard')}
              />
            )}
            {tab === 'oled' && <OledScreen />}
            {tab === 'textboard' && <TextboardScreen onOpenAccount={() => setAccountOpen(true)} />}
            {tab === 'history' && (
              <HistoryScreen
                onOpenAccount={() => setAccountOpen(true)}
                onOpenSettings={() => setTab('more')}
              />
            )}
            {tab === 'more' && (
              <MoreScreen
                onReplayIntro={handleReplayIntro}
                onOpenOled={() => setTab('oled')}
                onOpenAudit={() => openDetail('audit')}
                onOpenProfile={() => openDetail('profile')}
                onOpenAbout={() => openDetail('about')}
                onOpenMl={() => openDetail('ml')}
                // Admin is only reachable when the account actually holds the
                // role. Passed as undefined otherwise, so the row is not drawn
                // at all rather than being drawn and refused.
                onOpenAdmin={canOpenAdmin ? () => openDetail('admin') : undefined}
                onOpenAccount={() => setAccountOpen(true)}
                initialRecoveryMode={recoveryRequested}
                onCloseAccount={() => setRecoveryRequested(false)}
              />
            )}
          </>
        )}
      </View>

      {/* The tab bar is hidden behind a pushed screen: it would otherwise offer
          navigation away from a screen the user has not finished with. */}
      {detail === null ? <TabBar active={tab} onSelect={setTab} /> : null}

      <AccountSheet
        visible={accountOpen}
        onClose={() => {
          setAccountOpen(false);
          setRecoveryRequested(false);
        }}
        isRecoveryMode={recoveryRequested}
        maintenanceOn={maintenanceOn}
      />
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

/** The application root: state, then account, then theme, then navigation. */
export function App({
  introSession,
  storage,
  transport,
  leftTransport,
}: AppProps = {}): React.JSX.Element {
  return (
    <AppStateProvider storage={storage} transport={transport} leftTransport={leftTransport}>
      {/*
        Account sits inside app state and outside the theme, because the account
        answer is needed by the header on every screen and by the admin gate, and
        neither of those should have to be re-derived per consumer.
      */}
      <AccountGate>
        <ThemeGate introSession={introSession} />
      </AccountGate>
    </AppStateProvider>
  );
}

/**
 * Wires the push registration to the account lifecycle.
 *
 * A component rather than an import inside `AccountProvider`, because the
 * dependency runs the other way: app state owns the push controller, the account
 * provider owns the session, and neither should have to know about the other.
 * This is the one place that does.
 *
 * Two jobs, and they are different jobs:
 *
 *  - `onBeforeSignOut` releases this install's push token *while the session is
 *    still live*, which is the only moment the database will allow it.
 *  - `PushAccountSync` keeps the token pointed at whoever is signed in now, so
 *    that signing in records it and signing out stops it.
 */
function AccountGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { push } = useAppState();

  const releasePushRegistration = useCallback(async () => {
    await push.setAccount(null);
  }, [push]);

  return (
    <AccountProvider onBeforeSignOut={releasePushRegistration}>
      <PushAccountSync />
      {children}
    </AccountProvider>
  );
}

/**
 * Tells the push controller which account is signed in.
 *
 * Renders nothing. It exists so that the push controller is not itself a
 * consumer of the account context, which would make the account provider a
 * dependency of the notification module and vice versa.
 */
function PushAccountSync(): null {
  const { push } = useAppState();
  const { user } = useAccount();
  const accountId = user?.id ?? null;

  useEffect(() => {
    void push.setAccount(accountId);
  }, [push, accountId]);

  return null;
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
