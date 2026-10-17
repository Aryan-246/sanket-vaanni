/**
 * Where the learning pipeline puts things.
 *
 * ## Why an index instead of one big key
 *
 * A sample is 30 frames of 11 numbers plus its metadata — several kilobytes of
 * JSON. Holding every sample under a single storage key would mean rewriting the
 * whole dataset to save one capture, and it would run into the platform's
 * per-entry size limit at a few hundred windows, which is a few days of ordinary
 * use. So each sample body lives under its own key and a small index holds the
 * headers.
 *
 * The index is a **cache, not the truth**: `dataset.ts` treats a body that has
 * gone missing as a damaged sample and reports it, rather than pretending the
 * header is the sample. Losing a body costs one sample and is visible; a single
 * monolithic key would lose everything at once.
 *
 * ## Guest data
 *
 * Every key below is local-only. Nothing in `src/ml` writes to Supabase, and the
 * `ownerId` on a sample records whose it is *on this device*. See the note in
 * `dataset.ts` about cloud backup being unimplemented.
 */
export const ML_STORE_VERSION = 'sv/v1/ml';

export const ML_KEYS = {
  settings: `${ML_STORE_VERSION}/settings`,
  labels: `${ML_STORE_VERSION}/labels`,
  sessions: `${ML_STORE_VERSION}/sessions`,
  sampleIndex: `${ML_STORE_VERSION}/samples-index`,
  sample: (id: string) => `${ML_STORE_VERSION}/samples/${id}`,
  /**
   * The window that has been recorded but not yet confirmed as a sign.
   *
   * Held in its own key so that a window is never lost to a crash between "the
   * recording finished" and "the user said which sign it was", and never stored
   * as a sample under a label nobody chose. It is cleared the moment the window
   * is confirmed, relabelled away, or discarded.
   */
  pendingWindow: `${ML_STORE_VERSION}/pending-window`,
  modelIndex: `${ML_STORE_VERSION}/models-index`,
  model: (id: string) => `${ML_STORE_VERSION}/models/${id}`,
  /** Which model version is live, per language and modality. */
  active: (languageId: string, modality: string) =>
    `${ML_STORE_VERSION}/active/${languageId}/${modality}`,
  /** Running count for human-readable model versions. */
  versionCounter: (languageId: string, modality: string) =>
    `${ML_STORE_VERSION}/versions/${languageId}/${modality}`,
  /** How many imports have run, so partial failures can be summarised. */
  importLog: `${ML_STORE_VERSION}/imports`,
} as const;

/** Prefix under which every sample body lives, for deletion scans. */
export const ML_SAMPLE_PREFIX = `${ML_STORE_VERSION}/samples/`;

/**
 * Bounds that keep the store honest about size.
 *
 * These are limits, not targets. A capture that would exceed them is refused
 * with a reason rather than truncated, because a truncated window is a sample
 * that does not mean what it says.
 */
export const ML_LIMITS = {
  /** Windows kept locally before the oldest unconfirmed ones are reported. */
  maxSamples: 2000,
  /** Sessions kept before the oldest closed ones are reported. */
  maxSessions: 500,
  /** Model versions kept per language and modality. */
  maxModelsPerTarget: 20,
  /** Largest single imported file accepted, bytes (25 MB). */
  maxImportBytes: 25 * 1024 * 1024,
  /** Most frames extracted from one imported video. */
  maxImportedFrames: 5,
  /** Longest video accepted, milliseconds (2 minutes). */
  maxImportDurationMs: 120_000,
} as const;
