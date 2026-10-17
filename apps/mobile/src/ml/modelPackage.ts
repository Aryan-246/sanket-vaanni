/**
 * Model packages: moving a fitted version to another phone.
 *
 * ## The problem this solves
 *
 * A model trained on one phone lives on that phone. Nothing in the app could
 * carry it anywhere: the dataset export moves samples and labels, and it holds
 * no weights at all, so the receiving install would have to capture its own data
 * and train its own version. Two phones could therefore never be known to be
 * running the same fitted model.
 *
 * ## What a package is
 *
 * One JSON document holding the weights plus a *compatibility contract* — the
 * full set of facts a receiving install needs in order to decide whether the
 * weights mean anything there. The contract is not decoration. A model is a
 * matrix of numbers fitted against a specific feature layout, a specific window
 * pipeline and a specific set of labels; loading those numbers under a different
 * layout produces a model that runs, answers confidently, and is wrong. So the
 * receiving side verifies before it writes anything, and refuses with a reason
 * when it cannot.
 *
 * ## What it deliberately is not
 *
 * It is **not** a cloud service, a model registry, a store, or a delivery
 * mechanism. There is no server side to this file and nothing here calls the
 * network — a package moves the same way a dataset export does, as text the
 * operator carries. That is a real limitation and the UI says so rather than
 * implying a shared catalogue that does not exist.
 *
 * It is also **not** publication. `publicationStatus` records what the version's
 * status was on the phone that exported it. Importing never activates anything:
 * an imported version lands as a candidate, because activation is a decision
 * against thresholds on the receiving install's own terms, and a phone that
 * silently started recognising signs differently because a file was pasted into
 * it would be the worst possible behaviour for this feature.
 */
import { canonical, fnv1a } from './dataset';
import { FEATURE_SPEC } from './features';
import { PREPROCESSING_VERSION } from './types';
import type {
  EvaluationReport,
  HandContext,
  LabelDefinition,
  Modality,
  ModelParameters,
  ModelRecord,
  SampleSource,
  TrainingConfig,
  TrainingSample,
} from './types';

export const MODEL_PACKAGE_FORMAT = 'sanketvaanni.ml.model';

/** Bumped when the envelope's shape changes, so an old reader refuses cleanly. */
export const MODEL_PACKAGE_VERSION = 1;

/**
 * How a package's hand configuration was arrived at.
 *
 * The distinction is the point. A model record does not store which hand it was
 * fitted for, so the contract states this as a *derived* fact about the samples
 * still present on the exporting device — and names the derivation, so a reader
 * is never told something stronger than what was measured.
 */
export type HandConfigurationBasis =
  | 'derived-from-matching-samples-on-this-phone'
  | 'no-matching-samples-still-present';

export interface ModelHandConfiguration {
  /** The `handContext` values among the samples that match this model's target. */
  readonly contexts: readonly HandContext[];
  /** The matched samples disagreed about which hand these signs were made with. */
  readonly ambiguous: boolean;
  readonly basis: HandConfigurationBasis;
  readonly matchingSampleCount: number;
}

export interface ModelVocabulary {
  readonly labelIds: readonly string[];
  /** Display text for each label, so the receiving phone can show what it holds. */
  readonly labelTexts: Readonly<Record<string, string>>;
  /**
   * A digest of the vocabulary, so two installs can tell at a glance whether
   * their label sets agree without comparing the whole set by hand.
   *
   * It is a *fingerprint*, not a version number: labels here are user-defined
   * and there is no central vocabulary to version against.
   */
  readonly vocabularyFingerprint: string;
}

/**
 * The compatibility contract.
 *
 * Every field is either read from the model record or derived from data on the
 * exporting device. Nothing is estimated, and the fields this build cannot know
 * say so in words rather than carrying a plausible default.
 */
export interface ModelCompatibilityContract {
  readonly modelId: string;
  readonly version: number;
  readonly languageId: string;
  readonly modality: Modality;
  readonly algorithm: ModelRecord['algorithm'];
  readonly algorithmDetail: string;
  readonly featureSpecVersion: string;
  /** The ordered feature names the weights are laid out against. */
  readonly featureNames: readonly string[];
  readonly featureCount: number;
  readonly preprocessingVersion: string;
  readonly datasetVersion: number;
  readonly vocabulary: ModelVocabulary;
  readonly handConfiguration: ModelHandConfiguration;
  /**
   * How a live prediction is turned into a decision.
   *
   * Stored with the package because the thresholds are part of the behaviour: the
   * same weights at a different `unknownScore` recognise a different set of
   * gestures. `calibrated` is false and stays false — these thresholds were
   * chosen, not measured, and the UI says so wherever they are shown.
   */
  readonly decoding: {
    readonly unknownScore: number;
    readonly unknownMargin: number;
    readonly calibrated: false;
    readonly note: string;
  };
  readonly evaluation: EvaluationReport | null;
  readonly trainingConfig: TrainingConfig;
  readonly trainedAtMs: number;
  readonly sampleCount: number;
  readonly sessionCount: number;
  readonly trainedOn: readonly SampleSource[];
  /**
   * Whether the glove protocol was verified when this was fitted.
   *
   * It is not a field that can be `true` today: the app has no BLE transport and
   * the firmware protocol is unverified, so every model in existence was fitted
   * on Demo Mode motion or on nothing. Carrying the field now means a package
   * written after the protocol is verified can say so, and a reader can tell the
   * two apart instead of assuming.
   */
  readonly gloveProtocol: { readonly state: 'unverified'; readonly reason: string };
  /** The build that produced the package, or an honest "unknown". */
  readonly exportedByAppVersion: string;
  /** The version's status on the exporting phone, at the moment of export. */
  readonly publicationStatus: ModelRecord['status'];
}

export interface ModelPackage {
  readonly format: typeof MODEL_PACKAGE_FORMAT;
  readonly packageVersion: number;
  readonly exportedAtMs: number;
  readonly contract: ModelCompatibilityContract;
  readonly parameters: ModelParameters;
  /** Digest over the contract and the weights together. */
  readonly integrity: string;
  readonly note: string;
}

/**
 * A fingerprint of a label set.
 *
 * Sorted, so two installs holding the same labels in a different order agree.
 * The display text is included as well as the id: two phones can hold labels
 * with the same ids and different words if one of them renamed a sign.
 */
export function vocabularyFingerprint(
  labelIds: readonly string[],
  texts: Readonly<Record<string, string>>,
): string {
  return fnv1a(
    canonical([...labelIds].sort().map((id) => [id, texts[id] ?? ''] as const)),
  );
}

/** Digest over the contract and the weights, in their canonical form. */
export function packageIntegrity(
  contract: ModelCompatibilityContract,
  parameters: ModelParameters,
): string {
  return fnv1a(canonical({ contract, parameters }));
}

/**
 * The hand configuration, derived from the samples that match a model's target.
 *
 * Matching is by language, modality, approval and label — the same conditions the
 * trainer used to build its sample set. It is an approximation of what the model
 * was fitted on rather than a recording of it, because the record does not carry
 * the sample ids; the returned `basis` and `matchingSampleCount` say so, and the
 * UI repeats them.
 */
export function deriveHandConfiguration(
  samples: readonly TrainingSample[],
  model: Pick<ModelRecord, 'languageId' | 'modality' | 'labelIds'>,
): ModelHandConfiguration {
  const labelIds = new Set(model.labelIds);
  const matching = samples.filter(
    (sample) =>
      sample.languageId === model.languageId &&
      sample.modality === model.modality &&
      sample.approval === 'approved' &&
      labelIds.has(sample.labelId),
  );

  const contexts = [
    ...new Set(matching.map((sample) => sample.handContext)),
  ].sort() as HandContext[];

  return {
    contexts,
    ambiguous: contexts.length > 1,
    basis:
      matching.length === 0
        ? 'no-matching-samples-still-present'
        : 'derived-from-matching-samples-on-this-phone',
    matchingSampleCount: matching.length,
  };
}

export interface BuildPackageInput {
  readonly model: ModelRecord;
  readonly labels: readonly LabelDefinition[];
  readonly samples: readonly TrainingSample[];
  readonly decoding: { readonly unknownScore: number; readonly unknownMargin: number };
  /** The build version, or an honest unknown. Never invented. */
  readonly appVersion: string;
  readonly nowMs: number;
}

export function buildModelPackage(input: BuildPackageInput): ModelPackage {
  const texts: Record<string, string> = {};
  for (const label of input.labels) texts[label.id] = label.text;

  const contract: ModelCompatibilityContract = {
    modelId: input.model.id,
    version: input.model.version,
    languageId: input.model.languageId,
    modality: input.model.modality,
    algorithm: input.model.algorithm,
    algorithmDetail: input.model.algorithmDetail,
    featureSpecVersion: input.model.parameters.featureSpec.version,
    featureNames: input.model.parameters.featureSpec.names,
    featureCount: input.model.parameters.featureSpec.names.length,
    preprocessingVersion: input.model.preprocessingVersion,
    datasetVersion: input.model.datasetVersion,
    vocabulary: {
      labelIds: input.model.labelIds,
      labelTexts: texts,
      vocabularyFingerprint: vocabularyFingerprint(input.model.labelIds, texts),
    },
    handConfiguration: deriveHandConfiguration(input.samples, input.model),
    decoding: {
      unknownScore: input.decoding.unknownScore,
      unknownMargin: input.decoding.unknownMargin,
      calibrated: false,
      note: 'These thresholds were chosen, not measured. They decide when the app says it is unsure, and they are not confidence estimates.',
    },
    evaluation: input.model.evaluation,
    trainingConfig: input.model.trainingConfig,
    trainedAtMs: input.model.trainedAtMs,
    sampleCount: input.model.sampleCount,
    sessionCount: input.model.sessionCount,
    trainedOn: input.model.trainedOn,
    gloveProtocol: {
      state: 'unverified',
      reason:
        'No BLE transport exists in this build and the glove firmware protocol is unverified, so this version was not fitted on frames read from a glove.',
    },
    exportedByAppVersion: input.appVersion,
    publicationStatus: input.model.status,
  };

  return {
    format: MODEL_PACKAGE_FORMAT,
    packageVersion: MODEL_PACKAGE_VERSION,
    exportedAtMs: input.nowMs,
    contract,
    parameters: input.model.parameters,
    integrity: packageIntegrity(contract, input.model.parameters),
    note:
      'A fitted version and the facts needed to decide whether it means anything on another phone. It does not move the recordings it was fitted on, and it does not activate itself anywhere.',
  };
}

/** One reason a package cannot be used here, or a warning about using it. */
export interface CompatibilityFinding {
  readonly severity: 'blocks' | 'warns';
  readonly message: string;
}

/**
 * Whether a package can be used on this install, and what to say about it.
 *
 * Returns `blocks` findings separately from `warns`. A block means the weights
 * would not mean what they say and the import must not proceed; a warning means
 * it will work but the operator should know something first. Collapsing the two
 * would either refuse usable packages or accept unusable ones, and this is the
 * one decision in the feature where being wrong is silent.
 */
export function assessCompatibility(
  contract: ModelCompatibilityContract,
  local: LocalCapabilities,
): readonly CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];

  if (contract.preprocessingVersion !== local.preprocessingVersion) {
    findings.push({
      severity: 'blocks',
      message: `It was built by a different window pipeline (${contract.preprocessingVersion}; this build uses ${local.preprocessingVersion}). Its weights are fitted against numbers this build does not produce.`,
    });
  }

  if (contract.featureSpecVersion !== local.featureSpecVersion) {
    findings.push({
      severity: 'blocks',
      message: `It expects feature layout ${contract.featureSpecVersion}, and this build produces ${local.featureSpecVersion}.`,
    });
  } else if (contract.featureNames.join('|') !== local.featureNames.join('|')) {
    /*
     * The version matches but the names do not. That combination should be
     * impossible, which is exactly why it is checked: it means one of the two
     * builds changed the layout without bumping the version, and loading the
     * weights would misalign every column silently.
     */
    findings.push({
      severity: 'blocks',
      message:
        'Its feature layout claims the same version as this build but lists different statistics. One of the two is wrong and the columns cannot be lined up.',
    });
  }

  if (contract.algorithm !== 'softmax-linear') {
    findings.push({
      severity: 'blocks',
      message: `It was fitted by ${contract.algorithm}, which this build cannot load.`,
    });
  }

  if (contract.modality !== 'glove-sensor') {
    findings.push({
      severity: 'blocks',
      message: 'Only glove windows can be recognised. This package is not a glove model.',
    });
  }

  if (contract.handConfiguration.basis === 'no-matching-samples-still-present') {
    findings.push({
      severity: 'warns',
      message:
        'The exporting phone no longer holds the recordings this was fitted on, so the package cannot say which hand it was made for. Nothing here can check that it matches how you sign.',
    });
  } else if (contract.handConfiguration.ambiguous) {
    findings.push({
      severity: 'warns',
      message:
        'It was fitted on recordings that used more than one hand configuration. Its output depends on you signing the way those recordings did.',
    });
  }

  if (contract.gloveProtocol.state === 'unverified') {
    findings.push({
      severity: 'warns',
      message:
        'It was not fitted on frames read from a glove. Expect it to recognise the motion it was trained on and little else.',
    });
  }

  if (contract.evaluation === null || contract.evaluation.accuracy === null) {
    findings.push({
      severity: 'warns',
      message: 'It carries no held-back accuracy figure, so its quality cannot be judged from the package.',
    });
  }

  return findings;
}

/** What this build produces, read from the live pipeline rather than restated. */
export interface LocalCapabilities {
  readonly featureSpecVersion: string;
  readonly featureNames: readonly string[];
  readonly preprocessingVersion: string;
}

/**
 * This build's own capability facts.
 *
 * Read from the running feature pipeline, never written down twice. A copy of
 * these constants maintained by hand would drift from the pipeline it describes
 * and then *approve* an incompatible package — the failure mode this whole file
 * exists to prevent.
 */
export function localCapabilities(): LocalCapabilities {
  return {
    featureSpecVersion: FEATURE_SPEC.version,
    featureNames: FEATURE_SPEC.names,
    preprocessingVersion: PREPROCESSING_VERSION,
  };
}

export interface VerifyInput {
  readonly package: unknown;
  readonly local: LocalCapabilities;
}

export type VerifyOutcome =
  | {
      readonly ok: true;
      readonly package: ModelPackage;
      readonly findings: readonly CompatibilityFinding[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads a package and decides whether it may be used.
 *
 * Checked in order of how cheap the check is and how catastrophic the failure
 * would be: shape, then integrity, then compatibility. Integrity before
 * compatibility matters because a truncated file usually still parses far enough
 * to look incompatible, and reporting "wrong pipeline" for a file that is simply
 * half-missing sends the operator after the wrong problem.
 */
export function verifyModelPackage(input: VerifyInput): VerifyOutcome {
  const value = input.package;

  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'That is not a version package.' };
  }

  const candidate = value as Partial<ModelPackage>;
  if (candidate.format !== MODEL_PACKAGE_FORMAT) {
    return { ok: false, reason: 'That file was not exported as a version package by Sanket Vaanni.' };
  }
  if (candidate.packageVersion !== MODEL_PACKAGE_VERSION) {
    return {
      ok: false,
      reason: `That package was written in format version ${String(candidate.packageVersion)}, and this build understands version ${MODEL_PACKAGE_VERSION}.`,
    };
  }
  if (typeof candidate.contract !== 'object' || candidate.contract === null) {
    return { ok: false, reason: 'The package has no compatibility contract, so nothing can be checked.' };
  }
  if (typeof candidate.parameters !== 'object' || candidate.parameters === null) {
    return { ok: false, reason: 'The package carries no fitted weights.' };
  }

  const present = candidate as ModelPackage;
  if (
    typeof present.integrity !== 'string' ||
    present.integrity.length === 0 ||
    present.integrity !== packageIntegrity(present.contract, present.parameters)
  ) {
    return {
      ok: false,
      reason: 'The package is incomplete or was altered after it was written.',
    };
  }

  const findings = assessCompatibility(present.contract, input.local);
  const blocked = findings.filter((finding) => finding.severity === 'blocks');
  if (blocked.length > 0) {
    return { ok: false, reason: blocked.map((finding) => finding.message).join(' ') };
  }

  return { ok: true, package: present, findings };
}
