/**
 * The learning centre as one wired object.
 *
 * ## Why this exists rather than the screen doing the wiring
 *
 * Three things have to agree about the same frames: the recorder needs every
 * frame from the glove a session is recording from, live inference needs the
 * same frames buffered into a window, and the active model has to be re-read
 * from storage whenever a version is activated, withdrawn or deleted. Doing
 * that inside a screen means it is rebuilt on every mount, torn down on every
 * unmount, and untestable without rendering anything.
 *
 * So the centre is a plain class. It owns a `MlStore`, a `CaptureController`
 * and a `LiveInference`, subscribes to frame sources itself, and exposes one
 * snapshot for the screens to read. `AppState` constructs it once, the same way
 * it constructs the glove controllers.
 *
 * ## Frames come from an interface, not from `GloveController`
 *
 * `FrameSource` is the single method this needs — `onFrame`. That keeps the
 * centre constructible in a test with a hand-cranked producer and no transport,
 * no timers and no native modules, which is the only way the wiring itself can
 * be asserted rather than assumed.
 *
 * ## What the centre refuses to do
 *
 * It will not open a capture session when no source is connected. A session
 * that recorded nothing but silence would produce windows of nothing, and the
 * honest answer to "record this sign" with no glove is "there is nothing to
 * record from", not an empty session the user then has to interpret.
 *
 * It also does not decide what a window *is*. Frames go into the recorder; the
 * label comes back only from a person, through `capture.confirm`.
 */
import type { GloveSide } from '../sensors/types';
import type { SensorSample } from '../sensors/types';
import type { Storage } from '../storage';
import { CaptureController, type CaptureState, type StartSessionInput } from './capture';
import { LiveInference, type InferenceState } from './inference';
import { MlStore, type MlSnapshot, type ModelSummary } from './store';
import type { MediaPicker } from './media';
import type { HandContext, ModelRecord, SampleSource } from './types';

/** The one thing a frame producer has to offer. Implemented by `GloveController`. */
export interface FrameSource {
  onFrame(listener: (sample: SensorSample) => void): () => void;
}

/**
 * What the app knows about a glove that the centre needs in order to record.
 *
 * Passed as a function rather than as values because it is read at the moment a
 * session starts, and a connection can change while the screen is open. A
 * captured-then-stale snapshot would let a session start against a glove that
 * has since gone away.
 */
export interface GloveInfo {
  /** Whether a link is up and frames are being produced. */
  readonly connected: boolean;
  /** False for the Demo Mode producer. A simulated source is recorded as such. */
  readonly real: boolean;
  /** The transport's own name, e.g. `Demo Mode (simulated)`. */
  readonly transportName: string;
  /** The calibration the frames were produced under, or null. */
  readonly calibrationVersion: number | null;
}

export interface MlCentreDeps {
  readonly storage: Storage;
  readonly newId: () => string;
  readonly now: () => number;
  /** The sign language the centre opens on. */
  readonly defaultLanguageId: string;
  readonly sources: Readonly<Record<GloveSide, FrameSource>>;
  readonly gloveInfo: (side: GloveSide) => GloveInfo;
  readonly picker: MediaPicker;
}

/**
 * Who the recordings belong to.
 *
 * Told to the centre rather than read by it, because the account provider is
 * mounted *inside* the state provider — the same direction that makes
 * `PushAccountSync` a component in `RootNavigator.tsx` rather than a read. The
 * centre starts as a guest's, and a signed-in account claims it.
 */
export interface MlAccount {
  readonly ownerId: string | null;
  /** True for a real signed-in user; false for a guest, including anonymous ones. */
  readonly signedIn: boolean;
}

const GUEST: MlAccount = { ownerId: null, signedIn: false };

export interface MlCentreSnapshot {
  readonly capture: CaptureState;
  readonly inference: InferenceState;
  /**
   * The live model, as its card.
   *
   * A summary rather than the record, because the record's weights are the one
   * thing no screen needs — see `toSummary`. Live prediction keeps its own
   * reference to the full record.
   */
  readonly activeModel: ModelSummary | null;
  /** The run in flight, or the last one's final line. Null when none has run. */
  readonly training: ReturnType<MlStore['getProgress']>;
  readonly training_: boolean;
}

export class MlCentre {
  readonly store: MlStore;
  readonly capture: CaptureController;
  readonly inference: LiveInference;
  readonly picker: MediaPicker;

  private readonly deps: MlCentreDeps;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[] = [];

  /** The full record behind `snapshot.activeModel`, for prediction only. */
  private activeRecord: ModelRecord | null = null;
  /** Change signature of the model index, so a reload happens only when it moves. */
  private modelSignature = '';
  private liveUpdates = false;
  private started = false;
  private disposed = false;
  private account: MlAccount = GUEST;
  private snapshot: MlCentreSnapshot;

  constructor(deps: MlCentreDeps) {
    this.deps = deps;
    this.picker = deps.picker;

    this.store = new MlStore({
      storage: deps.storage,
      newId: deps.newId,
      now: deps.now,
      defaultLanguageId: deps.defaultLanguageId,
      currentOwnerId: () => this.account.ownerId,
    });

    this.capture = new CaptureController({
      sink: this.store,
      newId: deps.newId,
      now: deps.now,
      /*
       * Read through the centre rather than captured, so a window confirmed after
       * a sign-in belongs to the account that confirmed it.
       */
      currentOwnerId: () => this.account.ownerId,
      onChange: () => this.emit(),
    });

    this.inference = new LiveInference({
      now: deps.now,
      onUpdate: () => this.emit(),
    });

    this.snapshot = {
      capture: this.capture.getSnapshot(),
      inference: this.inference.getSnapshot(),
      activeModel: null,
      training: null,
      training_: false,
    };
  }

  /**
   * Reads storage, subscribes to the frame sources and loads the live model.
   *
   * Idempotent: a second call before `dispose` does nothing, so a screen that
   * mounts twice cannot double every frame into the recorder.
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;

    await this.store.start();

    this.unsubscribes.push(
      this.store.subscribe(() => {
        void this.syncActiveModel();
        this.refreshTraining();
      }),
    );

    for (const side of ['left', 'right'] as const) {
      const source = this.deps.sources[side];
      this.unsubscribes.push(source.onFrame((sample) => this.handleFrame(sample)));
    }

    await this.syncActiveModel();
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.listeners.clear();
    this.inference.dispose();
    this.store.dispose();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): MlCentreSnapshot => this.snapshot;

  /** The store's own snapshot, for the screens that render data rather than state. */
  get dataset(): MlSnapshot {
    return this.store.getSnapshot();
  }

  /**
   * Records which account the data belongs to.
   *
   * Called by the account sync component in `RootNavigator`, and again on sign
   * out with `null`. Nothing is migrated between accounts: a guest's recordings
   * stay on the phone and unowned, which is what §4 of the directive requires
   * and what the guest-migration work handles separately.
   */
  setAccount(account: MlAccount): void {
    if (
      this.account.ownerId === account.ownerId &&
      this.account.signedIn === account.signedIn
    ) {
      return;
    }
    this.account = account;
    this.emit();
  }

  /** Who the recordings belong to, for capability descriptions and import. */
  get accountInfo(): MlAccount {
    return this.account;
  }

  /**
   * Points the centre at the sign language the app has selected.
   *
   * The app already has one answer to "which sign language is this build set
   * to" — the profile preference — and the centre having a second one would let
   * the two disagree, with windows filed under a language the rest of the app
   * is not showing.
   */
  setLanguage(languageId: string): void {
    const current = this.store.getSnapshot();
    if (current.languageId === languageId) return;
    this.store.setContext(languageId, current.modality);
  }

  /* ------------------------------------------------------------ live updates */

  /**
   * Turns live evaluation on or off.
   *
   * Off by default, and turned on by the screen that shows it. Evaluating every
   * frame while nobody is watching burns battery for a figure no one can see,
   * and the buffer is cleared on the way out so a reading taken minutes ago is
   * never presented as the current one.
   */
  setLiveUpdates(enabled: boolean): void {
    if (this.liveUpdates === enabled) return;
    this.liveUpdates = enabled;
    if (!enabled) this.inference.reset(this.inferenceContext());
  }

  /* ---------------------------------------------------------------- capture */

  /**
   * Opens a capture session against a real source.
   *
   * Refused when nothing is connected, because a session with no frames produces
   * no windows and would leave the user labelling nothing.
   */
  async beginCapture(input: {
    readonly side: GloveSide | 'both';
    readonly handContext: HandContext;
    readonly targetMs?: number;
    readonly targetFrames?: number;
    readonly sampleIntervalMs?: number;
    readonly recordMode?: 'word' | 'sentence';
    readonly languageId?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    let source: SampleSource = 'simulated';
    let deviceLabel = 'Both Gloves (Left + Right)';
    let calibrationVersion: number | null = null;

    if (input.side === 'both') {
      const leftInfo = this.deps.gloveInfo('left');
      const rightInfo = this.deps.gloveInfo('right');
      if (!leftInfo.connected || !rightInfo.connected) {
        const missing =
          !leftInfo.connected && !rightInfo.connected
            ? 'both the Left and Right gloves'
            : !leftInfo.connected
            ? 'the Left glove'
            : 'the Right glove';
        return {
          ok: false,
          reason: `Please connect ${missing} to record dual-hand gestures, or select a single glove.`,
        };
      }
      deviceLabel = `Left: ${leftInfo.transportName} | Right: ${rightInfo.transportName}`;
      source = leftInfo.real && rightInfo.real ? 'glove' : 'simulated';
      calibrationVersion = rightInfo.calibrationVersion ?? leftInfo.calibrationVersion;
    } else {
      const info = this.deps.gloveInfo(input.side);
      if (!info.connected) {
        return {
          ok: false,
          reason: `No glove is connected on the ${input.side} hand, so there is nothing to record from. Connect a glove, or switch on Demo Mode for that hand.`,
        };
      }
      source = sourceFor(info);
      deviceLabel = info.transportName;
      calibrationVersion = info.calibrationVersion;
    }

    const context = this.store.getSnapshot();
    const languageId = input.languageId ?? context.languageId;
    if (languageId.length === 0) {
      return { ok: false, reason: 'Choose a sign language before recording.' };
    }

    const session: StartSessionInput = {
      languageId,
      modality: 'glove-sensor',
      source,
      side: input.side,
      deviceLabel,
      calibrationVersion,
      handContext: input.handContext,
      targetMs: input.targetMs,
      targetFrames: input.targetFrames,
      sampleIntervalMs: input.sampleIntervalMs,
      recordMode: input.recordMode,
    };

    await this.capture.startSession(session);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- training */

  /**
   * Runs a training job and re-reads the live model afterwards.
   *
   * The reload is the point: a run can activate its own result, and a run that
   * did not must leave the previously active version exactly where it was. Both
   * outcomes are only true of `activeRecord` if it is re-read rather than
   * assumed.
   */
  async train(): Promise<ReturnType<MlStore['train']>> {
    this.refreshTraining();
    this.emit();
    const outcome = await this.store.train(() => {
      this.refreshTraining();
      this.emit();
    });
    await this.syncActiveModel();
    this.refreshTraining();
    this.emit();
    return outcome;
  }

  async activate(modelId: string): Promise<Awaited<ReturnType<MlStore['activate']>>> {
    const result = await this.store.activate(modelId);
    await this.syncActiveModel();
    return result;
  }

  async rollback(): Promise<Awaited<ReturnType<MlStore['rollback']>>> {
    const context = this.store.getSnapshot();
    const result = await this.store.rollback(context.languageId, 'glove-sensor');
    await this.syncActiveModel();
    return result;
  }

  /* ------------------------------------------------ shared cloud vocabulary & data */

  async syncSharedVocabulary(options?: { isAdmin?: boolean }): Promise<ReturnType<MlStore['syncSharedVocabulary']>> {
    const result = await this.store.syncSharedVocabulary(this.store.getSnapshot().languageId, options);
    this.emit();
    return result;
  }

  async createSharedWord(params: {
    text: string;
    note: string | null;
    spokenPhrase?: string | null;
    deviceAlias?: string;
    reason?: string;
    isAdmin?: boolean;
  }): Promise<ReturnType<MlStore['createSharedWord']>> {
    const result = await this.store.createSharedWord(params);
    this.emit();
    return result;
  }

  async archiveWord(labelId: string, options?: { reason?: string; isAdmin?: boolean }): Promise<ReturnType<MlStore['archiveLabel']>> {
    const result = await this.store.archiveLabel(labelId, options);
    this.emit();
    return result;
  }

  async deleteWordPermanently(labelId: string, options?: { reason?: string; isAdmin?: boolean }): Promise<ReturnType<MlStore['deleteLabel']>> {
    const result = await this.store.deleteLabel(labelId, options);
    this.emit();
    return result;
  }

  async syncSharedTrainingData(): Promise<ReturnType<MlStore['syncSharedTrainingData']>> {
    const result = await this.store.syncSharedTrainingData(this.store.getSnapshot().languageId);
    this.emit();
    return result;
  }

  async uploadConsentedSamples(options?: {
    deviceAlias?: string;
    reason?: string;
  }): Promise<ReturnType<MlStore['uploadConsentedSamples']>> {
    return this.store.uploadConsentedSamples({
      languageId: this.store.getSnapshot().languageId,
      ...options,
    });
  }

  /** The context live prediction is fed. Built fresh each time it is needed. */
  private inferenceContext(): {
    model: ModelRecord | null;
    labels: MlSnapshot['labels'];
    settings: MlSnapshot['settings'];
  } {
    const context = this.store.getSnapshot();
    return {
      model: this.activeRecord,
      labels: context.labels,
      settings: context.settings,
    };
  }

  private handleFrame(sample: SensorSample): void {
    if (this.disposed) return;
    this.capture.pushFrame(sample);
    if (this.liveUpdates) this.inference.push(sample, this.inferenceContext());
  }

  /**
   * Re-reads the live model when, and only when, the model index has moved.
   *
   * The store notifies on every write — a saved window, a renamed sign — and
   * re-reading the model on each of those would be a storage read per frame
   * confirmation for no change in answer.
   */
  private async syncActiveModel(): Promise<void> {
    if (this.disposed) return;
    const context = this.store.getSnapshot();
    const signature = `${context.languageId}|${context.models
      .map((model) => `${model.id}:${model.status}`)
      .join(',')}`;
    if (signature === this.modelSignature && this.started) {
      this.emit();
      return;
    }
    this.modelSignature = signature;

    this.activeRecord = await this.store.loadActiveModel(context.languageId, 'glove-sensor');
    const active = context.models.find((model) => model.id === this.activeRecord?.id) ?? null;

    this.snapshot = { ...this.snapshot, activeModel: active };
    this.inference.refresh(this.inferenceContext());
    this.emit();
  }

  private refreshTraining(): void {
    this.snapshot = {
      ...this.snapshot,
      training: this.store.getProgress(),
      training_: this.store.isTraining(),
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.snapshot = {
      ...this.snapshot,
      capture: this.capture.getSnapshot(),
      inference: this.inference.getSnapshot(),
    };
    for (const listener of this.listeners) listener();
  }
}

/**
 * Which provenance a session's windows carry.
 *
 * Read from the transport rather than chosen by the user: the Demo Mode producer
 * *is* a simulation, and a session recorded through it has to say so in its own
 * record. Letting the caller pick would make the provenance a claim instead of a
 * fact, and the split, the activation gate and the model card all read it.
 */
function sourceFor(info: GloveInfo): SampleSource {
  return info.real ? 'glove' : 'simulated';
}

/**
 * The production id factory.
 *
 * Not a UUID. Every id in `ml/` names a row on one phone that is never merged
 * with another device's, so a clock reading plus a per-process counter cannot
 * collide where it would matter. The clock is read here rather than injected
 * because this *is* the injection the rest of `ml/` takes as `newId` — a test
 * passes a counter instead, and gets reproducible ids.
 */
export function createIdFactory(prefix = 'ml'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
  };
}
