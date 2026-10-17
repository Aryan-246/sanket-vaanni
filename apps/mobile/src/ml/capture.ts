/**
 * Recording a window and attaching a sign to it.
 *
 * ## The rule this file exists to hold
 *
 * **Nothing is labelled until a person labels it.** Sensor motion is not a
 * gesture. A window that has been recorded and not yet confirmed is a pending
 * window — it is stored, so a crash cannot lose it, but it is stored *as* a
 * pending window rather than as a sample under a guessed label, and nothing
 * downstream can train on it. That is why `pendingWindow` is a separate storage
 * key rather than a sample row with an empty label.
 *
 * ## Why the session is a first-class thing
 *
 * Windows captured minutes apart in one sitting are near-duplicates, and the
 * split in `split.ts` relies on knowing which sitting each came from. So a
 * capture is a session with an id, and every window carries it. The session also
 * carries what the windows were captured with — the transport's own name, the
 * calibration version, the pipeline version — because a dataset whose provenance
 * was not written down cannot be defended later.
 *
 * ## Checkpointing
 *
 * Each confirmed window is handed to the sink and written immediately; each
 * state change writes the session count. Nothing is buffered until the end,
 * because the end is exactly what a crash prevents. A session that is never
 * closed is recovered as `interrupted` on the next launch, keeping every window
 * that was saved.
 *
 * ## Cancellation is a first-class outcome
 *
 * A recording can be abandoned part-way, and the partial window is thrown away
 * rather than padded to length — a half window padded to 30 frames is a window
 * that never happened, and training on it would teach the model a hand shape the
 * person never made.
 */
import type { GloveSide, SensorSample } from '../sensors/types';
import { windowFingerprint } from './dataset';
import { buildWindow, qualityNote } from './window';
import {
  DATASET_VERSION,
  PREPROCESSING_VERSION,
  WINDOW_FRAMES,
  WINDOW_MS,
  type CaptureSessionMeta,
  type HandContext,
  type Modality,
  type SampleQuality,
  type SampleSource,
  type SensorWindowSample,
} from './types';

/** Where a capture has got to. Every one of these is reachable from the UI. */
export type CapturePhase =
  /** No session. Nothing is being recorded. */
  | 'idle'
  /** A session is open and waiting for the user to start a window. */
  | 'ready'
  /** Collecting frames. */
  | 'recording'
  /** The window is built and waiting for the user to say which sign it is. */
  | 'awaiting-label'
  /** Writing a confirmed window. */
  | 'saving'
  /** The session is closed. */
  | 'closed';

/** A window that exists but has no confirmed sign yet. */
export interface PendingWindow {
  readonly sessionId: string;
  readonly side: GloveSide;
  readonly handContext: HandContext;
  readonly source: SampleSource;
  readonly languageId: string;
  readonly frames: SensorWindowSample['frames'];
  readonly quality: SampleQuality;
  readonly capturedAtMs: number;
  readonly calibrationVersion: number | null;
  readonly sourceHz: number;
  /** True when this is a window that was saved and is being corrected. */
  readonly replacingSampleId: string | null;
}

export interface CaptureState {
  readonly phase: CapturePhase;
  readonly session: CaptureSessionMeta | null;
  /** Frames collected in the window being recorded. */
  readonly frames: number;
  /**
   * Frames a full window needs, or 0 while recording.
   *
   * Zero until the window completes, because the arrival rate is the transport's
   * and not ours: a count "needed" derived from a nominal rate would be a guess
   * shown as a target. Progress is measured by `elapsedMs` against `targetMs`,
   * which is real.
   */
  readonly framesNeeded: number;
  /** Milliseconds recorded so far, measured from the first frame. */
  readonly elapsedMs: number;
  /** Milliseconds a full window spans. */
  readonly targetMs: number;
  readonly pending: PendingWindow | null;
  /** What the last saved window was, so the screen can confirm it. */
  readonly lastSaved: { readonly sampleId: string; readonly labelId: string; readonly atMs: number } | null;
  /** A sentence about the current window's signal, or null. */
  readonly qualityNote: string | null;
  readonly error: string | null;
}

/** What the sink must be able to persist. Implemented by `store.ts`. */
export interface CaptureSink {
  saveSample(sample: SensorWindowSample): Promise<void>;
  putPendingWindow(pending: PendingWindow | null): Promise<void>;
  saveSession(session: CaptureSessionMeta): Promise<void>;
  /** Flags a stored window as not being the sign it was recorded under. */
  markRejected(sampleId: string, reason: string): Promise<void>;
}

export interface CaptureDeps {
  readonly sink: CaptureSink;
  readonly newId: () => string;
  readonly now: () => number;
  /**
   * Whose account a new window belongs to, or null in guest mode.
   *
   * Asked at the moment a window is saved rather than captured once, because a
   * person can sign in *between* opening a session and confirming a window — the
   * account provider is mounted inside the state provider, so the centre learns
   * who it belongs to after it has already started. Reading it once at
   * construction would stamp a guest's id on a signed-in person's recording.
   *
   * Optional so a caller with no account concept — the pipeline's own tests —
   * need not invent one. Absent and "signed out" both mean null, which is the
   * honest value: a recording nobody owns is a guest's recording.
   */
  readonly currentOwnerId?: () => string | null;
  /** Called on every state change, the same shape as the other controllers. */
  readonly onChange?: () => void;
}

/** What the caller must know to open a session. */
export interface StartSessionInput {
  readonly languageId: string;
  readonly modality: Modality;
  readonly source: SampleSource;
  /**
   * Which glove this session records from.
   *
   * Required, and enforced against every frame. A session that accepted frames
   * from both hands would build windows out of two gloves' readings, and nothing
   * downstream could tell that had happened. The two transports are separate
   * controllers, so the caller always knows which one it is recording.
   */
  readonly side: GloveSide;
  /** The transport's own name, e.g. `Demo Mode (simulated)`. */
  readonly deviceLabel: string | null;
  readonly calibrationVersion: number | null;
  /**
   * Which hand the person is signing with, as the caller states it.
   *
   * Deliberately *not* inferred from the frames: a run of readings from the right
   * glove says which sensor moved, not which hand the person meant to use, and a
   * two-handed sign recorded from one glove is normal. Reading it off the motion
   * would be the same mistake as reading a label off the motion.
   */
  readonly handContext: HandContext;
}

export class CaptureController {
  private readonly deps: CaptureDeps;
  private state: CaptureState;
  private collected: SensorSample[] = [];
  /** The glove this session records from, set when the session opens. */
  private side: GloveSide | null = null;
  /** The hand the caller said the person is signing with. */
  private handContext: HandContext = 'right';

  constructor(deps: CaptureDeps) {
    this.deps = deps;
    this.state = {
      phase: 'idle',
      session: null,
      frames: 0,
      framesNeeded: 0,
      elapsedMs: 0,
      targetMs: WINDOW_MS,
      pending: null,
      lastSaved: null,
      qualityNote: null,
      error: null,
    };
  }

  readonly getSnapshot = (): CaptureState => this.state;

  /**
   * Opens a session.
   *
   * A session is written immediately, so that even a launch which crashes during
   * the very first window leaves a record of what was being attempted.
   */
  async startSession(input: StartSessionInput): Promise<void> {
    const nowMs = this.deps.now();
    this.side = input.side;
    this.handContext = input.handContext;
    const session: CaptureSessionMeta = {
      id: this.deps.newId(),
      languageId: input.languageId,
      modality: input.modality,
      source: input.source,
      deviceLabel: input.deviceLabel,
      startedAtMs: nowMs,
      endedAtMs: null,
      status: 'open',
      sampleCount: 0,
      calibrationVersion: input.calibrationVersion,
      preprocessingVersion: PREPROCESSING_VERSION,
      note: null,
    };

    this.collected = [];
    this.state = {
      ...this.state,
      phase: 'ready',
      session,
      frames: 0,
      elapsedMs: 0,
      pending: null,
      qualityNote: null,
      error: null,
    };
    this.emit();
    await this.deps.sink.saveSession(session);
  }

  /**
   * Starts collecting a window.
   *
   * Refused while a window is already recording or awaiting a label: overlapping
   * windows would produce two samples sharing frames, which the duplicate check
   * would then have to untangle.
   */
  beginWindow(): { ok: true } | { ok: false; reason: string } {
    if (this.state.session === null) {
      return { ok: false, reason: 'No capture session is open.' };
    }
    if (this.state.phase === 'recording') {
      return { ok: false, reason: 'A window is already being recorded.' };
    }
    if (this.state.phase === 'awaiting-label') {
      return {
        ok: false,
        reason: 'The window that was just recorded still needs a sign before another can start.',
      };
    }
    if (this.state.session.languageId.length === 0) {
      return { ok: false, reason: 'Choose a sign language before recording.' };
    }

    this.collected = [];
    this.state = {
      ...this.state,
      phase: 'recording',
      frames: 0,
      framesNeeded: 0,
      elapsedMs: 0,
      qualityNote: null,
      error: null,
    };
    this.emit();
    return { ok: true };
  }

  /**
   * Feeds one calibrated frame in. Ignored unless a window is recording.
   *
   * Ignoring rather than erroring is deliberate: frames arrive from a
   * subscription that is live whenever the glove is, and a frame arriving
   * between windows is normal, not a fault.
   *
   * Returns true when the window has just completed, so a caller can await the
   * resulting state change if it needs to.
   */
  pushFrame(sample: SensorSample): boolean {
    if (this.state.phase !== 'recording' || this.state.session === null) return false;

    // A frame from the other hand is not part of this window. The glove
    // controller already filters by side; this is the second line of defence —
    // and the first one that catches a whole window arriving from the wrong
    // glove, because it compares against the session's own side rather than
    // against whichever frame happened to arrive first.
    if (this.side !== null && sample.side !== this.side) return false;

    this.collected.push(sample);
    const first = this.collected[0]!;
    const elapsedMs = sample.timestampMs - first.timestampMs;

    this.state = {
      ...this.state,
      frames: this.collected.length,
      elapsedMs: Math.max(0, elapsedMs),
    };
    this.emit();

    if (elapsedMs >= WINDOW_MS) {
      void this.finishWindow();
      return true;
    }
    return false;
  }

  /**
   * Ends the window early, or builds it if the time is already up.
   *
   * Used by the "finish now" control and by `pushFrame` itself, so an early stop
   * and a full-length window take exactly the same path.
   */
  async finishWindow(): Promise<void> {
    if (this.state.phase !== 'recording' || this.state.session === null) return;

    const session = this.state.session;
    const built = buildWindow(this.collected, { frames: WINDOW_FRAMES });

    if (!built.ok) {
      this.collected = [];
      this.state = {
        ...this.state,
        phase: 'ready',
        frames: 0,
        elapsedMs: 0,
        error: built.reason,
      };
      this.emit();
      return;
    }

    const pending: PendingWindow = {
      sessionId: session.id,
      side: this.side ?? this.collected[0]!.side,
      handContext: this.handContext,
      source: session.source,
      languageId: session.languageId,
      frames: built.frames,
      quality: built.quality,
      capturedAtMs: this.deps.now(),
      calibrationVersion: session.calibrationVersion,
      sourceHz: estimateHz(this.collected),
      replacingSampleId: null,
    };

    this.collected = [];
    this.state = {
      ...this.state,
      phase: 'awaiting-label',
      frames: built.quality.frameCount,
      elapsedMs: 0,
      pending,
      qualityNote: qualityNote(built.quality),
      error: null,
    };
    this.emit();

    // Written before the label prompt appears, so a crash here loses nothing.
    await this.deps.sink.putPendingWindow(pending);
  }

  /**
   * Abandons the window in progress, or the one awaiting a label.
   *
   * A partial recording is discarded, never padded. The pending window is
   * cleared from storage, because a window nobody will label is not data.
   */
  async cancel(): Promise<void> {
    this.collected = [];

    if (this.state.phase === 'awaiting-label' || this.state.pending !== null) {
      await this.deps.sink.putPendingWindow(null);
    }

    this.state = {
      ...this.state,
      phase: this.state.session === null ? 'idle' : 'ready',
      frames: 0,
      elapsedMs: 0,
      pending: null,
      qualityNote: null,
      error: null,
    };
    this.emit();
  }

  /**
   * Confirms which sign the pending window is, and saves it.
   *
   * `labelId === null` saves it as **pending**, not as a labelled example. That
   * is what "I am not sure what I just did" looks like: the motion is kept, it
   * appears in the library as unconfirmed, and the trainer will not touch it.
   */
  async confirm(labelId: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
    const pending = this.state.pending;
    if (pending === null || this.state.session === null) {
      return { ok: false, reason: 'There is no recorded window waiting for a sign.' };
    }

    const session = this.state.session;
    const sampleId = pending.replacingSampleId ?? this.deps.newId();
    const atMs = this.deps.now();
    const labelIdForRecord = labelId ?? UNCONFIRMED_LABEL_ID;

    const sample: SensorWindowSample = {
      id: sampleId,
      sessionId: pending.sessionId,
      /*
       * Stamped from the account as it stands at this instant. It used to be a
       * hard-coded null, which meant every recording — including one made by a
       * signed-in account — was stored as belonging to nobody. Nothing read the
       * field, so nothing failed; but a sample that cannot say whose it is cannot
       * be exported, synchronised or deleted on an owner's behalf later, and the
       * window to fix that is before the data exists rather than after.
       */
      ownerId: this.deps.currentOwnerId?.() ?? null,
      languageId: pending.languageId,
      // A pending save keeps the id it was given, but is not approved — the
      // approval state is what stops it being trained on, not a fake label.
      labelId: labelIdForRecord,
      modality: 'glove-sensor',
      source: pending.source,
      handContext: pending.handContext,
      approval: labelId === null ? 'pending' : 'approved',
      quality: pending.quality,
      capturedAtMs: pending.capturedAtMs,
      calibrationVersion: pending.calibrationVersion,
      preprocessingVersion: PREPROCESSING_VERSION,
      datasetVersion: DATASET_VERSION,
      fingerprint: windowFingerprint({
        languageId: pending.languageId,
        labelId: labelIdForRecord,
        side: pending.side,
        source: pending.source,
        handContext: pending.handContext,
        frames: pending.frames,
      }),
      rejectionReason: null,
      side: pending.side,
      frames: pending.frames,
      sourceHz: pending.sourceHz,
    };

    this.state = { ...this.state, phase: 'saving', error: null };
    this.emit();

    await this.deps.sink.saveSample(sample);

    const updated: CaptureSessionMeta = {
      ...session,
      sampleCount: session.sampleCount + 1,
    };

    this.state = {
      ...this.state,
      phase: 'ready',
      session: updated,
      pending: null,
      qualityNote: null,
      lastSaved: { sampleId: sample.id, labelId: sample.labelId, atMs },
    };
    this.emit();

    // The count is written with the window, so the session record cannot claim
    // more windows than were actually stored.
    await this.deps.sink.putPendingWindow(null);
    await this.deps.sink.saveSession(updated);
    return { ok: true };
  }

  /**
   * Marks the last saved window as not being the sign it was recorded under.
   *
   * The window is kept and flagged `rejected`, never deleted: what a person
   * decided about their own recording is part of the record, and a rejected
   * window is exactly the evidence that a sign is hard. The trainer refuses it
   * by rule — see `trainableSet`.
   */
  async rejectLast(sampleId: string, reason: string): Promise<void> {
    await this.deps.sink.markRejected(sampleId, reason);
    this.state = { ...this.state, lastSaved: null, error: null };
    this.emit();
  }

  /** Closes the session, marking it closed and stamping its end. */
  async closeSession(): Promise<void> {
    const session = this.state.session;
    if (session === null) return;

    const closed: CaptureSessionMeta = {
      ...session,
      status: 'closed',
      endedAtMs: this.deps.now(),
    };

    this.state = { ...this.state, phase: 'closed', session: closed, pending: null };
    this.emit();
    await this.deps.sink.putPendingWindow(null);
    await this.deps.sink.saveSession(closed);
  }

  private emit(): void {
    this.deps.onChange?.();
  }
}

/**
 * The label id a window carries while it is unconfirmed.
 *
 * Not a real label and deliberately not a readable word: it must never be
 * mistaken for a sign somebody chose, and `trainableSet` refuses it because the
 * sample's `approval` is `pending`.
 */
export const UNCONFIRMED_LABEL_ID = '__unconfirmed__';

/** Observed frame rate, rounded, for the record. Never a nominal guess. */
function estimateHz(samples: readonly SensorSample[]): number {
  if (samples.length < 2) return 0;
  const spanMs = samples[samples.length - 1]!.timestampMs - samples[0]!.timestampMs;
  if (spanMs <= 0) return 0;
  return Math.round(((samples.length - 1) / spanMs) * 1000);
}
