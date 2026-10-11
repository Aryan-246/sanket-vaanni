/**
 * The screen shell has to keep content off the status bar.
 *
 * Android draws this app edge to edge, so the window runs behind the system bar.
 * `Screen` puts the top inset on its scroll *content*, which is right at rest —
 * but padding does nothing for content that is scrolled: it slides up under the
 * bar, and the status bar's clock and icons are drawn on top of it. On the
 * target device two chips were measured at y 11–50 inside a band of 0–88.
 *
 * The fix is a strip drawn over the scrolling content. The assertions below are
 * about that strip: that it appears, that it is the height of the inset, and —
 * the one that matters most — that it does not intercept touches. A scrim that
 * swallowed them would disable the top row of every screen in the app, which
 * would be a far worse defect than the one it fixes.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { AppText } from '../src/components/AppText';
import { Screen, STATUS_BAR_SCRIM_TEST_ID } from '../src/components/Screen';
import { createInMemoryStorage } from '../src/storage';
import { spacing } from '../src/theme';
import { ThemeProvider } from '../src/theme/ThemeProvider';

/* --------------------------------------------------------------- fixtures */

/** The target phone's status bar, from the device: 88 px at 440 dpi. */
const STATUS_BAR = 88;
const HOME_INDICATOR = 24;

const METRICS = (top: number, bottom: number) => ({
  frame: { x: 0, y: 0, width: 393, height: 851 },
  insets: { top, bottom, left: 0, right: 0 },
});

/**
 * Renders a `Screen` with real insets.
 *
 * The safe-area mock honours `initialMetrics`, so the provider is driven rather
 * than the hook being stubbed — the component under test reads the same context
 * it reads on a device.
 */
async function renderScreen(
  node: React.ReactNode,
  insets: { top: number; bottom: number },
): Promise<ReactTestRenderer.ReactTestRenderer> {
  const { SafeAreaProvider } = jest.requireMock('react-native-safe-area-context');
  let renderer!: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <ThemeProvider storage={createInMemoryStorage()} initialMode="dark">
        <SafeAreaProvider initialMetrics={METRICS(insets.top, insets.bottom)}>
          {node}
        </SafeAreaProvider>
      </ThemeProvider>,
    );
  });

  return renderer;
}

function scrimOf(
  renderer: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance | undefined {
  return renderer.root
    .findAllByProps({ testID: STATUS_BAR_SCRIM_TEST_ID })
    .find((node) => node.props.pointerEvents !== undefined);
}

/* ------------------------------------------------------------------ cases */

describe('keeping scrolled content off the status bar', () => {
  it('draws a strip the height of the top inset', async () => {
    const renderer = await renderScreen(
      <Screen testID="probe">
        <AppText>Row</AppText>
      </Screen>,
      { top: STATUS_BAR, bottom: HOME_INDICATOR },
    );

    const scrim = scrimOf(renderer);
    expect(scrim).toBeDefined();
    expect(StyleSheet.flatten(scrim?.props.style).height).toBe(STATUS_BAR);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('lets touches through it', async () => {
    // The property that makes the strip safe. Without `pointerEvents="none"` it
    // would cover the top 88 px of the window and swallow every tap there.
    const renderer = await renderScreen(
      <Screen testID="probe">
        <AppText>Row</AppText>
      </Screen>,
      { top: STATUS_BAR, bottom: HOME_INDICATOR },
    );

    expect(scrimOf(renderer)?.props.pointerEvents).toBe('none');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('still puts the first row below the bar when nothing has scrolled', async () => {
    // The strip must not be doing the inset's job: at rest the content padding
    // is what keeps the first row clear, and the strip sits above it.
    const renderer = await renderScreen(
      <Screen testID="probe">
        <AppText>Row</AppText>
      </Screen>,
      { top: STATUS_BAR, bottom: HOME_INDICATOR },
    );

    const scroll = renderer.root
      .findAllByProps({ testID: 'probe' })
      .find((node) => node.props.contentContainerStyle !== undefined);
    const content = StyleSheet.flatten(scroll?.props.contentContainerStyle);

    expect(content?.paddingTop).toBe(STATUS_BAR + spacing.md);
    expect(content?.paddingBottom).toBe(HOME_INDICATOR + spacing.xxl);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('adds no strip where there is no inset to cover', async () => {
    const renderer = await renderScreen(
      <Screen testID="probe">
        <AppText>Row</AppText>
      </Screen>,
      { top: 0, bottom: 0 },
    );

    expect(scrimOf(renderer)).toBeUndefined();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('adds no strip to a screen that cannot scroll', async () => {
    // Nothing can move underneath the bar, so a strip would be decoration.
    const renderer = await renderScreen(
      <Screen testID="probe" scroll={false}>
        <AppText>Row</AppText>
      </Screen>,
      { top: STATUS_BAR, bottom: HOME_INDICATOR },
    );

    expect(scrimOf(renderer)).toBeUndefined();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });
});
