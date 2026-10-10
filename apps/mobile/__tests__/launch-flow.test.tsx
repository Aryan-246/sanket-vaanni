/**
 * Root flow: the launch gate, navigation, and the home screen's honesty rules.
 *
 * These tests exercise real routing and real state, not a mocked navigator.
 *
 * The gate is the process-lifetime session from `launchSession.ts`, not
 * persisted storage, so each case constructs its own session with
 * `createIntroSession()`. That is what makes "this is a fresh launch"
 * expressible in a test at all — under the old persisted flag, the second test
 * in this file would have behaved differently from the first, which was exactly
 * the bug.
 *
 * Note that `render` does not await anything before asserting. The launch
 * decision is synchronous by design; the previous version had to await a
 * storage read, and the blank frame it rendered while waiting was the black
 * startup gap.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { AppStateProvider } from '../src/app/AppState';
import { RootNavigator } from '../src/app/RootNavigator';
import { createIntroSession } from '../src/app/launchSession';
import type { IntroSession } from '../src/app/launchSession';
import { MockTransport } from '../src/ble/mockTransport';
import { createInMemoryStorage } from '../src/storage';

/** A string only the home screen renders. */
const HOME_MARKER = 'Glove link';
/** The native video host component, as mocked in `jest.setup.js`. */
const VIDEO_MARKER = '"Video"';
/** A string only the settings screen renders. */
const SETTINGS_MARKER = 'Replay intro';

async function render(
  session: IntroSession = createIntroSession(),
): Promise<ReactTestRenderer.ReactTestRenderer> {
  const transport = new MockTransport('right');
  let renderer!: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <AppStateProvider storage={createInMemoryStorage()} transport={transport}>
        <RootNavigator introSession={session} />
      </AppStateProvider>,
    );
  });

  return renderer;
}

function text(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function press(
  renderer: ReactTestRenderer.ReactTestRenderer,
  accessibilityLabel: string,
): Promise<void> {
  const target = renderer.root.findByProps({ accessibilityLabel });
  await ReactTestRenderer.act(async () => {
    target.props.onPress();
  });
}

/** Unmounts so the intro's timers do not outlive the test. */
async function teardown(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    renderer.unmount();
  });
}

describe('launch gate', () => {
  it('starts with the intro on a fresh launch', async () => {
    const renderer = await render();
    const output = text(renderer);

    expect(output).toContain(VIDEO_MARKER);
    expect(output).not.toContain(HOME_MARKER);

    await teardown(renderer);
  });

  it('starts on the home screen when this launch already showed the intro', async () => {
    // Standing in for "the user pressed Home and came back": the process, and
    // therefore the session, is still alive.
    const session = createIntroSession();
    session.markIntroPlayed();

    const renderer = await render(session);
    const output = text(renderer);

    expect(output).toContain(HOME_MARKER);
    expect(output).not.toContain(VIDEO_MARKER);

    await teardown(renderer);
  });

  it('shows the intro again on a new session, however many launches preceded it', async () => {
    // The regression this whole change exists for: under the persisted flag the
    // intro appeared exactly once, ever.
    const previousLaunch = createIntroSession();
    previousLaunch.markIntroPlayed();

    const renderer = await render(createIntroSession());

    expect(text(renderer)).toContain(VIDEO_MARKER);

    await teardown(renderer);
  });
});

describe('navigation', () => {
  it('opens settings from home and returns with Done', async () => {
    const session = createIntroSession();
    session.markIntroPlayed();

    const renderer = await render(session);
    await press(renderer, 'Settings');
    expect(text(renderer)).toContain(SETTINGS_MARKER);

    await press(renderer, 'Done');
    expect(text(renderer)).toContain(HOME_MARKER);
    expect(text(renderer)).not.toContain(SETTINGS_MARKER);

    await teardown(renderer);
  });

  it('replays the intro from settings, even though this launch already showed it', async () => {
    // Replay is an explicit user action, so it must not be filtered by the
    // launch gate.
    const session = createIntroSession();
    session.markIntroPlayed();

    const renderer = await render(session);
    await press(renderer, 'Settings');
    await press(renderer, 'Replay intro');

    expect(text(renderer)).toContain(VIDEO_MARKER);

    await teardown(renderer);
  });
});

describe('home screen honesty', () => {
  async function renderHome(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const session = createIntroSession();
    session.markIntroPlayed();
    return render(session);
  }

  it('labels simulated data as Demo Mode', async () => {
    const renderer = await renderHome();
    expect(text(renderer)).toContain('Demo mode');

    await teardown(renderer);
  });

  it('states that recognition is not implemented instead of showing a sign', async () => {
    const renderer = await renderHome();
    const output = text(renderer);

    expect(output).toContain('Recognised sign');
    expect(output).toContain('Not implemented');
    expect(output).toContain('No recognition model exists yet');

    await teardown(renderer);
  });

  it('says Bluetooth is not in use', async () => {
    const renderer = await renderHome();
    expect(text(renderer)).toContain('no Bluetooth is in use');

    await teardown(renderer);
  });

  it('does not display a fabricated sign or confidence', async () => {
    const renderer = await renderHome();
    const output = text(renderer);

    // The recogniser returns null and reports no confidence, so no percentage
    // or confidence figure should appear anywhere on the screen.
    expect(output).not.toMatch(/\d+%\s*(confidence|match)/i);
    expect(output).not.toContain('confidence');

    await teardown(renderer);
  });
});
