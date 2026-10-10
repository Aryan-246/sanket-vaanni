/**
 * Real glove transport — NOT IMPLEMENTED.
 *
 * The firmware's service UUID, characteristic UUIDs, frame layout, byte order,
 * sample rate and checksum are all unverified. See `docs/ble-protocol.md` for
 * the open checklist.
 *
 * This file is deliberately a stub that throws. It exists so that:
 *  - the interface it must satisfy is already fixed and used by the app;
 *  - the app can say "not available yet" honestly instead of pretending;
 *  - swapping it in later touches one file, not the UI.
 *
 * Do NOT fill in UUIDs here from inference, a blog post, or a plausible-looking
 * guess. Every constant must come from the firmware source or a live scan.
 */
import type {
  DiscoveredGlove,
  GloveTransport,
  TransportStatus,
  Unsubscribe,
} from './types';
import type { RawSample } from '../sensors/types';

const REASON =
  'Glove BLE is not implemented: the firmware protocol (service/characteristic ' +
  'UUIDs, frame layout, sample rate) has not been verified. See docs/ble-protocol.md.';

class ProtocolUnverifiedError extends Error {
  constructor() {
    super(REASON);
    this.name = 'ProtocolUnverifiedError';
  }
}

export class BleTransport implements GloveTransport {
  readonly name = 'Bluetooth LE (not implemented)';
  /**
   * Not synthetic, because it produces nothing at all. Claiming `true` would
   * make the UI show a Demo Mode badge over an empty screen, which would be
   * misleading in the other direction.
   */
  readonly isSynthetic = false;

  #status: TransportStatus = { kind: 'unavailable', reason: REASON };

  getStatus(): TransportStatus {
    return this.#status;
  }

  onStatusChange(listener: (status: TransportStatus) => void): Unsubscribe {
    listener(this.#status);
    return () => undefined;
  }

  async scan(): Promise<DiscoveredGlove[]> {
    throw new ProtocolUnverifiedError();
  }

  async connect(_deviceId: string): Promise<void> {
    throw new ProtocolUnverifiedError();
  }

  async disconnect(): Promise<void> {
    this.#status = { kind: 'unavailable', reason: REASON };
  }

  subscribe(_listener: (sample: RawSample) => void): Unsubscribe {
    return () => undefined;
  }
}

/** Surfaced in the UI so the reason is visible without reading source. */
export const BLE_UNAVAILABLE_REASON = REASON;
