/**
 * Root flow: the launch gate and the five-tab navigation.
 *
 * These tests exercise real routing and real state, not a mocked navigator.
 *
 * The gate is the process-lifetime session from `launchSession.ts`, not
 * persisted storage, so each case constructs its own session with
 * `createIntroSession()`. That is what makes "this is a fresh launch"
 * expressible in a test at all — under a persisted flag, the second test in this
 * file would have behaved differently from the first, which was exactly the bug.
 *
 * Note that nothing here mocks the screens. The markers asserted below are the
 * `testID` each screen's root `Screen` carries, so a destination that fails to
 * mount fails the test rather than passing against a stub.
 */
import { BackHandler } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { createIntroSession } from '../src/app/launchSession';
import {
  AUDIT_MARKER,
  DASHBOARD_MARKER,
  HISTORY_MARKER,
  MORE_MARKER,
  OLED_MARKER,
  TEXTBOARD_MARKER,
  VIDEO_MARKER,
  has,
  pressByLabel,
  pressByTestId,
  renderApp,
  teardown,
  textOf,
} from './support';

describe('launch gate', () => {
  it('starts with the intro on a fresh launch', async () => {
    const { renderer, session } = await renderApp();
    const output = textOf(renderer);

    expect(session.shouldPlayIntro()).toBe(true);
    expect(output).toContain(VIDEO_MARKER);
    expect(output).not.toContain(DASHBOARD_MARKER);

    await teardown(renderer);
  });

  it('starts on the Dashboard when this launch already showed the intro', async () => {
    // Standing in for "the user pressed Home and came back": the process, and
    // therefore the session, is still alive.
    const { renderer } = await renderApp({ skipIntro: true });
    const output = textOf(renderer);

    expect(output).toContain(DASHBOARD_MARKER);
    expect(output).not.toContain(VIDEO_MARKER);

    await teardown(renderer);
  });

  it('shows the intro again on a new session, however many launches preceded it', async () => {
    // The regression this whole change exists for: under a persisted flag the
    // intro appeared exactly once, ever.
    const previousLaunch = createIntroSession();
    previousLaunch.markIntroPlayed();

    const { renderer } = await renderApp({ session: createIntroSession() });

    expect(textOf(renderer)).toContain(VIDEO_MARKER);

    await teardown(renderer);
  });
});

describe('navigation', () => {
  it('reaches every destination from the tab bar', async () => {
    const { renderer } = await renderApp({ skipIntro: true });

    expect(has(renderer, DASHBOARD_MARKER)).toBe(true);

    await pressByLabel(renderer, 'OLED');
    expect(has(renderer, OLED_MARKER)).toBe(true);

    await pressByLabel(renderer, 'Textboard');
    expect(has(renderer, TEXTBOARD_MARKER)).toBe(true);

    await pressByLabel(renderer, 'History');
    expect(has(renderer, HISTORY_MARKER)).toBe(true);

    await pressByLabel(renderer, 'Settings');
    expect(has(renderer, MORE_MARKER)).toBe(true);

    await pressByLabel(renderer, 'Dashboard');
    expect(has(renderer, DASHBOARD_MARKER)).toBe(true);

    /*
     * The Audit readout is deliberately not a tab. It is a diagnostic detail
     * screen pushed from Settings, so it is reached the way a reader reaches
     * it — and it is checked last, because a pushed screen hides the tab bar.
     */
    await pressByLabel(renderer, 'Settings');
    await pressByLabel(renderer, 'Component status');
    expect(has(renderer, AUDIT_MARKER)).toBe(true);

    await teardown(renderer);
  });

  it('mounts only the active destination', async () => {
    // The performance decision, asserted rather than assumed: five mounted
    // screens would keep the Dashboard's sensor subscription re-rendering while
    // the user is reading these settings.
    const { renderer } = await renderApp({ skipIntro: true });

    await pressByLabel(renderer, 'Settings');

    expect(has(renderer, MORE_MARKER)).toBe(true);
    expect(has(renderer, DASHBOARD_MARKER)).toBe(false);
    expect(has(renderer, OLED_MARKER)).toBe(false);
    expect(has(renderer, AUDIT_MARKER)).toBe(false);


    await teardown(renderer);
  });

  it('does not replay the intro when moving between tabs', async () => {
    const { renderer, session } = await renderApp({ skipIntro: true });

    await pressByLabel(renderer, 'OLED');
    await pressByLabel(renderer, 'Settings');

    expect(textOf(renderer)).not.toContain(VIDEO_MARKER);
    expect(session.shouldPlayIntro()).toBe(false);

    await teardown(renderer);
  });

  it('replays the intro from Settings, even though this launch already showed it', async () => {
    // Replay is an explicit user action, so it must not be filtered by the gate.
    const { renderer } = await renderApp({ skipIntro: true });

    await pressByLabel(renderer, 'Settings');
    await pressByTestId(renderer, 'replay-intro-row');

    expect(textOf(renderer)).toContain(VIDEO_MARKER);

    await teardown(renderer);
  });
});

describe('Android back', () => {
  /** Captures the handler the navigator registers, so it can be invoked. */
  function captureBackHandler(): { invoke: () => boolean } {
    let handler: (() => boolean) | null = null;
    jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_event, listener) => {
        handler = listener as () => boolean;
        return { remove: jest.fn() };
      });

    return {
      invoke: () => {
        if (handler === null) throw new Error('No back handler was registered.');
        return handler();
      },
    };
  }

  afterEach(() => jest.restoreAllMocks());

  it('returns to the Dashboard from another tab', async () => {
    const back = captureBackHandler();
    const { renderer } = await renderApp({ skipIntro: true });

    await pressByLabel(renderer, 'Settings');
    expect(has(renderer, MORE_MARKER)).toBe(true);

    await ReactTestRenderer.act(async () => {
      expect(back.invoke()).toBe(true);
    });

    expect(has(renderer, DASHBOARD_MARKER)).toBe(true);
    expect(has(renderer, MORE_MARKER)).toBe(false);

    await teardown(renderer);
  });

  it('does not intercept back on the Dashboard itself', async () => {
    // A handler here would swallow the press and stop the OS leaving the app,
    // which is the standard Android behaviour on a root screen.
    const back = captureBackHandler();
    const { renderer } = await renderApp({ skipIntro: true });

    expect(has(renderer, DASHBOARD_MARKER)).toBe(true);
    expect(() => back.invoke()).toThrow('No back handler was registered.');

    await teardown(renderer);
  });

  it('leaves the app alone while the intro is playing', async () => {
    const back = captureBackHandler();
    const { renderer } = await renderApp();

    expect(textOf(renderer)).toContain(VIDEO_MARKER);
    expect(() => back.invoke()).toThrow('No back handler was registered.');

    await teardown(renderer);
  });
});
