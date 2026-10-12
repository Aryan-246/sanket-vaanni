/**
 * Sheet scrolling.
 *
 * The reported defect: a long sheet opened with content running past the bottom
 * of the screen. The title and the X stayed visible, but everything below them
 * was clipped and no amount of dragging revealed it.
 *
 * The cause was structural. The sheet was bounded at 88% of the screen but its
 * body was a plain `View`, so overflowing content was simply cut off — there
 * was no scroll container anywhere in the component. These tests pin the
 * hierarchy that fixes it: header pinned, body scrolled, footer pinned.
 *
 * Insets come from the real safe-area context (the mock honours
 * `initialMetrics`), so the height bound is exercised with a real status bar.
 */
import React from 'react';
import { Dimensions, ScrollView } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { AppText } from '../src/components/AppText';
import { Sheet } from '../src/components/Sheet';
import { createInMemoryStorage } from '../src/storage';
import { ThemeProvider } from '../src/theme/ThemeProvider';

/* --------------------------------------------------------------- fixtures */

/** The target phone, from the device: 1080x2408 at 440 dpi, so ~393x851 dp. */
const SCREEN = { width: 393, height: 851 };
const STATUS_BAR = 40;
const NAV_BAR = 24;

/**
 * The height the sheet actually measures against.
 *
 * `Sheet` reads `useWindowDimensions`, so the bound has to be checked against
 * what the environment reports, not against the phone's real dp — otherwise
 * the assertion would only be testing the test's own constant.
 */
const WINDOW_HEIGHT = Dimensions.get('window').height;

const METRICS = {
  frame: { x: 0, y: 0, ...SCREEN },
  insets: { top: STATUS_BAR, bottom: NAV_BAR, left: 0, right: 0 },
};

async function renderSheet(props: Partial<React.ComponentProps<typeof Sheet>> = {}) {
  const { SafeAreaProvider } = jest.requireMock('react-native-safe-area-context');
  let renderer!: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <ThemeProvider storage={createInMemoryStorage()} initialMode="dark">
        <SafeAreaProvider initialMetrics={METRICS}>
          <Sheet visible onClose={() => {}} title="Sheet title" {...props}>
            {props.children ?? (
              <AppText testID="sheet-body-child">BODY CONTENT</AppText>
            )}
          </Sheet>
        </SafeAreaProvider>
      </ThemeProvider>,
    );
  });

  return renderer;
}

/** The scroll container, or undefined if the body is not scrollable at all. */
function findBodyScroll(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(ScrollView)[0];
}

/** Flattens a `style` prop that may be an array or nested arrays. */
function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  if (typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

function panelStyle(renderer: ReactTestRenderer.ReactTestRenderer): Record<string, unknown> {
  return flattenStyle(renderer.root.findAllByProps({ testID: 'sheet-panel' })[0]?.props.style);
}

/** Every string rendered inside a test instance. */
function textWithin(instance: ReactTestRenderer.ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const child = node as ReactTestRenderer.ReactTestInstance | null;
    if (child && Array.isArray(child.children)) walk(child.children);
  };
  walk(instance.children);
  return parts.join('');
}

/** Drives the layout callbacks RN would fire on a device. */
function reportLayout(
  renderer: ReactTestRenderer.ReactTestRenderer,
  bodyPx: number,
  contentPx: number,
): void {
  const scroll = findBodyScroll(renderer);
  ReactTestRenderer.act(() => {
    scroll.props.onLayout({ nativeEvent: { layout: { height: bodyPx } } });
    scroll.props.onContentSizeChange(SCREEN.width, contentPx);
  });
}

function separatorUnderHeader(renderer: ReactTestRenderer.ReactTestRenderer): number {
  // The separator is the only hairline border in the sheet's own chrome.
  return renderer.root.findAll((node) => 'borderBottomWidth' in flattenStyle(node.props?.style))
    .length;
}

async function teardown(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    renderer.unmount();
  });
}

/* ------------------------------------------------------------------ tests */

describe('Sheet scrolling', () => {
  it('puts the body inside a scroll container so long content is reachable', async () => {
    const renderer = await renderSheet();

    const scroll = findBodyScroll(renderer);
    expect(scroll).toBeDefined();

    // The body content is a descendant of the scroll view — this is the whole
    // fix. Before it, the body was a plain View and this node did not exist.
    expect(scroll.findAllByProps({ testID: 'sheet-body-child' }).length).toBeGreaterThan(0);

    await teardown(renderer);
  });

  it('keeps the title and close control pinned outside the scroll container', async () => {
    const renderer = await renderSheet();

    const scroll = findBodyScroll(renderer);
    const scrolled = textWithin(scroll);
    // Reachable no matter how far down the body is scrolled.
    expect(scrolled).not.toContain('Sheet title');
    expect(scrolled).toContain('BODY CONTENT');

    // ...but still on screen.
    expect(JSON.stringify(renderer.toJSON())).toContain('Sheet title');

    await teardown(renderer);
  });

  it('keeps the pinned footer outside the scroll container so actions stay reachable', async () => {
    const renderer = await renderSheet({
      footer: <AppText testID="sheet-footer-action">Save</AppText>,
    });

    const scroll = findBodyScroll(renderer);
    expect(scroll.findAllByProps({ testID: 'sheet-footer-action' }).length).toBe(0);
    expect(renderer.root.findAllByProps({ testID: 'sheet-footer-action' }).length).toBeGreaterThan(0);

    await teardown(renderer);
  });

  it('bounds the sheet to at most 90% of the screen and clears the status bar', async () => {
    const renderer = await renderSheet();

    const maxHeight = panelStyle(renderer).maxHeight as number;
    expect(typeof maxHeight).toBe('number');
    expect(maxHeight).toBeLessThanOrEqual(WINDOW_HEIGHT * 0.9);
    // Bottom-anchored, so the top is what collides with the status bar first.
    expect(WINDOW_HEIGHT - maxHeight).toBeGreaterThan(STATUS_BAR);

    await teardown(renderer);
  });

  it('lets a vertical drag that starts on a nested chip row still scroll the body', async () => {
    const renderer = await renderSheet();
    const scroll = findBodyScroll(renderer);

    // Without both of these a horizontal chip list inside a sheet steals the
    // gesture on Android, and a tap on a control is swallowed as a dismiss.
    expect(scroll.props.nestedScrollEnabled).toBe(true);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');

    await teardown(renderer);
  });

  it('marks the body as scrollable only when the content actually overflows', async () => {
    const renderer = await renderSheet();

    // Short content: no separators, so a small sheet does not look truncated.
    reportLayout(renderer, 400, 120);
    expect(separatorUnderHeader(renderer)).toBe(0);

    // Tall content: the hairline appears, signalling there is more below.
    reportLayout(renderer, 400, 900);
    expect(separatorUnderHeader(renderer)).toBeGreaterThan(0);

    await teardown(renderer);
  });

  it('routes the Android back button to close when the sheet is dismissible', async () => {
    const onClose = jest.fn();
    const renderer = await renderSheet({ onClose });

    const modal = renderer.root.findAllByProps({ transparent: true })[0];
    ReactTestRenderer.act(() => {
      modal.props.onRequestClose();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await teardown(renderer);
  });

  it('refuses to dismiss a dialog that must be answered', async () => {
    const onClose = jest.fn();
    const renderer = await renderSheet({ onClose, dismissible: false });

    const modal = renderer.root.findAllByProps({ transparent: true })[0];
    ReactTestRenderer.act(() => {
      modal.props.onRequestClose();
    });
    expect(onClose).not.toHaveBeenCalled();

    await teardown(renderer);
  });
});
