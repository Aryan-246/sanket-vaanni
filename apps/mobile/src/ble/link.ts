/**
 * Per-glove connection state.
 *
 * A pure reducer over an explicit state machine, so the UI can render every
 * state the product brief asks for — nearby, connecting, connected,
 * disconnected, unavailable — without any of them being invented at the point
 * of display.
 *
 * The important rule this file enforces: a state is only ever produced by an
 * *action that actually happened*. There is no `optimisticConnect`, and
 * `connected` can only be reached by a `connected` action, which the controller
 * dispatches only after the transport has genuinely connected. A tap on Connect
 * therefore cannot fabricate a connection.
 */
import type { DiscoveredGlove, GloveSide, TransportStatus } from './types';
import { MOCK_DEVICE_NAME } from './types';
import type { HealthState } from '../audit/status';

export type LinkKind =
  | 'idle'
  /** Actively scanning for nearby gloves. */
  | 'scanning'
  /** A scan completed and found at least one glove. */
  | 'nearby'
  | 'connecting'
  | 'connected'
  /** Was connected, now closed. Distinct from `idle`, which never connected. */
  | 'disconnected'
  /** The transport cannot operate at all (protocol unverified, BLE off). */
  | 'unavailable'
  | 'error';

export interface LinkState {
  readonly kind: LinkKind;
  /** Devices from the most recent successful scan. */
  readonly discovered: readonly DiscoveredGlove[];
  readonly deviceId: string | null;
  readonly deviceName: string | null;
  /**
   * Why the link is not usable. Set for `unavailable`, `disconnected` and
   * `error`; null for the rest. Never a placeholder string.
   */
  readonly reason: string | null;
  /** When the last successful scan completed, for showing staleness. */
  readonly lastScanAtMs: number | null;
}

export const INITIAL_LINK: LinkState = {
  kind: 'idle',
  discovered: [],
  deviceId: null,
  deviceName: null,
  reason: null,
  lastScanAtMs: null,
};

export type LinkAction =
  | { type: 'scan-start' }
  | { type: 'scan-result'; devices: readonly DiscoveredGlove[]; atMs: number }
  | { type: 'scan-failed'; reason: string }
  | { type: 'connect-start'; device: DiscoveredGlove }
  | { type: 'connected'; deviceId: string; deviceName: string }
  | { type: 'connect-failed'; reason: string }
  | { type: 'disconnected'; reason: string }
  | { type: 'unavailable'; reason: string }
  | { type: 'reset' };

export function linkReducer(state: LinkState, action: LinkAction): LinkState {
  switch (action.type) {
    case 'scan-start':
      return { ...state, kind: 'scanning', reason: null };

    case 'scan-result':
      return {
        ...state,
        // An empty scan is `idle`, not `nearby` — there is nothing to offer.
        kind: action.devices.length > 0 ? 'nearby' : 'idle',
        discovered: action.devices,
        lastScanAtMs: action.atMs,
        reason: null,
      };

    case 'scan-failed':
      return { ...state, kind: 'error', reason: action.reason, discovered: [] };

    case 'connect-start':
      return {
        ...state,
        kind: 'connecting',
        deviceId: action.device.id,
        deviceName: action.device.name,
        reason: null,
      };

    case 'connected':
      return {
        ...state,
        kind: 'connected',
        deviceId: action.deviceId,
        deviceName: action.deviceName,
        reason: null,
      };

    case 'connect-failed':
      return { ...state, kind: 'error', reason: action.reason };

    case 'disconnected':
      return {
        ...state,
        kind: 'disconnected',
        deviceId: null,
        deviceName: null,
        reason: action.reason,
      };

    case 'unavailable':
      return { ...state, kind: 'unavailable', reason: action.reason, discovered: [] };

    case 'reset':
      return INITIAL_LINK;

    default:
      return state;
  }
}

/**
 * Maps a transport's own status onto the link state.
 *
 * Used for the initial value and for transports that report a permanent
 * condition (`BleTransport` reports `unavailable` immediately). Note that this
 * is a *translation*, not a promotion: an `unavailable` transport stays
 * unavailable here, and nothing becomes `connected` without a real connect.
 */
export function linkStateFromTransport(status: TransportStatus): LinkState {
  switch (status.kind) {
    case 'connected':
      return {
        ...INITIAL_LINK,
        kind: 'connected',
        deviceId: null,
        deviceName: status.deviceName,
      };
    case 'unavailable':
      return { ...INITIAL_LINK, kind: 'unavailable', reason: status.reason };
    case 'disconnected':
      return { ...INITIAL_LINK, kind: 'disconnected', reason: status.reason };
    case 'error':
      return { ...INITIAL_LINK, kind: 'error', reason: status.message };
    case 'scanning':
      return { ...INITIAL_LINK, kind: 'scanning' };
    case 'connecting':
      return { ...INITIAL_LINK, kind: 'connecting' };
    default:
      return INITIAL_LINK;
  }
}

/** True while a scan or connect is in flight, so the UI can show a spinner. */
export function isLinkBusy(link: LinkState): boolean {
  return link.kind === 'scanning' || link.kind === 'connecting';
}

/** True when the link is genuinely carrying data. */
export function isLinkLive(link: LinkState): boolean {
  return link.kind === 'connected';
}

/**
 * Health of the *link*, for the audit and dashboard chips.
 *
 * `idle` and `nearby` map to `unknown` rather than to a problem: nothing has
 * gone wrong, we simply have no link yet. Mapping them to `warning` would make
 * an app that has not been asked to connect look broken.
 */
export function linkHealth(link: LinkState): HealthState {
  switch (link.kind) {
    case 'connected':
      return 'healthy';
    case 'disconnected':
      return 'disconnected';
    case 'unavailable':
      return 'unavailable';
    case 'error':
      return 'warning';
    default:
      return 'unknown';
  }
}

/**
 * True when the connected device is the simulator rather than hardware.
 *
 * Keys off the device name the mock reports, which is an unambiguous sentinel
 * (`__demo__`) precisely so this cannot be confused with a real glove that
 * happens to be called something similar.
 */
export function isSimulatedLink(link: LinkState): boolean {
  return link.kind === 'connected' && link.deviceName === MOCK_DEVICE_NAME;
}

/** Short human label for the current link, used on the status chip. */
export function linkLabel(link: LinkState, side: GloveSide): string {
  const hand = side === 'left' ? 'Left' : 'Right';
  switch (link.kind) {
    case 'scanning':
      return `${hand} · scanning`;
    case 'nearby':
      return `${hand} · ${link.discovered.length} nearby`;
    case 'connecting':
      return `${hand} · connecting`;
    case 'connected':
      return isSimulatedLink(link) ? `${hand} · simulated` : `${hand} · connected`;
    case 'disconnected':
      return `${hand} · disconnected`;
    case 'unavailable':
      return `${hand} · unavailable`;
    case 'error':
      return `${hand} · error`;
    default:
      return `${hand} · not connected`;
  }
}

/**
 * A device name fit to show a person.
 *
 * The simulator advertises the sentinel `__demo__` so that no code path can
 * confuse it with hardware. That sentinel is not something to put on screen, so
 * it is translated here — in exactly one place, next to the constant it
 * translates, so the two cannot drift apart. Every other name is passed through
 * unchanged: a real glove's advertised name is whatever the firmware chose, and
 * rewriting it would hide information during the protocol work.
 */
export function deviceDisplayName(name: string): string {
  return name === MOCK_DEVICE_NAME ? 'Demo glove (simulated)' : name;
}
