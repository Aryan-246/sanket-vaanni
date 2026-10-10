/**
 * Intro screen.
 *
 * The requirement is that the intro can never trap the user: every path —
 * finishing, skipping, failing to play, or hanging — must reach `onComplete`
 * exactly once.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { IntroScreen } from '../src/screens/IntroScreen';

const SKIP_LABEL = 'Skip intro';
const SKIP_REVEAL_MS = 700;
const FALLBACK_HOLD_MS = 1400;
const INTRO_MAX_MS = 15_000;

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

describe('IntroScreen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders the bundled video with a poster', async () => {
    const renderer = await renderIntro(jest.fn());
    const video = videoNode(renderer);

    expect(video).toBeDefined();
    expect(video?.props.source).toBeDefined();
    expect(video?.props.poster).toBeDefined();
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

    // …and the app is released shortly afterwards.
    await advance(FALLBACK_HOLD_MS + 50);
    expect(onComplete).toHaveBeenCalledTimes(1);

    await unmount(renderer);
  });

  it('never traps the user if playback stalls without ending or erroring', async () => {
    const onComplete = jest.fn();
    const renderer = await renderIntro(onComplete);

    // Neither onEnd nor onError fires.
    await advance(INTRO_MAX_MS + 50);

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
    await advance(INTRO_MAX_MS + FALLBACK_HOLD_MS + 100);

    expect(onComplete).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });
});
