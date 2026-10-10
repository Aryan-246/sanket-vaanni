/**
 * Transport behaviour.
 *
 * The important assertion here is the honesty one: the real BLE transport must
 * refuse to operate while the protocol is unverified, and the mock must
 * identify itself as synthetic so the UI can label it.
 */
import { BleTransport, BLE_UNAVAILABLE_REASON } from '../src/ble/bleTransport';
import { MockTransport } from '../src/ble/mockTransport';
import { isSynthetic, MOCK_DEVICE_NAME } from '../src/ble/types';
import type { RawSample } from '../src/sensors/types';

describe('MockTransport', () => {
  it('identifies itself as synthetic so the UI can label it', () => {
    const transport = new MockTransport('right');
    expect(transport.isSynthetic).toBe(true);
    expect(transport.name).toMatch(/demo|simulat/i);
  });

  it('starts idle', () => {
    expect(new MockTransport('right').getStatus().kind).toBe('idle');
  });

  it('reports the demo device name when connected', async () => {
    const transport = new MockTransport('right');
    await transport.connect('demo-right');

    const status = transport.getStatus();
    expect(status.kind).toBe('connected');
    expect(isSynthetic(status)).toBe(true);

    transport.dispose();
  });

  it('emits no frames until connected', async () => {
    jest.useFakeTimers();
    const transport = new MockTransport('right', { sampleIntervalMs: 50 });
    const frames: RawSample[] = [];
    transport.subscribe((frame) => frames.push(frame));

    await jest.advanceTimersByTimeAsync(500);

    expect(frames).toHaveLength(0);
    transport.dispose();
    jest.useRealTimers();
  });

  it('emits frames once connected', async () => {
    jest.useFakeTimers();
    const transport = new MockTransport('right', { sampleIntervalMs: 50 });
    const frames: RawSample[] = [];
    transport.subscribe((frame) => frames.push(frame));

    const connecting = transport.connect('demo-right');
    await jest.advanceTimersByTimeAsync(400);
    await connecting;
    await jest.advanceTimersByTimeAsync(250);

    expect(frames.length).toBeGreaterThan(0);
    transport.dispose();
    jest.useRealTimers();
  });

  it('produces the five flex channels in range', async () => {
    jest.useFakeTimers();
    const transport = new MockTransport('right', { sampleIntervalMs: 50 });
    const frames: RawSample[] = [];
    transport.subscribe((frame) => frames.push(frame));

    const connecting = transport.connect('demo-right');
    await jest.advanceTimersByTimeAsync(400);
    await connecting;
    await jest.advanceTimersByTimeAsync(250);

    expect(frames[0]?.flex).toHaveLength(5);
    frames.forEach((frame) => {
      frame.flex.forEach((value) => {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      });
    });

    transport.dispose();
    jest.useRealTimers();
  });

  it('stops emitting after disconnect', async () => {
    jest.useFakeTimers();
    const transport = new MockTransport('right', { sampleIntervalMs: 50 });
    const frames: RawSample[] = [];
    transport.subscribe((frame) => frames.push(frame));

    const connecting = transport.connect('demo-right');
    await jest.advanceTimersByTimeAsync(400);
    await connecting;
    await jest.advanceTimersByTimeAsync(200);

    const countAfterConnect = frames.length;
    await transport.disconnect();
    await jest.advanceTimersByTimeAsync(500);

    expect(frames.length).toBe(countAfterConnect);
    transport.dispose();
    jest.useRealTimers();
  });

  it('refuses to connect to an unknown device id', async () => {
    const transport = new MockTransport('right');
    await expect(transport.connect('some-real-glove')).rejects.toThrow(/demo-right/);
    transport.dispose();
  });

  it('is deterministic for the same elapsed time', async () => {
    jest.useFakeTimers();
    const a = new MockTransport('right', { sampleIntervalMs: 50, sideOffsetMs: 0 });
    const b = new MockTransport('right', { sampleIntervalMs: 50, sideOffsetMs: 0 });
    const framesA: RawSample[] = [];
    const framesB: RawSample[] = [];
    a.subscribe((f) => framesA.push(f));
    b.subscribe((f) => framesB.push(f));

    const ca = a.connect('demo-right');
    const cb = b.connect('demo-right');
    await jest.advanceTimersByTimeAsync(400);
    await Promise.all([ca, cb]);
    await jest.advanceTimersByTimeAsync(250);

    expect(framesA[0]?.flex).toEqual(framesB[0]?.flex);
    a.dispose();
    b.dispose();
    jest.useRealTimers();
  });
});

describe('BleTransport (real)', () => {
  it('reports itself as unavailable rather than idle', () => {
    const transport = new BleTransport();
    expect(transport.getStatus().kind).toBe('unavailable');
  });

  it('does not claim to be synthetic', () => {
    // It produces nothing at all; claiming synthetic would make the UI show a
    // Demo Mode badge over an empty screen.
    expect(new BleTransport().isSynthetic).toBe(false);
  });

  it('refuses to scan while the protocol is unverified', async () => {
    await expect(new BleTransport().scan()).rejects.toThrow(/not implemented|not been verified/i);
  });

  it('refuses to connect while the protocol is unverified', async () => {
    await expect(new BleTransport().connect('anything')).rejects.toThrow(/verified/i);
  });

  it('explains why, naming the protocol document', () => {
    expect(BLE_UNAVAILABLE_REASON).toContain('docs/ble-protocol.md');
  });
});

describe('transport contract constants', () => {
  it('uses a demo device name that cannot be mistaken for hardware', () => {
    expect(MOCK_DEVICE_NAME).toBe('__demo__');
  });
});
