/**
 * How the speech waveform is allowed to animate.
 *
 * ## Why this file exists
 *
 * The waveform's bars used to animate `height`, which cannot be handed to the
 * native driver, so the animation ran a JavaScript frame loop and re-rendered
 * thirty-six `Animated.View`s through React on every one of them. That is what
 * used to make this suite unreliable: a render inside `act()` could not
 * converge, because the animation produced React work at least as fast as the
 * act queue drained it. The test that mounts the panel in its *available* state
 * — the only state that starts the resting animation — did not fail; it ran
 * until the 15 s test timeout, and only when the machine was loaded enough for
 * that race to go that way. Every other test in the same file finished in
 * milliseconds, in the same process, in the same run.
 *
 * Asserting the *driver* is therefore the regression guard, not a style
 * preference: put this animation back on the JavaScript driver and these
 * assertions fail here, by name, instead of the suite hanging somewhere else.
 * The geometry assertions are the other half — they pin the envelope the
 * approved design specifies, which is what makes the driver safe to change.
 *
 * `Animated.View` with a native-driver animation is delegated to the animated
 * module; under Jest that module is a stub, so no frames tick and the act queue
 * drains. That is the whole mechanism this file protects.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Animated } from 'react-native';

import { SpeechOutputWaveform, WAVEFORM_BAR_COUNT } from '../src/components/SpeechOutputWaveform';
import { VoicePanel } from '../src/components/VoicePanel';
import { renderThemed, teardown } from './support';

const WAVE = 'wave-under-test';

type Renderer = ReactTestRenderer.ReactTestRenderer;

/** Every bar's drawn height and vertical scale, found by its transform. */
function barScales(renderer: Renderer): { height: unknown; scale: unknown }[] {
  const found: { height: unknown; scale: unknown }[] = [];

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const element = node as { props?: Record<string, unknown>; children?: unknown[] };
    const style = element.props?.style;
    const flat: unknown[] = Array.isArray(style) ? style : [style];
    const objects = flat.filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    );

    // Only bars: a bar is the node whose transform carries a vertical scale.
    // `Toggle` is also a transformed `Animated.View` and must not be counted.
    const scaleY = objects
      .map((entry) => entry.transform)
      .find((value) => Array.isArray(value))
      ?.map((entry) => (entry as { scaleY?: unknown }).scaleY)
      .find((value) => value !== undefined);

    if (scaleY !== undefined) {
      const height = objects.map((entry) => entry.height).find((value) => value !== undefined);
      found.push({ height, scale: scaleY });
    }

    for (const child of element.children ?? []) walk(child);
  };

  // Scoped to the waveform's own viewport, so nothing else in the tree can be
  // mistaken for a bar.
  const json = renderer.toJSON() as { children?: unknown[] } | null;
  const viewport = (json?.children ?? []).find(
    (node) => (node as { props?: Record<string, unknown> } | null)?.props?.testID === WAVE,
  );
  walk(viewport ?? json);

  return found;
}

describe('the speech waveform animation', () => {
  const mounted: Renderer[] = [];

  const mount = async (node: React.ReactNode): Promise<Renderer> => {
    const renderer = await renderThemed(node);
    mounted.push(renderer);
    return renderer;
  };

  /*
   * Unmounting in an `afterEach` rather than at the end of each test body: a
   * failing assertion skips the rest of its test, and an animation left mounted
   * by a failure keeps ticking — which leaves Jest unable to exit, turning one
   * red test into a hung suite.
   */
  afterEach(async () => {
    while (mounted.length > 0) {
      const renderer = mounted.pop();
      if (renderer !== undefined) await teardown(renderer);
    }
    jest.restoreAllMocks();
  });

  it('scales its bars rather than animating their height', async () => {
    /*
     * `height` is a layout property, and animating a layout property is what
     * forces the JavaScript driver. The bars hold a fixed height and move a
     * scale instead — the same envelope about the same vertically centred row,
     * which the native driver can take.
     */
    const renderer = await mount(<SpeechOutputWaveform enabled speaking={false} testID={WAVE} />);

    const bars = barScales(renderer);

    expect(bars).toHaveLength(WAVEFORM_BAR_COUNT);
    for (const bar of bars) {
      // A real number, not an interpolation: the height itself does not move.
      expect(typeof bar.height).toBe('number');
      expect(bar.scale).toBeDefined();
    }
  });

  it('starts both halves of its resting animation on the native driver', async () => {
    const timing = jest.spyOn(Animated, 'timing');

    await mount(<SpeechOutputWaveform enabled speaking={false} testID={WAVE} />);

    const configs = timing.mock.calls.map((call) => call[1] as { useNativeDriver?: boolean });

    // The breath is a sequence of two timings. If this ever reads zero the
    // state under test stopped animating, and the assertion below proves
    // nothing — so the count is asserted rather than assumed.
    expect(configs).toHaveLength(2);
    for (const config of configs) {
      expect(config?.useNativeDriver).toBe(true);
    }
  });

  it('starts nothing at all when speech cannot run', async () => {
    const timing = jest.spyOn(Animated, 'timing');

    const renderer = await mount(
      <SpeechOutputWaveform enabled speaking={false} blocked testID={WAVE} />,
    );

    // An unavailable panel has nothing to animate, so it must not start a loop
    // that would run for as long as the screen is open.
    expect(timing).not.toHaveBeenCalled();

    const bars = barScales(renderer);
    expect(bars).toHaveLength(WAVEFORM_BAR_COUNT);
    for (const bar of bars) {
      expect(bar.scale).toBe(1);
      expect(bar.height).toBe(3.5);
    }
  });

  it('keeps the design envelope while doing so', async () => {
    /*
     * The swap is only safe because the visible result is unchanged: the
     * resting breath still rises to 1.35× the bar's drawn height, and the
     * speaking envelope's scales are the same numbers the heights used, divided
     * by their own base.
     */
    const interpolate = jest.spyOn(Animated.Value.prototype, 'interpolate');

    await mount(<SpeechOutputWaveform enabled speaking={false} testID={WAVE} />);

    const ranges = interpolate.mock.calls.map(
      (call) => (call[0] as unknown as { outputRange?: readonly number[] }).outputRange,
    );

    expect(ranges).toContainEqual([1, 1.35]);
  });

  it('draws the bars inside the panel it is mounted in', async () => {
    /*
     * The unit above tests the waveform directly; this one goes through the
     * panel, because the panel is where the state decides which of the three
     * profiles is drawn — and the *available* state, the one that animates, was
     * the state nothing used to render.
     */
    const renderer = await renderThemed(
      <VoicePanel
        enabled
        onToggle={() => undefined}
        available
        unavailableReason={null}
        phrase={null}
      />,
    );
    mounted.push(renderer);

    const bars = barScales(renderer);

    expect(bars).toHaveLength(WAVEFORM_BAR_COUNT);
    // Ready, so the accent profile rather than the dormant one.
    for (const bar of bars) expect(bar.scale).toBeDefined();
  });
});
