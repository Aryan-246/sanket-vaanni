/**
 * The glove input layer, tested where it is not a screen.
 *
 * ## Why this file exists next to `device-state.test.tsx`
 *
 * `device-state.test.tsx` asks what a *person* sees: it renders the app and
 * presses Connect, and it checks the connection card's wording. That is the
 * right test for the error UI, and it already covers two controller cases.
 *
 * What it cannot see is the contract underneath. Three properties matter more
 * than any label, and none of them is visible through a render:
 *
 *   1. A connection cannot be fabricated. Not by the reducer, and not by the
 *      transport: the only action that produces `connected` is a `connected`
 *      action, and only the transport dispatches it, and the transport only
 *      dispatches it after the platform link is genuinely up.
 *   2. The unverified BLE transport produces nothing. It is the file that will
 *      one day talk to hardware, so the test that matters now is that today it
 *      refuses, in a way no caller can mistake for data.
 *   3. A paused recorder must not hold a frozen stream, and a *recording* must
 *      see every frame even though React does not. The UI is throttled; the
 *      recorder is not. If that ever gets wired the wrong way round, the
 *      windows in `ml/` would be built from a stream missing two frames in
 *      five, and nothing on screen would look wrong.
 *
 * ## No hardware, and no claim to have spoken to any
 *
 * Nothing here connects to a glove. The simulated transport is a simulator and
 * is asserted as such; the real transport is asserted to be inert. There is no
 * fixture that pretends to be a recorded frame from hardware, because no such
 * recording exists.
 */
import {
  BleTransport,
  BLE_UNAVAILABLE_REASON,
} from '../src/ble/bleTransport';
import { GloveController, PACKET_STALE_MS } from '../src/ble/controller';
import {
  INITIAL_LINK,
  deviceDisplayName,
  isLinkBusy,
  isLinkLive,
  isSimulatedLink,
  linkHealth,
  linkLabel,
  linkReducer,
  linkStateFromTransport,
  type LinkAction,
  type LinkState,
} from '../src/ble/link';
import { MockTransport } from '../src/ble/mockTransport';
import {
  MOCK_DEVICE_NAME,
  isConnected,
  isSynthetic,
  type DiscoveredGlove,
  type GloveSide,
  type GloveTransport,
  type SuspendableTransport,
  type TransportStatus,
} from '../src/ble/types';
import type { RawSample } from '../src/sensors/types';

/* ------------------------------------------------------------------ fixtures */

/** A frame that is well formed for its side. Values are arbitrary, not measured. */
function frame(side: GloveSide, timestampMs: number, fill = 0.5): RawSample {
  return {
    side,
    timestampMs,
    flex: [fill, fill, fill, fill, fill],
    accel: { x: 0, y: 0, z: 9.81 },
    gyro: { x: 0, y: 0, z: 0 },
  };
}

/**
 * A transport a test drives by hand.
 *
 * Reports status changes on demand and emits frames on demand, so the
 * controller's own logic is what is being measured — not the simulator's
 * waveform and not a timer.
 */
class ScriptedTransport implements GloveTransport, SuspendableTransport {
  readonly name: string;
  readonly isSynthetic: boolean;

  pauseCalls = 0;
  resumeCalls = 0;
  scanCalls = 0;
  connectCalls: string[] = [];
  disposed = false;

  #status: TransportStatus = { kind: 'idle' };
  #statusListeners = new Set<(status: TransportStatus) => void>();
  #sampleListeners = new Set<(sample: RawSample) => void>();
  #devices: readonly DiscoveredGlove[] = [];
  /** When set, `connect` rejects with this message instead of connecting. */
  refuseWith: string | null = null;

  constructor(options: { name?: string; synthetic?: boolean } = {}) {
    this.name = options.name ?? 'Scripted transport';
    this.isSynthetic = options.synthetic ?? false;
  }

  getStatus(): TransportStatus {
    return this.#status;
  }

  onStatusChange(listener: (status: TransportStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  setStatus(status: TransportStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  /** How many status listeners are attached — used to prove dispose detaches. */
  statusListenerCount(): number {
    return this.#statusListeners.size;
  }

  sampleListenerCount(): number {
    return this.#sampleListeners.size;
  }

  emitting(): boolean {
    return this.#sampleListeners.size > 0;
  }

  async scan(): Promise<DiscoveredGlove[]> {
    this.scanCalls += 1;
    this.setStatus({ kind: 'scanning' });
    this.setStatus({ kind: 'idle' });
    // The contract returns a mutable array; the scripted devices are a shared
    // fixture, so this is a copy rather than the fixture itself.
    return [...this.#devices];
  }

  setDevices(devices: readonly DiscoveredGlove[]): void {
    this.#devices = devices;
  }

  async connect(deviceId: string): Promise<void> {
    this.connectCalls.push(deviceId);
    this.setStatus({ kind: 'connecting', side: 'right' });
    if (this.refuseWith !== null) {
      this.setStatus({ kind: 'error', message: this.refuseWith });
      throw new Error(this.refuseWith);
    }
    this.setStatus({ kind: 'connected', side: 'right', deviceName: 'Scripted glove' });
  }

  async disconnect(): Promise<void> {
    this.setStatus({ kind: 'disconnected', side: 'right', reason: 'Scripted disconnect' });
  }

  subscribe(listener: (sample: RawSample) => void): () => void {
    this.#sampleListeners.add(listener);
    return () => {
      this.#sampleListeners.delete(listener);
    };
  }

  emit(sample: RawSample): void {
    for (const listener of this.#sampleListeners) listener(sample);
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  resume(): void {
    this.resumeCalls += 1;
  }

  dispose(): void {
    this.disposed = true;
    this.#statusListeners.clear();
    this.#sampleListeners.clear();
  }
}

const ONE_DEVICE: readonly DiscoveredGlove[] = [
  { id: 'glove-a', name: 'Some glove', side: 'right', rssi: -55 },
];

/* ------------------------------------------------------- the state machine */

describe('the link state machine', () => {
  /** Every action, so a "nothing reaches connected" claim covers all of them. */
  const NON_CONNECTING_ACTIONS: readonly LinkAction[] = [
    { type: 'scan-start' },
    { type: 'scan-result', devices: [], atMs: 1 },
    { type: 'scan-result', devices: ONE_DEVICE, atMs: 1 },
    { type: 'scan-failed', reason: 'radio off' },
    { type: 'connect-start', device: ONE_DEVICE[0]! },
    { type: 'connect-failed', reason: 'refused' },
    { type: 'disconnected', reason: 'user' },
    { type: 'unavailable', reason: 'no protocol' },
    { type: 'reset' },
  ];

  const STARTING_STATES: readonly LinkState[] = [
    INITIAL_LINK,
    linkReducer(INITIAL_LINK, { type: 'connected', deviceId: 'a', deviceName: 'A' }),
    linkReducer(INITIAL_LINK, { type: 'connect-start', device: ONE_DEVICE[0]! }),
    linkReducer(INITIAL_LINK, { type: 'scan-result', devices: ONE_DEVICE, atMs: 1 }),
    linkReducer(INITIAL_LINK, { type: 'disconnected', reason: 'was connected' }),
    linkReducer(INITIAL_LINK, { type: 'unavailable', reason: 'no protocol' }),
    linkReducer(INITIAL_LINK, { type: 'scan-failed', reason: 'radio off' }),
  ];

  it('reaches connected only through a connected action', () => {
    /*
     * The rule the whole file exists to enforce. A tap on Connect dispatches
     * `connect-start`; if any of these could land on `connected`, a UI could
     * show a live glove with no link behind it.
     */
    expect(STARTING_STATES).toHaveLength(7);
    for (const state of STARTING_STATES) {
      for (const action of NON_CONNECTING_ACTIONS) {
        const next = linkReducer(state, action);
        expect({ from: state.kind, action: action.type, to: next.kind }).not.toMatchObject({
          to: 'connected',
        });
      }
    }
  });

  it('treats an empty scan as idle rather than as a glove nearby', () => {
    // `nearby` with nothing in the list would put an empty "found" panel on
    // screen next to a count of zero.
    expect(linkReducer(INITIAL_LINK, { type: 'scan-result', devices: [], atMs: 5 }).kind).toBe(
      'idle',
    );
    expect(
      linkReducer(INITIAL_LINK, { type: 'scan-result', devices: ONE_DEVICE, atMs: 5 }).kind,
    ).toBe('nearby');
  });

  it('clears the found list when the link goes unavailable', () => {
    // A glove discovered by a radio that can no longer scan is not offerable.
    const found = linkReducer(INITIAL_LINK, { type: 'scan-result', devices: ONE_DEVICE, atMs: 5 });
    const gone = linkReducer(found, { type: 'unavailable', reason: 'no protocol' });
    expect(gone.kind).toBe('unavailable');
    expect(gone.discovered).toHaveLength(0);
  });

  it('records the reason on every state that has one, and never a placeholder', () => {
    expect(linkReducer(INITIAL_LINK, { type: 'scan-failed', reason: 'radio off' }).reason).toBe(
      'radio off',
    );
    expect(linkReducer(INITIAL_LINK, { type: 'unavailable', reason: 'no protocol' }).reason).toBe(
      'no protocol',
    );
    expect(linkReducer(INITIAL_LINK, { type: 'connected', deviceId: 'a', deviceName: 'A' }).reason).toBeNull();
  });

  it('translates a transport status without promoting it', () => {
    // `unavailable` has to survive the translation: it is a permanent condition,
    // not something a retry will clear.
    expect(linkStateFromTransport({ kind: 'unavailable', reason: 'no protocol' })).toMatchObject({
      kind: 'unavailable',
      reason: 'no protocol',
    });
    expect(linkStateFromTransport({ kind: 'error', message: 'boom' })).toMatchObject({
      kind: 'error',
      reason: 'boom',
    });
    // A transport connecting leaves no device id: the status does not carry one,
    // and inventing it would name a device nobody chose.
    expect(linkStateFromTransport({ kind: 'connected', side: 'right', deviceName: 'G' })).toMatchObject({
      kind: 'connected',
      deviceId: null,
      deviceName: 'G',
    });
    expect(linkStateFromTransport({ kind: 'idle' })).toBe(INITIAL_LINK);
  });

  it('calls a link that has not been asked to connect unknown, not broken', () => {
    // Mapping `idle` to `warning` would make an app nobody has asked to connect
    // report a fault on the health chip.
    expect(linkHealth(INITIAL_LINK)).toBe('unknown');
    expect(linkHealth(linkReducer(INITIAL_LINK, { type: 'scan-result', devices: ONE_DEVICE, atMs: 1 }))).toBe(
      'unknown',
    );
    expect(linkHealth(linkReducer(INITIAL_LINK, { type: 'connected', deviceId: 'a', deviceName: 'A' }))).toBe(
      'healthy',
    );
    expect(linkHealth(linkReducer(INITIAL_LINK, { type: 'unavailable', reason: 'x' }))).toBe(
      'unavailable',
    );
  });

  it('separates a link that is working from one that is still being asked', () => {
    const busy = linkReducer(INITIAL_LINK, { type: 'scan-start' });
    expect(isLinkBusy(busy)).toBe(true);
    expect(isLinkLive(busy)).toBe(false);

    const live = linkReducer(INITIAL_LINK, { type: 'connected', deviceId: 'a', deviceName: 'A' });
    expect(isLinkBusy(live)).toBe(false);
    expect(isLinkLive(live)).toBe(true);
  });

  it('marks a link simulated only for the simulator, and never for a name that merely resembles it', () => {
    expect(
      isSimulatedLink(
        linkReducer(INITIAL_LINK, { type: 'connected', deviceId: 'x', deviceName: MOCK_DEVICE_NAME }),
      ),
    ).toBe(true);
    for (const name of ['Demo glove', 'demo', 'Right glove', `${MOCK_DEVICE_NAME}2`]) {
      expect(
        isSimulatedLink(linkReducer(INITIAL_LINK, { type: 'connected', deviceId: 'x', deviceName: name })),
      ).toBe(false);
    }
    // A disconnected simulator is not a live simulated link.
    expect(isSimulatedLink(INITIAL_LINK)).toBe(false);
  });

  it('does not put the simulator sentinel on screen, and passes a real name through unchanged', () => {
    expect(deviceDisplayName(MOCK_DEVICE_NAME)).toBe('Demo glove (simulated)');
    // A glove's advertised name is whatever its firmware chose; rewriting it
    // would hide information during the protocol work.
    expect(deviceDisplayName('SANKET-L')).toBe('SANKET-L');
  });

  it('labels each hand and state in words a person can read', () => {
    const connected = linkReducer(INITIAL_LINK, {
      type: 'connected',
      deviceId: 'a',
      deviceName: MOCK_DEVICE_NAME,
    });
    expect(linkLabel(connected, 'right')).toBe('Right · simulated');
    expect(linkLabel(INITIAL_LINK, 'left')).toBe('Left · not connected');
    expect(linkLabel(linkReducer(INITIAL_LINK, { type: 'unavailable', reason: 'x' }), 'left')).toBe(
      'Left · unavailable',
    );
    // The sentinel must not leak into the chip for a real device either.
    const hardware = linkReducer(INITIAL_LINK, {
      type: 'connected',
      deviceId: 'a',
      deviceName: 'SANKET-L',
    });
    expect(linkLabel(hardware, 'left')).toBe('Left · connected');
  });
});

/* --------------------------------------------------- the unverified transport */

describe('the real BLE transport, until the protocol is verified', () => {
  it('reports unavailable, naming the reason a person can act on', () => {
    const transport = new BleTransport();
    const status = transport.getStatus();
    expect(status.kind).toBe('unavailable');
    if (status.kind !== 'unavailable') throw new Error('unreachable');
    expect(status.reason).toBe(BLE_UNAVAILABLE_REASON);
    expect(status.reason).toContain('not implemented');
    expect(status.reason).toContain('ble-protocol.md');
  });

  it('is not synthetic, because it produces nothing at all', () => {
    // Claiming `true` would put a Demo Mode badge over an empty screen, which is
    // the opposite lie: a simulation label on a transport that emits no frames.
    expect(new BleTransport().isSynthetic).toBe(false);
    expect(isConnected(new BleTransport().getStatus())).toBe(false);
    expect(isSynthetic(new BleTransport().getStatus())).toBe(false);
  });

  it('tells a new subscriber its status straight away', () => {
    const seen: TransportStatus[] = [];
    const off = new BleTransport().onStatusChange((status) => seen.push(status));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('unavailable');
    // Unsubscribing is safe, and nothing else will arrive — there is no radio.
    expect(() => off()).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('refuses to scan or connect, and cannot be left looking connected', async () => {
    const transport = new BleTransport();
    await expect(transport.scan()).rejects.toThrow(/not implemented/);
    await expect(transport.connect('any-id')).rejects.toThrow(/not implemented/);
    // The refusals must not have moved it anywhere near a working link.
    expect(transport.getStatus().kind).toBe('unavailable');
    expect(isLinkLive(linkStateFromTransport(transport.getStatus()))).toBe(false);
  });

  it('delivers no frames and its unsubscribe is safe to call', () => {
    const transport = new BleTransport();
    const seen: RawSample[] = [];
    const off = transport.subscribe((sample) => seen.push(sample));
    expect(seen).toHaveLength(0);
    expect(() => off()).not.toThrow();
  });

  it('stays unavailable after a disconnect, rather than looking merely disconnected', async () => {
    // A user who presses Disconnect on a transport that was never available has
    // not closed a link; the honest state is still "unavailable".
    const transport = new BleTransport();
    await transport.disconnect();
    expect(transport.getStatus().kind).toBe('unavailable');
  });
});

/* --------------------------------------------------------- the simulated one */

describe('the simulated transport', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is labelled synthetic, and finds exactly one device carrying the sentinel', async () => {
    jest.useFakeTimers();
    const transport = new MockTransport('right');
    expect(transport.isSynthetic).toBe(true);

    const pending = transport.scan();
    await jest.advanceTimersByTimeAsync(700);
    const found = await pending;

    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe(MOCK_DEVICE_NAME);
    expect(transport.getStatus().kind).toBe('idle');
    transport.dispose();
  });

  it('refuses an id it did not advertise, without becoming connected', async () => {
    jest.useFakeTimers();
    const transport = new MockTransport('right');

    await expect(transport.connect('some-other-glove')).rejects.toThrow(/can only connect/);
    // The important half: a refused connect leaves no connection behind.
    expect(transport.getStatus().kind).not.toBe('connected');
    transport.dispose();
  });

  it('reaches connected only for its own id, and then produces frames', async () => {
    jest.useFakeTimers();
    const transport = new MockTransport('right');
    const seen: RawSample[] = [];
    transport.subscribe((sample) => seen.push(sample));

    const pending = transport.connect('demo-right');
    await jest.advanceTimersByTimeAsync(400);
    await pending;

    expect(transport.getStatus().kind).toBe('connected');
    expect(seen.length).toBeGreaterThan(0);
    // Every frame must be this glove's own side, or a two-hand app would show
    // the wrong hand's motion.
    expect(seen.every((sample) => sample.side === 'right')).toBe(true);
    transport.dispose();
  });

  it('stops frames while paused, and keeps the link up', async () => {
    jest.useFakeTimers();
    const transport = new MockTransport('right');
    const seen: RawSample[] = [];
    transport.subscribe((sample) => seen.push(sample));

    const pending = transport.connect('demo-right');
    await jest.advanceTimersByTimeAsync(400);
    await pending;

    transport.pause();
    const atPause = seen.length;
    await jest.advanceTimersByTimeAsync(2000);
    // No frames, but the connection was not dropped on the user's behalf.
    expect(seen.length).toBe(atPause);
    expect(transport.getStatus().kind).toBe('connected');

    transport.resume();
    await jest.advanceTimersByTimeAsync(200);
    expect(seen.length).toBeGreaterThan(atPause);
    transport.dispose();
  });

  it('resumes where it left off rather than jumping the waveform', async () => {
    /*
     * The pause is meant to freeze phase, not reset it. A resume that restarted
     * the clock would make the motion jump — and a simulator that produces an
     * instantaneous jump teaches the wrong thing about the sensor, because a
     * real glove would show that as a glitch.
     */
    jest.useFakeTimers();
    const transport = new MockTransport('right');
    const seen: RawSample[] = [];
    transport.subscribe((sample) => seen.push(sample));

    const pending = transport.connect('demo-right');
    await jest.advanceTimersByTimeAsync(400);
    await pending;
    await jest.advanceTimersByTimeAsync(300);

    transport.pause();
    const atPause = seen.length;
    const lastBefore = seen[seen.length - 1]!;
    await jest.advanceTimersByTimeAsync(4000);
    // Nothing was produced during the four seconds it was paused.
    expect(seen.length).toBe(atPause);

    transport.resume();
    await jest.advanceTimersByTimeAsync(60);
    expect(seen.length).toBeGreaterThan(atPause);
    const firstAfter = seen[seen.length - 1]!;

    // One sample interval has passed since the pause, so the waveform should
    // have moved a little — not restarted. A reset would land near the t≈0
    // value, which is a long way from here.
    for (let channel = 0; channel < 5; channel += 1) {
      const drift = Math.abs((firstAfter.flex[channel] ?? 0) - (lastBefore.flex[channel] ?? 0));
      expect(drift).toBeLessThan(0.2);
    }
    transport.dispose();
  });

  it('stops producing frames once disposed, so a hot reload cannot leak a timer', async () => {
    jest.useFakeTimers();
    const transport = new MockTransport('right');
    const seen: RawSample[] = [];
    transport.subscribe((sample) => seen.push(sample));

    const pending = transport.connect('demo-right');
    await jest.advanceTimersByTimeAsync(400);
    await pending;

    transport.dispose();
    const atDispose = seen.length;
    await jest.advanceTimersByTimeAsync(2000);
    expect(seen.length).toBe(atDispose);
  });
});

/* ------------------------------------------------------ the controller itself */

describe('the controller’s own contract', () => {
  it('hands a recorder every frame, and the UI only what it needs', () => {
    /*
     * `subscribe` is throttled to `uiHz`; `onFrame` is not. A recording built
     * from the throttled stream would be missing roughly two frames in five,
     * and `ml/window.ts` would then interpolate across gaps the glove never
     * had. The clock is frozen at one instant, so every frame after the first
     * is suppressed for the UI and none is suppressed for the recorder.
     */
    const transport = new ScriptedTransport();
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    let uiEmissions = 0;
    controller.subscribe(() => {
      uiEmissions += 1;
    });
    const frames: RawSample[] = [];
    controller.onFrame((sample) => frames.push(sample));

    for (let index = 0; index < 10; index += 1) transport.emit(frame('right', 1_000 + index));

    expect(frames).toHaveLength(10);
    // One published snapshot for ten frames: the first frame is what the
    // throttle lets through, and the nine after it are dropped.
    expect(uiEmissions).toBe(1);

    /*
     * Referential stability from here on: with the clock frozen, the next nine
     * frames must not rebuild the snapshot at all. `useSyncExternalStore` reads
     * this object to decide whether to re-render, so a fresh object per frame
     * would re-render the whole dashboard twenty times a second.
     *
     * The timestamps stay inside one throttle window of the published frame
     * above, so this measures the throttle rather than the clock.
     */
    const settled = controller.getSnapshot();
    for (let index = 0; index < 5; index += 1) transport.emit(frame('right', 1_010 + index));
    expect(controller.getSnapshot()).toBe(settled);
    expect(frames).toHaveLength(15);

    controller.dispose();
  });

  it('drops a frame from the other glove instead of cross-feeding the hand', () => {
    // How the two gloves are told apart on the wire is unverified, so the code
    // must not act on a side it did not ask for.
    const transport = new ScriptedTransport();
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    const frames: RawSample[] = [];
    controller.onFrame((sample) => frames.push(sample));

    transport.emit(frame('left', 1_000));
    expect(frames).toHaveLength(0);
    expect(controller.getSnapshot().packetCount).toBe(0);

    transport.emit(frame('right', 1_000));
    expect(frames).toHaveLength(1);
    expect(controller.getSnapshot().packetCount).toBe(1);

    controller.dispose();
  });

  it('reports readings as stale once they stop being current', () => {
    let clock = 1_000;
    const transport = new ScriptedTransport();
    const controller = new GloveController('right', transport, { now: () => clock });

    expect(controller.isPacketFresh()).toBe(false);
    transport.emit(frame('right', 1_000));

    clock = 1_000 + PACKET_STALE_MS;
    expect(controller.isPacketFresh()).toBe(true);
    clock = 1_000 + PACKET_STALE_MS + 1;
    expect(controller.isPacketFresh()).toBe(false);

    controller.dispose();
  });

  it('does not call a connected-but-silent glove a source of data', () => {
    // `source` stays `none` until a frame arrives: labelling an absence as data
    // is the failure this guards.
    const transport = new ScriptedTransport();
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    transport.setStatus({ kind: 'connected', side: 'right', deviceName: 'Scripted glove' });
    expect(controller.getSnapshot().link.kind).toBe('connected');
    expect(controller.getSnapshot().source).toBe('none');

    transport.emit(frame('right', 1_000));
    expect(controller.getSnapshot().source).toBe('real');

    controller.dispose();
  });

  it('calls the simulator simulated even when it claims to be connected hardware', () => {
    /*
     * A regression guard for the capture gate. `AppState.gloveInfo` reads this
     * snapshot from outside React to decide whether a recording session may
     * open, and it reads it with no component subscribed to the throttled
     * channel — which is exactly the state the learning centre is in, because it
     * is a detail screen and the dashboard is unmounted behind it.
     *
     * So `getSnapshot` has to be current with no subscribers. If the rebuild
     * were skipped when nothing is listening, a streaming glove would report
     * `none` here and "Start a recording session" would refuse on a live glove.
     */
    const transport = new ScriptedTransport({ synthetic: true });
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    // Deliberately nothing subscribed to the throttled channel.
    transport.setStatus({ kind: 'connected', side: 'right', deviceName: MOCK_DEVICE_NAME });
    transport.emit(frame('right', 1_000));

    const snapshot = controller.getSnapshot();
    expect(snapshot.synthetic).toBe(true);
    expect(snapshot.source).toBe('simulated');
    expect(snapshot.packetCount).toBe(1);

    controller.dispose();
  });

  it('clears the last reading on disconnect, so a closed link shows no current data', async () => {
    const transport = new ScriptedTransport();
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    transport.setStatus({ kind: 'connected', side: 'right', deviceName: 'Scripted glove' });
    transport.emit(frame('right', 1_000));
    expect(controller.getSnapshot().packetCount).toBe(1);

    await controller.disconnect();
    const snapshot = controller.getSnapshot();
    expect(snapshot.raw).toBeNull();
    expect(snapshot.calibrated).toBeNull();
    expect(snapshot.source).toBe('none');
    expect(snapshot.packetCount).toBe(0);

    controller.dispose();
  });

  it('will not scan on a transport that cannot operate', async () => {
    const transport = new ScriptedTransport();
    transport.setStatus({ kind: 'unavailable', reason: 'no protocol' });
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    expect(await controller.scan()).toHaveLength(0);
    expect(transport.scanCalls).toBe(0);
    expect(controller.getSnapshot().link.kind).toBe('unavailable');

    controller.dispose();
  });

  it('cannot be made to connect on an unavailable transport', async () => {
    const transport = new ScriptedTransport();
    transport.setStatus({ kind: 'unavailable', reason: 'no protocol' });
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    await controller.connect('glove-a');
    expect(transport.connectCalls).toHaveLength(0);
    expect(controller.getSnapshot().link.kind).toBe('unavailable');

    controller.dispose();
  });

  it('re-reads an unavailable transport on retry instead of pretending it worked', async () => {
    const transport = new ScriptedTransport();
    transport.setStatus({ kind: 'unavailable', reason: 'no protocol' });
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    await controller.retry();
    // Nothing was attempted, because there is nothing that can be attempted.
    expect(transport.scanCalls).toBe(0);
    expect(transport.connectCalls).toHaveLength(0);
    expect(controller.getSnapshot().link.kind).toBe('unavailable');

    controller.dispose();
  });

  it('retries against a device a scan already found, without scanning again', async () => {
    const transport = new ScriptedTransport();
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    transport.setDevices(ONE_DEVICE);
    await controller.scan();
    expect(controller.getSnapshot().link.kind).toBe('nearby');

    await controller.retry();
    expect(transport.connectCalls).toEqual(['glove-a']);
    expect(transport.scanCalls).toBe(1);
    expect(controller.getSnapshot().link.kind).toBe('connected');

    controller.dispose();
  });

  it('reports a failed scan as a failure, not as an empty world', async () => {
    const transport = new ScriptedTransport();
    transport.scan = async () => {
      throw new Error('radio off');
    };
    const controller = new GloveController('right', transport, { now: () => 1_000 });

    expect(await controller.scan()).toHaveLength(0);
    const link = controller.getSnapshot().link;
    expect(link.kind).toBe('error');
    expect(link.reason).toBe('radio off');

    controller.dispose();
  });

  it('suspends a suspendable transport without dropping the link', () => {
    const transport = new ScriptedTransport();
    const controller = new GloveController('right', transport, { now: () => 1_000 });
    transport.setStatus({ kind: 'connected', side: 'right', deviceName: 'Scripted glove' });

    expect(controller.isPaused).toBe(false);
    controller.pause(true);
    expect(transport.pauseCalls).toBe(1);
    expect(controller.isPaused).toBe(true);
    // The user keeps their glove: pausing is not disconnecting.
    expect(controller.getSnapshot().link.kind).toBe('connected');

    controller.pause(true);
    expect(transport.pauseCalls).toBe(1);

    controller.pause(false);
    expect(transport.resumeCalls).toBe(1);
    expect(controller.isPaused).toBe(false);

    controller.dispose();
  });

  it('disposes once, detaching both subscriptions and the transport', () => {
    const transport = new ScriptedTransport();
    const controller = new GloveController('right', transport, { now: () => 1_000 });
    expect(transport.statusListenerCount()).toBe(1);
    expect(transport.sampleListenerCount()).toBe(1);

    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });

    controller.dispose();
    expect(transport.statusListenerCount()).toBe(0);
    expect(transport.sampleListenerCount()).toBe(0);
    expect(transport.disposed).toBe(true);

    // A disposed controller is inert: a frame that arrives late must not reach
    // a listener, and a second dispose must not blow up.
    const before = notified;
    transport.emit(frame('right', 1_000));
    expect(notified).toBe(before);
    expect(() => controller.dispose()).not.toThrow();
  });
});
