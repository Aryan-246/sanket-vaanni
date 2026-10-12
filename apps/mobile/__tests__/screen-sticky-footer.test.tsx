/**
 * The pinned footer, and the space it owes the scroll.
 *
 * A footer pinned above the bottom inset floats *over* the scrolling content,
 * which is what makes it reachable from anywhere on a long screen. The cost is
 * that it also covers whatever is underneath it, and a ScrollView will not
 * scroll past its own content — so a screen that ends flush against its last
 * row would have that row permanently hidden behind the bar.
 *
 * The fix is to grow the content's bottom padding by the bar's height, and to
 * measure that height rather than assume one, because it depends on the button
 * labels and the user's font scale.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { AppText } from '../src/components/AppText';
import { Screen } from '../src/components/Screen';
import { createInMemoryStorage } from '../src/storage';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 851 },
  insets: { top: 40, bottom: 24, left: 0, right: 0 },
};

async function renderScreen(stickyFooter?: React.ReactNode) {
  const { SafeAreaProvider } = jest.requireMock('react-native-safe-area-context');
  let renderer!: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <ThemeProvider storage={createInMemoryStorage()} initialMode="dark">
        <SafeAreaProvider initialMetrics={METRICS}>
          <Screen stickyFooter={stickyFooter} testID="screen-under-test">
            <AppText>SCROLLED CONTENT</AppText>
          </Screen>
        </SafeAreaProvider>
      </ThemeProvider>,
    );
  });

  return renderer;
}

/** Flattens a `style` prop that may be an array or nested arrays. */
function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  if (typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

/** The content padding the ScrollView was given. */
function contentPadding(renderer: ReactTestRenderer.ReactTestRenderer): {
  paddingBottom: number;
} {
  const scroll = renderer.root.findAllByType(ScrollView)[0];
  if (scroll === undefined) throw new Error('No ScrollView in the tree.');
  return flattenStyle(scroll.props.contentContainerStyle) as { paddingBottom: number };
}

/** Reports the pinned bar's height, as the platform would. */
function reportFooterHeight(renderer: ReactTestRenderer.ReactTestRenderer, height: number): void {
  const footer = renderer.root.findAllByProps({ testID: 'screen-sticky-footer' })[0];
  if (footer === undefined) throw new Error('No pinned footer in the tree.');
  ReactTestRenderer.act(() => {
    footer.props.onLayout({ nativeEvent: { layout: { height } } });
  });
}

async function teardown(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    renderer.unmount();
  });
}

describe('a screen with a pinned footer', () => {
  it('pins the footer outside the scroll, so it survives any scroll position', async () => {
    const renderer = await renderScreen(
      <View>
        <AppText>PINNED ACTION</AppText>
      </View>,
    );

    const scroll = renderer.root.findAllByType(ScrollView)[0];
    expect(scroll.findAllByProps({ testID: 'screen-sticky-footer' }).length).toBe(0);
    expect(renderer.root.findAllByProps({ testID: 'screen-sticky-footer' }).length).toBeGreaterThan(
      0,
    );

    await teardown(renderer);
  });

  it('adds the footer height to the content padding, so the last row clears it', async () => {
    const renderer = await renderScreen(
      <View>
        <AppText>PINNED ACTION</AppText>
      </View>,
    );

    const before = contentPadding(renderer).paddingBottom;
    reportFooterHeight(renderer, 118);
    const after = contentPadding(renderer).paddingBottom;

    // Exactly the measured height: less would leave the last row clipped.
    expect(after - before).toBe(118);

    await teardown(renderer);
  });

  it('reserves nothing when there is no footer', async () => {
    const renderer = await renderScreen();
    const padding = contentPadding(renderer).paddingBottom;

    // The bottom inset plus the screen's own tail spacing, and no more — a
    // screen without a pinned bar must not carry its cost.
    expect(padding).toBe(METRICS.insets.bottom + 32);

    await teardown(renderer);
  });
});
