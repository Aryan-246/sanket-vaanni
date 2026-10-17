/**
 * Shared test scaffolding.
 *
 * Not a suite — `jest.config.js` matches `*.test.*` only, so this file is
 * imported, never collected. It exists so each suite builds the same tree the
 * app does, rather than each one inventing a slightly different one.
 *
 * The tree here is deliberately the real one: `AppStateProvider` (which owns the
 * controllers, the pose streams and the storage) wrapping `RootNavigator` (which
 * owns the themed root, the launch gate and the tabs). Nothing is stubbed except
 * the transport and the clock, which are the two things a test has to control.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { App, type DetailKey } from '../src/app/RootNavigator';
import { createIntroSession, type IntroSession } from '../src/app/launchSession';
import { MockTransport } from '../src/ble/mockTransport';
import { createInMemoryStorage, type Storage } from '../src/storage';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import type { ThemeMode } from '../src/app/preferences';

/** A string only the Dashboard's root `Screen` renders. */
export const DASHBOARD_MARKER = 'dashboard-screen';
/** A string only the OLED Studio's root `Screen` renders. */
export const OLED_MARKER = 'oled-screen';
/** A string only the Audit's root `Screen` renders. */
export const AUDIT_MARKER = 'audit-screen';
/** A string only More's root `Screen` renders. */
export const MORE_MARKER = 'more-screen';
/** A string only the Textboard's root `Screen` renders. */
export const TEXTBOARD_MARKER = 'textboard-screen';
/** A string only the History screen's root `Screen` renders. */
export const HISTORY_MARKER = 'history-screen';
/** The native video host component, as mocked in `jest.setup.js`. */
export const VIDEO_MARKER = '"Video"';

export interface AppHarness {
  readonly renderer: ReactTestRenderer.ReactTestRenderer;
  readonly storage: Storage;
  readonly session: IntroSession;
  readonly right: MockTransport;
  readonly left: MockTransport;
}

export interface RenderAppOptions {
  /** Defaults to a fresh session, i.e. a cold launch that has not shown the intro. */
  session?: IntroSession;
  /** Defaults to a fresh in-memory store, so no case sees another's writes. */
  storage?: Storage;
  /** Set true to land on the tabs without the intro, standing in for a warm launch. */
  skipIntro?: boolean;
  /** Seed the theme preference, for theme tests that need a starting mode. */
  themeMode?: ThemeMode;
  /**
   * Start with a screen already pushed.
   *
   * The only way to ask whether a *route* is gated, as opposed to whether its
   * entry point is drawn. Navigating to it cannot answer that question, because
   * navigation is what the gate removes.
   */
  initialDetail?: DetailKey | null;
  /**
   * Called once per React commit.
   *
   * Wrapping the tree in a `Profiler` is what makes "how much does an update
   * cost" a measured number rather than an impression. `actualDuration` is only
   * meaningful as a *comparison* between two runs on this same setup — it is
   * test-renderer time, not device time — which is exactly how the performance
   * cases use it.
   */
  onCommit?: (info: CommitInfo) => void;
}

export interface CommitInfo {
  readonly phase: string;
  readonly actualDuration: number;
}

/**
 * Renders the app.
 *
 * Async because `act` has to flush the storage read the theme provider starts on
 * mount. The launch gate itself is synchronous — that is the point of it — so
 * the intro/tabs decision is already made by the time this returns.
 */
export async function renderApp(options: RenderAppOptions = {}): Promise<AppHarness> {
  const storage = options.storage ?? createInMemoryStorage();
  if (options.themeMode !== undefined) {
    await storage.setThemeMode(options.themeMode);
  }

  const session = options.session ?? createIntroSession();
  if (options.skipIntro === true) session.markIntroPlayed();

  const right = new MockTransport('right');
  const left = new MockTransport('left', { sideOffsetMs: 0 });

  const app = (
    <App
      storage={storage}
      transport={right}
      leftTransport={left}
      introSession={session}
      initialDetail={options.initialDetail}
    />
  );
  const onCommit = options.onCommit;

  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      onCommit === undefined ? (
        app
      ) : (
        <React.Profiler
          id="app"
          onRender={(_id, phase, actualDuration) => onCommit({ phase, actualDuration })}
        >
          {app}
        </React.Profiler>
      ),
    );
  });

  return { renderer, storage, session, right, left };
}

/** Renders a bare component inside the theme, which is all `AppText` needs. */
export async function renderThemed(
  node: React.ReactNode,
  mode: ThemeMode = 'dark',
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <ThemeProvider storage={createInMemoryStorage()} initialMode={mode}>
        {node}
      </ThemeProvider>,
    );
  });
  return renderer;
}

/** Everything the tree renders, as one string, for containment assertions. */
export function textOf(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

/**
 * The visible text of the whole tree, concatenated.
 *
 * Needed because JSX splits adjacent text into separate children: a line such as
 *
 *     Connecting to {name}…
 *
 * renders as `["Connecting to", " ", "Demo glove (simulated)", "…"]`, so none of
 * those children contains the sentence and a JSON containment check cannot find
 * it. Joining them reconstructs what a reader actually sees.
 *
 * Props are not included, which is the point: an assertion about what the screen
 * *claims* should not be satisfied by an `accessibilityLabel`.
 */
export function renderedText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  const parts: string[] = [];

  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node === 'object') {
      walk((node as { children?: unknown }).children);
    }
  };

  walk(renderer.toJSON());
  return parts.join('');
}

/**
 * Presses the thing announced by an accessibility label.
 *
 * `findAllByProps` rather than `findByProps`, then the first node that actually
 * carries an `onPress`. Props are threaded down through wrappers — `ActionButton`
 * to `Pressable` to the host `View` — so several nodes share the label and only
 * the outermost pressable is the control. Picking by capability rather than by
 * position keeps this independent of how many layers a component happens to have.
 */
export async function pressByLabel(
  renderer: ReactTestRenderer.ReactTestRenderer,
  accessibilityLabel: string,
): Promise<void> {
  await pressFirstWithOnPress(
    renderer.root.findAllByProps({ accessibilityLabel }),
    `accessibilityLabel "${accessibilityLabel}"`,
  );
}

/** Presses the first node carrying a testID. */
export async function pressByTestId(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await pressFirstWithOnPress(
    renderer.root.findAllByProps({ testID }),
    `testID "${testID}"`,
  );
}

async function pressFirstWithOnPress(
  nodes: ReactTestRenderer.ReactTestInstance[],
  description: string,
): Promise<void> {
  const target = nodes.find((node) => typeof node.props.onPress === 'function');
  if (target === undefined) {
    throw new Error(`No pressable node found for ${description}.`);
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress();
  });
}

/** True when a node with this testID is mounted. */
export function has(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  return renderer.root.findAllByProps({ testID }).length > 0;
}

/**
 * Whether the control with this testID is disabled.
 *
 * Reads `accessibilityState.disabled` off the node rather than the `disabled`
 * prop, because that is what a screen reader is told and therefore what the user
 * actually experiences. A button that is disabled in the tree but still announced
 * as enabled is a bug this would otherwise miss.
 *
 * Throws when nothing carries the testID: an absent control is not a disabled
 * one, and folding the two together would let a test pass against a screen that
 * forgot to render the thing it is testing.
 */
export function isDisabled(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  const nodes = renderer.root.findAllByProps({ testID });
  if (nodes.length === 0) throw new Error(`No node found for testID "${testID}".`);
  return nodes.some((node) => node.props.accessibilityState?.disabled === true);
}

/** Flushes pending microtasks — a storage read, a fire-and-forget write. */
export async function flush(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
  });
}

/** Unmounts, so timers and native animation drivers do not outlive the case. */
export async function teardown(
  renderer: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    renderer.unmount();
  });
}
