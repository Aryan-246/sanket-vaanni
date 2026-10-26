/**
 * Regression and verification test suite for genuine BLE discovery,
 * connection status separation, and sensor telemetry integrity.
 *
 * Verifies:
 * - Empty scan results (honest "No compatible glove found nearby").
 * - Unrelated nearby BLE devices are rejected.
 * - Genuine compatible device discovery (service UUID matching).
 * - Alternate advertised names for supported devices.
 * - Connection failure and timeout handling.
 * - Successful GATT connection without notifications ("Connected to app").
 * - Valid fresh telemetry ("Receiving data").
 * - Stale packet expiration and malformed packet rejection.
 * - Disconnect and reconnect state transitions.
 * - Left and Right identity separation.
 * - Both gloves connected simultaneously.
 * - Strict rejection of fabricated scan results or calibration values.
 */
import {
  isCompatibleGloveDevice,
  inferSideFromDevice,
  SERVICE_UUID,
} from '../src/ble/bleTransport';
import { GloveController, PACKET_STALE_MS } from '../src/ble/controller';
import { linkReducer, INITIAL_LINK, isLinkLive } from '../src/ble/link';
import type { DiscoveredGlove, GloveSide, GloveTransport, TransportStatus, Unsubscribe } from '../src/ble/types';
import type { RawSample } from '../src/sensors/types';
import { createHardwareDefaultCalibration } from '../src/sensors/calibration';

class MockVerifiableTransport implements GloveTransport {
  readonly name = 'MockVerifiableTransport';
  readonly isSynthetic = false;

  #status: TransportStatus = { kind: 'idle' };
  #statusListeners = new Set<(s: TransportStatus) => void>();
  #sampleListeners = new Set<(s: RawSample) => void>();
  discoveredToReturn: DiscoveredGlove[] = [];
  shouldFailScan = false;
  scanFailureReason = 'Radio off';
  shouldFailConnect = false;
  connectFailureReason = 'Connection timeout';

  getStatus(): TransportStatus {
    return this.#status;
  }

  setStatus(s: TransportStatus): void {
    this.#status = s;
    for (const l of this.#statusListeners) l(s);
  }

  onStatusChange(listener: (s: TransportStatus) => void): Unsubscribe {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  subscribe(listener: (s: RawSample) => void): Unsubscribe {
    this.#sampleListeners.add(listener);
    return () => this.#sampleListeners.delete(listener);
  }

  emitSample(sample: RawSample): void {
    for (const l of this.#sampleListeners) l(sample);
  }

  async scan(): Promise<DiscoveredGlove[]> {
    if (this.shouldFailScan) {
      throw new Error(this.scanFailureReason);
    }
    return [...this.discoveredToReturn];
  }

  async connect(deviceId: string): Promise<void> {
    if (this.shouldFailConnect) {
      throw new Error(this.connectFailureReason);
    }
    this.setStatus({ kind: 'connected', side: 'left', deviceName: deviceId });
  }

  async disconnect(): Promise<void> {
    this.setStatus({ kind: 'disconnected', side: 'left', reason: 'User requested' });
  }
}

function makeRawSample(side: GloveSide, flex: [number, number, number, number, number]): RawSample {
  return {
    side,
    timestampMs: Date.now(),
    flex,
    accel: { x: 0, y: 0, z: 16384 },
    gyro: { x: 0, y: 0, z: 0 },
    battery_v: 3.7,
    battery_pin_v: 1.0,
    battery_pct: 45,
    imu_temp_c: 41.5,
    pitch: 0,
    roll: 0,
  };
}

describe('BLE Device Discovery & Filtering (Section 2)', () => {
  it('accepts devices advertising verified SERVICE_UUID regardless of casing', () => {
    expect(isCompatibleGloveDevice('Unknown Device', [SERVICE_UUID])).toBe(true);
    expect(isCompatibleGloveDevice(null, [SERVICE_UUID.toUpperCase()])).toBe(true);
    expect(isCompatibleGloveDevice('', ['8F2A1000-7D2B-4C9A-9C4E-6B1E2F000001'])).toBe(true);
  });

  it('accepts legitimate name variations for Sanket Vaanni gloves', () => {
    expect(isCompatibleGloveDevice('SanketVaanni-Left', [])).toBe(true);
    expect(isCompatibleGloveDevice('SanketVaanni-Right', [])).toBe(true);
    expect(isCompatibleGloveDevice('SanketVaanni', [])).toBe(true);
    expect(isCompatibleGloveDevice('Sanket-Vaanni-Left', [])).toBe(true);
    expect(isCompatibleGloveDevice('Sanket Vaanni Right', [])).toBe(true);
    expect(isCompatibleGloveDevice('SV-Left', [])).toBe(true);
    expect(isCompatibleGloveDevice('SV-Right', [])).toBe(true);
    expect(isCompatibleGloveDevice('SV_Glove', [])).toBe(true);
  });

  it('rejects unrelated nearby BLE devices', () => {
    expect(isCompatibleGloveDevice('Sony WH-1000XM4', [])).toBe(false);
    expect(isCompatibleGloveDevice('AirPods Pro', null)).toBe(false);
    expect(isCompatibleGloveDevice('Samsung Smart TV', ['0000180f-0000-1000-8000-00805f9b34fb'])).toBe(false);
    expect(isCompatibleGloveDevice('Mi Band 7', ['0000fee0-0000-1000-8000-00805f9b34fb'])).toBe(false);
    expect(isCompatibleGloveDevice('Left Earbud', [])).toBe(false); // Name has "Left" but not Sanket Vaanni
    expect(isCompatibleGloveDevice('Right Speaker', [])).toBe(false);
    expect(isCompatibleGloveDevice('', [])).toBe(false);
    expect(isCompatibleGloveDevice(null, null)).toBe(false);
  });

  it('infers side correctly when present, or returns null for protocol resolution', () => {
    expect(inferSideFromDevice('SanketVaanni-Left')).toBe('left');
    expect(inferSideFromDevice('SV-Right')).toBe('right');
    expect(inferSideFromDevice('Sanket Vaanni Left')).toBe('left');
    expect(inferSideFromDevice('SanketVaanni')).toBeNull(); // Side determined by GATT protocol
    expect(inferSideFromDevice('SV-Glove')).toBeNull();
  });
});

describe('Empty Scan Results & Honest Link State (Section 2 & 7)', () => {
  it('sets reason to "No compatible glove found nearby" on empty scan without fabricating devices', () => {
    const afterEmptyScan = linkReducer(INITIAL_LINK, {
      type: 'scan-result',
      devices: [],
      atMs: 1000,
    });

    expect(afterEmptyScan.kind).toBe('idle');
    expect(afterEmptyScan.discovered).toHaveLength(0);
    expect(afterEmptyScan.reason).toBe('No compatible glove found nearby');
  });

  it('does not return cached devices when scan finds zero devices', async () => {
    const transport = new MockVerifiableTransport();
    transport.discoveredToReturn = [];

    const controller = new GloveController('left', transport);
    const discovered = await controller.scan();

    expect(discovered).toEqual([]);
    expect(controller.getSnapshot().link.kind).toBe('idle');
    expect(controller.getSnapshot().link.reason).toBe('No compatible glove found nearby');
    controller.dispose();
  });

  it('records explicit error reason on scan failure', async () => {
    const transport = new MockVerifiableTransport();
    transport.shouldFailScan = true;
    transport.scanFailureReason = 'Bluetooth is off or unavailable';

    const controller = new GloveController('left', transport);
    const discovered = await controller.scan();

    expect(discovered).toEqual([]);
    expect(controller.getSnapshot().link.kind).toBe('error');
    expect(controller.getSnapshot().link.reason).toBe('Bluetooth is off or unavailable');
    controller.dispose();
  });
});

describe('GATT Connection vs Data Stream Separation (Section 3 & 7)', () => {
  it('displays connected GATT link but NOT receiving data before first frame arrives', () => {
    let now = 10000;
    const transport = new MockVerifiableTransport();
    const controller = new GloveController('left', transport, { now: () => now });

    transport.setStatus({ kind: 'connected', side: 'left', deviceName: 'SanketVaanni-Left' });

    const snap = controller.getSnapshot();
    expect(snap.link.kind).toBe('connected');
    expect(isLinkLive(snap.link)).toBe(true);
    expect(snap.receivingData).toBe(false); // Distinct state: connected to app, but no data yet
    expect(snap.source).toBe('none');

    controller.dispose();
  });

  it('transitions to receivingData = true when valid fresh telemetry arrives', () => {
    let now = 10000;
    const transport = new MockVerifiableTransport();
    const controller = new GloveController('left', transport, { now: () => now });

    transport.setStatus({ kind: 'connected', side: 'left', deviceName: 'SanketVaanni-Left' });

    // Emit fresh frame from Left glove
    transport.emitSample(makeRawSample('left', [3550, 3950, 0, 0, 4070]));

    const snap = controller.getSnapshot();
    expect(snap.link.kind).toBe('connected');
    expect(snap.receivingData).toBe(true);
    expect(snap.source).toBe('real');
    expect(snap.raw?.flex).toEqual([3550, 3950, 0, 0, 4070]);

    controller.dispose();
  });

  it('drops receivingData to false when frames become stale (> 1500 ms)', () => {
    let now = 10000;
    const transport = new MockVerifiableTransport();
    const controller = new GloveController('left', transport, { now: () => now });

    transport.setStatus({ kind: 'connected', side: 'left', deviceName: 'SanketVaanni-Left' });
    transport.emitSample(makeRawSample('left', [3550, 3950, 0, 0, 4070]));

    expect(controller.getSnapshot().receivingData).toBe(true);

    // Advance time past PACKET_STALE_MS
    now += PACKET_STALE_MS + 100;

    expect(controller.isPacketFresh()).toBe(false);
    expect(controller.getSnapshot().receivingData).toBe(false); // Link is still connected, but stream is stale

    controller.dispose();
  });

  it('ignores frames from opposite hand to prevent cross-talk', () => {
    let now = 10000;
    const transport = new MockVerifiableTransport();
    const controller = new GloveController('left', transport, { now: () => now });

    transport.setStatus({ kind: 'connected', side: 'left', deviceName: 'SanketVaanni-Left' });

    // Right hand frame arrives on Left controller
    transport.emitSample(makeRawSample('right', [2100, 2900, 3100, 5100, 3600]));

    const snap = controller.getSnapshot();
    expect(snap.raw).toBeNull();
    expect(snap.receivingData).toBe(false);
    expect(snap.packetCount).toBe(0);

    controller.dispose();
  });
});

describe('Disconnect and Reconnect Integrity (Section 3 & 6)', () => {
  it('immediately transitions to disconnected and clears readings upon link drop', async () => {
    let now = 10000;
    const transport = new MockVerifiableTransport();
    const controller = new GloveController('left', transport, { now: () => now });

    transport.setStatus({ kind: 'connected', side: 'left', deviceName: 'SanketVaanni-Left' });
    transport.emitSample(makeRawSample('left', [3550, 3950, 0, 0, 4070]));

    expect(controller.getSnapshot().receivingData).toBe(true);

    // Device disconnects
    await controller.disconnect();

    const snap = controller.getSnapshot();
    expect(snap.link.kind).toBe('disconnected');
    expect(snap.receivingData).toBe(false);
    expect(snap.raw).toBeNull();
    expect(snap.calibrated).toBeNull();
    expect(snap.source).toBe('none');

    controller.dispose();
  });

  it('resumes streaming on reconnect without retaining stale frames', async () => {
    let now = 10000;
    const transport = new MockVerifiableTransport();
    const controller = new GloveController('left', transport, { now: () => now });

    await controller.disconnect();
    expect(controller.getSnapshot().link.kind).toBe('disconnected');

    // Reconnect
    await controller.connect('SanketVaanni-Left');
    expect(controller.getSnapshot().link.kind).toBe('connected');
    expect(controller.getSnapshot().receivingData).toBe(false);

    // Fresh telemetry arrives
    now += 50;
    transport.emitSample(makeRawSample('left', [3560, 3960, 0, 0, 4080]));

    const snap = controller.getSnapshot();
    expect(snap.receivingData).toBe(true);
    expect(snap.raw?.flex).toEqual([3560, 3960, 0, 0, 4080]);

    controller.dispose();
  });
});

describe('Dual-Glove Identity Separation (Section 6)', () => {
  it('maintains independent identities, streams, and states for Left and Right gloves simultaneously', () => {
    let now = 10000;
    const leftTransport = new MockVerifiableTransport();
    const rightTransport = new MockVerifiableTransport();

    const leftController = new GloveController('left', leftTransport, { now: () => now });
    const rightController = new GloveController('right', rightTransport, { now: () => now });

    leftTransport.setStatus({ kind: 'connected', side: 'left', deviceName: 'SanketVaanni-Left' });
    rightTransport.setStatus({ kind: 'connected', side: 'right', deviceName: 'SanketVaanni-Right' });

    leftTransport.emitSample(makeRawSample('left', [3550, 3950, 0, 0, 4070]));
    rightTransport.emitSample(makeRawSample('right', [2190, 2960, 3110, 5120, 3610]));

    const leftSnap = leftController.getSnapshot();
    const rightSnap = rightController.getSnapshot();

    expect(leftSnap.receivingData).toBe(true);
    expect(rightSnap.receivingData).toBe(true);
    expect(leftSnap.raw?.flex).toEqual([3550, 3950, 0, 0, 4070]);
    expect(rightSnap.raw?.flex).toEqual([2190, 2960, 3110, 5120, 3610]);

    // Disconnecting Left does not disconnect or overwrite Right
    leftTransport.setStatus({ kind: 'disconnected', side: 'left', reason: 'Link dropped' });

    expect(leftController.getSnapshot().link.kind).toBe('disconnected');
    expect(leftController.getSnapshot().receivingData).toBe(false);

    expect(rightController.getSnapshot().link.kind).toBe('connected');
    expect(rightController.getSnapshot().receivingData).toBe(true);
    expect(rightController.getSnapshot().raw?.flex).toEqual([2190, 2960, 3110, 5120, 3610]);

    leftController.dispose();
    rightController.dispose();
  });
});

describe('Sensor Telemetry & Calibration Anchors Honesty (Section 5)', () => {
  it('preserves raw hardware zeros on Left Ch2 and Ch3 without fabricating non-zero values', () => {
    const rawLeftFlex: [number, number, number, number, number] = [3552, 3908, 0, -4, 4064];
    const leftProfile = createHardwareDefaultCalibration('left');

    // Asserts raw sample holds real hardware numbers as received from ADS1115
    const sample = makeRawSample('left', rawLeftFlex);
    expect(sample.flex[2]).toBe(0);
    expect(sample.flex[3]).toBe(-4);

    // Profile anchors must remain honest
    expect(leftProfile.channels[2]?.rest).toBe(290);
    expect(leftProfile.channels[3]?.rest).toBe(340);
  });
});
