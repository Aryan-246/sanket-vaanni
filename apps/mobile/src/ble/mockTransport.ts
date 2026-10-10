/**
 * Simulated glove transport.
 *
 * ## What this is
 *
 * A deterministic source of synthetic sensor frames, so that the UI, the
 * processing pipeline, the history store and the API client can all be built
 * and tested while the real gloves are unavailable and the BLE protocol is
 * unverified.
 *
 * ## What this is NOT
 *
 * It is **not** a model of the hardware. The waveforms below are sine waves
 * chosen to look plausible and to exercise the pipeline. They are not derived
 * from a measurement, and no conclusion about real flex-sensor behaviour may
 * be drawn from them. `isSynthetic` is `true` and the UI must label it.
 *
 * Determinism matters: the same elapsed time always yields the same frame, so
 * screenshots and tests are stable.
 */
import {
  MOCK_DEVICE_NAME,
  type DiscoveredGlove,
  type GloveSide,
  type GloveTransport,
  type TransportStatus,
  type Unsubscribe,
} from './types';
import { FLEX_CHANNEL_COUNT, type FlexReading, type RawSample } from '../sensors/types';

/** 20 Hz. Fast enough to look live, slow enough not to churn React renders. */
const SAMPLE_INTERVAL_MS = 50;

/**
 * Synthetic oscillation period per finger, in ms. Chosen to be mutually
 * non-harmonic so the five channels visibly differ.
 */
const FINGER_PERIODS_MS = [2600, 3100, 3700, 4300, 4900] as const;

/** Per-finger constant offset so channels are not in phase. */
const FINGER_PHASE = [0, 0.8, 1.9, 2.7, 3.6] as const;

const TAU = Math.PI * 2;

/** Maps a value into 0..1 with a smooth ease, avoiding hard clipping. */
function smooth01(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function buildFlex(elapsedMs: number, channel: number): number {
  const period = FINGER_PERIODS_MS[channel] ?? 3000;
  const phase = FINGER_PHASE[channel] ?? 0;
  const wave = Math.sin(TAU * (elapsedMs / period) + phase);
  return smooth01(0.5 + 0.5 * wave);
}

function buildFlexReading(elapsedMs: number): FlexReading {
  return [
    buildFlex(elapsedMs, 0),
    buildFlex(elapsedMs, 1),
    buildFlex(elapsedMs, 2),
    buildFlex(elapsedMs, 3),
    buildFlex(elapsedMs, 4),
  ];
}

export interface MockTransportOptions {
  /** Override the sample interval, for tests. */
  readonly sampleIntervalMs?: number;
  /** Skew the assumed clock origin. Keeps two gloves out of phase. */
  readonly sideOffsetMs?: number;
}

export class MockTransport implements GloveTransport {
  readonly name = 'Demo Mode (simulated)';
  readonly isSynthetic = true;

  readonly #deviceId: string;
  readonly #side: GloveSide;
  readonly #sampleIntervalMs: number;
  readonly #sideOffsetMs: number;

  #status: TransportStatus = { kind: 'idle' };
  #statusListeners = new Set<(status: TransportStatus) => void>();
  #sampleListeners = new Set<(sample: RawSample) => void>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #startedAtMs = 0;

  constructor(side: GloveSide = 'right', options: MockTransportOptions = {}) {
    this.#side = side;
    this.#deviceId = `demo-${side}`;
    this.#sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.#sideOffsetMs = options.sideOffsetMs ?? (side === 'left' ? 0 : 700);
  }

  getStatus(): TransportStatus {
    return this.#status;
  }

  onStatusChange(listener: (status: TransportStatus) => void): Unsubscribe {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  async scan(): Promise<DiscoveredGlove[]> {
    this.#setStatus({ kind: 'scanning' });
    // Simulated discovery latency, so the UI's scanning state is exercised.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    const found: DiscoveredGlove[] = [
      { id: this.#deviceId, name: MOCK_DEVICE_NAME, side: this.#side, rssi: -42 },
    ];
    this.#setStatus({ kind: 'idle' });
    return found;
  }

  async connect(deviceId: string): Promise<void> {
    if (deviceId !== this.#deviceId) {
      throw new Error(
        `MockTransport can only connect to "${this.#deviceId}" — received "${deviceId}"`,
      );
    }
    this.#setStatus({ kind: 'connecting', side: this.#side });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    this.#startStreaming();
    this.#setStatus({
      kind: 'connected',
      side: this.#side,
      deviceName: MOCK_DEVICE_NAME,
    });
  }

  async disconnect(): Promise<void> {
    this.#stopStreaming();
    this.#setStatus({
      kind: 'disconnected',
      side: this.#side,
      reason: 'Disconnected by user',
    });
  }

  subscribe(listener: (sample: RawSample) => void): Unsubscribe {
    this.#sampleListeners.add(listener);
    return () => {
      this.#sampleListeners.delete(listener);
    };
  }

  /** Stops the timer. Call on unmount so a hot reload cannot leak intervals. */
  dispose(): void {
    this.#stopStreaming();
    this.#statusListeners.clear();
    this.#sampleListeners.clear();
  }

  #startStreaming(): void {
    this.#stopStreaming();
    this.#startedAtMs = Date.now();
    this.#timer = setInterval(() => {
      const elapsed = Date.now() - this.#startedAtMs + this.#sideOffsetMs;
      const flex = buildFlexReading(elapsed);
      const sample: RawSample = {
        side: this.#side,
        timestampMs: Date.now(),
        flex,
        // Slow synthetic motion. Values are illustrative, not measured.
        accel: {
          x: 0.06 * Math.sin(TAU * (elapsed / 5200)),
          y: 0.06 * Math.cos(TAU * (elapsed / 6100)),
          z: 9.81,
        },
        gyro: {
          x: 0.11 * Math.sin(TAU * (elapsed / 4400)),
          y: 0.11 * Math.cos(TAU * (elapsed / 5300)),
          z: 0.05 * Math.sin(TAU * (elapsed / 6800)),
        },
      };
      for (const listener of this.#sampleListeners) {
        listener(sample);
      }
    }, this.#sampleIntervalMs);
  }

  #stopStreaming(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #setStatus(status: TransportStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) {
      listener(status);
    }
  }
}

/** Exposed so tests can assert the channel count stays in step with the UI. */
export const MOCK_FLEX_CHANNEL_COUNT = FLEX_CHANNEL_COUNT;
