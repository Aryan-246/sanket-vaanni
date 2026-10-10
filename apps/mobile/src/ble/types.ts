/**
 * Glove transport contract.
 *
 * This is the seam that lets the whole app — UI, signal processing, history —
 * be built and tested before the glove firmware protocol is verified. The real
 * implementation and the mock implementation are interchangeable from the
 * caller's point of view.
 *
 * Import from here, never from a concrete implementation.
 */
import type { SensorSample } from '../sensors/types';

export type { SensorSample };

export type GloveSide = 'left' | 'right';

/**
 * Connection state.
 *
 * Deliberately explicit about `unavailable`: the real transport is not
 * implemented, and that must be representable rather than disguised as an
 * error or as "disconnected".
 */
export type TransportStatus =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'connecting'; side: GloveSide }
  | { kind: 'connected'; side: GloveSide; deviceName: string }
  | { kind: 'disconnected'; side: GloveSide; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; reason: string };

export interface DiscoveredGlove {
  id: string;
  name: string;
  side: GloveSide;
  /** Signal strength in dBm, or null when the platform does not report it. */
  rssi: number | null;
}

/** True when the transport is emitting data the user may act on. */
export function isConnected(status: TransportStatus): boolean {
  return status.kind === 'connected';
}

/** True when the data on screen is synthetic. Drives Demo Mode labelling. */
export function isSynthetic(status: TransportStatus): boolean {
  return status.kind === 'connected' && status.deviceName === MOCK_DEVICE_NAME;
}

/**
 * The name the mock transport reports. Exported so the UI can decide to show
 * the Demo Mode badge without guessing, and so a test can assert the badge
 * appears.
 */
export const MOCK_DEVICE_NAME = '__demo__';

export type Unsubscribe = () => void;

/**
 * A transport whose data production can be suspended without dropping the
 * link.
 *
 * Distinct from `disconnect()`: the connection stays up and the user keeps
 * their glove, but no frames are produced while suspended. That is what lets a
 * backgrounded app stop burning battery without the user returning to find
 * their glove has been disconnected underneath them.
 *
 * Optional, because a real BLE stack may not offer this — the caller checks for
 * it rather than assuming.
 */
export interface SuspendableTransport {
  pause(): void;
  resume(): void;
}

export interface GloveTransport {
  /** Human-readable transport name, for diagnostics and the about screen. */
  readonly name: string;

  /**
   * True when this transport produces synthetic data. The UI must label
   * synthetic readings; this flag is how it knows.
   */
  readonly isSynthetic: boolean;

  /** Current connection state. */
  getStatus(): TransportStatus;

  /** Subscribe to status changes. Fires immediately with the current status. */
  onStatusChange(listener: (status: TransportStatus) => void): Unsubscribe;

  /** Discover nearby gloves. */
  scan(): Promise<DiscoveredGlove[]>;

  /** Connect to a discovered glove by id. */
  connect(deviceId: string): Promise<void>;

  /** Disconnect the active glove, if any. */
  disconnect(): Promise<void>;

  /** Subscribe to sensor samples. Fires only while connected. */
  subscribe(listener: (sample: SensorSample) => void): Unsubscribe;
}
