/**
 * Performance, measured rather than asserted by feel.
 *
 * The reported symptom was a slow, laggy app. "It feels faster now" is not a
 * finding, so these cases count the two things that actually cost work while
 * the app is live:
 *
 *   * **commits** — how many times React re-renders the whole tree for one
 *     frame of glove data, and what that costs in `actualDuration`;
 *   * **bridge messages** — how many scripts `HandModel3D` pushes into the
 *     WebView, because each one crosses into another JavaScript context.
 *
 * Both are counted on the same setup the app runs on under test, so the before
 * and after numbers are comparable. The absolute values are test-renderer
 * numbers, not device timings; the ratios are the finding.
 *
 * The sample rate is the controller's own (`DEFAULT_UI_HZ`), so a frame that
 * does not cross that interval produces no commit at all — which is the first
 * thing these cases pin, because it is the difference between a screen that
 * updates 12 times a second and one that updates 60.
 */
import ReactTestRenderer from 'react-test-renderer';

import { pressByLabel, renderApp, teardown, type CommitInfo } from './support';

/** One glove's notification interval, mirroring the controller's UI rate. */
const UI_INTERVAL_MS = 1000 / 12;

/** WebView scripts sent so far, across every mounted viewer. */
function injectedScripts(): readonly string[] {
  return jest.requireMock('react-native-webview').__injected as readonly string[];
}

/** Empties the bridge log, so a case measures only its own traffic. */
function clearInjected(): void {
  (jest.requireMock('react-native-webview').__injected as string[]).length = 0;
}

/**
 * Tells every mounted viewer it has finished loading.
 *
 * A real viewer reports this over the bridge once the GLB is parsed, and until
 * it does, `HandModel3D` deliberately sends it nothing. Without this step the
 * measurement would be of an empty bridge.
 */
async function reportViewersReady(
  renderer: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  const views = renderer.root.findAll(
    (node) => typeof node.props?.onMessage === 'function',
  );
  expect(views.length).toBeGreaterThan(0);
  await ReactTestRenderer.act(async () => {
    for (const view of views) {
      view.props.onMessage({ nativeEvent: { data: '{"type":"loaded"}' } });
    }
  });
}

/** Advances fake timers inside `act`, which the app's effects require. */
async function advanceBy(ms: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Brings both demo gloves up.
 *
 * Driven through the UI rather than by poking the controller, because a stream
 * started behind the app's back would not have the pose subscriptions that the
 * cost being measured is made of.
 */
async function connectBothGloves(
  renderer: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await connectRightGlove(renderer);
  await pressByLabel(renderer, 'Find the left glove');
  await advanceBy(700);
  await pressByLabel(renderer, 'Connect Demo glove (simulated) as the left glove');
  await advanceBy(700);
}

/** Brings only the right demo glove up, which is the common configuration. */
async function connectRightGlove(
  renderer: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await pressByLabel(renderer, 'Find the right glove');
  await advanceBy(700);
  await pressByLabel(renderer, 'Connect Demo glove (simulated) as the right glove');
  await advanceBy(700);
}

describe('what one frame of glove data costs', () => {
  /*
   * These mount the whole application and drive it through real state updates,
   * which costs real CPU: rendering the app is the thing under test, so it
   * cannot be faked away. Jest's default 5 s is a budget for a unit test, and
   * on a loaded machine — the full run puts a worker on every core — this suite
   * overran it and timed out, which then cascaded into "Can't access .root on
   * unmounted test renderer" in the tests after it. Measured: the suite passes
   * on its own and fails in parallel at 5 s, and passes in parallel at this
   * budget. Nothing here is asserted less strictly for it.
   */
  jest.setTimeout(30000);

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not re-render the screen for samples below the UI rate', async () => {
    const commits: CommitInfo[] = [];
    const { renderer } = await renderApp({
      skipIntro: true,
      onCommit: (info) => commits.push(info),
    });
    await connectBothGloves(renderer);
    await reportViewersReady(renderer);

    // One UI interval's worth of samples. The demo stream emits far faster than
    // this, and the controller is expected to coalesce the difference rather
    // than hand the screen a render each time.
    commits.length = 0;
    await advanceBy(UI_INTERVAL_MS - 40);
    const belowRate = commits.length;

    commits.length = 0;
    await advanceBy(UI_INTERVAL_MS);
    const atRate = commits.length;

    /*
     * Measured with both demo gloves streaming: 0 commits below the rate and 2
     * in an interval, carrying 8.00 ms of render time between them — about a
     * tenth of the 83 ms interval, so the screen is idle most of the time it is
     * live. Only the *counts* are asserted: `actualDuration` is test-renderer
     * time, and it moves with how loaded the machine is (this case passes alone
     * and measured higher inside the full run), so a millisecond bound here
     * would be a flake rather than a property.
     */
    expect(belowRate).toBeLessThanOrEqual(1);
    expect(atRate).toBeLessThanOrEqual(3);

    await teardown(renderer);
  });

  it('sends each hand only the pose that actually changed', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    // One glove, which is the common case: a single hand is live, and the other
    // viewer has nothing to say.
    await connectRightGlove(renderer);
    await reportViewersReady(renderer);

    // Both viewers are up and have been sent their first pose.
    clearInjected();
    await advanceBy(UI_INTERVAL_MS);
    expect(injectedScripts().length).toBeGreaterThan(0);

    /*
     * The measurement: the right glove streams, the left one is silent.
     *
     * The Dashboard re-renders — correct, the numbers on screen come from the
     * glove that moved — but the *left* hand's WebView has nothing new to draw.
     * Pushing its unchanged pose in anyway is pure cost: a serialize on this
     * side, a bridge crossing, and a parse plus a bone update in the renderer,
     * twelve times a second, to arrive at the rotations it already had.
     */
    clearInjected();
    await advanceBy(UI_INTERVAL_MS * 5);
    const sent = injectedScripts().length;

    /*
     * One live hand at ~12 Hz over five intervals is five poses; the measured
     * figure is 4. The bound is the property, not the measurement: no more than
     * one message per interval, because anything approaching ten would mean the
     * idle hand's viewer is being refreshed too.
     */
    expect(sent).toBeLessThanOrEqual(5);

    // And every message is still a real pose.
    const latest = injectedScripts()[injectedScripts().length - 1] as string;
    expect(latest).toContain('updatePose');

    await teardown(renderer);
  });

  it('sends nothing to a viewer when a re-render carries no new pose', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await connectRightGlove(renderer);
    await reportViewersReady(renderer);
    await advanceBy(UI_INTERVAL_MS);
    clearInjected();

    // A sheet opening re-renders the Dashboard without producing a single new
    // sample. Neither viewer should hear about it.
    await pressByLabel(renderer, 'About the hand viewer and 3D rig');
    await advanceBy(50);
    const onOpen = injectedScripts().length;

    // Measured: 0. A sheet opening is not a pose, so it must not cross the
    // bridge at all.
    expect(onOpen).toBe(0);

    await teardown(renderer);
  });

  it('does not write the stored configuration while the user is typing', async () => {
    // The defect this guards: a keystroke that commits a profile and queues a
    // storage write turns typing into I/O. Edits now live in a draft, so a
    // typing burst should reach storage exactly zero times.
    const { renderer, storage } = await renderApp({ skipIntro: true });
    await pressByLabel(renderer, 'OLED');

    const written: string[] = [];
    const original = storage.setJson.bind(storage);
    storage.setJson = async (key, value) => {
      written.push(key);
      return original(key, value);
    };

    const field = renderer.root.findAll(
      (node) => typeof node.props?.onChangeText === 'function' && node.props.maxLength === 5,
    )[0];
    if (field === undefined) throw new Error('No intro-duration field on the OLED screen.');

    await ReactTestRenderer.act(async () => {
      for (const text of ['1', '10', '100', '1000', '1000']) {
        field.props.onChangeText(text);
      }
      await jest.advanceTimersByTimeAsync(1200);
    });

    expect(written).toEqual([]);

    await teardown(renderer);
  });
});
