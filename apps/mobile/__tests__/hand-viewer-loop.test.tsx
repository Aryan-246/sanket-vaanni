/**
 * The viewer's render loop, and who is allowed to stop it.
 *
 * The hand viewer draws in a WebView, which is a second JavaScript context with
 * its own animation loop. That loop used to be unconditional — an infinite
 * `requestAnimationFrame` chain that rendered sixty times a second from page
 * load until teardown, whether or not anybody could see it.
 *
 * Measured against the real page in Chrome at 393x851 (CDP, counting GPU
 * `drawElements` calls) the page issued 60 draw calls per second while visible
 * and **60 per second with the document marked hidden** — the same work, with
 * nothing on screen to show for it. After the gate in `hand_viewer.js` the
 * hidden figure is 0, with the visible rate unchanged at 60.
 *
 * These cases cover this side of the bridge: that the host tells the viewer to
 * stop, that it tells it to resume, and that it stops listening when the viewer
 * goes away. The page's own half — that it obeys, and resumes on its own — is
 * what the browser measurement above demonstrates.
 */
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { HandModel3D } from '../src/components/HandModel3D';
import { createPresetPose } from '../src/hands/poseController';
import { DEFAULT_SMOOTHING } from '../src/hands/pose';
import type { ViewerFrame } from '../src/hands/viewer';
import { renderThemed, teardown } from './support';

/** A frame carrying a neutral pose — enough to exercise the bridge wiring. */
const FRAME: ViewerFrame = {
  pose: createPresetPose('right', 'rest', 'simulated'),
  neutral: null,
  smoothing: DEFAULT_SMOOTHING,
};

/** Every script pushed into a WebView so far. */
function injectedScripts(): readonly string[] {
  return jest.requireMock('react-native-webview').__injected as readonly string[];
}

interface AppStateHarness {
  /** Reports a state change, as the platform would. */
  readonly emit: (state: AppStateStatus) => void;
  /** True once every subscription taken out has been released. */
  readonly allReleased: () => boolean;
  readonly restore: () => void;
}

/**
 * Intercepts `AppState.addEventListener` so a case can drive it.
 *
 * Jest has no way to make the real AppState emit — it is backed by a native
 * emitter that does not exist here — so the handler is captured and called
 * directly. That also lets these cases assert the subscription is released,
 * which is the other half of a listener: a viewer that unmounts must not leave
 * one behind.
 */
function captureAppState(): AppStateHarness {
  const handlers: ((state: AppStateStatus) => void)[] = [];
  const removers: jest.Mock[] = [];

  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (state: AppStateStatus) => void,
  ) => {
    handlers.push(handler);
    const remove = jest.fn();
    removers.push(remove);
    return { remove } as unknown as ReturnType<typeof AppState.addEventListener>;
  }) as typeof AppState.addEventListener);

  return {
    emit: (state) => {
      for (const handler of handlers) handler(state);
    },
    allReleased: () => removers.length > 0 && removers.every((remove) => remove.mock.calls.length > 0),
    restore: () => spy.mockRestore(),
  };
}

/** Tells the mounted viewer it has finished loading, as the page does. */
async function reportReady(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  const views = renderer.root.findAll((node) => typeof node.props?.onMessage === 'function');
  expect(views.length).toBeGreaterThan(0);
  await ReactTestRenderer.act(async () => {
    views[0].props.onMessage({ nativeEvent: { data: '{"type":"loaded"}' } });
  });
}

/** The scripts that tell the page whether to run its loop. */
function activityScripts(): readonly string[] {
  return injectedScripts().filter((script) => script.includes('setViewerActive'));
}

async function renderViewer(): Promise<ReactTestRenderer.ReactTestRenderer> {
  return renderThemed(
    <HandModel3D side="right" frame={FRAME} width={160} height={216} />,
  );
}

describe('the 3D viewer stops drawing when nothing can see it', () => {
  let appState: AppStateHarness;

  beforeEach(() => {
    appState = captureAppState();
    (jest.requireMock('react-native-webview').__injected as string[]).length = 0;
  });
  afterEach(() => {
    appState.restore();
  });

  it('tells the viewer to stop when the app goes to the background', async () => {
    const renderer = await renderViewer();
    await reportReady(renderer);

    // The page reported ready while the app was in the foreground, so the first
    // thing it hears is "keep drawing" — the state is asserted, not assumed.
    expect(activityScripts()).toHaveLength(1);
    expect(activityScripts()[0]).toContain('setViewerActive(true)');

    await ReactTestRenderer.act(async () => {
      appState.emit('background');
    });

    expect(activityScripts()).toHaveLength(2);
    expect(activityScripts()[1]).toContain('setViewerActive(false)');

    await teardown(renderer);
  });

  it('tells it to start again when the app comes back', async () => {
    const renderer = await renderViewer();
    await reportReady(renderer);

    await ReactTestRenderer.act(async () => {
      appState.emit('background');
    });
    await ReactTestRenderer.act(async () => {
      appState.emit('active');
    });

    // The last word is the one that counts, and it is "resume": a viewer that
    // came back from the background and stayed paused would be a frozen hand.
    const scripts = activityScripts();
    expect(scripts[scripts.length - 1]).toContain('setViewerActive(true)');

    await teardown(renderer);
  });

  it('holds a viewer that finishes loading while already in the background', async () => {
    // The order that would otherwise leave a hidden viewer rendering forever:
    // backgrounded first, model ready afterwards. Nothing can be sent before
    // the page is ready — it has not defined `setViewerActive` yet — so the
    // instruction has to be re-issued the moment it can be heard.
    const renderer = await renderViewer();

    await ReactTestRenderer.act(async () => {
      appState.emit('background');
    });
    expect(activityScripts()).toEqual([]);

    await reportReady(renderer);

    expect(activityScripts()).toHaveLength(1);
    expect(activityScripts()[0]).toContain('setViewerActive(false)');

    await teardown(renderer);
  });

  it('releases its app-state listener when the viewer unmounts', async () => {
    const renderer = await renderViewer();
    await reportReady(renderer);
    expect(appState.allReleased()).toBe(false);

    await teardown(renderer);

    expect(appState.allReleased()).toBe(true);
  });
});
