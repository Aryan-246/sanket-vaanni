/**
 * 3D hand viewer bridge.
 *
 * These lock the two guarantees that the black-viewport bug violated:
 *
 *  1. the viewport is transparent by default, and offers a card-matching
 *     fallback rather than an opaque panel;
 *  2. a viewer that fails, reports an error, or simply never starts renders a
 *     diagnostic — it never leaves a silent blank panel.
 *
 * The WebView is the mock from `jest.setup.js`, which spreads its props onto a
 * plain `View`, so `onMessage` can be driven directly.
 */
import React from 'react';
import { act } from 'react-test-renderer';
import type ReactTestRenderer from 'react-test-renderer';

import { HandModel3D } from '../src/components/HandModel3D';
import { DEFAULT_SMOOTHING, emptyPose } from '../src/hands/pose';
import type { ViewerFrame } from '../src/hands/viewer';
import type { GloveSide } from '../src/ble/types';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { createInMemoryStorage } from '../src/storage';
import { renderThemed, renderedText, teardown } from './support';

const frame: ViewerFrame = {
  pose: emptyPose('left'),
  neutral: null,
  smoothing: DEFAULT_SMOOTHING,
};

const frames: Record<GloveSide, ViewerFrame> = {
  left: { pose: emptyPose('left'), neutral: null, smoothing: DEFAULT_SMOOTHING },
  right: { pose: emptyPose('right'), neutral: null, smoothing: DEFAULT_SMOOTHING },
};

/** The WebView, found by the `source` prop only it carries. */
function findHost(
  renderer: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  return renderer.root.findAll(
    (node) => Boolean(node.props?.source?.uri),
  )[0];
}

/**
 * Whether the loading/error overlay is on screen.
 *
 * `findAll` matches both a composite and its rendered host node, so the count
 * is not meaningful — presence is.
 */
function hasStatusOverlay(renderer: ReactTestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findAllByProps({ testID: 'view-3d-status' }).length > 0;
}

function emit(
  renderer: ReactTestRenderer.ReactTestRenderer,
  payload: Record<string, unknown>,
): void {
  const host = findHost(renderer);
  act(() => {
    host.props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
  });
}

describe('HandModel3D viewer bridge', () => {
  it('loads the offline asset for its own side, with no query by default', async () => {
    const renderer = await renderThemed(
      <HandModel3D side="left" frame={frame} width={158} height={213} testID="view-3d" />,
    );

    const uri = findHost(renderer).props.source.uri as string;
    expect(uri).toBe('file:///android_asset/hands/viewer_left.html');

    await teardown(renderer);
  });

  it('defaults to a transparent viewport, and can fall back to the card colour', async () => {
    // The colour must match the card surface, never a hard-coded black.
    const transparent = await renderThemed(
      <HandModel3D side="left" frame={frame} width={158} height={213} />,
    );
    expect(findHost(transparent).props.source.uri).not.toContain('bg=card');
    await teardown(transparent);

    const fallback = await renderThemed(
      <HandModel3D side="left" frame={frame} width={158} height={213} opaqueBackground />,
    );
    const uri = findHost(fallback).props.source.uri as string;
    expect(uri).toContain('bg=card');
    // `%23` is the encoded '#', so the value is a colour the page can apply.
    expect(uri).toMatch(/c=%23[0-9A-Fa-f]{6}/);
    await teardown(fallback);
  });

  it('shows a loading state until the viewer reports itself ready', async () => {
    const renderer = await renderThemed(
      <HandModel3D side="left" frame={frame} width={158} height={213} testID="view-3d" />,
    );

    expect(renderedText(renderer)).toContain('Loading 3D hand');
    expect(hasStatusOverlay(renderer)).toBe(true);

    emit(renderer, { type: 'loaded', side: 'left' });

    // Ready: the overlay is gone entirely, so it cannot tint the hand.
    expect(hasStatusOverlay(renderer)).toBe(false);
    expect(renderedText(renderer)).not.toContain('Loading 3D hand');

    await teardown(renderer);
  });

  it('renders a diagnostic when the viewer reports an error, not a blank panel', async () => {
    const renderer = await renderThemed(
      <HandModel3D side="right" frame={frame} width={158} height={213} testID="view-3d" />,
    );

    emit(renderer, { type: 'error', side: 'right', error: 'GLB load failed: not found' });

    const text = renderedText(renderer);
    expect(text).toContain('3D hand unavailable');
    expect(text).toContain('GLB load failed: not found');
    // A failed viewer must still say something; an empty overlay is the bug.
    expect(text).not.toContain('Loading 3D hand');

    await teardown(renderer);
  });

  it('reports the failure if the host WebView cannot load the asset at all', async () => {
    const renderer = await renderThemed(
      <HandModel3D side="left" frame={frame} width={158} height={213} testID="view-3d" />,
    );

    act(() => {
      findHost(renderer).props.onError({
        nativeEvent: { description: 'net::ERR_FILE_NOT_FOUND' },
      });
    });

    const text = renderedText(renderer);
    expect(text).toContain('3D hand unavailable');
    expect(text).toContain('net::ERR_FILE_NOT_FOUND');

    await teardown(renderer);
  });

  it('gives up on a viewer that never reports ready, instead of waiting forever', async () => {
    jest.useFakeTimers();
    try {
      const renderer = await renderThemed(
        <HandModel3D side="left" frame={frame} width={158} height={213} testID="view-3d" />,
      );

      expect(renderedText(renderer)).toContain('Loading 3D hand');

      // Nothing ever arrives from the page.
      act(() => {
        jest.advanceTimersByTime(13000);
      });

      const text = renderedText(renderer);
      expect(text).toContain('3D hand unavailable');
      expect(text).toContain('did not start within');

      await teardown(renderer);
    } finally {
      jest.useRealTimers();
    }
  });

  it('forgets readiness when the side changes, so a new document must re-report', async () => {
    // Switching focus re-navigates the same WebView. Without this reset the
    // component would inject poses into a document that is still loading.
    const storage = createInMemoryStorage();
    const wrap = (side: GloveSide): React.JSX.Element => (
      <ThemeProvider storage={storage} initialMode="dark">
        <HandModel3D
          side={side}
          frame={side === 'left' ? frame : frames.right}
          width={158}
          height={213}
          testID="view-3d"
        />
      </ThemeProvider>
    );

    const renderer = await renderThemed(wrap('left'));
    emit(renderer, { type: 'loaded', side: 'left' });
    expect(hasStatusOverlay(renderer)).toBe(false);

    await act(async () => {
      renderer.update(wrap('right'));
    });

    expect(findHost(renderer).props.source.uri).toContain('viewer_right.html');
    expect(hasStatusOverlay(renderer)).toBe(true);

    await teardown(renderer);
  });
});
