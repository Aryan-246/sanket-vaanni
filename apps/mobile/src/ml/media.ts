/**
 * Bringing photos and videos into the library.
 *
 * ## This build has no picker, and says so
 *
 * There is no image picker, camera-roll or document-picker dependency in this
 * project — `package.json` has none, and the only media library present is a
 * video *player*. A screen with a "Choose a photo" button that called a missing
 * module would fail at the moment of use, and a screen that pretended to import
 * would be worse. So the picker is an injected capability with a real
 * availability check, and this build's picker reports that it is not installed
 * and why. The button exists, is reachable, and explains itself.
 *
 * Adding a picker is a native dependency change: it alters the Android build and
 * needs a fresh APK before anything about it can be verified. That is an owner
 * decision, not something to slip in behind an unrelated change — see the ML
 * section of the dated report.
 *
 * ## Vision stays on its own pipeline
 *
 * What this file produces is a `VisionSample`: a reference to a file on the
 * device plus the label a person gave it. It carries `usedForTraining: false`
 * and there is no code path anywhere that turns it into a sensor feature vector.
 * Storing a video does not train the glove model, and the UI says so in those
 * words.
 *
 * ## Failure is per item
 *
 * An import of five files where one is 40 MB and one has an unsupported type must
 * keep the other three. So nothing here returns a single status for a batch:
 * each item either becomes a sample or a named failure, and the report carries
 * both counts so a partial import can be described accurately rather than
 * rounded to "it failed".
 */
import { DATASET_VERSION, PREPROCESSING_VERSION, type LabelDefinition, type MediaReference, type VisionSample } from './types';
import { mediaFingerprint } from './dataset';
import { ML_LIMITS } from './keys';

/** What a picker returns. Deliberately plain data, no picker types leak out. */
export interface PickedMedia {
  readonly kind: 'photo' | 'video';
  readonly uri: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  /** Milliseconds for a video; null for a photo. */
  readonly durationMs: number | null;
}

/**
 * The device's media picker, as this module needs it.
 *
 * `isAvailable` is synchronous so a screen can decide what to render without
 * awaiting anything, and `unavailableReason` is a sentence rather than a code
 * because the person reading it needs to know what is missing.
 */
export interface MediaPicker {
  isAvailable(): boolean;
  unavailableReason(): string;
  pick(kind: 'photo' | 'video'): Promise<readonly PickedMedia[]>;
}

/**
 * The picker this build actually has.
 *
 * Every method that would reach a native module throws instead of returning an
 * empty list, so a caller that forgets to check availability gets a visible
 * error rather than a silent "you chose nothing".
 */
export class UnavailablePicker implements MediaPicker {
  isAvailable(): boolean {
    return false;
  }

  unavailableReason(): string {
    return 'This build has no photo or video picker installed, so files cannot be chosen from the device. Importing is unavailable until a picker is added to the app.';
  }

  async pick(): Promise<readonly PickedMedia[]> {
    throw new Error(this.unavailableReason());
  }
}

/** Why a file was not accepted. */
export type MediaRejection =
  | 'too-large'
  | 'too-long'
  | 'unsupported-type'
  | 'not-a-local-file'
  | 'no-dimensions'
  | 'no-consent'
  | 'picker-unavailable';

const REJECTION_TEXT: Record<MediaRejection, string> = {
  'too-large': `The file is larger than the ${Math.round(ML_LIMITS.maxImportBytes / (1024 * 1024))} MB an import can hold.`,
  'too-long': `The video is longer than the ${Math.round(ML_LIMITS.maxImportDurationMs / 1000)} seconds an import can hold.`,
  'unsupported-type': 'This file type is not one the app can read.',
  'not-a-local-file': 'The file is not on this device, so it cannot be kept reliably.',
  'no-dimensions': 'The file did not report its size, so it cannot be validated.',
  'no-consent': 'You have not agreed to importing files yet.',
  'picker-unavailable': 'This build has no photo or video picker installed.',
};

/** Accepted image and video types. Checked by MIME, not by file extension. */
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'];

export type MediaCheck =
  | { readonly ok: true; readonly reference: MediaReference }
  | { readonly ok: false; readonly code: MediaRejection; readonly reason: string };

/**
 * Whether one picked file may be kept.
 *
 * The size and duration limits exist because this data is stored on the phone
 * indefinitely and the frames of a long video would be copied into memory to be
 * examined. `file://` is required because a content URI or a network URL can stop
 * resolving, and a library entry pointing at nothing is a broken record.
 */
export function checkMedia(item: PickedMedia): MediaCheck {
  if (!item.uri.startsWith('file://')) {
    return { ok: false, code: 'not-a-local-file', reason: REJECTION_TEXT['not-a-local-file'] };
  }
  if (!Number.isFinite(item.byteSize) || item.byteSize <= 0) {
    return { ok: false, code: 'no-dimensions', reason: REJECTION_TEXT['no-dimensions'] };
  }
  if (item.byteSize > ML_LIMITS.maxImportBytes) {
    return { ok: false, code: 'too-large', reason: REJECTION_TEXT['too-large'] };
  }
  if (item.width <= 0 || item.height <= 0) {
    return { ok: false, code: 'no-dimensions', reason: REJECTION_TEXT['no-dimensions'] };
  }

  const supported = item.kind === 'photo' ? PHOTO_TYPES : VIDEO_TYPES;
  if (!supported.includes(item.mimeType.toLowerCase())) {
    return { ok: false, code: 'unsupported-type', reason: REJECTION_TEXT['unsupported-type'] };
  }

  if (item.kind === 'video') {
    if (item.durationMs === null || item.durationMs <= 0) {
      return { ok: false, code: 'no-dimensions', reason: REJECTION_TEXT['no-dimensions'] };
    }
    if (item.durationMs > ML_LIMITS.maxImportDurationMs) {
      return { ok: false, code: 'too-long', reason: REJECTION_TEXT['too-long'] };
    }
  }

  return {
    ok: true,
    reference: {
      kind: item.kind,
      uri: item.uri,
      mimeType: item.mimeType,
      byteSize: item.byteSize,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
    },
  };
}

/* --------------------------------------------------------------- importing */

export interface ImportFailure {
  readonly uri: string;
  readonly code: MediaRejection;
  readonly reason: string;
}

export interface ImportReport {
  readonly requested: number;
  readonly imported: readonly VisionSample[];
  readonly failed: readonly ImportFailure[];
  /** Files already in the library, skipped rather than stored twice. */
  readonly duplicates: number;
  /** True when every item failed, so the screen can say so plainly. */
  readonly totalFailure: boolean;
  readonly note: string;
}

export interface ImportInput {
  readonly picker: MediaPicker;
  readonly kind: 'photo' | 'video';
  readonly languageId: string;
  readonly labelId: string;
  /** Files already held, so a repeat import does not double the library. */
  readonly existingUris: readonly string[];
  /** The user's explicit agreement to import. Asked once, on the screen. */
  readonly consented: boolean;
  readonly ownerId: string | null;
  readonly nowMs: number;
  readonly newId: () => string;
}

/**
 * Picks files and turns each accepted one into a labelled vision sample.
 *
 * Nothing is trained, nothing is uploaded, and each item's fate is recorded
 * separately — see the note at the top of this file about partial failure.
 */
export async function importMedia(input: ImportInput): Promise<ImportReport> {
  if (!input.consented) {
    return {
      requested: 0,
      imported: [],
      failed: [
        { uri: '', code: 'no-consent', reason: REJECTION_TEXT['no-consent'] },
      ],
      duplicates: 0,
      totalFailure: true,
      note: 'Nothing was imported because you have not agreed to it yet.',
    };
  }

  if (!input.picker.isAvailable()) {
    return {
      requested: 0,
      imported: [],
      failed: [
        { uri: '', code: 'picker-unavailable', reason: input.picker.unavailableReason() },
      ],
      duplicates: 0,
      totalFailure: true,
      note: input.picker.unavailableReason(),
    };
  }

  let picked: readonly PickedMedia[];
  try {
    picked = await input.picker.pick(input.kind);
  } catch (err) {
    const reason = err instanceof Error && err.message.length > 0 ? err.message : 'the picker gave no reason';
    return {
      requested: 0,
      imported: [],
      failed: [{ uri: '', code: 'picker-unavailable', reason }],
      duplicates: 0,
      totalFailure: true,
      note: `The picker could not be opened: ${reason}`,
    };
  }

  const seen = new Set(input.existingUris);
  const imported: VisionSample[] = [];
  const failed: ImportFailure[] = [];
  let duplicates = 0;

  for (const item of picked) {
    if (seen.has(item.uri)) {
      duplicates += 1;
      continue;
    }

    const check = checkMedia(item);
    if (!check.ok) {
      failed.push({ uri: item.uri, code: check.code, reason: check.reason });
      continue;
    }

    seen.add(item.uri);
    imported.push({
      id: input.newId(),
      sessionId: input.newId(),
      ownerId: input.ownerId,
      languageId: input.languageId,
      labelId: input.labelId,
      modality: 'vision',
      source: 'media',
      handContext: 'both',
      // A newly imported file has not been reviewed by the person yet.
      approval: 'pending',
      quality: {
        expectedFrames: 0,
        frameCount: 0,
        maxGapMs: 0,
        flatChannels: [],
        outOfRangeChannels: [],
        ok: true,
      },
      capturedAtMs: input.nowMs,
      calibrationVersion: null,
      preprocessingVersion: PREPROCESSING_VERSION,
      datasetVersion: DATASET_VERSION,
      fingerprint: mediaFingerprint(item.uri),
      rejectionReason: null,
      media: check.reference,
      usedForTraining: false,
    });
  }

  return {
    requested: picked.length,
    imported,
    failed,
    duplicates,
    /*
     * "Nothing was added" and "nothing worked" are different results. A batch of
     * files that are all already in the library added nothing and failed at
     * nothing — the note says so, and a failure banner over it would contradict
     * that sentence. So this is true only when something was actually refused.
     */
    totalFailure: imported.length === 0 && failed.length > 0,
    note: describeImport(picked.length, imported.length, failed.length, duplicates),
  };
}

/** One sentence summarising a batch, counting each outcome separately. */
export function describeImport(
  requested: number,
  imported: number,
  failed: number,
  duplicates: number,
): string {
  if (requested === 0) return 'Nothing was chosen.';
  const parts = [`${imported} of ${requested} file${requested === 1 ? '' : 's'} added`];
  if (duplicates > 0) parts.push(`${duplicates} already in the library`);
  if (failed > 0) parts.push(`${failed} not accepted`);
  return `${parts.join(', ')}.`;
}

/* ------------------------------------------------------------------ frames */

export type FrameExtraction =
  | { readonly ok: true; readonly frames: readonly string[] }
  | { readonly ok: false; readonly code: 'no-extractor'; readonly reason: string };

/**
 * Frames from a video, for the vision pipeline.
 *
 * Not implemented, and not stubbed. Extracting frames needs a native decoder;
 * this build has a video *player* and no way to pull individual frames out of a
 * file. Returning placeholder images, or a single thumbnail presented as a
 * frame sequence, would be exactly the kind of invention the rest of this
 * pipeline refuses — and it would feed a vision model that does not exist.
 */
export function extractVideoFrames(): FrameExtraction {
  return {
    ok: false,
    code: 'no-extractor',
    reason:
      'This build cannot pull frames out of a video, so imported videos are kept as labelled records only.',
  };
}

/** Removes a vision sample's record. The file itself belongs to the device. */
export function mediaDeletionNote(reference: MediaReference): string {
  return `This removes the app's record of the ${reference.kind}. The file itself stays in your phone's storage, because the app did not put it there and will not delete it.`;
}

/** Whether this label may receive media, given the language it belongs to. */
export function labelAcceptsMedia(
  label: LabelDefinition | null,
  languageId: string,
): { ok: true } | { ok: false; reason: string } {
  if (label === null) {
    return { ok: false, reason: 'Choose which sign these files are examples of.' };
  }
  if (label.archivedAtMs !== null) {
    return { ok: false, reason: `"${label.text}" has been archived, so nothing new can be added to it.` };
  }
  if (label.languageId !== languageId) {
    return {
      ok: false,
      reason: `"${label.text}" belongs to a different sign language than the one selected.`,
    };
  }
  return { ok: true };
}
