/**
 * The hand viewer has to fit inside its card.
 *
 * This file exists because of a defect that reached the phone. `HandFigure` gave
 * its caption `maxWidth: 280`, while `HandViewer` allotted each hand a column of
 * about 158 dp on the target device. The caption — not the hand — therefore
 * decided how wide a hand was: the two columns needed roughly 1570 px inside a
 * 904 px card, the centered row overflowed both edges, and Android clipped them.
 * The left label rendered as "eft" and the right figure ran off the screen.
 *
 * No test could see it, because none of them looked at geometry. Neither do
 * these — React Native does not lay out under Jest, so measuring pixels here is
 * not possible and pretending to would be worse than not trying. What these
 * assertions pin is the *contract* that made the overflow possible, in two
 * halves:
 *
 *  1. the arithmetic that divides the card between two hands, checked as
 *     arithmetic; and
 *  2. the rule that nothing rendered inside a hand may claim more room than the
 *     hand was given — which is the rule the caption broke.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { HandViewer, handColumnWidth } from '../src/components/HandViewer';
import { DEFAULT_SMOOTHING, emptyPose } from '../src/hands/pose';
import type { ViewerFrame } from '../src/hands/viewer';
import type { GloveSide } from '../src/ble/types';
import { layout, spacing } from '../src/theme';
import { renderThemed, teardown } from './support';

/* --------------------------------------------------------------- fixtures */

/** The target phone: 1080 px at 440 dpi, so 393 dp wide. */
const DEVICE = { width: 393, height: 851, scale: 2.75, fontScale: 1 };

/**
 * Restores the window after a case.
 *
 * Each test file gets its own module registry, so this cannot leak into another
 * suite — but a case that changes the window and does not put it back would
 * still affect the case after it in this file, which is worth one line to avoid.
 */
const ORIGINAL_WINDOW = Dimensions.get('window');

function setWindowWidth(width: number): void {
  const metrics = { ...DEVICE, width };
  Dimensions.set({ window: metrics, screen: metrics });
}

/**
 * The room the two columns and the gap between them must share between them:
 * inside the page padding and inside the card padding. The gap is *not*
 * deducted here — it is part of what has to fit, so the case below adds it back
 * when it checks the total.
 */
function usableWidth(windowWidth: number): number {
  return windowWidth - 2 * layout.screenPadding - 2 * spacing.lg;
}

/** A frame for a hand with no glove attached — the state the phone was in. */
function restingFrame(side: GloveSide): ViewerFrame {
  return { pose: emptyPose(side), neutral: null, smoothing: DEFAULT_SMOOTHING };
}

const RESTING_FRAMES: Readonly<Record<GloveSide, ViewerFrame>> = {
  left: restingFrame('left'),
  right: restingFrame('right'),
};

const NOTHING_LIVE: Readonly<Record<GloveSide, boolean>> = { left: false, right: false };

/**
 * Every node under `root` that declares a width wider than it was allotted.
 *
 * `width`, `minWidth` and `maxWidth` are all checked: the original defect was a
 * `maxWidth`, and a `minWidth` would cause the same overflow from the other
 * direction. A half-pixel of tolerance absorbs the rounding in the figure's own
 * `left`/`width` maths, which lands within a fraction of the column by design.
 */
function overwideDeclarations(
  root: ReactTestRenderer.ReactTestInstance,
  allotted: number,
): string[] {
  const found: string[] = [];

  const visit = (node: ReactTestRenderer.ReactTestInstance): void => {
    const flat = StyleSheet.flatten(node.props?.style) as Record<string, unknown> | undefined;
    if (flat !== undefined) {
      for (const key of ['width', 'minWidth', 'maxWidth'] as const) {
        const value = flat[key];
        if (typeof value === 'number' && value > allotted + 0.5) {
          found.push(`${key}: ${value} > ${allotted}`);
        }
      }
    }
    for (const child of node.children) {
      if (typeof child !== 'string') visit(child);
    }
  };

  visit(root);
  return found;
}

/* ------------------------------------------------------------------ cases */

describe('dividing the card between two hands', () => {
  afterEach(() => {
    Dimensions.set({ window: ORIGINAL_WINDOW, screen: ORIGINAL_WINDOW });
  });

  it('fits two hands and their gap at every width a phone could report', () => {
    for (let width = 200; width <= 1200; width += 1) {
      const column = handColumnWidth(width);
      // The failure the phone showed, expressed as arithmetic: the columns plus
      // the gap they sit either side of must not exceed the room they are in.
      expect(2 * column + spacing.md).toBeLessThanOrEqual(usableWidth(width) + 1e-9);
    }
  });

  it('gives each hand half of the room that is left once the gap is taken', () => {
    expect(handColumnWidth(DEVICE.width)).toBeCloseTo(
      (usableWidth(DEVICE.width) - spacing.md) / 2,
      9,
    );
  });

  it('stops growing, so a tablet does not get a pair of enormous hands', () => {
    // Expressed by saturating rather than by naming the cap, so the assertion
    // survives the cap being retuned.
    expect(handColumnWidth(2000)).toBe(handColumnWidth(1400));
    expect(handColumnWidth(1400)).toBeLessThan(usableWidth(1400) / 2);
  });

  it('never returns a negative or zero width, however absurd the window', () => {
    for (const width of [0, 1, 60, 120, 200]) {
      expect(handColumnWidth(width)).toBeGreaterThanOrEqual(0);
    }
  });

  it('grows with the window rather than shrinking with it', () => {
    let previous = 0;
    for (let width = 240; width <= 1200; width += 8) {
      const column = handColumnWidth(width);
      expect(column).toBeGreaterThanOrEqual(previous);
      previous = column;
    }
  });
});

describe('what the rendered viewer does with that width', () => {
  afterEach(() => {
    Dimensions.set({ window: ORIGINAL_WINDOW, screen: ORIGINAL_WINDOW });
  });

  /**
   * Renders the viewer at a chosen window width.
   *
   * `Dimensions.set` is the real API the hook reads, so this drives the actual
   * `useWindowDimensions` rather than replacing it — which matters, because the
   * defect was in the arithmetic fed by that hook.
   */
  async function renderViewer(
    windowWidth: number,
  ): Promise<ReactTestRenderer.ReactTestRenderer> {
    setWindowWidth(windowWidth);
    return renderThemed(
      <HandViewer frames={RESTING_FRAMES} live={NOTHING_LIVE} onExplain={() => undefined} />,
    );
  }

  it('gives each hand column exactly the width the arithmetic asked for', async () => {
    const renderer = await renderViewer(DEVICE.width);
    const expected = handColumnWidth(DEVICE.width);

    for (const side of ['left', 'right'] as const) {
      const column = renderer.root.findAllByProps({ testID: `hand-column-${side}` })[0];
      expect(column).toBeDefined();
      expect(StyleSheet.flatten(column?.props.style).width).toBeCloseTo(expected, 6);
    }

    await teardown(renderer);
  });

  it('renders nothing inside a hand that claims more room than the hand has', async () => {
    // The exact property the caption broke. This is the assertion that fails
    // against `maxWidth: 280` and passes without it.
    for (const windowWidth of [320, DEVICE.width, 412, 768, 1024]) {
      const renderer = await renderViewer(windowWidth);
      const allotted = handColumnWidth(windowWidth);

      for (const side of ['left', 'right'] as const) {
        const column = renderer.root.findAllByProps({ testID: `hand-column-${side}` })[0];
        expect(overwideDeclarations(column as ReactTestRenderer.ReactTestInstance, allotted)).toEqual([]);
      }

      await teardown(renderer);
    }
  });

  it('looks the same in both themes, since only the palette differs', async () => {
    setWindowWidth(DEVICE.width);
    const renderer = await renderThemed(
      <HandViewer frames={RESTING_FRAMES} live={NOTHING_LIVE} onExplain={() => undefined} />,
      'light',
    );

    const allotted = handColumnWidth(DEVICE.width);
    const column = renderer.root.findAllByProps({ testID: 'hand-column-left' })[0];

    expect(overwideDeclarations(column as ReactTestRenderer.ReactTestInstance, allotted)).toEqual([]);

    await teardown(renderer);
  });
});
