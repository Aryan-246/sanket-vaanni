/**
 * The learning pipeline, as one importable surface.
 *
 * ## The shape of it
 *
 * | File | What it decides |
 * | --- | --- |
 * | `types.ts` | The data contract. What a sample is and what travels with it. |
 * | `window.ts` | A run of frames becomes a fixed-length window, or is refused. |
 * | `features.ts` | A window becomes 55 named statistics. |
 * | `split.ts` | Which capture sessions train and which are held back. |
 * | `metrics.ts` | What the held-out figures are, and what they do not cover. |
 * | `classifier.ts` | The model: training, prediction, the algorithm's own words. |
 * | `modelStore.ts` | Whether a version may go live, and its card. |
 * | `modelPackage.ts` | Carrying a version to another phone, and refusing it when it does not fit. |
 * | `dataset.ts` | Which windows may be trained on, and why not the others. |
 * | `training.ts` | One run, end to end, from the data to a stored version. |
 * | `capture.ts` | Recording a window and asking a person what it was. |
 * | `inference.ts` | What may be said about live signing, including "not sure". |
 * | `media.ts` | Importing photos and video, on its own pipeline. |
 * | `store.ts` | Persistence: headers, bodies, models, sessions, settings. |
 * | `describe.ts` | What the centre claims about itself. |
 *
 * Every file above is either a pure function or a class with no React in it, so
 * all of the behaviour is testable without rendering anything. The screens read
 * from them; nothing about the learning logic lives in a component.
 *
 * ## The rule that holds the whole thing together
 *
 * Sensor motion is never a label. A label exists because a person chose it, and
 * a window without one is not a training example. Everything else here — the
 * fingerprint, the consent flag, the activation gate, the caveats — exists to
 * keep that statement true as data moves through the pipeline.
 */
export * from './types';
export * from './keys';
export {
  buildWindow,
  qualityNote,
  MIN_SOURCE_FRAMES,
  MAX_GAP_MS,
  type WindowBuild,
  type WindowFailure,
} from './window';
export {
  FEATURE_SPEC,
  FEATURE_COUNT,
  FEATURE_DESCRIPTION,
  FEATURE_CHANNELS,
  FEATURE_STATS,
  extractFeatures,
  fitStandardisation,
  matchesSpec,
  standardise,
} from './features';
export {
  splitBySession,
  leakedSessions,
  DEFAULT_FRACTIONS,
  type SplitFractions,
  type SplitOutcome,
} from './split';
export {
  buildEvaluation,
  describeAccuracy,
  type PredictionPair,
  type BuildEvaluationInput,
} from './metrics';
export {
  trainModel,
  predict,
  isCompatible,
  DESCRIPTIONS,
  DEFAULT_TRAINING_CONFIG,
  type EpochProgress,
  type Prediction,
  type TrainInput,
  type TrainOutcome,
} from './classifier';
export {
  activationDecision,
  activeModel,
  candidates,
  modelCard,
  nextVersion,
  planActivation,
  pruneTarget,
  relativeDay,
  describeSource,
  type ActivationDecision,
  type ActivationPlan,
  type ModelCard,
  type ModelCardLine,
} from './modelStore';
export {
  buildExport,
  datasetChecksum,
  datasetStateForModel,
  duplicateKey,
  findDuplicate,
  mediaFingerprint,
  MODALITY_LABEL,
  summarise,
  thinClasses,
  trainableDigest,
  trainableSet,
  verifyExport,
  VISION_NOTE,
  windowFingerprint,
  type DatasetExport,
  type DatasetMatch,
  type DatasetSummary,
  type Refusal,
  type RefusalCode,
  type TrainableSet,
} from './dataset';
export {
  runTraining,
  blockingClasses,
  describeTrainingFailure,
  type TrainingOutcome,
  type TrainingProgress,
} from './training';
export {
  CaptureController,
  UNCONFIRMED_LABEL_ID,
  type CapturePhase,
  type CaptureSink,
  type CaptureState,
  type PendingWindow,
} from './capture';
export {
  inferFromFrames,
  LiveInference,
  LIVE_NOTE,
  SCORE_NOTE,
  type InferInput,
  type InferenceOutcome,
  type InferenceState,
  type ScoredLabel,
  type UnknownReason,
} from './inference';
export {
  checkMedia,
  describeImport,
  importMedia,
  extractVideoFrames,
  labelAcceptsMedia,
  mediaDeletionNote,
  UnavailablePicker,
  type ImportReport,
  type MediaCheck,
  type MediaPicker,
  type MediaRejection,
  type PickedMedia,
} from './media';
export { MlStore, toHeader, toSummary, type MlResult, type MlSnapshot, type ModelSummary } from './store';
export {
  MODEL_PACKAGE_FORMAT,
  MODEL_PACKAGE_VERSION,
  assessCompatibility,
  buildModelPackage,
  deriveHandConfiguration,
  localCapabilities,
  packageIntegrity,
  verifyModelPackage,
  vocabularyFingerprint,
  type BuildPackageInput,
  type CompatibilityFinding,
  type HandConfigurationBasis,
  type LocalCapabilities,
  type ModelCompatibilityContract,
  type ModelHandConfiguration,
  type ModelPackage,
  type ModelVocabulary,
  type VerifyOutcome,
} from './modelPackage';
export {
  MlCentre,
  createIdFactory,
  type FrameSource,
  type GloveInfo,
  type MlAccount,
  type MlCentreDeps,
  type MlCentreSnapshot,
} from './centre';
export {
  activeModelDrift,
  candidateHold,
  describeCapabilities,
  describeDataset,
  describeModelStatus,
  describeModelSummary,
  describeRecordStatus,
  interruptedSessions,
  provenanceWarning,
  readiness,
  SOURCE_LABEL,
  versionsFor,
  type Capability,
  type CapabilityInput,
  type CapabilityState,
  type ReadinessStep,
} from './describe';
