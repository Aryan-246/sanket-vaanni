/**
 * Glove controller.
 *
 * Owns one transport, its link state machine and its sample stream, and
 * publishes a single immutable snapshot.
 *
 * ## Why this is a plain class and not a hook
 *
 * The lifecycle here is genuinely stateful — two subscriptions, a throttle
 * clock, a processing pipeline and a dispose path — and getting it wrong
 * produces exactly the failures the brief calls out: intervals that outlive
 * their screen, and stale results overwriting newer ones. Expressing it as a
 * class means it can be unit-tested without React, and means the React layer
 * only has to subscribe.
 *
 * ## Update rate
 *
 * Sensor frames arrive at 20 Hz. React does not need to see all of them: the
 * snapshot is rebuilt on every frame but listeners are notified at most
 * `uiHz` times a second. Components that do not display live values never
 * subscribe at all, so a sample never re-renders the recognition panel.
 */
import {
  INITIAL_LINK,
  isSimulatedLink,
  linkReducer,
  linkStateFromTransport,
  type LinkAction,
  type LinkState,
} from './link';
import type {
  DiscoveredGlove,
  GloveSide,
  GloveTransport,
  SuspendableTransport,
  TransportStatus,
  Unsubscribe,
} from './types';
import type { DataSource } from '../audit/status';
import {
  CalibrationError,
  createDemoCalibration,
  type CalibrationProfile,
} from '../sensors/calibration';
import { createProcessingPipeline } from '../sensors/processing';
import type { RawSample, SensorSample } from '../sensors/types';

/** How often subscribers are notified about new samples. */
const DEFAULT_UI_HZ = 12;

/** A packet older than this is not "live" any more. */
export const PACKET_STALE_MS = 1500;

export interface GloveSnapshot {
  readonly side: GloveSide;
  readonly link: LinkState;
  /**
   * Where the current readings come from.
   *
   * `none` whenever there is no live stream — including while connected but
   * before the first packet arrives. That gap is deliberate: showing
   * `simulated` before any data exists would label an absence as data.
   */
  readonly source: DataSource;
  /** Last raw frame, for the "raw" column. */
  readonly raw: RawSample | null;
  /** Last calibrated frame, for the bend column. */
  readonly calibrated: SensorSample | null;
  readonly lastPacketAtMs: number | null;
  readonly packetCount: number;
  readonly transportName: string;
  /** True when this transport is a simulator, regardless of connection state. */
  readonly synthetic: boolean;
  /** False while the transport reports it cannot operate at all. */
  readonly available: boolean;
  /** True only when valid, fresh frames are actively arriving from this glove. */
  readonly receivingData?: boolean;
}

export interface GloveControllerOptions {
  readonly calibration?: CalibrationProfile;
  readonly uiHz?: number;
  /** Injectable clock, so tests can control staleness without real time. */
  readonly now?: () => number;
}

export type GloveListener = (snapshot: GloveSnapshot) => void;

/**
 * Receives every calibrated frame, at the transport's own rate.
 *
 * Used by recording and by live inference, both of which need the frames the
 * throttled snapshot stream would drop.
 */
export type FrameListener = (sample: SensorSample) => void;

export class GloveController {
  readonly side: GloveSide;

  readonly #transport: GloveTransport;
  #calibration: CalibrationProfile;
  #pipeline: ReturnType<typeof createProcessingPipeline>;
  readonly #now: () => number;
  readonly #minEmitIntervalMs: number;

  #link: LinkState;
  #raw: RawSample | null = null;
  #calibrated: SensorSample | null = null;
  #lastPacketAtMs: number | null = null;
  #packetCount = 0;
  #lastEmitMs = 0;

  #listeners = new Set<GloveListener>();
  #statusUnsub: Unsubscribe | null = null;
  #sampleUnsub: Unsubscribe | null = null;
  #staleTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  #paused = false;
  readonly #frameListeners = new Set<FrameListener>();

  #snapshot: GloveSnapshot;

  constructor(side: GloveSide, transport: GloveTransport, options: GloveControllerOptions = {}) {
    this.side = side;
    this.#transport = transport;
    this.#calibration = options.calibration ?? createDemoCalibration(side);
    this.#pipeline = createProcessingPipeline(this.#calibration);
    this.#now = options.now ?? (() => Date.now());
    this.#minEmitIntervalMs = 1000 / (options.uiHz ?? DEFAULT_UI_HZ);

    this.#link = linkStateFromTransport(transport.getStatus());
    this.#snapshot = this.#buildSnapshot();

    this.#statusUnsub = transport.onStatusChange(this.#handleStatus);
    this.#sampleUnsub = transport.subscribe(this.#handleSample);
  }

  getCalibration(): CalibrationProfile {
    return this.#calibration;
  }

  setCalibration(calibration: CalibrationProfile): void {
    if (calibration.side !== this.side) {
      throw new CalibrationError(
        `Calibration is for the ${calibration.side} glove but the controller is for the ${this.side} glove`,
      );
    }
    this.#calibration = calibration;
    this.#pipeline = createProcessingPipeline(calibration);
  }

  getSnapshot(): GloveSnapshot {
    if (this.#snapshot.receivingData && !this.isPacketFresh()) {
      this.#snapshot = this.#buildSnapshot();
    }
    return this.#snapshot;
  }

  subscribe(listener: GloveListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Every calibrated frame, at the transport's own rate.
   *
   * Separate from `subscribe` on purpose. `subscribe` is throttled to `uiHz`
   * because React does not need 20 renders a second — but a *recording* does
   * need every frame. Reconstructing a window from the throttled stream would
   * silently drop roughly two frames in five, and the resampling in
   * `ml/window.ts` would then interpolate across gaps that the glove never had.
   *
   * Nothing is notified when the controller is paused: a paused controller is
   * not producing data, and a recorder must not hold a frozen stream.
   */
  onFrame(listener: FrameListener): Unsubscribe {
    this.#frameListeners.add(listener);
    return () => {
      this.#frameListeners.delete(listener);
    };
  }

  /**
   * Discovers nearby gloves.
   *
   * Resolves with what was actually found — possibly nothing, possibly a
   * rejection from a transport that cannot scan. It never resolves with a
   * fabricated device.
   */
  async scan(): Promise<readonly DiscoveredGlove[]> {
    if (this.#disposed || this.#link.kind === 'unavailable') return [];

    this.#dispatch({ type: 'scan-start' });
    try {
      const devices = await this.#transport.scan();
      this.#dispatch({ type: 'scan-result', devices, atMs: this.#now() });
      return devices;
    } catch (error) {
      this.#dispatch({ type: 'scan-failed', reason: messageOf(error) });
      return [];
    }
  }

  /** Connects to a device id that came from `scan`. */
  async connect(deviceId: string): Promise<void> {
    if (this.#disposed) return;
    if (this.#link.kind === 'unavailable') return;

    const device =
      this.#link.discovered.find((candidate) => candidate.id === deviceId) ??
      ({ id: deviceId, name: deviceId, side: this.side, rssi: null } as DiscoveredGlove);

    this.#dispatch({ type: 'connect-start', device });
    try {
      await this.#transport.connect(deviceId);
      // The transport's own status change is what moves the link to
      // `connected`. Nothing is dispatched here on success, so a transport that
      // resolves without reporting a connection cannot produce a fake one.
    } catch (error) {
      this.#dispatch({ type: 'connect-failed', reason: messageOf(error) });
    }
  }

  async disconnect(): Promise<void> {
    if (this.#disposed) return;
    if (this.#staleTimer) {
      clearTimeout(this.#staleTimer);
      this.#staleTimer = null;
    }
    try {
      await this.#transport.disconnect();
    } catch (error) {
      this.#dispatch({ type: 'connect-failed', reason: messageOf(error) });
    }
    // Clear readings: the last frame from a closed link is not current data.
    this.#raw = null;
    this.#calibrated = null;
    this.#packetCount = 0;
    this.#emit(true);
  }

  /**
   * Re-attempts whatever failed, without inventing a new state.
   *
   * Rescans first when there is nothing to connect to, so a retry after a
   * failed scan does something useful rather than repeating a connect to a
   * device that is no longer known.
   */
  async retry(): Promise<void> {
    if (this.#disposed) return;
    if (this.#link.kind === 'unavailable') {
      // Re-read the transport in case the underlying condition changed; do not
      // pretend the retry succeeded.
      this.#link = linkStateFromTransport(this.#transport.getStatus());
      this.#emit(true);
      return;
    }

    const devices =
      this.#link.discovered.length > 0 ? this.#link.discovered : await this.scan();
    const first = devices[0];
    if (first !== undefined) {
      await this.connect(first.id);
    }
  }

  async sendOledCommand(command: Record<string, unknown>): Promise<void> {
    if (this.#disposed) return;
    if (typeof this.#transport.sendOledCommand === 'function') {
      await this.#transport.sendOledCommand(command);
    }
  }

  /**
   * Suspends or resumes frame production without dropping the link.
   *
   * A no-op for transports that do not implement `SuspendableTransport`, which
   * is preferred to disconnecting on the user's behalf — they would come back
   * to an app that had silently let go of their glove.
   *
   * Readings are cleared while paused, so a screen that is still mounted but
   * no longer receiving cannot keep showing the last frame as if it were live.
   */
  pause(paused: boolean): void {
    if (this.#disposed || paused === this.#paused) return;
    this.#paused = paused;

    const suspendable = this.#transport as Partial<SuspendableTransport>;
    if (paused) {
      suspendable.pause?.();
    } else {
      suspendable.resume?.();
    }
  }

  /** True while frame production is suspended. */
  get isPaused(): boolean {
    return this.#paused;
  }

  /** Releases both subscriptions and disposes the transport's timers. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    if (this.#staleTimer) {
      clearTimeout(this.#staleTimer);
      this.#staleTimer = null;
    }

    this.#statusUnsub?.();
    this.#sampleUnsub?.();
    this.#statusUnsub = null;
    this.#sampleUnsub = null;

    const disposable = this.#transport as GloveTransport & { dispose?: () => void };
    disposable.dispose?.();

    this.#pipeline.reset();
    this.#listeners.clear();
    this.#frameListeners.clear();
  }

  /** True when the last packet is recent enough to be considered live. */
  isPacketFresh(): boolean {
    if (this.#lastPacketAtMs === null) return false;
    return this.#now() - this.#lastPacketAtMs <= PACKET_STALE_MS;
  }

  /* ------------------------------------------------------------- internals */

  #handleStatus = (status: TransportStatus): void => {
    if (this.#disposed) return;

    const next = linkStateFromTransport(status);

    if (status.kind === 'connected') {
      // Preserve the device id learned during connect; the transport reports
      // only a display name.
      this.#link = { ...this.#link, ...next, discovered: this.#link.discovered };
    } else if (status.kind === 'disconnected' || status.kind === 'idle') {
      this.#raw = null;
      this.#calibrated = null;
      this.#packetCount = 0;
      this.#link = { ...this.#link, ...next };
    } else if (status.kind === 'scanning' || status.kind === 'connecting') {
      this.#link = { ...this.#link, kind: next.kind, reason: null };
    } else if (status.kind === 'unavailable' || status.kind === 'error') {
      this.#link = { ...this.#link, ...next };
    }

    this.#emit(true);
  };

  #handleSample = (raw: RawSample): void => {
    if (this.#disposed) return;

    // A frame from a glove other than this controller's is a wiring bug, and
    // silently accepting it would put the wrong hand's data on screen.
    if (raw.side !== this.side) return;

    this.#raw = raw;
    this.#calibrated = this.#pipeline.process(raw);
    this.#packetCount += 1;
    this.#lastPacketAtMs = this.#now();

    if (this.#staleTimer) clearTimeout(this.#staleTimer);
    this.#staleTimer = setTimeout(() => {
      if (!this.#disposed && this.#link.kind === 'connected' && !this.isPacketFresh()) {
        this.#emit(true);
      }
    }, PACKET_STALE_MS + 50);

    /*
     * Every frame goes to the frame listeners, before the throttle below. A
     * recorder that only saw the throttled stream would be missing frames.
     */
    const frame = this.#calibrated;
    for (const listener of this.#frameListeners) listener(frame);

    const now = this.#now();
    if (now - this.#lastEmitMs >= this.#minEmitIntervalMs) {
      this.#lastEmitMs = now;
      this.#emit(false);
    }
  };

  #dispatch(action: LinkAction): void {
    const next = linkReducer(this.#link, action);
    if (next === this.#link) return;
    this.#link = next;
    this.#emit(true);
  }

  /**
   * Rebuilds the snapshot and notifies.
   *
   * The rebuild happens whether or not anyone is subscribed to the throttled
   * channel, and the notification is what the early return skips.
   *
   * That order matters. `getSnapshot` is a public read, and it is read from
   * outside React: `AppState`'s `gloveInfo` calls it to decide whether a glove
   * is delivering data, which is what lets the learning centre open a recording
   * session. Skipping the rebuild when `#listeners` was empty would leave that
   * decision reading a snapshot from the last status change — so a streaming
   * glove would report `source: 'none'` while no React component happened to be
   * subscribed, and "Start a recording session" would refuse on a working glove.
   * That is reachable: the dashboard unmounts when a detail screen is pushed, and
   * the learning centre *is* a detail screen.
   *
   * A new object is only created when the snapshot is actually going to change
   * or be published, so `getSnapshot` stays referentially stable between
   * notifying changes — which is what `useSyncExternalStore` requires to avoid an
   * infinite render loop. The caller in `#handleSample` applies the throttle, so
   * this still runs at most `uiHz` times a second.
   */
  #emit(force: boolean): void {
    if (this.#disposed) return;

    this.#snapshot = this.#buildSnapshot();
    if (!force && this.#listeners.size === 0) return;

    for (const listener of this.#listeners) {
      listener(this.#snapshot);
    }
  }

  #buildSnapshot(): GloveSnapshot {
    const live = this.#link.kind === 'connected';

    let source: DataSource = 'none';
    if (live) {
      source = isSimulatedLink(this.#link) || this.#transport.isSynthetic ? 'simulated' : 'real';
    }

    const isFresh = this.#lastPacketAtMs !== null && this.#now() - this.#lastPacketAtMs <= PACKET_STALE_MS;
    const receivingData = live && isFresh && this.#calibrated !== null;

    return {
      side: this.side,
      link: this.#link,
      // Connected but no frame yet is `none`, not a source we have not seen.
      source: this.#calibrated === null ? 'none' : source,
      raw: this.#raw,
      calibrated: this.#calibrated,
      lastPacketAtMs: this.#lastPacketAtMs,
      packetCount: this.#packetCount,
      transportName: this.#transport.name,
      synthetic: this.#transport.isSynthetic,
      available: this.#link.kind !== 'unavailable',
      receivingData,
    };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export { INITIAL_LINK };
