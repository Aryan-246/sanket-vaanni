/**
 * Theme selection and persistence.
 *
 * The brief's requirement is that the whole app updates consistently and that
 * the preference survives a restart. Both are asserted against the real tree:
 * the theme is chosen on the More screen exactly as a user would, and the effect
 * is read from the root's own status bar, which is the element a single themed
 * component cannot fake.
 */
import { StatusBar } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import {
  flush,
  pressByLabel,
  renderApp,
  teardown,
  textOf,
} from './support';
import { createInMemoryStorage } from '../src/storage';

/** The bar style the root currently reports, or null if none is mounted. */
function statusBarStyle(
  renderer: ReactTestRenderer.ReactTestRenderer,
): string | null {
  const bars = renderer.root.findAllByType(StatusBar);
  const bar = bars[bars.length - 1];
  return bar === undefined ? null : (bar.props.barStyle as string);
}

/** Opens More, where the appearance control lives. */
async function openMore(
  renderer: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await pressByLabel(renderer, 'More');
}

describe('theme', () => {
  it('starts dark, so the first frame and the default palette agree', async () => {
    const { renderer } = await renderApp({ skipIntro: true });

    expect(statusBarStyle(renderer)).toBe('light-content');

    await teardown(renderer);
  });

  it('applies a chosen theme to the whole app, not just the control', async () => {
    const { renderer } = await renderApp({ skipIntro: true });

    await openMore(renderer);
    await pressByLabel(renderer, 'Light');
    await flush();

    expect(statusBarStyle(renderer)).toBe('dark-content');

    // …and back, so the change is a real toggle rather than a one-way switch.
    await pressByLabel(renderer, 'Dark');
    await flush();

    expect(statusBarStyle(renderer)).toBe('light-content');

    await teardown(renderer);
  });

  it('stores the choice so it survives a restart', async () => {
    const storage = createInMemoryStorage();
    const first = await renderApp({ skipIntro: true, storage });

    await openMore(first.renderer);
    await pressByLabel(first.renderer, 'Light');
    await flush();

    expect(await storage.getThemeMode()).toBe('light');
    await teardown(first.renderer);

    // A restart is a new tree over the same storage — the app's own path, not a
    // value handed in through a prop.
    const second = await renderApp({ skipIntro: true, storage });
    await flush();

    expect(statusBarStyle(second.renderer)).toBe('dark-content');

    await teardown(second.renderer);
  });

  it('defaults to dark when storage holds nothing usable', async () => {
    const storage = createInMemoryStorage();
    await storage.setThemeMode('chartreuse' as never);

    const { renderer } = await renderApp({ skipIntro: true, storage });
    await flush();

    expect(statusBarStyle(renderer)).toBe('light-content');

    await teardown(renderer);
  });

  it('keeps showing System as the selection while naming the resolved scheme', async () => {
    // Selecting System must not appear to do nothing: the control still shows
    // the user's choice, and the caption reports what that resolved to.
    const { renderer } = await renderApp({ skipIntro: true });

    await openMore(renderer);
    await pressByLabel(renderer, 'System');
    await flush();

    const output = textOf(renderer);
    expect(output).toContain('Following your phone');
    expect(output).toContain('System');

    await teardown(renderer);
  });

  it('reports the preference rather than following the phone once a theme is pinned', async () => {
    const { renderer } = await renderApp({ skipIntro: true });

    await openMore(renderer);
    await pressByLabel(renderer, 'Light');
    await flush();

    expect(textOf(renderer)).toContain('regardless of your phone');

    await teardown(renderer);
  });
});
