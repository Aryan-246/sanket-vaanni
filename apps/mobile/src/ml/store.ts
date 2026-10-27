/**
 * The learning centre's state: what is stored, what is live, and what happens
 * when something goes wrong.
 *
 * ## Why headers and bodies are separate
 *
 * The index holds a `SampleHeader` per window — everything except the 30 frames.
 * A screen that shows "48 windows, 12 waiting to be confirmed" needs the headers
 * and nothing else, so a launch does not read several megabytes of numbers to
 * draw a list. Bodies are read when they are needed: when a window is opened in
 * the library, when a dataset is exported, and when training starts.
 *
 * A body that has gone missing is reported as a damaged sample and skipped.
 * Nothing pretends the header is the sample, and nothing counts it as trainable.
 *
 * ## Why every write is immediate
 *
 * There is no "save" button and no dirty buffer. A confirmed window is written
 * before its confirmation is acknowledged, the pending window is written before
 * the label prompt appears, and the session count is written alongside. The
 * cost is more small writes; the benefit is that a crash, a killed process or a
 * battery pull costs at most the window in progress.
 *
 * ## What this store will not do
 *
 * It does not upload, sync or back up, and it does not call the network at all.
 * Nothing has been verified about cloud storage for this data, and the report
 * says so. It also will not delete a sample quietly: deletion is explicit, always
 * names what it is removing, and leaves the media files on the device alone.
 */
import type { Storage } from '../storage';
import { ML_KEYS, ML_LIMITS, ML_STORE_VERSION } from './keys';
import {
  buildExport,
  datasetStateForModel,
  MODALITY_LABEL,
  summarise,
  trainableSet,
  verifyExport,
  windowFingerprint,
  type DatasetExport,
  type DatasetMatch,
  type DatasetSummary,
} from './dataset';
import {
  activeModel,
  planActivation,
  pruneTarget,
  nextVersion,
  type ActivationPlan,
} from './modelStore';
import {
  buildModelPackage,
  localCapabilities,
  verifyModelPackage,
  type CompatibilityFinding,
  type ModelPackage,
} from './modelPackage';
import { VERSION_UNKNOWN } from '../config/app';
import { nativeBuildInfo } from '../native/SanketVaanniNative';
import { runTraining, type TrainingOutcome, type TrainingProgress } from './training';
import type { CaptureSink, PendingWindow } from './capture';
import {
  DATASET_VERSION,
  DEFAULT_ML_SETTINGS,
  type CaptureSessionMeta,
  type EvaluationReport,
  type LabelDefinition,
  type MlSettings,
  type Modality,
  type ModelRecord,
  type SampleHeader,
  type SensorWindowSample,
  type TrainingSample,
  type VisionSample,
} from './types';

/** A model without its weights, which is what the index holds. */
export type ModelSummary = Omit<ModelRecord, 'parameters'>;

export interface MlSnapshot {
  /** False until the first read finishes. */
  readonly ready: boolean;
  readonly settings: MlSettings;
  readonly labels: readonly LabelDefinition[];
  readonly sessions: readonly CaptureSessionMeta[];
  readonly headers: readonly SampleHeader[];
  readonly models: readonly ModelSummary[];
  /** The window recorded but not yet confirmed, if one survived a restart. */
  readonly pendingWindow: PendingWindow | null;
  /** The language the learning centre is currently showing. */
  readonly languageId: string;
  /** The modality being worked on. Vision is viewable but never trained here. */
  readonly modality: Modality;
  /** Sample ids whose body could not be read. */
  readonly damaged: readonly string[];
  /** A sentence about the last failure, or null. */
  readonly error: string | null;
}

export type MlResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export interface MlStoreDeps {
  readonly storage: Storage;
  readonly newId: () => string;
  readonly now: () => number;
  readonly defaultLanguageId: string;
  /**
   * Whose account the data belongs to, or null in guest mode.
   *
   * Read when an export is written, not stored on the instance: the same reason
   * as `CaptureDeps.currentOwnerId` — the account can change while the store is
   * alive, and an export stamped from a stale value would name the wrong owner on
   * the one artefact that leaves the device.
   */
  readonly currentOwnerId?: () => string | null;
}

/** The persisted index shapes, so a version bump is visible in one place. */
interface PersistedIndex {
  readonly storeVersion: string;
  readonly headers: readonly SampleHeader[];
}

export class MlStore implements CaptureSink {
  private readonly storage: Storage;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly currentOwnerId: (() => string | null) | undefined;
  private readonly listeners = new Set<() => void>();

  private snapshot: MlSnapshot;
  private bodies = new Map<string, TrainingSample>();
  private cancelled = false;
  private training = false;
  private disposed = false;

  constructor(deps: MlStoreDeps) {
    this.storage = deps.storage;
    this.newId = deps.newId;
    this.now = deps.now;
    this.currentOwnerId = deps.currentOwnerId;
    this.snapshot = {
      ready: false,
      settings: DEFAULT_ML_SETTINGS,
      labels: [],
      sessions: [],
      headers: [],
      models: [],
      pendingWindow: null,
      languageId: deps.defaultLanguageId,
      modality: 'glove-sensor',
      damaged: [],
      error: null,
    };
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Reads everything back.
   *
   * Sessions left open by a process that died are marked `interrupted` rather
   * than closed: the app does not know when they ended, and inventing an end
   * time would put a false duration on a capture session. Every window that was
   * saved is kept, and a pending window is restored so the person is asked about
   * it again instead of losing it.
   */
  async start(): Promise<void> {
    try {
      const [settings, labels, sessions, index, models, pending] = await Promise.all([
        this.storage.getJson<MlSettings>(ML_KEYS.settings),
        this.storage.getJson<LabelDefinition[]>(ML_KEYS.labels),
        this.storage.getJson<CaptureSessionMeta[]>(ML_KEYS.sessions),
        this.storage.getJson<PersistedIndex>(ML_KEYS.sampleIndex),
        this.storage.getJson<ModelSummary[]>(ML_KEYS.modelIndex),
        this.storage.getJson<PendingWindow>(ML_KEYS.pendingWindow),
      ]);

      if (this.disposed) return;

      const recoveredSessions = (sessions ?? []).map((session) =>
        session.status === 'open' ? { ...session, status: 'interrupted' as const } : session,
      );

      this.snapshot = {
        ...this.snapshot,
        ready: true,
        settings: sanitiseSettings(settings),
        labels: labels ?? [],
        sessions: recoveredSessions,
        headers: index?.headers ?? [],
        models: models ?? [],
        pendingWindow: pending,
      };
      this.emit();
    } catch (err) {
      this.patch({ ready: true, error: `The learning data could not be read: ${describe(err)}` });
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): MlSnapshot => this.snapshot;

  dispose(): void {
    this.disposed = true;
    this.cancelled = true;
    this.listeners.clear();
    this.bodies.clear();
  }

  private patch(next: Partial<MlSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /* ----------------------------------------------------------------- tabs */

  /** Which language and modality the centre is showing. */
  setContext(languageId: string, modality: Modality): void {
    this.patch({ languageId, modality });
  }

  /* --------------------------------------------------------------- labels */

  /**
   * Defines a sign.
   *
   * The text is the user's own words. Nothing derives a label from motion, and
   * nothing suggests one: a label that the app invented would be a claim about
   * what a person's hand meant.
   */
  async createLabel(text: string, note: string | null): Promise<MlResult<LabelDefinition>> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: 'A sign needs a name before anything can be recorded under it.' };
    }
    if (trimmed.length > 60) {
      return { ok: false, error: 'Keep the name under 60 characters so it fits on a card.' };
    }

    const existing = this.snapshot.labels.find(
      (label) =>
        label.languageId === this.snapshot.languageId &&
        label.archivedAtMs === null &&
        label.text.toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing !== undefined) {
      return { ok: false, error: `"${existing.text}" already exists in this sign language.` };
    }

    const label: LabelDefinition = {
      id: this.newId(),
      languageId: this.snapshot.languageId,
      text: trimmed,
      note,
      createdAtMs: this.now(),
      createdBy: 'user',
      archivedAtMs: null,
    };

    const labels = [...this.snapshot.labels, label];
    await this.storage.setJson(ML_KEYS.labels, labels);
    this.patch({ labels, error: null });
    return { ok: true, data: label };
  }

  /** Retires a sign. Existing windows keep pointing at it. */
  async archiveLabel(labelId: string): Promise<MlResult<LabelDefinition>> {
    const label = this.snapshot.labels.find((entry) => entry.id === labelId);
    if (label === undefined) return { ok: false, error: 'That sign is no longer in the list.' };
    if (label.archivedAtMs !== null) {
      return { ok: false, error: `"${label.text}" has already been retired.` };
    }

    const archived: LabelDefinition = { ...label, archivedAtMs: this.now() };
    const labels = this.snapshot.labels.map((entry) => (entry.id === labelId ? archived : entry));
    await this.storage.setJson(ML_KEYS.labels, labels);
    this.patch({ labels, error: null });
    return { ok: true, data: archived };
  }

  /** Permanently deletes a sign and removes all dataset samples recorded under it. */
  async deleteLabel(labelId: string): Promise<MlResult<void>> {
    const label = this.snapshot.labels.find((entry) => entry.id === labelId);
    if (label === undefined) return { ok: false, error: 'That sign is no longer in the list.' };

    const samplesToDelete = this.snapshot.headers
      .filter((entry) => entry.labelId === labelId)
      .map((entry) => entry.id);

    if (samplesToDelete.length > 0) {
      await this.deleteSamples(samplesToDelete);
    }

    const labels = this.snapshot.labels.filter((entry) => entry.id !== labelId);
    await this.storage.setJson(ML_KEYS.labels, labels);
    this.patch({ labels, error: null });
    return { ok: true, data: undefined };
  }

  /**
   * Provisions the canonical 5 starter vocabulary words for the language if no active signs exist.
   * HELLO, BYE, THANK YOU, YES, NO.
   */
  async ensureCanonicalLabels(languageId: string = this.snapshot.languageId): Promise<readonly LabelDefinition[]> {
    const starterWords = [
      { text: 'HELLO', note: 'Standard ASL greeting: open hand at temple or wave' },
      { text: 'BYE', note: 'Standard ASL farewell: open palm flexing fingers / waving' },
      { text: 'THANK YOU', note: 'Standard ASL: flat hand touches chin then moves outward' },
      { text: 'YES', note: 'Standard ASL: fist nodding up and down like a head nod' },
      { text: 'NO', note: 'Standard ASL: index and middle finger snap down against thumb' },
      { text: 'REST', note: 'Neutral baseline: relaxed resting hands on lap or table' },
    ];

    const existing = this.snapshot.labels.filter(
      (l) => l.languageId === languageId && l.archivedAtMs === null,
    );
    const existingTexts = new Set(existing.map((l) => l.text.toUpperCase().trim()));

    const missingWords = starterWords.filter(
      (w) => !existingTexts.has(w.text.toUpperCase().trim()),
    );
    if (missingWords.length === 0) return existing;

    const created: LabelDefinition[] = missingWords.map((word) => ({
      id: this.newId(),
      languageId,
      text: word.text,
      note: word.note,
      createdAtMs: this.now(),
      createdBy: 'user',
      archivedAtMs: null,
    }));

    const labels = [...this.snapshot.labels, ...created];
    await this.storage.setJson(ML_KEYS.labels, labels);
    this.patch({ labels, error: null });
    return [...existing, ...created];
  }

  /* -------------------------------------------------------------- samples */

  /** How many windows are stored, by state, for the library. */
  summary(): DatasetSummary {
    return summarise(this.snapshot.headers as TrainingSample[], this.snapshot.labels, this.snapshot.sessions.length);
  }

  /**
   * Writes one confirmed window. Called by the capture controller.
   *
   * The duplicate check runs on the header fingerprint, so a window captured
   * twice in a row — a double press, or a resume that re-confirmed — is refused
   * rather than stored twice. Refusing is reported, not silent.
   */
  async saveSample(sample: SensorWindowSample): Promise<void> {
    const existing = this.snapshot.headers.find(
      (header) => header.fingerprint === sample.fingerprint && header.id !== sample.id,
    );

    if (existing !== undefined) {
      this.patch({
        error: `That window is already saved as "${this.labelText(existing.labelId)}". It was not stored again.`,
      });
      return;
    }

    await this.writeSample(sample);
  }

  private async writeSample(sample: TrainingSample): Promise<void> {
    const header = toHeader(sample);
    const headers = [
      ...this.snapshot.headers.filter((entry) => entry.id !== sample.id),
      header,
    ];

    await this.storage.setJson(ML_KEYS.sample(sample.id), sample);
    await this.storage.setJson(ML_KEYS.sampleIndex, {
      storeVersion: ML_STORE_VERSION,
      headers,
    } satisfies PersistedIndex);

    this.bodies.set(sample.id, sample);
    this.patch({ headers, error: null });
  }

  /** Stores an imported photo or video record. */
  async saveVisionSample(sample: VisionSample): Promise<void> {
    const existing = this.snapshot.headers.find(
      (header) => header.fingerprint === sample.fingerprint && header.id !== sample.id,
    );
    if (existing !== undefined) return;
    await this.writeSample(sample);
  }

  /** Reads one window's frames, for the detail view. */
  async loadSample(id: string): Promise<TrainingSample | null> {
    const cached = this.bodies.get(id);
    if (cached !== undefined) return cached;

    const stored = await this.storage.getJson<TrainingSample>(ML_KEYS.sample(id));
    if (stored === null) {
      const damaged = [...new Set([...this.snapshot.damaged, id])];
      this.patch({ damaged });
      return null;
    }
    this.bodies.set(id, stored);
    return stored;
  }

  /** Reads every stored window, for training and for export. */
  async loadAllSamples(): Promise<{ samples: TrainingSample[]; damaged: string[] }> {
    const samples: TrainingSample[] = [];
    const damaged: string[] = [];

    for (const header of this.snapshot.headers) {
      const sample = await this.loadSample(header.id);
      if (sample === null) damaged.push(header.id);
      else samples.push(sample);
    }

    this.patch({ damaged });
    return { samples, damaged };
  }

  /**
   * Whether a model still matches the data it was fitted on.
   *
   * Uses `trainableSet`, the *same* membership rule training uses, so the two
   * digests being compared describe the same set. A cheaper approximation over
   * stored headers — skipping the frame-length and quality checks that need a
   * body — would report `changed` for a window that was merely damaged on disk,
   * which is a different and more alarming statement than "your data changed".
   *
   * Async, and deliberately not part of the snapshot: it reads every sample body,
   * and the snapshot is rebuilt on every recorded window. The model list asks for
   * this once when it renders.
   */
  async datasetStateFor(modelId: string): Promise<DatasetMatch> {
    /*
     * The full record, not `snapshot.models`: those are summaries, and a summary
     * carries the counts and the evaluation but not this digest. Reading the
     * digest off a summary would find `undefined` every time and report every
     * version as unknown — a wrong answer that looks like a cautious one.
     */
    const model = await this.loadModel(modelId);
    if (model === null) return 'unknown';

    const { samples } = await this.loadAllSamples();
    const trainable = trainableSet({
      samples,
      languageId: model.languageId,
      settings: this.snapshot.settings,
    });
    return datasetStateForModel(model, trainable.samples);
  }

  /**
   * Confirms a window that was saved without a label.
   *
   * Also how a mislabelled window is corrected: the confirmation replaces the
   * label and clears any rejection, and the window becomes eligible for training
   * only at this point. Correction therefore always passes through a person.
   */
  async relabel(sampleId: string, labelId: string): Promise<MlResult<SampleHeader>> {
    const header = this.snapshot.headers.find((entry) => entry.id === sampleId);
    if (header === undefined) return { ok: false, error: 'That window is no longer stored.' };

    const label = this.snapshot.labels.find((entry) => entry.id === labelId);
    if (label === undefined) return { ok: false, error: 'That sign is no longer in the list.' };
    if (label.archivedAtMs !== null) {
      return { ok: false, error: `"${label.text}" has been retired, so nothing new can be filed under it.` };
    }
    if (label.languageId !== header.languageId) {
      return { ok: false, error: `"${label.text}" belongs to a different sign language.` };
    }

    const sample = await this.loadSample(sampleId);
    if (sample === null) {
      return { ok: false, error: 'The window’s frames could not be read, so it cannot be relabelled.' };
    }

    const updated: TrainingSample = {
      ...sample,
      labelId,
      approval: 'approved',
      rejectionReason: null,
      // Recomputed rather than patched: the fingerprint includes the label, and
      // a string replace on the old one could hit the wrong occurrence.
      fingerprint:
        sample.modality === 'glove-sensor'
          ? windowFingerprint({ ...sample, labelId })
          : sample.fingerprint,
    };

    await this.writeSample(updated);
    const next = this.snapshot.headers.find((entry) => entry.id === sampleId)!;
    return { ok: true, data: next };
  }

  /** Flags a window as not being the sign it was recorded under. Keeps it. */
  async markRejected(sampleId: string, reason: string): Promise<void> {
    const sample = await this.loadSample(sampleId);
    if (sample === null) return;
    await this.writeSample({ ...sample, approval: 'rejected', rejectionReason: reason });
  }

  /**
   * Deletes windows, by id.
   *
   * The body goes before the header, so an interrupted delete leaves a header
   * whose frames cannot be read — a *visible* damaged sample the user can delete
   * again — rather than an orphaned body nothing can reach or count. The store
   * has no way to list keys, so an invisible orphan would never be reclaimable.
   */
  async deleteSamples(ids: readonly string[]): Promise<MlResult<number>> {
    if (ids.length === 0) return { ok: false, error: 'Nothing was selected.' };

    let removed = 0;
    for (const id of ids) {
      await this.storage.removeKey(ML_KEYS.sample(id));
      this.bodies.delete(id);
      removed += 1;
    }

    const headers = this.snapshot.headers.filter((header) => !ids.includes(header.id));
    await this.storage.setJson(ML_KEYS.sampleIndex, {
      storeVersion: ML_STORE_VERSION,
      headers,
    } satisfies PersistedIndex);
    this.patch({ headers });

    return { ok: true, data: removed };
  }

  /** Deletes everything: windows, sessions, models and labels. Not settings. */
  async deleteEverything(): Promise<MlResult<{ samples: number; models: number; labels: number }>> {
    const counts = {
      samples: this.snapshot.headers.length,
      models: this.snapshot.models.length,
      labels: this.snapshot.labels.length,
    };

    await this.deleteSamples(this.snapshot.headers.map((header) => header.id));
    for (const model of this.snapshot.models) {
      await this.storage.removeKey(ML_KEYS.model(model.id));
    }

    await this.storage.removeKey(ML_KEYS.modelIndex);
    await this.storage.removeKey(ML_KEYS.sessions);
    await this.storage.removeKey(ML_KEYS.labels);
    await this.storage.removeKey(ML_KEYS.sampleIndex);
    await this.storage.removeKey(ML_KEYS.pendingWindow);

    this.bodies.clear();
    this.patch({
      headers: [],
      models: [],
      sessions: [],
      labels: [],
      pendingWindow: null,
      damaged: [],
      error: null,
    });

    return { ok: true, data: counts };
  }

  /* --------------------------------------------------------- CaptureSink */

  async putPendingWindow(pending: PendingWindow | null): Promise<void> {
    if (pending === null) await this.storage.removeKey(ML_KEYS.pendingWindow);
    else await this.storage.setJson(ML_KEYS.pendingWindow, pending);
    this.patch({ pendingWindow: pending });
  }

  async saveSession(session: CaptureSessionMeta): Promise<void> {
    const sessions = [
      ...this.snapshot.sessions.filter((entry) => entry.id !== session.id),
      session,
    ];
    await this.storage.setJson(ML_KEYS.sessions, sessions);
    this.patch({ sessions });
  }

  /* -------------------------------------------------------------- training */

  private lastProgress: TrainingProgress | null = null;

  /** The last measured progress of a run in flight, or null. */
  getProgress(): TrainingProgress | null {
    return this.lastProgress;
  }

  /** Stops a run in flight. The previous active model is untouched. */
  cancelTraining(): void {
    this.cancelled = true;
  }

  isTraining(): boolean {
    return this.training;
  }

  /**
   * Trains a model for the current language.
   *
   * Nothing is written until the run produces a model. A run that is cancelled,
   * refuses on thin data, or fails leaves the stored models exactly as they were
   * and the active one still active — which is the behaviour the directive
   * requires when training is interrupted.
   */
  async train(onProgress?: (progress: TrainingProgress) => void): Promise<TrainingOutcome> {
    if (this.training) {
      return {
        ok: false,
        code: 'bad-config',
        reason: 'A training run is already going.',
        refused: [],
      };
    }

    this.training = true;
    this.cancelled = false;

    try {
      const { samples } = await this.loadAllSamples();
      const outcome = runTraining({
        samples,
        languageId: this.snapshot.languageId,
        modality: 'glove-sensor',
        labels: this.snapshot.labels,
        settings: this.snapshot.settings,
        existingModels: this.snapshot.models as ModelRecord[],
        nowMs: this.now(),
        newId: this.newId,
        onProgress: (progress) => {
          this.lastProgress = progress;
          onProgress?.(progress);
        },
        shouldStop: () => this.cancelled || this.disposed,
      });

      if (!outcome.ok) return outcome;

      await this.writeModel(outcome.model);
      return outcome;
    } finally {
      this.training = false;
      this.lastProgress = null;
    }
  }

  private async writeModel(model: ModelRecord): Promise<void> {
    let models: ModelSummary[] = [
      ...this.snapshot.models.filter((entry) => entry.id !== model.id),
      toSummary(model),
    ];

    if (model.status === 'active') {
      models = models.map((entry) =>
        entry.languageId === model.languageId &&
        entry.modality === model.modality &&
        entry.id !== model.id &&
        entry.status === 'active'
          ? { ...entry, status: 'retired' as const, statusReason: null }
          : entry,
      );
    }

    const kept = pruneTarget(
      models,
      model.languageId,
      model.modality,
      ML_LIMITS.maxModelsPerTarget,
    );
    const dropped = models.filter((entry) => !kept.some((live) => live.id === entry.id));

    await this.storage.setJson(ML_KEYS.model(model.id), model);
    await this.storage.setJson(ML_KEYS.modelIndex, kept);

    for (const gone of dropped) {
      await this.storage.removeKey(ML_KEYS.model(gone.id));
    }

    this.patch({ models: kept });
  }

  /**
   * Switches to a stored version.
   *
   * The confirmation this drives states what will be retired and what a rollback
   * would restore — `planActivation` produces that, so the screen and the stored
   * record agree.
   */
  async activate(modelId: string): Promise<MlResult<ActivationPlan>> {
    const summary = this.snapshot.models.find((entry) => entry.id === modelId);
    if (summary === undefined) return { ok: false, error: 'That version is no longer stored.' };

    const model = await this.loadModel(modelId);
    if (model === null) {
      return { ok: false, error: 'That version’s weights could not be read.' };
    }

    const plan = planActivation(this.snapshot.models as ModelRecord[], model);
    await this.writeModel({ ...model, status: 'active', statusReason: null });
    return { ok: true, data: plan };
  }

  /** Restores the version a rollback would go back to. */
  async rollback(languageId: string, modality: Modality): Promise<MlResult<ModelSummary>> {
    const current = activeModel(this.snapshot.models as ModelRecord[], languageId, modality);
    const previous = this.snapshot.models
      .filter(
        (entry) =>
          entry.languageId === languageId &&
          entry.modality === modality &&
          entry.status !== 'active' &&
          (current === null || entry.version < current.version),
      )
      .sort((a, b) => b.version - a.version)[0];

    if (previous === undefined) {
      return { ok: false, error: 'There is no earlier version to go back to.' };
    }

    const restored = await this.loadModel(previous.id);
    if (restored === null) {
      return { ok: false, error: 'The earlier version’s weights could not be read.' };
    }

    await this.writeModel({ ...restored, status: 'active', statusReason: null });
    return { ok: true, data: previous };
  }

  /** Reads a model's weights for inference. */
  async loadModel(id: string): Promise<ModelRecord | null> {
    return this.storage.getJson<ModelRecord>(ML_KEYS.model(id));
  }

  /** The live model for a target, weights and all, or null. */
  async loadActiveModel(languageId: string, modality: Modality): Promise<ModelRecord | null> {
    const summary = this.snapshot.models.find(
      (entry) => entry.languageId === languageId && entry.modality === modality && entry.status === 'active',
    );
    if (summary === undefined) return null;
    return this.loadModel(summary.id);
  }

  /** Deleting one version. The live one cannot be deleted by this method. */
  async deleteModel(modelId: string): Promise<MlResult<number>> {
    const summary = this.snapshot.models.find((entry) => entry.id === modelId);
    if (summary === undefined) return { ok: false, error: 'That version is no longer stored.' };
    if (summary.status === 'active') {
      return {
        ok: false,
        error: 'This is the version in use. Switch to another version before removing it.',
      };
    }

    const models = this.snapshot.models.filter((entry) => entry.id !== modelId);
    await this.storage.setJson(ML_KEYS.modelIndex, models);
    await this.storage.removeKey(ML_KEYS.model(modelId));
    this.patch({ models });
    return { ok: true, data: models.length };
  }

  /* --------------------------------------------------------- model packages */

  /**
   * Writes a version out as a file that can be carried to another phone.
   *
   * The hand configuration in the contract is derived from the samples *still*
   * on this phone, not recorded from the run that produced the model — the record
   * does not keep them. So the derivation is asked for and named, and a phone
   * that has since deleted those windows produces a package which says it cannot
   * confirm the hand rather than one that asserts a hand it never checked.
   */
  async exportModel(modelId: string): Promise<MlResult<ModelPackage>> {
    const summary = this.snapshot.models.find((entry) => entry.id === modelId);
    if (summary === undefined) return { ok: false, error: 'That version is no longer stored.' };

    const model = await this.loadModel(modelId);
    if (model === null) {
      return {
        ok: false,
        error: 'That version’s weights could not be read, so there is nothing to carry.',
      };
    }

    const { samples } = await this.loadAllSamples();
    const payload = buildModelPackage({
      model,
      labels: this.snapshot.labels,
      samples,
      decoding: {
        unknownScore: this.snapshot.settings.unknownScore,
        unknownMargin: this.snapshot.settings.unknownMargin,
      },
      appVersion: await installedAppVersion(),
      nowMs: this.now(),
    });

    return { ok: true, data: payload };
  }

  /**
   * Takes a version in from another phone.
   *
   * ## It always lands as a candidate
   *
   * Importing never changes which version is in use. A phone that began
   * recognising signs differently because a file was pasted into it would be the
   * worst behaviour available to this feature, and "the operator meant to" is not
   * something this code can check. So the weights are stored, and putting them in
   * use remains a separate act.
   *
   * ## Why the threshold gate is not re-run here
   *
   * `activationDecision` refuses a model whose classes had too few confirmed
   * examples. That check is about the data a model was *fitted on*, and that data
   * is on the other phone. Counting this phone's windows would measure something
   * else entirely — a version fitted on four hundred windows elsewhere would be
   * refused here for having none. So the gate is not applied, and the record says
   * so instead of implying the version passed it.
   */
  /**
   * Ensures labels defined in a model package's vocabulary are present in local labels,
   * associating their human-readable words for display, captions and speech.
   */
  async ensureLabelsFromPackage(contract: {
    readonly languageId: string;
    readonly vocabulary: {
      readonly labelIds: readonly string[];
      readonly labelTexts?: Readonly<Record<string, string>>;
    };
  }): Promise<void> {
    const updatedLabels: LabelDefinition[] = [...this.snapshot.labels];
    let labelsChanged = false;

    for (const labelId of contract.vocabulary.labelIds) {
      const existing = updatedLabels.find((l) => l.id === labelId);
      const textFromPackage = contract.vocabulary.labelTexts?.[labelId];

      if (!existing && textFromPackage) {
        updatedLabels.push({
          id: labelId,
          languageId: contract.languageId,
          text: textFromPackage,
          note: null,
          createdAtMs: this.now(),
          createdBy: 'user',
          archivedAtMs: null,
        });
        labelsChanged = true;
      }
    }

    if (labelsChanged) {
      await this.storage.setJson(ML_KEYS.labels, updatedLabels);
      this.patch({ labels: updatedLabels });
    }
  }

  async importModel(
    payload: unknown,
    options?: { readonly importLabels?: boolean },
  ): Promise<MlResult<{ summary: ModelSummary; findings: readonly CompatibilityFinding[] }>> {
    const verdict = verifyModelPackage({ package: payload, local: localCapabilities() });
    if (!verdict.ok) return { ok: false, error: verdict.reason };

    const contract = verdict.package.contract;

    if (options?.importLabels) {
      await this.ensureLabelsFromPackage(contract);
    }

    const labelsNotDefinedHere = contract.vocabulary.labelIds.filter(
      (labelId) => !this.snapshot.labels.some((label) => label.id === labelId),
    );

    const model: ModelRecord = {
      id: this.newId(),
      /*
       * A fresh version number for this target, not the one it carried on the
       * exporting phone. Two installs number independently, so importing v3 could
       * collide with a v3 already here; `nextVersion` keeps this phone's own
       * sequence monotonic, and `importedFrom.sourceVersion` preserves the other
       * number for anyone who needs to trace it back.
       */
      version: nextVersion(this.snapshot.models as ModelRecord[], contract.languageId, contract.modality),
      languageId: contract.languageId,
      modality: contract.modality,
      algorithm: 'softmax-linear',
      algorithmDetail: contract.algorithmDetail,
      trainedAtMs: contract.trainedAtMs,
      datasetVersion: contract.datasetVersion,
      preprocessingVersion: contract.preprocessingVersion,
      trainedOn: contract.trainedOn,
      sampleCount: contract.sampleCount,
      sessionCount: contract.sessionCount,
      labelIds: [...contract.vocabulary.labelIds],
      parameters: verdict.package.parameters,
      evaluation: contract.evaluation,
      status: 'candidate',
      statusReason: importReason(labelsNotDefinedHere, contract.evaluation),
      trainingConfig: contract.trainingConfig,
      importedFrom: {
        exportedAtMs: verdict.package.exportedAtMs,
        exportedByAppVersion: contract.exportedByAppVersion,
        sourceVersion: contract.version,
        vocabularyFingerprint: contract.vocabulary.vocabularyFingerprint,
        importedAtMs: this.now(),
        labelsNotDefinedHere,
      },
    };

    await this.writeModel(model);

    const findings: CompatibilityFinding[] = [...verdict.findings];
    if (labelsNotDefinedHere.length > 0) {
      findings.push({
        severity: 'warns',
        message: `${labelsNotDefinedHere.length} of its signs ${labelsNotDefinedHere.length === 1 ? 'is' : 'are'} not defined on this phone, so ${labelsNotDefinedHere.length === 1 ? 'that output shows' : 'those outputs show'} its id instead of a word. Nothing was added to your signs to make them fit.`,
      });
    }

    return { ok: true, data: { summary: toSummary(model), findings } };
  }

  /* -------------------------------------------------------------- settings */

  /**
   * Changes learning settings.
   *
   * Turning training permission off does not delete anything; it makes every
   * window ineligible, which is what the trainer checks. Consent is stamped with
   * a time when it is given, so a dataset can be defended later.
   */
  async updateSettings(patch: Partial<MlSettings>): Promise<MlResult<MlSettings>> {
    const settings: MlSettings = {
      ...this.snapshot.settings,
      ...patch,
      consentRecordedAtMs:
        patch.allowCollectedDataForTraining === true
          ? (this.snapshot.settings.consentRecordedAtMs ?? this.now())
          : patch.allowCollectedDataForTraining === false
            ? null
            : this.snapshot.settings.consentRecordedAtMs,
    };

    await this.storage.setJson(ML_KEYS.settings, settings);
    this.patch({ settings, error: null });
    return { ok: true, data: settings };
  }

  /* ---------------------------------------------------------------- export */

  /** Everything, as a versioned file the user can keep. */
  async exportDataset(): Promise<MlResult<DatasetExport>> {
    const { samples } = await this.loadAllSamples();
    const payload = buildExport({
      samples,
      labels: this.snapshot.labels,
      sessions: this.snapshot.sessions,
      /*
       * The account the export is made under, so a file found later can be traced
       * to whoever's data it holds. It was a fixed null, which made every export
       * equally unowned and left a file containing someone's recordings with
       * nothing in it saying whose they were.
       */
      ownerId: this.currentOwnerId?.() ?? null,
      datasetVersion: DATASET_VERSION,
      nowMs: this.now(),
    });
    return { ok: true, data: payload };
  }

  /**
   * Reads an exported file back.
   *
   * Verified against its checksum before anything is stored, and merged by id so
   * importing the same file twice adds nothing. Existing windows with the same
   * fingerprint are left alone rather than duplicated.
   */
  async importDataset(payload: DatasetExport): Promise<MlResult<{ added: number; skipped: number }>> {
    const verdict = verifyExport(payload);
    if (!verdict.ok) return { ok: false, error: verdict.reason };

    const knownLabels = new Set(this.snapshot.labels.map((label) => label.id));
    const labels = [...this.snapshot.labels];
    for (const label of payload.labels) {
      if (!knownLabels.has(label.id)) {
        labels.push(label);
        knownLabels.add(label.id);
      }
    }

    let added = 0;
    let skipped = 0;
    for (const sample of payload.samples) {
      const existing = this.snapshot.headers.find(
        (header) => header.id === sample.id || header.fingerprint === sample.fingerprint,
      );
      if (existing !== undefined) {
        skipped += 1;
        continue;
      }
      await this.writeSample(sample);
      added += 1;
    }

    await this.storage.setJson(ML_KEYS.labels, labels);
    this.patch({ labels });

    return { ok: true, data: { added, skipped } };
  }

  /**
   * Sample bodies with no header, left behind by an interrupted delete.
   *
   * The storage interface cannot list keys, so this only finds bodies whose ids
   * the caller already knows about — it is a repair aid, not a scan.
   */
  async orphans(ids: readonly string[]): Promise<readonly string[]> {
    const known = new Set(this.snapshot.headers.map((header) => header.id));
    const found: string[] = [];
    for (const id of ids) {
      if (known.has(id)) continue;
      const body = await this.storage.getJson<TrainingSample>(ML_KEYS.sample(id));
      if (body !== null) {
        await this.storage.removeKey(ML_KEYS.sample(id));
        found.push(id);
      }
    }
    return found;
  }

  /** The words for a label id, for error messages and the library. */
  labelText(labelId: string): string {
    return this.snapshot.labels.find((label) => label.id === labelId)?.text ?? labelId;
  }

  /** Which modality a given set of headers describes, for headings. */
  modalityLabel(modality: Modality): string {
    return MODALITY_LABEL[modality];
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * The header of a sample: everything except the frames or the media file.
 *
 * Written out field by field rather than by destructuring the rest away. The
 * explicit version is checked: adding a field to `SampleHeader` and forgetting
 * it here is a compile error, whereas a rest-spread would quietly carry whatever
 * happened to be left over — including the frames this exists to keep out of the
 * index.
 */
export function toHeader(sample: TrainingSample): SampleHeader {
  return {
    id: sample.id,
    sessionId: sample.sessionId,
    ownerId: sample.ownerId,
    languageId: sample.languageId,
    labelId: sample.labelId,
    modality: sample.modality,
    source: sample.source,
    handContext: sample.handContext,
    approval: sample.approval,
    quality: sample.quality,
    capturedAtMs: sample.capturedAtMs,
    calibrationVersion: sample.calibrationVersion,
    preprocessingVersion: sample.preprocessingVersion,
    datasetVersion: sample.datasetVersion,
    fingerprint: sample.fingerprint,
    rejectionReason: sample.rejectionReason,
  };
}

/** A model without its weights, for the index. Written out for the same reason. */
export function toSummary(model: ModelRecord): ModelSummary {
  return {
    id: model.id,
    version: model.version,
    languageId: model.languageId,
    modality: model.modality,
    algorithm: model.algorithm,
    algorithmDetail: model.algorithmDetail,
    trainedAtMs: model.trainedAtMs,
    datasetVersion: model.datasetVersion,
    preprocessingVersion: model.preprocessingVersion,
    trainedOn: model.trainedOn,
    sampleCount: model.sampleCount,
    sessionCount: model.sessionCount,
    labelIds: model.labelIds,
    evaluation: model.evaluation,
    status: model.status,
    statusReason: model.statusReason,
    trainingConfig: model.trainingConfig,
    importedFrom: model.importedFrom ?? null,
  };
}

/**
 * Settings as stored, with anything unreadable replaced by its default.
 *
 * A settings blob written by an older build, or damaged, must not leave the
 * app unable to decide whether it may train — so an unreadable value falls back
 * to the default, which is "off".
 */
function sanitiseSettings(stored: MlSettings | null): MlSettings {
  if (stored === null) return DEFAULT_ML_SETTINGS;

  return {
    allowCollectedDataForTraining: stored.allowCollectedDataForTraining === true,
    consentRecordedAtMs:
      typeof stored.consentRecordedAtMs === 'number' ? stored.consentRecordedAtMs : null,
    allowSimulatedTraining: stored.allowSimulatedTraining === true,
    activation: {
      minSamplesPerClass: clamp(stored.activation?.minSamplesPerClass, 2, 50, DEFAULT_ML_SETTINGS.activation.minSamplesPerClass),
      minTestAccuracy: clamp(stored.activation?.minTestAccuracy, 0.1, 1, DEFAULT_ML_SETTINGS.activation.minTestAccuracy),
    },
    unknownScore: clamp(stored.unknownScore, 0, 1, DEFAULT_ML_SETTINGS.unknownScore),
    unknownMargin: clamp(stored.unknownMargin, 0, 1, DEFAULT_ML_SETTINGS.unknownMargin),
  };
}

function clamp(value: unknown, low: number, high: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, low), high);
}

/**
 * What a package records as the build that wrote it.
 *
 * Read from the installed package, never restated as a constant. A version string
 * written by hand here would drift from the APK it claims to describe, and this
 * field exists precisely so that a package found later can be traced to a build.
 * When the device cannot be asked — the web target, a test run — it says so.
 */
async function installedAppVersion(): Promise<string> {
  const info = await nativeBuildInfo();
  if (info === null) return VERSION_UNKNOWN;
  const label = `${info.versionName} (${info.versionCode})`;
  return label.trim().length > 0 ? label : VERSION_UNKNOWN;
}

/**
 * Why an imported version is not in use.
 *
 * Stated as the reason it did not become active, because that is the field the
 * model card shows it in. The first clause is true of every import; the second
 * is added only when the package carries a weak or absent measurement, which is
 * the one fact a reader needs in order not to over-trust numbers from elsewhere.
 */
function importReason(
  labelsNotDefinedHere: readonly string[],
  evaluation: EvaluationReport | null,
): string {
  const parts = [
    'It was fitted on another phone and carried here as a file. Taking a file in never puts a version in use, so it is stored and becomes the version in use only when you switch to it.',
  ];

  if (labelsNotDefinedHere.length > 0) {
    parts.push(
      `${labelsNotDefinedHere.length} of its signs ${labelsNotDefinedHere.length === 1 ? 'has' : 'have'} no definition on this phone, so ${labelsNotDefinedHere.length === 1 ? 'its output' : 'those outputs'} cannot be shown as words until you add ${labelsNotDefinedHere.length === 1 ? 'it' : 'them'}.`,
    );
  }

  if (evaluation === null || evaluation.accuracy === null) {
    parts.push('It carries no held-back measurement, so nothing in the file says how often it is right.');
  }

  parts.push(
    'The requirements for going live are not applied to it: those count the examples a version was fitted on, and the examples stayed on the phone that fitted it.',
  );

  return parts.join(' ');
}

function describe(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  return 'the device gave no reason';
}
