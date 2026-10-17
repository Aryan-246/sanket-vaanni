/**
 * What the learning centre can and cannot do, in one place.
 *
 * ## Why this is a module and not `const CAPABILITIES = [...]` in the screen
 *
 * Every claim here is a statement about the app that somebody will rely on. If
 * they live in a screen, nothing can assert them, and the first refactor makes
 * the screen say something the code no longer does. Here they are computed from
 * real inputs — whether a picker exists, which transport is connected, how many
 * windows are confirmed — and the tests beside this file pin each one.
 *
 * ## The three states, and why "not built" is not "broken"
 *
 * - `working` — done, and reachable now.
 * - `blocked` — real code exists, but something outside the app stops it. Always
 *   carries whose decision it is: the phone, the glove, the owner.
 * - `not-built` — no code, and saying so is the point. A vision model does not
 *   exist; pretending otherwise would make the media library look like it
 *   contributed to recognition.
 *
 * A screen that renders this list cannot overstate the app, because it is not
 * inventing the words.
 */
import type { DatasetSummary } from './dataset';
import type { CaptureSessionMeta, MlSettings, ModelRecord, SampleSource } from './types';
import type { ModelSummary } from './store';

export type CapabilityState = 'working' | 'blocked' | 'not-built';

export interface Capability {
  readonly id: string;
  readonly title: string;
  readonly state: CapabilityState;
  /** What is true right now, in one sentence. */
  readonly detail: string;
  /** What would change it, when something can. Null when nothing here can. */
  readonly action: string | null;
}

export interface CapabilityInput {
  /** Whether the glove transport is a real one or the Demo Mode producer. */
  readonly transportSynthetic: boolean;
  readonly transportName: string;
  readonly linkConnected: boolean;
  readonly pickerAvailable: boolean;
  readonly pickerReason: string;
  readonly settings: MlSettings;
  readonly summary: DatasetSummary;
  readonly activeModel: ModelSummary | null;
  readonly candidateCount: number;
  readonly signedIn: boolean;
}

/**
 * Every capability the ML centre shows, in the order it is shown.
 *
 * The order runs from "can I record anything at all" outwards, because that is
 * the order in which someone meets the obstacles.
 */
export function describeCapabilities(input: CapabilityInput): readonly Capability[] {
  const connectedToGlove = input.linkConnected && !input.transportSynthetic;

  return [
    {
      id: 'capture',
      title: 'Recording from a glove',
      state: input.linkConnected ? 'working' : 'blocked',
      detail: input.linkConnected
        ? `Recording receives every frame from ${input.transportName}.`
        : 'No glove is connected, so nothing can be recorded yet.',
      action: input.linkConnected
        ? null
        : 'Connect a glove on the OLED screen, or use Demo Mode to record simulated motion.',
    },
    {
      id: 'real-glove',
      title: 'A real glove connection',
      state: connectedToGlove ? 'working' : 'blocked',
      detail: connectedToGlove
        ? `Connected to ${input.transportName}.`
        : input.transportSynthetic
          ? 'Demo Mode produces a simulated waveform. It is not a glove, and a model trained on it learns that waveform.'
          : 'The Bluetooth transport is not connected. The connection manager is written, but the glove’s protocol has never been verified against hardware.',
      action: connectedToGlove
        ? null
        : 'The protocol still needs checking against a real glove: service and characteristic UUIDs, packet layout, sample rate and handshake. Until that is done, a real connection cannot be attempted.',
    },
    {
      id: 'labels',
      title: 'Defining signs',
      state: 'working',
      detail:
        input.summary.labels > 0
          ? `${input.summary.labels} sign${input.summary.labels === 1 ? '' : 's'} defined. These are your own names, not a reviewed vocabulary.`
          : 'No signs defined yet. Recording needs at least one name to file windows under.',
      action:
        input.summary.labels > 0
          ? null
          : 'A published vocabulary requires a Deaf-led review, which has not happened. Definitions you make here are working labels for your own data.',
    },
    {
      id: 'training',
      title: 'Training on this phone',
      state: input.settings.allowCollectedDataForTraining ? 'working' : 'blocked',
      detail: input.settings.allowCollectedDataForTraining
        ? `A linear classifier is fitted on the phone, offline. ${describeConfirmed(input.summary)}`
        : 'Training is off, because recorded data has not been allowed for it. Recording and training are separate permissions.',
      action: input.settings.allowCollectedDataForTraining
        ? null
        : 'Turn on "Use my recordings to train" in the privacy section when you are ready.',
    },
    {
      id: 'evaluation',
      title: 'Measuring a model',
      state: input.summary.sessions >= 2 ? 'working' : 'blocked',
      detail:
        input.summary.sessions >= 2
          ? 'Windows from one capture session are held back, so the figure is measured on a sitting the model never saw.'
          : `Only ${input.summary.sessions} capture session${input.summary.sessions === 1 ? '' : 's'} so far. With one session, nothing can be held back and no figure can be measured.`,
      action:
        input.summary.sessions >= 2
          ? null
          : 'Record the same signs in a second session, ideally on another day or with the glove re-calibrated.',
    },
    {
      id: 'inference',
      title: 'Recognising live',
      state: input.activeModel === null ? 'blocked' : 'working',
      detail:
        input.activeModel === null
          ? input.candidateCount > 0
            ? `${input.candidateCount} trained version${input.candidateCount === 1 ? '' : 's'} exist but none has passed the checks to go live.`
            : 'No model has been trained yet, so nothing is recognised.'
          : `Version ${input.activeModel.version} is live. It names a sign only when the top score is clear of the next one; otherwise it says it is not sure.`,
      action:
        input.activeModel === null && input.candidateCount > 0
          ? 'Open the version to see what held it back. More confirmed examples of the signs it confuses is usually the answer.'
          : null,
    },
    {
      id: 'media',
      title: 'Importing photos and video',
      state: input.pickerAvailable ? 'working' : 'blocked',
      detail: input.pickerAvailable
        ? 'Files can be chosen from the device and stored as labelled records.'
        : `${input.pickerReason} Files are kept as labelled records only; they never train the glove model.`,
      action: input.pickerAvailable
        ? null
        : 'Adding a picker changes the native build, so it needs its own release and a fresh device test. It is not installed in this build.',
    },
    {
      id: 'vision',
      title: 'Learning from photos and video',
      state: 'not-built',
      detail:
        'No vision model exists in this app, and this build cannot extract frames from a video. Storing a photo or a video does not train anything.',
      action: null,
    },
    {
      id: 'cloud',
      title: 'Backing up to the cloud',
      state: 'not-built',
      detail: input.signedIn
        ? 'Your recordings are on this phone. There is no dataset table on the server for them, so nothing is uploaded.'
        : 'Your recordings are on this phone only, and are not tied to an account. Nothing is uploaded.',
      action: null,
    },
    {
      id: 'simulated',
      title: 'Training on simulated motion',
      state: 'working',
      detail: input.settings.allowSimulatedTraining
        ? 'Allowed. A model fitted on Demo Mode windows recognises that simulated waveform — it is a real test of the pipeline and not evidence of recognising signing.'
        : 'Off. Demo Mode windows are recorded and shown, but kept out of training.',
      action: null,
    },
  ];
}

function describeConfirmed(summary: DatasetSummary): string {
  const confirmed = summary.approved;
  return `${confirmed} confirmed window${confirmed === 1 ? '' : 's'} across ${summary.sessions} session${summary.sessions === 1 ? '' : 's'}.`;
}

/* --------------------------------------------------------------- readiness */

export interface ReadinessStep {
  readonly id: string;
  readonly text: string;
  readonly met: boolean;
}

/**
 * What stands between the user and a first trained model, in order.
 *
 * Rendered as a list with the unmet items first, so the next thing to do is the
 * first thing on screen rather than something to work out from three cards.
 */
export function readiness(input: {
  readonly summary: DatasetSummary;
  readonly settings: MlSettings;
  readonly languageSelected: boolean;
  readonly gloveConnected: boolean;
  readonly thinnestClass: number;
}): readonly ReadinessStep[] {
  return [
    {
      id: 'language',
      text: 'Choose a sign language',
      met: input.languageSelected,
    },
    {
      id: 'labels',
      text: 'Define at least two signs',
      met: input.summary.labels >= 2,
    },
    {
      id: 'glove',
      text: 'Have a source of frames — a connected glove or Demo Mode',
      met: input.gloveConnected,
    },
    {
      id: 'samples',
      text: `Confirm at least ${input.settings.activation.minSamplesPerClass} windows of each sign`,
      met: input.summary.labels > 0 && input.thinnestClass >= input.settings.activation.minSamplesPerClass,
    },
    {
      id: 'consent',
      text: 'Allow your recordings to be used for training',
      met: input.settings.allowCollectedDataForTraining,
    },
    {
      id: 'sessions',
      text: 'Record in at least two separate sessions',
      met: input.summary.sessions >= 2,
    },
  ];
}

/* ------------------------------------------------------------ dataset state */

/** One sentence describing the dataset, for the library heading. */
export function describeDataset(summary: DatasetSummary): string {
  if (summary.total === 0) {
    return 'No windows recorded yet.';
  }

  const parts = [
    `${summary.total} window${summary.total === 1 ? '' : 's'} from ${summary.sessions} session${summary.sessions === 1 ? '' : 's'}`,
    `${summary.approved} confirmed`,
  ];
  if (summary.pending > 0) parts.push(`${summary.pending} waiting to be confirmed`);
  if (summary.rejected > 0) parts.push(`${summary.rejected} marked not this sign`);
  if (summary.vision > 0) parts.push(`${summary.vision} photo or video record${summary.vision === 1 ? '' : 's'}`);

  return `${parts.join(', ')}.`;
}

/** How each source reads, so provenance is never a code name on screen. */
export const SOURCE_LABEL: Record<SampleSource, string> = {
  glove: 'Real glove',
  simulated: 'Demo Mode',
  imported: 'Imported recording',
  media: 'Photo or video',
};

/** A warning to show above the dataset when its provenance is simulated. */
export function provenanceWarning(summary: DatasetSummary): string | null {
  const simulated = summary.bySource.simulated ?? 0;
  const real = (summary.bySource.glove ?? 0) + (summary.bySource.imported ?? 0);

  if (simulated > 0 && real === 0) {
    return 'Everything here came from Demo Mode. A model trained on it recognises that simulation, and this must not be presented as recognising signing.';
  }
  if (simulated > 0 && real > 0) {
    return `${simulated} of these windows came from Demo Mode and ${real} from a real source. Mixing them teaches the model two different worlds.`;
  }
  return null;
}

/** Sessions that were cut off, so nothing implies a capture finished cleanly. */
export function interruptedSessions(sessions: readonly CaptureSessionMeta[]): readonly CaptureSessionMeta[] {
  return sessions.filter((session) => session.status === 'interrupted');
}

/* ------------------------------------------------------------- model state */

/** A version's headline, without its weights. */
export function describeModelSummary(model: ModelSummary): string {
  const measured =
    model.evaluation === null
      ? 'not measured on held-out data'
      : model.evaluation.accuracy === null
        ? 'no held-out figure'
        : `${Math.round(model.evaluation.accuracy * 1000) / 10}% of held-out windows`;

  return `v${model.version} · ${model.sampleCount} windows · ${measured}`;
}

/** How a version's status reads. The reason, when there is one, is separate. */
export function describeModelStatus(model: ModelSummary): string {
  switch (model.status) {
    case 'active':
      return 'In use';
    case 'candidate':
      return 'Not in use';
    case 'retired':
      return 'Superseded';
  }
}

/** The one-line reason a candidate is not live, for a list row. */
export function candidateHold(model: ModelSummary): string | null {
  return model.status === 'candidate' ? model.statusReason : null;
}

/**
 * Whether the live model still deserves to be live.
 *
 * Checked when the dataset changes: a model activated on eight examples per sign
 * does not become wrong when a ninth is added, but a model whose *signs* have
 * since been retired, or whose source has been disallowed since, should not stay
 * in use without the user being told. Returns a sentence, or null.
 */
export function activeModelDrift(input: {
  readonly model: ModelSummary | null;
  readonly labels: readonly { readonly id: string; readonly archivedAtMs: number | null }[];
  readonly settings: MlSettings;
}): string | null {
  const model = input.model;
  if (model === null) return null;

  if (model.trainedOn.includes('simulated') && !input.settings.allowSimulatedTraining) {
    return 'This model was trained with Demo Mode windows, and that is no longer allowed. It is still in use until you switch to another version.';
  }

  const archived = model.labelIds.filter(
    (labelId) => input.labels.find((label) => label.id === labelId)?.archivedAtMs != null,
  );
  if (archived.length > 0) {
    return `${archived.length} of this model's signs have since been retired. It can still name them, which is why retiring a sign does not remove it from a live model.`;
  }

  return null;
}

/** Models stored for a target, newest first. */
export function versionsFor(
  models: readonly ModelSummary[],
  languageId: string,
): readonly ModelSummary[] {
  return models
    .filter((model) => model.languageId === languageId && model.modality === 'glove-sensor')
    .sort((a, b) => b.version - a.version);
}

/** A full model record's status, for the detail sheet. */
export function describeRecordStatus(model: ModelRecord): string {
  return model.status === 'active' ? 'In use' : model.status === 'candidate' ? 'Not in use' : 'Superseded';
}
