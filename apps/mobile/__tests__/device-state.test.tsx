/**
 * Device state: what the connection UI is allowed to say.
 *
 * The brief's hardest rule here is "a tap on Connect must never fabricate a
 * successful connection". That is testable in two places, and this file does
 * both:
 *
 *  - the card renders only what its snapshot says, so a tap that the transport
 *    has not confirmed cannot change what the card claims;
 *  - the controller only reaches `connected` when the transport reported it, and
 *    a transport that rejects produces an error, never a connection.
 *
 * The last block runs the real app end to end — a scan and a connect driven
 * through the buttons a user would press — and checks that the resulting demo
 * data is labelled as demo everywhere it surfaces.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { GloveCard, type GloveCardActions } from '../src/components/GloveCard';
import { GloveController } from '../src/ble/controller';
import { INITIAL_LINK, type LinkState } from '../src/ble/link';
import { MockTransport } from '../src/ble/mockTransport';
import type { DiscoveredGlove, GloveTransport, TransportStatus } from '../src/ble/types';
import { MOCK_DEVICE_NAME } from '../src/ble/types';
import type { GloveSnapshot } from '../src/ble/controller';
import {
  pressByLabel,
  renderedText,
  renderApp,
  renderThemed,
  teardown,
} from './support';

/* ------------------------------------------------------------------ fixtures */

function snapshot(link: LinkState, overrides: Partial<GloveSnapshot> = {}): GloveSnapshot {
  return {
    side: 'right',
    link,
    source: 'none',
    raw: null,
    calibrated: null,
    lastPacketAtMs: null,
    packetCount: 0,
    transportName: 'Bluetooth LE (not implemented)',
    synthetic: false,
    available: false,
    ...overrides,
  };
}

function noopActions(): GloveCardActions {
  return {
    scan: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    retry: jest.fn(),
  };
}

async function renderCard(
  link: LinkState,
  actions: GloveCardActions = noopActions(),
  overrides: Partial<GloveSnapshot> = {},
): Promise<{
  renderer: ReactTestRenderer.ReactTestRenderer;
  actions: GloveCardActions;
}> {
  const renderer = await renderThemed(
    <GloveCard side="right" snapshot={snapshot(link, overrides)} actions={actions} />,
  );
  return { renderer, actions };
}

/** Everything the card shows, as a reader would see it. */
const shown = renderedText;

/* -------------------------------------------------------- one state at a time */

describe('connection card', () => {
  it('offers a scan when nothing has been tried, without implying a glove', async () => {
    const { renderer, actions } = await renderCard(INITIAL_LINK);
    const output = shown(renderer);

    expect(output).toContain('No glove connected');
    // The visible label names the action, not the hand. The hand belongs in the
    // accessible name, where it disambiguates the two cards for a screen reader.
    expect(output).toContain('Find gloves');
    expect(output).not.toContain('Connected');
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Find right gloves' }).length,
    ).toBeGreaterThan(0);

    await pressByLabel(renderer, 'Find right gloves');
    expect(actions.scan).toHaveBeenCalledTimes(1);

    await teardown(renderer);
  });

  it('says an unverified transport is unavailable, and does not call the control a retry', async () => {
    // The real BLE transport cannot operate because the protocol is unverified.
    // Offering "Retry" there would suggest one more tap might work.
    const { renderer } = await renderCard({
      ...INITIAL_LINK,
      kind: 'unavailable',
      reason: 'The BLE protocol has not been verified.',
    });
    const output = shown(renderer);

    expect(output).toContain('The BLE protocol has not been verified.');
    expect(output).toContain('Re-check availability');
    expect(output).not.toContain('Retry');
    expect(output).not.toContain('Try again');

    await teardown(renderer);
  });

  it('shows a scan in progress rather than an empty list', async () => {
    const { renderer } = await renderCard({ ...INITIAL_LINK, kind: 'scanning' });
    const output = shown(renderer);

    expect(output).toContain('Scanning for nearby gloves');
    expect(output).toContain('Cancel');

    await teardown(renderer);
  });

  it('lists what a scan found, and says when signal strength was not reported', async () => {
    const { renderer, actions } = await renderCard({
      ...INITIAL_LINK,
      kind: 'nearby',
      discovered: [{ id: 'demo-right', name: MOCK_DEVICE_NAME, side: 'right', rssi: null }],
      lastScanAtMs: 1_000,
    });
    const output = shown(renderer);

    // The sentinel is never shown to a person; it is translated at one place.
    expect(output).not.toContain(MOCK_DEVICE_NAME);
    expect(output).toContain('Demo glove (simulated)');
    expect(output).toContain('Signal strength not reported');

    await pressByLabel(renderer, 'Connect to Demo glove (simulated)');
    expect(actions.connect).toHaveBeenCalledWith('demo-right');

    await teardown(renderer);
  });

  it('reports a real signal strength when the scan did report one', async () => {
    const { renderer } = await renderCard({
      ...INITIAL_LINK,
      kind: 'nearby',
      discovered: [{ id: 'demo-right', name: MOCK_DEVICE_NAME, side: 'right', rssi: -42 }],
      lastScanAtMs: 1_000,
    });

    expect(shown(renderer)).toContain('Signal -42 dBm');

    await teardown(renderer);
  });

  it('cannot be made to claim a connection by pressing Connect', async () => {
    // The honesty guarantee, isolated. The snapshot is still `nearby` — no
    // transport has confirmed anything — and the card therefore still shows the
    // device list. There is no optimistic branch that could show otherwise.
    const { renderer, actions } = await renderCard({
      ...INITIAL_LINK,
      kind: 'nearby',
      discovered: [{ id: 'demo-right', name: MOCK_DEVICE_NAME, side: 'right', rssi: -42 }],
      lastScanAtMs: 1_000,
    });

    await pressByLabel(renderer, 'Connect to Demo glove (simulated)');

    expect(actions.connect).toHaveBeenCalledTimes(1);
    expect(shown(renderer)).not.toContain('Data frames');
    expect(shown(renderer)).not.toContain('Last frame');
    expect(shown(renderer)).toContain('Demo glove (simulated)');

    await teardown(renderer);
  });

  it('shows the connecting state with the device it is connecting to', async () => {
    const { renderer } = await renderCard({
      ...INITIAL_LINK,
      kind: 'connecting',
      deviceName: MOCK_DEVICE_NAME,
    });
    const output = shown(renderer);

    expect(output).toContain('Connecting to Demo glove (simulated)');
    expect(output).not.toContain('Data frames');

    await teardown(renderer);
  });

  it('does not dress a silent link up as a working one', async () => {
    // "Connected" alone would hide the most common failure: a paired glove whose
    // firmware is not streaming.
    const { renderer } = await renderCard(
      { ...INITIAL_LINK, kind: 'connected', deviceId: 'demo-right', deviceName: MOCK_DEVICE_NAME },
      noopActions(),
      { source: 'simulated', synthetic: true, available: true, lastPacketAtMs: null },
    );
    const output = shown(renderer);

    expect(output).toContain('The link is up but no sensor frames are arriving');
    expect(output).toContain('Demo Mode');

    await teardown(renderer);
  });

  it('reports frame freshness once frames have arrived', async () => {
    const { renderer } = await renderCard(
      { ...INITIAL_LINK, kind: 'connected', deviceId: 'demo-right', deviceName: MOCK_DEVICE_NAME },
      noopActions(),
      { source: 'simulated', synthetic: true, available: true, lastPacketAtMs: 0, packetCount: 12 },
    );
    const output = shown(renderer);

    expect(output).toContain('Data frames');
    expect(output).toContain('Last frame');
    expect(output).not.toContain('No sensor frames are arriving');

    await teardown(renderer);
  });

  it('labels a simulated link as a demo and not as hardware', async () => {
    const { renderer } = await renderCard(
      { ...INITIAL_LINK, kind: 'connected', deviceId: 'demo-right', deviceName: MOCK_DEVICE_NAME },
      noopActions(),
      {
        source: 'simulated',
        synthetic: true,
        available: true,
        lastPacketAtMs: 0,
        packetCount: 1,
        transportName: 'Demo simulator',
      },
    );
    const output = shown(renderer);

    expect(output).toContain('Demo Mode');
    expect(output).toContain('Demo simulator');

    await teardown(renderer);
  });

  it('offers to find gloves again after a disconnect, naming the reason', async () => {
    const { renderer, actions } = await renderCard({
      ...INITIAL_LINK,
      kind: 'disconnected',
      reason: 'Disconnected by user',
    });
    const output = shown(renderer);

    expect(output).toContain('Disconnected by user');
    expect(output).toContain('Find gloves');

    await pressByLabel(renderer, 'Find right gloves again');
    expect(actions.retry).toHaveBeenCalledTimes(1);

    await teardown(renderer);
  });

  it('reports a failure as a failure', async () => {
    const { renderer } = await renderCard({
      ...INITIAL_LINK,
      kind: 'error',
      reason: 'The glove refused the connection.',
    });
    const output = shown(renderer);

    expect(output).toContain('The glove refused the connection.');
    expect(output).toContain('Try again');
    expect(output).not.toContain('Demo Mode');

    await teardown(renderer);
  });
});

/* ------------------------------------------------- the controller's own rule */

describe('the controller cannot invent a connection', () => {
  /** A transport that answers a scan and then refuses to connect. */
  function refusingTransport(): GloveTransport {
    const listeners = new Set<(status: TransportStatus) => void>();
    let status: TransportStatus = { kind: 'idle' };
    const set = (next: TransportStatus): void => {
      status = next;
      for (const listener of listeners) listener(next);
    };

    return {
      name: 'A transport that refuses',
      isSynthetic: false,
      getStatus: () => status,
      onStatusChange(listener) {
        listeners.add(listener);
        listener(status);
        return () => listeners.delete(listener);
      },
      async scan(): Promise<DiscoveredGlove[]> {
        set({ kind: 'scanning' });
        const found: DiscoveredGlove[] = [
          { id: 'x', name: 'Refusing glove', side: 'right', rssi: null },
        ];
        set({ kind: 'idle' });
        return found;
      },
      async connect() {
        set({ kind: 'connecting', side: 'right' });
        set({ kind: 'error', message: 'Refused' });
        throw new Error('Refused');
      },
      async disconnect() {
        set({ kind: 'disconnected', side: 'right', reason: 'test' });
      },
      subscribe: () => () => undefined,
    };
  }

  it('reaches error, not connected, when the transport refuses', async () => {
    const controller = new GloveController('right', refusingTransport());

    await controller.scan();
    expect(controller.getSnapshot().link.kind).toBe('nearby');

    await controller.connect('x');

    const link = controller.getSnapshot().link;
    expect(link.kind).toBe('error');
    expect(link.reason).toBe('Refused');
    expect(link.deviceName).toBeNull();

    controller.dispose();
  });

  it('does not reach connected on the strength of the request alone', async () => {
    // The mock takes 300 ms to connect. Before that elapses, the controller must
    // be reporting `connecting` — not `connected`.
    jest.useFakeTimers();
    const transport = new MockTransport('right');
    const controller = new GloveController('right', transport);

    await jest.advanceTimersByTimeAsync(0);
    const pending = controller.scan();
    await jest.advanceTimersByTimeAsync(600);
    await pending;

    const found = controller.getSnapshot().link.discovered;
    expect(found).toHaveLength(1);

    const connecting = controller.connect(found[0]!.id);
    await jest.advanceTimersByTimeAsync(100);

    expect(controller.getSnapshot().link.kind).toBe('connecting');
    expect(transport.getStatus().kind).toBe('connecting');

    await jest.advanceTimersByTimeAsync(300);
    await connecting;

    const link = controller.getSnapshot().link;
    expect(link.kind).toBe('connected');
    expect(link.deviceName).toBe(MOCK_DEVICE_NAME);

    controller.dispose();
    jest.useRealTimers();
  });
});

/* -------------------------------------------------------------- end to end */

describe('demo data is labelled everywhere it surfaces', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function advanceBy(ms: number): Promise<void> {
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  it('marks a connected simulator as Demo Mode, and never as hardware', async () => {
    const { renderer, right } = await renderApp({ skipIntro: true });

    // Nothing is connected yet, and the screen says so.
    expect(renderedText(renderer)).toContain('No glove connected');

    await pressByLabel(renderer, 'Find right gloves');
    await advanceBy(700);

    expect(renderedText(renderer)).toContain('Demo glove (simulated)');

    await pressByLabel(renderer, 'Connect to Demo glove (simulated)');

    // Mid-flight the UI reports connecting — it does not jump to connected.
    expect(renderedText(renderer)).toContain('Connecting to Demo glove (simulated)');

    await advanceBy(400);
    await advanceBy(300);

    const output = renderedText(renderer);

    expect(right.getStatus().kind).toBe('connected');
    expect(output).toContain('Demo Mode');
    expect(output).toContain('Simulated');
    // The sentinel is an implementation detail and must never be on screen.
    expect(output).not.toContain(MOCK_DEVICE_NAME);
    // And nothing anywhere claims the data came from hardware.
    expect(output).not.toContain('Hardware');

    await teardown(renderer);
  });
});
