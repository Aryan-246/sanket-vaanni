/**
 * Root flow: intro gate → home.
 *
 * These tests exercise real routing and real state, not a mocked navigator.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { AppStateProvider } from '../src/app/AppState';
import { RootNavigator } from '../src/app/RootNavigator';
import { MockTransport } from '../src/ble/mockTransport';
import { createInMemoryStorage } from '../src/storage';
import type { Storage } from '../src/storage';

async function render(storage: Storage): Promise<ReactTestRenderer.ReactTestRenderer> {
  const transport = new MockTransport('right');
  let renderer!: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <AppStateProvider storage={storage} transport={transport}>
        <RootNavigator />
      </AppStateProvider>,
    );
    // Let the async initial-route decision settle.
    await Promise.resolve();
  });

  return renderer;
}

function text(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

/** Unmounts so the intro's timers do not outlive the test. */
async function teardown(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    renderer.unmount();
  });
}

describe('launch flow', () => {
  it('shows the intro on first launch', async () => {
    const renderer = await render(createInMemoryStorage()); // isIntroSeen() === false
    const output = text(renderer);

    // IntroScreen renders the native Video host component.
    expect(output).toContain('"Video"');
    // …and not the home screen.
    expect(output).not.toContain('Glove link');

    await teardown(renderer);
  });

  it('goes straight to the home screen when the intro has been seen', async () => {
    const storage = createInMemoryStorage();
    await storage.setIntroSeen(true);

    const renderer = await render(storage);
    const output = text(renderer);

    expect(output).toContain('संकेत वाणी');
    expect(output).not.toContain('"Video"');

    await teardown(renderer);
  });

  it('launches into the app when storage fails, rather than looping the intro', async () => {
    const brokenStorage: Storage = {
      ...createInMemoryStorage(),
      isIntroSeen: async () => {
        throw new Error('storage unavailable');
      },
    };

    const renderer = await render(brokenStorage);
    const output = text(renderer);

    // Failing closed would replay the intro on every launch; the app must not.
    expect(output).not.toContain('"Video"');
    expect(output).toContain('संकेत वाणी');

    await teardown(renderer);
  });
});

describe('home screen honesty', () => {
  async function renderHome(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const storage = createInMemoryStorage();
    await storage.setIntroSeen(true);
    return render(storage);
  }

  it('labels simulated data as Demo Mode', async () => {
    const renderer = await renderHome();
    expect(text(renderer)).toContain('Demo mode');

    await teardown(renderer);
  });

  it('states that recognition is not implemented instead of showing a sign', async () => {
    const renderer = await renderHome();
    const output = text(renderer);

    expect(output).toContain('Recognised sign');
    expect(output).toContain('Not implemented');
    expect(output).toContain('No recognition model exists yet');

    await teardown(renderer);
  });

  it('says Bluetooth is not in use', async () => {
    const renderer = await renderHome();
    expect(text(renderer)).toContain('no Bluetooth is in use');

    await teardown(renderer);
  });

  it('does not display a fabricated sign or confidence', async () => {
    const renderer = await renderHome();
    const output = text(renderer);

    // The recogniser returns null and reports no confidence, so no percentage
    // or confidence figure should appear anywhere on the screen.
    expect(output).not.toMatch(/\d+%\s*(confidence|match)/i);
    expect(output).not.toContain('confidence');

    await teardown(renderer);
  });
});
