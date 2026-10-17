/**
 * The contracts the learning pipeline is built on.
 *
 * ## What a "sample" is, and why it carries so much with it
 *
 * A training sample is a *window of motion* plus everything needed to interpret
 * it later. The motion alone is not enough: the same flex reading means
 * different things on a calibrated glove and an uncalibrated one, in one sign
 * language and another, from the left hand and the right. A dataset that stores
 * only the numbers produces a model that cannot be trusted to reproduce its own
 * result, because the conditions it was trained under are gone.
 *
 * Everything here is therefore JSON-serialisable plain data with no functions,
 * no `undefined`-vs-absent ambiguity that matters, and no reference to a live
 * object. That is what lets a sample be written to storage the instant it is
 * captured, survive a crash, and be exported as a file somebody else can open.
 *
 * ## Modality is not a tag, it is a separate pipeline
 *
 * `Modality` divides samples into two families that share no code past this
 * file. A glove-sensor window is a sequence of 11-number frames; a photograph
 * is pixels. There is no feature vector that can hold either, and pretending
 * otherwise — padding a photo into a flex vector, or training a sensor model on
 * stored video — is the single most misleading thing this area could do. Making
 * it a discriminated union means the type system refuses the mistake before a
 * reviewer has to.
 *
 * ## Labels are user statements, not inferences
 *
 * Nothing here infers a label from motion. A label exists because a person said
 * "this window is that sign". See `dataset.ts` for the rule that a sample may
 * only enter training once its label has been confirmed.
 */

import type { GloveSide } from '../sensors/types';

/** Which hand(s) a sample was captured from. */
export type HandContext = 'left' | 'right' | 'both';

/**
 * Where a sample's motion came from.
 *
 * This is provenance, and it is load-bearing rather than descriptive:
 * `simulated` samples come from the Demo Mode transport, which produces a
 * plausible-looking sine wave and is explicitly *not* a model of the hardware.
 * A model trained on those recognises that waveform. It must never be described
 * as recognising signing, so the fact travels with the sample and is copied
 * into any model trained on it.
 */
export type SampleSource =
  /** A verified glove transport. Nothing produces this today. */
  | 'glove'
  /** The Demo Mode transport (`isSynthetic: true`). */
  | 'simulated'
  /** A recording file the user imported. */
  | 'imported'
  /** Media the user picked from the device. */
  | 'media';

/** The two input families. See the note above about why these are separate. */
export type Modality = 'glove-sensor' | 'vision';

/** Whether a sample may be used for training. */
export type ApprovalState =
  /** Captured, not yet confirmed by the user. Never trained on. */
  | 'pending'
  /** The user confirmed the label. Eligible for training. */
  | 'approved'
  /** The user rejected it. Kept so the decision is visible, never trained on. */
  | 'rejected';

/**
 * What is known about a sample's signal quality.
 *
 * Deliberately coarse. Each check below has a real definition in `quality.ts`;
 * there is no "score" here, because a composite number nobody can decompose is
 * how "87% quality" ends up meaning nothing.
 */
export interface SampleQuality {
  /** Frames the window was expected to hold after resampling. */
  readonly expectedFrames: number;
  /** Frames it actually holds. */
  readonly frameCount: number;
  /** Largest gap between consecutive frame timestamps, milliseconds. */
  readonly maxGapMs: number;
  /** Flex channels that never moved across the window (0..1 spread). */
  readonly flatChannels: readonly number[];
  /** Channels whose value left 0..1 after calibration. */
  readonly outOfRangeChannels: readonly number[];
  /** True when nothing above disqualifies the sample. */
  readonly ok: boolean;
}

/** One glove frame, reduced to the numbers a model can consume. */
export interface FrameVector {
  /** Milliseconds from the start of the window. */
  readonly tMs: number;
  /** Five flex channels, 0..1 after calibration. */
  readonly flex: readonly [number, number, number, number, number];
  /** Acceleration in m/s², glove frame. */
  readonly a: readonly [number, number, number];
  /** Angular rate in rad/s, glove frame. */
  readonly g: readonly [number, number, number];
}

/** Fields every sample carries regardless of modality. */
export interface SampleHeader {
  /** Stable, generated once, never reused. */
  readonly id: string;
  /** The capture session it belongs to. Splits are grouped by this. */
  readonly sessionId: string;
  /** The signed-in account that owns it, or null in guest mode. */
  readonly ownerId: string | null;
  /** Sign-language profile id (`isl`, `asl`, `bsl`) — never a mix. */
  readonly languageId: string;
  /** The label definition this sample is an example of. */
  readonly labelId: string;
  readonly modality: Modality;
  readonly source: SampleSource;
  readonly handContext: HandContext;
  readonly approval: ApprovalState;
  readonly quality: SampleQuality;
  /** Epoch milliseconds. */
  readonly capturedAtMs: number;
  /**
   * The calibration this sample's flex values were normalised with, or null
   * when none applied. A model trained across two calibrations without knowing
   * it is a model trained on two different scales.
   */
  readonly calibrationVersion: number | null;
  /** Feature-pipeline version. A model only accepts vectors it was built for. */
  readonly preprocessingVersion: string;
  /** Dataset version at capture time, bumped when the dataset's shape changes. */
  readonly datasetVersion: number;
  /**
   * Cheap equality fingerprint of the sample's content.
   *
   * Kept on the header so that "is this the same window again?" — a double
   * press, a resumed session, an import run twice — can be answered from the
   * index without reading every sample body back off the device. Its definition
   * lives in `dataset.ts`; it is a duplicate check, not a checksum, and nothing
   * about it is a security property.
   */
  readonly fingerprint: string;
  /** Why a sample was rejected, when it was. */
  readonly rejectionReason: string | null;
}

/** A window of glove motion, already calibrated, resampled to a fixed length. */
export interface SensorWindowSample extends SampleHeader {
  readonly modality: 'glove-sensor';
  readonly side: GloveSide;
  /** Fixed-length frames; length is `WINDOW_FRAMES` after preprocessing. */
  readonly frames: readonly FrameVector[];
  /** Nominal samples per second the window was captured at. */
  readonly sourceHz: number;
}

/** What was imported from the device's media library. */
export interface MediaReference {
  readonly kind: 'photo' | 'video';
  /** `file://` URI on the device. Never a network URL. */
  readonly uri: string;
  readonly mimeType: string;
  /** Bytes, as reported by the picker. */
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  /** Milliseconds, for video. Null for a photo. */
  readonly durationMs: number | null;
}

/** A photo or video the user labelled. Kept apart from sensor windows. */
export interface VisionSample extends SampleHeader {
  readonly modality: 'vision';
  readonly media: MediaReference;
  /**
   * Always false today.
   *
   * True would mean a vision model exists that this app can load and run, and
   * none does — see `ml/README.md`. It is a field rather than an assumption so
   * that "we stored a photo" can never be read as "we trained on photos".
   */
  readonly usedForTraining: boolean;
}

export type TrainingSample = SensorWindowSample | VisionSample;

/** A sign the user has defined. */
export interface LabelDefinition {
  readonly id: string;
  readonly languageId: string;
  /** The gloss or phrase. Supplied by the user; never generated from motion. */
  readonly text: string;
  /** Free-text note, e.g. which hand shape is meant. */
  readonly note: string | null;
  readonly createdAtMs: number;
  /**
   * Always `'user'` today.
   *
   * The roadmap requires a vocabulary defined with a Deaf-led reviewer. A label
   * created inside the app is a working label for this person's own data; it is
   * not a published vocabulary entry, and the model card says so.
   */
  readonly createdBy: 'user';
  /** Set when retired. Archived labels stay attached to their samples. */
  readonly archivedAtMs: number | null;
}

/** One capture session. Windows are grouped by it for leakage-safe splitting. */
export interface CaptureSessionMeta {
  readonly id: string;
  readonly languageId: string;
  readonly modality: Modality;
  readonly source: SampleSource;
  /**
   * The transport that produced it, in its own words — e.g.
   * `Demo Mode (simulated)`. Shown in the UI so the provenance of a dataset is
   * visible rather than implied.
   */
  readonly deviceLabel: string | null;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly status: 'open' | 'closed' | 'interrupted';
  readonly sampleCount: number;
  readonly calibrationVersion: number | null;
  readonly preprocessingVersion: string;
  readonly note: string | null;
}

/* --------------------------------------------------------------- evaluation */

/** Per-class figures computed from a confusion matrix. */
export interface ClassMetric {
  readonly labelId: string;
  readonly text: string;
  /** True examples of this class in the evaluation split. */
  readonly support: number;
  /**
   * Precision, recall and F1, or null when the denominator is zero.
   *
   * Null rather than 0: a class the model never predicted has undefined
   * precision, and printing 0% would claim a measurement that was not made.
   */
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
}

/** What a trained model measured, on data it did not train on. */
export interface EvaluationReport {
  /** Which split the figures below come from. */
  readonly split: 'test' | 'validation';
  /** Counts per split, as actually used. */
  readonly counts: {
    readonly train: number;
    readonly validation: number;
    readonly test: number;
    readonly trainSessions: number;
    readonly testSessions: number;
  };
  /** Row = actual class, column = predicted class, in `classLabels` order. */
  readonly confusion: readonly (readonly number[])[];
  readonly classLabels: readonly string[];
  readonly classes: readonly ClassMetric[];
  /**
   * Overall accuracy, or null when the evaluation split is empty — in which
   * case no figure is reported at all rather than a misleading zero.
   */
  readonly accuracy: number | null;
  readonly macroF1: number | null;
  /**
   * Statements a reader needs in order to not over-read the numbers. Populated
   * by `metrics.ts` — for example a class with no test examples, or a test set
   * containing a single session.
   */
  readonly caveats: readonly string[];
}

/* -------------------------------------------------------------------- model */

/** The only algorithm implemented. Named after what it is. */
export type ModelAlgorithm = 'softmax-linear';

/** The feature layout a model's weights were fitted to. */
export interface FeatureSpec {
  readonly version: string;
  readonly mode: 'glove-flex-imu-stats';
  /** Ordered feature names. A vector is only valid against this list. */
  readonly names: readonly string[];
}

/** A fitted model. Weights are plain arrays so the whole record is JSON. */
export interface ModelParameters {
  readonly kind: 'softmax-linear';
  readonly featureSpec: FeatureSpec;
  /** `classCount` rows, each `featureCount` long. */
  readonly weights: readonly (readonly number[])[];
  readonly biases: readonly number[];
  /** Softmax output is over the class order below, and only that order. */
  readonly classLabelIds: readonly string[];
  /** Mean and scale used to standardise inputs during fitting. */
  readonly standardisation: {
    readonly mean: readonly number[];
    readonly scale: readonly number[];
  };
}

/** A trained model version, with everything needed to judge and reproduce it. */
export interface ModelRecord {
  readonly id: string;
  /** Monotonic per language+modality, for humans to say "v3". */
  readonly version: number;
  readonly languageId: string;
  readonly modality: Modality;
  readonly algorithm: ModelAlgorithm;
  /** One sentence describing the algorithm, shown in the model card. */
  readonly algorithmDetail: string;
  readonly trainedAtMs: number;
  readonly datasetVersion: number;
  readonly preprocessingVersion: string;
  /**
   * The provenance of the data it was trained on. A model whose set is
   * `['simulated']` recognises the Demo Mode waveform and nothing else, and the
   * card says that in those words.
   */
  readonly trainedOn: readonly SampleSource[];
  readonly sampleCount: number;
  readonly sessionCount: number;
  readonly labelIds: readonly string[];
  /**
   * A digest of the exact trainable set this was fitted on, as it stood then.
   *
   * `sampleCount` cannot answer "is this model still fitted on the data that is
   * here?". Forty windows is forty windows whether they are the same forty or a
   * different forty, so a model trained before a deletion or a re-labelling
   * reads exactly like one trained after it. Comparing this digest against the
   * digest of the trainable set as it stands now is the only way the app can
   * tell the difference, and telling the difference is the whole point: the
   * weights are not updated when the data changes, and nothing else says so.
   *
   * Absent (`undefined`) on models fitted before this field existed and on
   * models imported from a package, where the exporting phone's data is not
   * available to describe. Absent means **unknown**, and is rendered as unknown
   * rather than as "unchanged" — see `datasetStateFor`.
   */
  readonly trainedOnDigest?: string | null;
  readonly parameters: ModelParameters;
  readonly evaluation: EvaluationReport | null;
  readonly status: 'candidate' | 'active' | 'retired';
  /** Why it did not become active, when the gate refused it. */
  readonly statusReason: string | null;
  /** Configuration the run used, so a rerun can be compared to it. */
  readonly trainingConfig: TrainingConfig;
  /**
   * Where these weights came from, when they were not fitted on this phone.
   *
   * Absent on every model this app trains, and present on every model taken in
   * from a package file. It is kept so that a version whose numbers this install
   * never computed can never be mistaken for one it did — the difference matters
   * most to whoever reads the record later, who will otherwise see a version
   * number and a set of figures with no way to tell which phone produced them.
   */
  readonly importedFrom?: ModelImport | null;
}

/** The origin of a version that arrived as a package rather than as a training run. */
export interface ModelImport {
  /** When the package was written on the phone that produced it. */
  readonly exportedAtMs: number;
  /** The build that wrote it, or the honest "unknown" when that build could not say. */
  readonly exportedByAppVersion: string;
  /** The version number it carried on that phone, which need not match ours. */
  readonly sourceVersion: number;
  /** The label-set fingerprint it carried, for spotting a mismatched vocabulary. */
  readonly vocabularyFingerprint: string;
  /** When this install took it in. */
  readonly importedAtMs: number;
  /**
   * Label ids it names that this install has no definition for.
   *
   * Recorded rather than repaired: a label is a person's own word for a sign, and
   * inventing one to satisfy a file would put a word in their mouth.
   */
  readonly labelsNotDefinedHere: readonly string[];
}

/** How a training run is configured. Stored with the model. */
export interface TrainingConfig {
  readonly epochs: number;
  readonly learningRate: number;
  readonly l2: number;
  readonly testFraction: number;
  readonly validationFraction: number;
  /** Split is grouped by session so near-duplicate windows cannot leak. */
  readonly splitKey: 'sessionId';
  readonly seed: number;
}

/** A candidate model's evaluation gate, applied before it may go live. */
export interface ActivationThresholds {
  /** Minimum labelled, approved samples per class to train at all. */
  readonly minSamplesPerClass: number;
  /** Minimum test accuracy a candidate must reach to be activatable. */
  readonly minTestAccuracy: number;
}

/** User-facing learning settings, including the consent that gates training. */
export interface MlSettings {
  /**
   * Whether newly captured data may be used to train. Off by default: consent
   * to record is not consent to train, and the two are asked separately.
   */
  readonly allowCollectedDataForTraining: boolean;
  readonly consentRecordedAtMs: number | null;
  readonly allowSimulatedTraining: boolean;
  readonly activation: ActivationThresholds;
  /**
   * Inference refuses a prediction below this score or margin. These are
   * presentation thresholds with no calibration evidence behind them, and the
   * UI says so — see `inference.ts`.
   */
  readonly unknownScore: number;
  readonly unknownMargin: number;
}

/** The preprocessing version this build writes and understands. */
export const PREPROCESSING_VERSION = 'glove-window/1';

/** Frame count every sensor window is resampled to. */
export const WINDOW_FRAMES = 30;

/** Nominal capture rate the window length assumes, in Hz. */
export const WINDOW_HZ = 20;

/** Window length in milliseconds, derived rather than written down twice. */
export const WINDOW_MS = Math.round((WINDOW_FRAMES / WINDOW_HZ) * 1000);

/** Defaults for a fresh install. */
export const DEFAULT_ML_SETTINGS: MlSettings = {
  allowCollectedDataForTraining: false,
  consentRecordedAtMs: null,
  allowSimulatedTraining: false,
  activation: {
    minSamplesPerClass: 3,
    minTestAccuracy: 0.6,
  },
  unknownScore: 0.5,
  unknownMargin: 0.1,
};

/** The dataset schema version, bumped when a stored shape changes. */
export const DATASET_VERSION = 1;
