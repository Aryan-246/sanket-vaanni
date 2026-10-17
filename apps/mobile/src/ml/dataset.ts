/* eslint-disable no-bitwise -- FNV-1a is defined in terms of 32-bit xor and
   multiply; the fingerprints and the export checksum in this file are the two
   places it appears, and there is no arithmetic spelling of it that stays
   faithful to the algorithm. */
/**
 * The rules a dataset has to satisfy before anything is trained on it.
 *
 * ## Why the refusals are the interesting part
 *
 * Anyone can write a filter that keeps `approval === 'approved'`. What makes a
 * dataset trustworthy is being able to say *why* everything else was left out,
 * and to say it to the person who captured it. A sample rejected because they
 * never confirmed the label is a different situation from one rejected because
 * its glove channels were out of range, and both are different again from a
 * dataset where the user never granted permission to train. So every exclusion
 * is returned as a counted, named reason.
 *
 * ## The rules this file exists to enforce
 *
 * - **No unlabelled motion as ground truth.** Only a sample the user confirmed
 *   is trainable. Motion alone is never a training example, however plausible.
 * - **No mixing of modalities.** A photograph is never a sensor window, and the
 *   filter below can only ever return sensor windows.
 * - **Simulated data is opt-in, and declared.** A model fitted on Demo Mode
 *   data recognises that waveform. It is permitted only when the user has turned
 *   it on, and the source travels into the model record so the card can say so.
 * - **One language at a time.** A model is built for one sign language; windows
 *   from another would give it labels that mean different things.
 * - **Consent is explicit and separate.** Permission to record is not permission
 *   to train — see `MlSettings.allowCollectedDataForTraining`.
 *
 * ## What is deliberately absent
 *
 * There is no upload, no sync and no cloud backup. The directive asks for cloud
 * persistence "once verified"; no dataset table exists on the backend, no
 * migration has been applied, and this build must not imply otherwise. Data
 * lives on this device until an owner-approved schema exists for it.
 */
import { PREPROCESSING_VERSION, WINDOW_FRAMES } from './types';
import type {
  CaptureSessionMeta,
  FrameVector,
  LabelDefinition,
  MlSettings,
  Modality,
  SampleHeader,
  SampleSource,
  SensorWindowSample,
  TrainingSample,
} from './types';

/** Statistical tolerance for calling two windows the same, in flex units. */
const DUPLICATE_TOLERANCE = 0.002;

/**
 * FNV-1a over a canonical rendering of the frames.
 *
 * Used only to spot a window that was captured twice — a double press, a resumed
 * session, an import run twice. It is a cheap equality check, not a checksum for
 * tamper detection, and nothing about it is a security property.
 */
function hashFrameList(frames: readonly FrameVector[]): string {
  const quantised = frames
    .map((frame) =>
      [
        Math.round(frame.tMs),
        ...frame.flex.map((value) => Math.round(value / DUPLICATE_TOLERANCE)),
        ...frame.a.map((value) => Math.round(value * 100)),
        ...frame.g.map((value) => Math.round(value * 100)),
      ].join(','),
    )
    .join(';');

  let value = 0x811c9dc5;
  for (let index = 0; index < quantised.length; index += 1) {
    value ^= quantised.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16);
}

/**
 * The identity of a window for duplicate purposes.
 *
 * Includes the label, because the same motion deliberately captured once under
 * each of two very similar signs is two examples, not a duplicate — a person
 * doing that has made a statement about the pair. Includes the language, the
 * source and the hand, because those change what the numbers mean.
 */
export function windowFingerprint(input: {
  readonly languageId: string;
  readonly labelId: string;
  readonly side: string;
  readonly source: string;
  readonly handContext: string;
  readonly frames: readonly FrameVector[];
}): string {
  return [
    input.languageId,
    input.labelId,
    input.side,
    input.source,
    input.handContext,
    hashFrameList(input.frames),
  ].join('|');
}

/** The fingerprint of a stored sensor sample. */
export function duplicateKey(sample: SensorWindowSample): string {
  return windowFingerprint(sample);
}

/** The first already-stored sample this one duplicates, or null. */
export function findDuplicate(
  existing: readonly TrainingSample[],
  sample: SensorWindowSample,
): SensorWindowSample | null {
  const key = duplicateKey(sample);
  for (const candidate of existing) {
    if (candidate.modality !== 'glove-sensor') continue;
    if (candidate.id === sample.id) continue;
    if (duplicateKey(candidate) === key) return candidate;
  }
  return null;
}

/** The fingerprint of an imported file: the same file is the same sample. */
export function mediaFingerprint(uri: string): string {
  return `media|${uri}`;
}

/** Why a sample was left out of training. Stable codes for the UI to group on. */
export type RefusalCode =
  | 'not-confirmed'
  | 'rejected-by-user'
  | 'consent-missing'
  | 'simulated-not-permitted'
  | 'vision-not-trainable'
  | 'quality-failed'
  | 'wrong-language'
  | 'deprecated-preprocessing'
  | 'wrong-shape';

export interface Refusal {
  readonly code: RefusalCode;
  readonly count: number;
  /** One sentence, already in the app's voice. */
  readonly reason: string;
}

export interface TrainableSet {
  readonly samples: readonly SensorWindowSample[];
  /** Every reason anything was excluded, with how many it affected. */
  readonly refused: readonly Refusal[];
  /** True when nothing can be trained, with the single most useful reason. */
  readonly blocked: { readonly code: RefusalCode; readonly reason: string } | null;
  /** Statements a reader of the resulting metrics needs, e.g. mixed calibration. */
  readonly caveats: readonly string[];
}

const REFUSAL_TEXT: Record<RefusalCode, string> = {
  'not-confirmed':
    'Not yet confirmed by you. Motion on its own is never treated as a labelled example.',
  'rejected-by-user': 'You marked these as not being the sign they were recorded under.',
  'consent-missing':
    'You have not yet allowed recorded data to be used for training.',
  'simulated-not-permitted':
    'Recorded in Demo Mode. A model trained on simulated motion recognises that simulation, not signing.',
  'vision-not-trainable':
    'Photos and videos. There is no vision model in this app, so stored media never trains anything.',
  'quality-failed':
    'The glove signal did not pass its checks, for example a channel that never moved.',
  'wrong-language': 'Recorded for a different sign language.',
  'deprecated-preprocessing': 'Recorded by an older version of the window pipeline.',
  'wrong-shape': 'The stored window is not the length this build produces.',
};

/** Counts each refusal reason once, in a fixed order, so output is stable. */
function countRefusals(codes: readonly RefusalCode[]): Refusal[] {
  const order: RefusalCode[] = [
    'not-confirmed',
    'rejected-by-user',
    'consent-missing',
    'simulated-not-permitted',
    'vision-not-trainable',
    'quality-failed',
    'wrong-language',
    'deprecated-preprocessing',
    'wrong-shape',
  ];
  const counts = new Map<RefusalCode, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);

  return order
    .filter((code) => (counts.get(code) ?? 0) > 0)
    .map((code) => ({ code, count: counts.get(code)!, reason: REFUSAL_TEXT[code] }));
}

export interface TrainableInput {
  readonly samples: readonly TrainingSample[];
  readonly languageId: string;
  readonly settings: MlSettings;
}

/**
 * The samples that may be trained on right now, and everything that may not.
 *
 * Order is preserved so a split is reproducible from the same input.
 */
export function trainableSet(input: TrainableInput): TrainableSet {
  const { samples, languageId, settings } = input;
  const kept: SensorWindowSample[] = [];
  const refused: RefusalCode[] = [];

  for (const sample of samples) {
    // Vision first, so a photo is never even considered by the sensor rules.
    if (sample.modality === 'vision') {
      refused.push('vision-not-trainable');
      continue;
    }

    if (sample.approval === 'pending') refused.push('not-confirmed');
    else if (sample.approval === 'rejected') refused.push('rejected-by-user');

    if (!settings.allowCollectedDataForTraining) refused.push('consent-missing');

    if (sample.source === 'simulated' && !settings.allowSimulatedTraining) {
      refused.push('simulated-not-permitted');
    }

    if (!sample.quality.ok) refused.push('quality-failed');
    if (sample.languageId !== languageId) refused.push('wrong-language');
    if (sample.preprocessingVersion !== PREPROCESSING_VERSION) {
      refused.push('deprecated-preprocessing');
    }
    if (sample.frames.length !== WINDOW_FRAMES) refused.push('wrong-shape');

    const excluded =
      sample.approval !== 'approved' ||
      !settings.allowCollectedDataForTraining ||
      (sample.source === 'simulated' && !settings.allowSimulatedTraining) ||
      !sample.quality.ok ||
      sample.languageId !== languageId ||
      sample.preprocessingVersion !== PREPROCESSING_VERSION ||
      sample.frames.length !== WINDOW_FRAMES;

    if (!excluded) kept.push(sample);
  }

  const caveats: string[] = [];
  const calibrations = new Set(
    kept.map((sample) => sample.calibrationVersion).filter((value): value is number => value !== null),
  );
  const uncalibrated = kept.filter((sample) => sample.calibrationVersion === null).length;

  if (calibrations.size > 1) {
    caveats.push(
      `This data was recorded with ${calibrations.size} different calibrations. Flex values from one are not on the same scale as another, so averaged statistics mix them.`,
    );
  }
  if (uncalibrated > 0) {
    caveats.push(
      `${uncalibrated} of these windows were recorded with no calibration, so their flex channels are raw.`,
    );
  }

  const sources = [...new Set(kept.map((sample) => sample.source))].sort();
  if (sources.includes('simulated')) {
    caveats.push(
      'Demo Mode windows are included. The model will recognise that simulated waveform; it is not evidence of recognising real signing.',
    );
  }

  const refusalSummary = countRefusals(refused);
  const blocked =
    kept.length === 0
      ? {
          code: (refusalSummary[0]?.code ?? 'not-confirmed') as RefusalCode,
          reason: blockReason(refusalSummary, samples.length),
        }
      : null;

  return { samples: kept, refused: refusalSummary, blocked, caveats };
}

/**
 * The single most useful thing to tell someone whose dataset cannot train.
 *
 * Consent comes first because it is the one exclusion that is a switch the user
 * can simply turn on, and the one that silently applies to everything.
 */
function blockReason(refusals: readonly Refusal[], total: number): string {
  if (total === 0) {
    return 'No window has been recorded yet. Record a few repetitions of two or more signs, then confirm each one.';
  }
  const consent = refusals.find((refusal) => refusal.code === 'consent-missing');
  if (consent !== undefined) {
    return `None of the ${total} recorded window${total === 1 ? '' : 's'} may be used for training yet, because you have not allowed it. That permission is in the learning settings.`;
  }
  const unconfirmed = refusals.find((refusal) => refusal.code === 'not-confirmed');
  if (unconfirmed !== undefined) {
    return `${unconfirmed.count} recorded window${unconfirmed.count === 1 ? '' : 's'} are waiting for you to confirm which sign they are. Confirming is what turns motion into a labelled example.`;
  }
  return refusals[0]?.reason ?? 'Nothing is available to train on yet.';
}

/* ------------------------------------------------------------- summaries */

export interface DatasetSummary {
  readonly total: number;
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
  readonly sensor: number;
  readonly vision: number;
  readonly bySource: Readonly<Record<SampleSource, number>>;
  readonly byLanguage: Readonly<Record<string, number>>;
  readonly sessions: number;
  readonly labels: number;
  /** Approved sensor windows per label — what a model's balance depends on. */
  readonly perLabel: Readonly<Record<string, number>>;
}

/** Counts for the library view. Pure, so the screen can render it directly. */
export function summarise(
  samples: readonly SampleHeader[],
  labels: readonly LabelDefinition[],
  sessionCount: number,
): DatasetSummary {
  const bySource: Record<SampleSource, number> = {
    glove: 0,
    simulated: 0,
    imported: 0,
    media: 0,
  };
  const byLanguage: Record<string, number> = {};
  const perLabel: Record<string, number> = {};

  let pending = 0;
  let approved = 0;
  let rejected = 0;
  let sensor = 0;
  let vision = 0;

  for (const sample of samples) {
    if (sample.approval === 'pending') pending += 1;
    else if (sample.approval === 'approved') approved += 1;
    else rejected += 1;

    if (sample.modality === 'vision') vision += 1;
    else sensor += 1;

    bySource[sample.source] = (bySource[sample.source] ?? 0) + 1;
    byLanguage[sample.languageId] = (byLanguage[sample.languageId] ?? 0) + 1;

    if (sample.modality === 'glove-sensor' && sample.approval === 'approved') {
      perLabel[sample.labelId] = (perLabel[sample.labelId] ?? 0) + 1;
    }
  }

  return {
    total: samples.length,
    pending,
    approved,
    rejected,
    sensor,
    vision,
    bySource,
    byLanguage,
    sessions: sessionCount,
    labels: labels.filter((label) => label.archivedAtMs === null).length,
    perLabel,
  };
}

/** Classes with fewer than `minimum` approved windows, worst first. */
export function thinClasses(
  summary: DatasetSummary,
  labels: readonly LabelDefinition[],
  minimum: number,
): readonly { readonly labelId: string; readonly text: string; readonly count: number }[] {
  return labels
    .filter((label) => label.archivedAtMs === null)
    .map((label) => ({
      labelId: label.id,
      text: label.text,
      count: summary.perLabel[label.id] ?? 0,
    }))
    .filter((entry) => entry.count < minimum)
    .sort((a, b) => a.count - b.count || a.text.localeCompare(b.text));
}

/* ----------------------------------------------------------------- export */

/** The exported dataset file. Versioned, because it is read back by a person. */
export interface DatasetExport {
  readonly format: 'sanketvaanni.ml.dataset';
  readonly datasetVersion: number;
  readonly exportedAtMs: number;
  readonly ownerId: string | null;
  readonly preprocessingVersion: string;
  readonly labels: readonly LabelDefinition[];
  readonly sessions: readonly CaptureSessionMeta[];
  readonly samples: readonly TrainingSample[];
  /** Integrity check over the sample bodies, so a partial file is detectable. */
  readonly checksum: string;
  readonly note: string;
}

/** Canonical rendering: keys sorted, so the same data always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

/**
 * FNV-1a over a string, as eight hex digits.
 *
 * Exported so there is one spelling of the digest in the learning pipeline. The
 * export checksum, the duplicate fingerprints and a version package's integrity
 * digest are all this function; written out three times they would eventually
 * disagree, and a digest that disagrees with itself reports every file as
 * damaged.
 */
export function fnv1a(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

/** A short hex digest of the samples, for spotting a truncated export. */
export function datasetChecksum(samples: readonly TrainingSample[]): string {
  return fnv1a(canonical(samples));
}

/**
 * A digest of *which* windows are in a set, by identity and content.
 *
 * Deliberately not `datasetChecksum`. That one hashes a whole export including
 * its ordering, because its job is spotting a truncated file. This one is
 * order-independent and covers only what a training run actually consumes: which
 * windows are present, what each one is labelled, and whether it has been
 * approved.
 *
 * A model records the digest of the set it was fitted on, so that the app can
 * later answer "is that set still here?" instead of leaving the reader to assume
 * the weights reflect data that has since been deleted or re-labelled. Without
 * it there is no way to tell: `ModelRecord` holds only counts, and a count of 40
 * windows reads the same whether they are the same 40 or a different 40.
 *
 * Not a security property and not a cryptographic commitment. It answers "has
 * this changed?", which deleting a window, re-labelling a window or rejecting one
 * all do.
 */
export function trainableDigest(samples: readonly TrainingSample[]): string {
  const parts = samples
    .map((sample) => `${sample.id}#${sample.fingerprint}#${sample.labelId}#${sample.approval}`)
    .sort();
  return fnv1a(parts.join('|'));
}

/**
 * Whether a model still matches the data it was fitted on.
 *
 * Three answers, not two. `unknown` is what a model reports when it carries no
 * digest — one fitted before the field existed, or one taken in from a package
 * written on another phone. Those are genuinely unknown, and folding them into
 * `unchanged` would assert something about a dataset this install has never
 * seen.
 *
 * `changed` does **not** mean the model is wrong or that it was retrained. It
 * means the weights are the same weights and the data underneath them is not:
 * deleting, re-labelling or rejecting a window moves the set, and nothing
 * updates the weights afterwards. The honest sentence is "the data has changed
 * since this was trained", not "this model is stale" and certainly not "this
 * model has been updated".
 */
export type DatasetMatch = 'unchanged' | 'changed' | 'unknown';

export function datasetStateForModel(
  model: { readonly trainedOnDigest?: string | null },
  currentTrainable: readonly TrainingSample[],
): DatasetMatch {
  const recorded = model.trainedOnDigest;
  if (recorded === undefined || recorded === null || recorded.length === 0) return 'unknown';
  return trainableDigest(currentTrainable) === recorded ? 'unchanged' : 'changed';
}

/**
 * Everything the user owns, in one file.
 *
 * Deliberately includes *all* samples, including pending and rejected ones and
 * including media references. A rejected sample is part of the record of what
 * was decided; dropping it would make an export silently disagree with the app.
 * Media files themselves are not embedded — only their references — and the note
 * in the payload says so, because an export that appears to contain a video it
 * does not is worse than one that says where the video lives.
 */
export function buildExport(input: {
  readonly samples: readonly TrainingSample[];
  readonly labels: readonly LabelDefinition[];
  readonly sessions: readonly CaptureSessionMeta[];
  readonly ownerId: string | null;
  readonly datasetVersion: number;
  readonly nowMs: number;
}): DatasetExport {
  return {
    format: 'sanketvaanni.ml.dataset',
    datasetVersion: input.datasetVersion,
    exportedAtMs: input.nowMs,
    ownerId: input.ownerId,
    preprocessingVersion: PREPROCESSING_VERSION,
    labels: input.labels,
    sessions: input.sessions,
    samples: input.samples,
    checksum: datasetChecksum(input.samples),
    note:
      'Windows are stored as recorded. Photos and videos are referenced by their location on this phone; the media itself is not inside this file.',
  };
}

/** Whether an exported payload is internally consistent, and why not if not. */
export function verifyExport(payload: DatasetExport): { ok: true } | { ok: false; reason: string } {
  if (payload.format !== 'sanketvaanni.ml.dataset') {
    return { ok: false, reason: 'This file was not exported by Sanket Vaanni.' };
  }
  if (payload.preprocessingVersion !== PREPROCESSING_VERSION) {
    return {
      ok: false,
      reason: `The file was written by a different window pipeline (${payload.preprocessingVersion}, this build uses ${PREPROCESSING_VERSION}).`,
    };
  }
  if (datasetChecksum(payload.samples) !== payload.checksum) {
    return { ok: false, reason: 'The file is incomplete or was altered after it was written.' };
  }
  return { ok: true };
}

/** How a modality reads in the UI. One place, so the words cannot drift. */
export const MODALITY_LABEL: Record<Modality, string> = {
  'glove-sensor': 'Glove sensors',
  vision: 'Photos and video',
};

/** Why vision samples exist at all, said honestly. */
export const VISION_NOTE =
  'Photos and videos are kept as labelled records and as a possible future input. Nothing in this app can learn from them yet, and storing one does not train the glove model.';
