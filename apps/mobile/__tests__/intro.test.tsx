/**
 * Intro screen.
 *
 * Two guarantees are under test here.
 *
 * **Never trap the user.** Every path — finishing, skipping, failing to play, or
 * hanging — must reach `onComplete` exactly once.
 *
 * **Never show a black frame.** The Android surface is a `SurfaceView`, which is
 * opaque black until a frame is presented, and react-native-video 6.19.3 exposes
 * no first-frame callback to say when that has happened. So the splash poster is
 * painted above the player and released only once both a decoder warm-up budget
 * *and* evidence that the clip is playing have arrived.
 */
import React from 'react';
import { Animated, StatusBar } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { IntroScreen } from '../src/screens/IntroScreen';

const SKIP_LABEL = 'Skip intro';
const SKIP_REVEAL_MS = 700;
const FALLBACK_HOLD_MS = 1400;
/** Deadline for playback to begin at all. */
const LOAD_DEADLINE_MS = 12_000;
/** Deadline for playback to *start*, counted from `onLoad`. */
const PLAYBACK_START_DEADLINE_MS = 2_500;
/** Margin the screen adds to the clip's own reported length. */
const PLAYBACK_MARGIN_MS = 4_000;
/** Decoder warm-up budget before the poster may move. */
const REVEAL_SETTLE_MS = 500;
/** Crossfade length once the poster is released. */
const POSTER_FADE_MS = 1_000;
/** The real clip length, as `onLoad` reports it. */
const CLIP_MS = 6_467;
const POSTER_TEST_ID = 'intro-poster';
const FALLBACK_TEST_ID = 'intro-fallback';

async function renderIntro(
  onComplete: () => void,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<IntroScreen onComplete={onComplete} />);
  });
  return renderer;
}

async function advance(ms: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

async function unmount(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    renderer.unmount();
  });
}

function videoNode(renderer: ReactTestRenderer.ReactTestRenderer) {
  // `jest.setup.js` mocks react-native-video as a host component named
  // 'Video'. React 19 types `ElementType` as the union of *known* intrinsic
  // tags, so comparing it to a custom host name needs the cast.
  const nodes = renderer.root.findAll(
    (node) => (node.type as unknown as string) === 'Video',
  );
  return nodes[0];
}

/**
 * Current opacity of the poster layer.
 *
 * `findAllByProps` rather than `findByProps`: `Animated.View` renders a `View`
 * and forwards the testID, so two nodes match and `findByProps` would throw.
 * The first match is the outer `Animated.View`, whose `style` is the array this
 * test handed in.
 */
function posterOpacity(renderer: ReactTestRenderer.ReactTestRenderer): number {
  const node = renderer.root.findAllByProps({ testID: POSTER_TEST_ID })[0];
  const style = node.props.style as Array<Record<string, unknown>>;
  const entry = style.find((part) => part && 'opacity' in part);
  const opacity = entry?.opacity as { __getValue(): number };
  return opacity.__getValue();
}

describe('IntroScreen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renders the bundled video full-screen, letterboxed against black', async () => {
    const renderer = await renderIntro(jest.fn());
    const video = videoNode(renderer);

    expect(video).toBeDefined();
    expect(video?.props.source).toBeDefined();
    // Full-screen and letterboxed against black, per the design.
    expect(video?.props.resizeMode).toBe('contain');

    await unmount(renderer);
  });

  it('plays with sound rather than muting by default', async () => {
    // Web autoplay policy does not apply on native, so the supplied soundtrack
    // should play without a "tap for sound" step.
    const renderer = await renderIntro(jest.fn());
    expect(videoNode(renderer)?.props.muted).toBe(false);

    await unmount(renderer);
  });

  it('leaves the poster to us instead of handing it to the player', async () => {
    // The poster is a sibling layer, not the `poster` prop, so the dissolve to
    // the first video frame is ours to control. react-native-video renders into
    // a SurfaceView on Android by default, and a SurfaceView is composited as
    // its own layer behind the window — it does not honour alpha, so fading the
    // video itself would silently do nothing.
    const renderer = await renderIntro(jest.fn());

    expect(videoNode(renderer)?.props.poster).toBeUndefined();
    expect(renderer.root.findAllByProps({ testID: POSTER_TEST_ID }).length).toBeGreaterThan(0);

    await unmount(renderer);
  });

  it('listens for progress only as the first-frame signal', async () => {
    // `progressUpdateInterval` is left at its default: the reports are used to
    // notice the playhead moving, and the handler writes to a ref rather than
    // to state, so the ~4 reports a second cost no React renders. Earlier the
    // interval was passed with no `onProgress` handler at all — pure overhead.
    const renderer = await renderIntro(jest.fn());

    expect(videoNode(renderer)?.props.progressUpdateInterval).toBeUndefined();
    expect(videoNode(renderer)?.props.onProgress).toBeInstanceOf(Function);

    await unmount(renderer);
  });

  it('does not reveal the video merely because the player is ready', async () => {
    // Regression. `onReadyForDisplay` is ExoPlayer's STATE_READY — the player is
    // prepared, which is *before* the first frame is composited. Fading there
    // was measured producing a black flash on a release cold start: the poster
    // was up at t+3.3 s and the screen was black by t+3.9 s.
    const timing = jest.spyOn(Animated, 'timing');
    const renderer = await renderIntro(jest.fn());

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onReadyForDisplay();
    });

    expect(timing).not.toHaveBeenCalled();
    expect(posterOpacity(renderer)).toBe(1);

    // Nor once the warm-up budget quietly expires: the only thing it proves is
    // that the player is prepared, which is not evidence of anything on screen.
    await advance(REVEAL_SETTLE_MS + 50);

    expect(timing).not.toHaveBeenCalled();
    expect(posterOpacity(renderer)).toBe(1);

    await unmount(renderer);
  });

  it('waits out the decoder warm-up even once the playhead is moving', async () => {
    // The clock behind `onProgress` is ExoPlayer's media clock, and because the
    // clip carries an audio track the audio renderer drives it. A moving
    // playhead therefore proves the clip is playing, not that a picture has been
    // painted — which is why it opens a gate instead of releasing the poster.
    const timing = jest.spyOn(Animated, 'timing');
    const renderer = await renderIntro(jest.fn());

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onReadyForDisplay();
      videoNode(renderer)?.props.onProgress({ currentTime: 0.25 });
    });

    expect(timing).not.toHaveBeenCalled();
    expect(posterOpacity(renderer)).toBe(1);

    await unmount(renderer);
  });

  it('dissolves the poster once both gates are satisfied', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const renderer = await renderIntro(jest.fn());

    // Opaque up front, so React Native having mounted is never a black frame.
    expect(posterOpacity(renderer)).toBe(1);

    // A report at the very start proves nothing — the frame may not be drawn.
    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onProgress({ currentTime: 0 });
    });
    expect(timing).not.toHaveBeenCalled();

    // Player prepared and playhead advancing, then the warm-up budget elapses.
    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onReadyForDisplay();
      videoNode(renderer)?.props.onProgress({ currentTime: 0.25 });
    });
    await advance(REVEAL_SETTLE_MS + 50);

    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: 0,
      duration: POSTER_FADE_MS,
      useNativeDriver: true,
    });

    await unmount(renderer);
  });

  it('dissolves the poster at most once, however many reports arrive', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const renderer = await renderIntro(jest.fn());

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onReadyForDisplay();
    });
    await advance(REVEAL_SETTLE_MS + 50);

    await ReactTestRenderer.act(async () => {
      for (const currentTime of [0.25, 0.5, 0.75, 1, 1.25]) {
        videoNode(renderer)?.props.onProgress({ currentTime });
      }
    });

    expect(timing).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('hides the status bar for the cinematic', async () => {
    // `StatusBar` is a stack: this entry sits above the one in `App.tsx` and is
    // popped on unmount, which is what restores the normal bar. No native code.
    const renderer = await renderIntro(jest.fn());
    const bars = renderer.root.findAllByType(StatusBar);

    expect(bars.length).toBeGreaterThan(0);
    expect(bars.some((bar) => bar.props.hidden === true)).toBe(true);

    await unmount(renderer);
  });

  it('reveals the skip control only after playback has started', async () => {
    const renderer = await renderIntro(jest.fn());

    expect(renderer.root.findAllByProps({ accessibilityLabel: SKIP_LABEL })).toHaveLength(0);

    await advance(SKIP_REVEAL_MS + 50);

    expect(
      renderer.root.findAllByProps({ accessibilityLabel: SKIP_LABEL }).length,
    ).toBeGreaterThan(0);

    await unmount(renderer);
  });

  it('completes when the animation ends', async () => {
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onEnd();
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('completes when skip is pressed', async () => {
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);
    await advance(SKIP_REVEAL_MS + 50);

    const skip = renderer.root.findByProps({ accessibilityLabel: SKIP_LABEL });
    await ReactTestRenderer.act(async () => {
      skip.props.onPress();
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('falls back to the poster and continues when playback fails', async () => {
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onError({ error: { errorString: 'decoder failed' } });
    });

    // The video is replaced by the still frame, not an error screen.
    expect(JSON.stringify(renderer.toJSON())).not.toContain('"Video"');
    expect(renderer.root.findAllByProps({ testID: FALLBACK_TEST_ID }).length).toBeGreaterThan(0);

    // …and the app is released shortly afterwards.
    await advance(FALLBACK_HOLD_MS + 50);
    expect(onComplete).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('does not draw a second copy of the wordmark over the poster', async () => {
    // The supplied poster artwork already carries the hands, the ring, the
    // संकेत वाणी wordmark and the loading dots. An earlier version drew the
    // wordmark again as text below it, which duplicated the brand.
    const renderer = await renderIntro(jest.fn());

    expect(JSON.stringify(renderer.toJSON())).not.toContain('संकेत वाणी');

    await unmount(renderer);
  });

  it('never traps the user if playback never begins', async () => {
    // No `onLoad`, no `onError`, no `onEnd` — the load simply hangs.
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);

    await advance(LOAD_DEADLINE_MS + 50);

    expect(JSON.stringify(renderer.toJSON())).not.toContain('"Video"');

    await advance(FALLBACK_HOLD_MS + 50);
    expect(onComplete).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('falls back promptly when the clip loads but never starts playing', async () => {
    // Measured on the target device with a call active: ExoPlayer prepared the
    // clip and then sat at frame 0 forever, because Android held transient audio
    // focus and react-native-video pauses on focus loss. Loading successfully and
    // playing are different things, and the user should not be left on a still
    // poster until the 12 s load deadline.
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onLoad({ duration: CLIP_MS / 1000 });
    });

    // Still showing the clip just before the deadline.
    await advance(PLAYBACK_START_DEADLINE_MS - 100);
    expect(JSON.stringify(renderer.toJSON())).toContain('"Video"');
    expect(onComplete).not.toHaveBeenCalled();

    await advance(200);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('"Video"');
    expect(renderer.root.findAllByProps({ testID: FALLBACK_TEST_ID }).length).toBeGreaterThan(0);

    await advance(FALLBACK_HOLD_MS + 50);
    expect(onComplete).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('drops the start deadline once the playhead moves', async () => {
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onLoad({ duration: CLIP_MS / 1000 });
      videoNode(renderer)?.props.onProgress({ currentTime: 0.25 });
    });

    // Well past the start deadline, and well past it again, with the clip still
    // running: a playing clip must never be cut off by it.
    await advance(PLAYBACK_START_DEADLINE_MS * 2);
    expect(JSON.stringify(renderer.toJSON())).toContain('"Video"');
    expect(onComplete).not.toHaveBeenCalled();

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onEnd();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('does not cut off a clip that is still playing', async () => {
    // Regression. A flat 15 s ceiling counted from mount fired at 16:00:56.373
    // on the target device with `onEnd` only ~0.2 s behind it — the intro was
    // playing correctly and the watchdog killed it. The cause was that
    // playback does not begin at mount: in a debug build React Native fetches
    // the asset from Metro over HTTP, which took ~8 s of the 15.
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onLoad({ duration: CLIP_MS / 1000 });
      videoNode(renderer)?.props.onProgress({ currentTime: 0.25 });
    });

    // Past the clip's own length, but still inside the margin.
    await advance(CLIP_MS);
    expect(JSON.stringify(renderer.toJSON())).toContain('"Video"');
    expect(onComplete).not.toHaveBeenCalled();

    // Then it ends normally and hands off exactly once.
    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onEnd();
    });
    expect(onComplete).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('releases the user when playback begins but never ends', async () => {
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onLoad({ duration: CLIP_MS / 1000 });
      videoNode(renderer)?.props.onProgress({ currentTime: 0.25 });
    });

    await advance(CLIP_MS + PLAYBACK_MARGIN_MS + 50);

    expect(JSON.stringify(renderer.toJSON())).not.toContain('"Video"');

    await advance(FALLBACK_HOLD_MS + 50);
    expect(onComplete).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('calls onComplete at most once even if several paths fire', async () => {
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);
    await advance(SKIP_REVEAL_MS + 50);

    const skip = renderer.root.findByProps({ accessibilityLabel: SKIP_LABEL });

    await ReactTestRenderer.act(async () => {
      videoNode(renderer)?.props.onEnd();
      skip.props.onPress();
      videoNode(renderer)?.props.onError({});
    });
    await advance(LOAD_DEADLINE_MS + FALLBACK_HOLD_MS + 100);

    expect(onComplete).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });
});
