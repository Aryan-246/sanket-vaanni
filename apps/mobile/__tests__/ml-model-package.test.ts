/**
 * Carrying a fitted version between phones.
 *
 * These tests run the real store, the real trainer and the real verifier over
 * the real in-memory storage. What they are defending is a single decision: a
 * set of weights that does not mean what it claims must not be usable, and a set
 * that does must not be refused for a reason nobody can act on.
 *
 * The fixtures are generated test data (`mlFixtures.ts`), so no accuracy figure
 * here says anything about recognising signing. Where a package's figures are
 * asserted they are asserted as *carried through unchanged*, which is the only
 * property this file is qualified to check.
 */
import { createInMemoryStorage, type Storage } from '../src/storage';
import { ML_KEYS } from '../src/ml/keys';
import { MlStore } from '../src/ml/store';
import { DESCRIPTIONS, predict } from '../src/ml/classifier';
import { extractFeatures } from '../src/ml/features';
import { activeModel } from '../src/ml/modelStore';
import {
  MODEL_PACKAGE_FORMAT,
  MODEL_PACKAGE_VERSION,
  assessCompatibility,
  buildModelPackage,
  deriveHandConfiguration,
  localCapabilities,
  packageIntegrity,
  verifyModelPackage,
  vocabularyFingerprint,
  type ModelCompatibilityContract,
  type ModelPackage,
} from '../src/ml/modelPackage';
import type { ModelRecord } from '../src/ml/types';
import { makeDataset, makeLabels, windowFor } from './mlFixtures';

const LANGUAGE = 'isl';
const SIGNS = ['sign-a', 'sign-b', 'sign-c'];

/** Ids that are readable in a failure, and identical across two stores. */
function idFactory(prefix: string): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

/**
 * A store holding three signs captured over four sittings, with permission given.
 *
 * The labels are written straight to storage before `start`, so their ids are
 * the fixture sign names and are the same on every store made this way. That is
 * what lets a package cross between two of them and mean the same thing; the
 * store's own id generator would give each phone different label ids and every
 * package would then report its whole vocabulary as undefined.
 */
async function storeWithDataset(options: {
  readonly prefix: string;
  readonly signs?: readonly string[];
  readonly storage?: Storage;
  readonly now?: () => number;
}): Promise<{ store: MlStore; storage: Storage }> {
  const storage = options.storage ?? createInMemoryStorage();
  const labels = makeLabels(options.signs ?? SIGNS, LANGUAGE);
  await storage.setJson(ML_KEYS.labels, labels);

  const store = new MlStore({
    storage,
    newId: idFactory(options.prefix),
    now: options.now ?? (() => 1_000),
    defaultLanguageId: LANGUAGE,
  });
  await store.start();
  await store.updateSettings({
    allowCollectedDataForTraining: true,
    allowSimulatedTraining: true,
  });

  const samples = makeDataset({
    signs: options.signs ?? SIGNS,
    sessions: 4,
    perSign: 4,
    source: 'simulated',
    languageId: LANGUAGE,
  });
  for (const sample of samples) await store.saveSample(sample);

  return { store, storage };
}

/** A store with one fitted version. Fails loudly rather than returning nothing. */
async function trainedStore(
  prefix: string,
): Promise<{ store: MlStore; model: ModelRecord }> {
  const { store } = await storeWithDataset({ prefix });
  const outcome = await store.train();
  if (!outcome.ok) throw new Error(`fixture training refused: ${outcome.reason}`);

  const model = await store.loadModel(outcome.model.id);
  if (model === null) throw new Error('the trained version’s weights could not be read back');
  return { store, model };
}

/** A package carrying these weights, built by this build's own pipeline. */
function packageFor(
  model: ModelRecord,
  options: { readonly samples?: Parameters<typeof buildModelPackage>[0]['samples'] } = {},
): ModelPackage {
  return buildModelPackage({
    model,
    labels: makeLabels(SIGNS, LANGUAGE),
    samples: options.samples ?? [],
    decoding: { unknownScore: 0.5, unknownMargin: 0.15 },
    appVersion: 'test-build (1)',
    nowMs: 2_000,
  });
}

/**
 * A package whose contract has been altered, with its digest recomputed.
 *
 * Recomputing the digest is what makes this a test of *compatibility* rather
 * than of the integrity check: the file is internally consistent and still must
 * not be accepted, because the facts it states do not match this build.
 */
function packageWithContract(
  model: ModelRecord,
  patch: Partial<ModelCompatibilityContract>,
): ModelPackage {
  const base = packageFor(model);
  const contract = { ...base.contract, ...patch } as ModelCompatibilityContract;
  return { ...base, contract, integrity: packageIntegrity(contract, base.parameters) };
}

/* ------------------------------------------------------- what travels */

describe('a package carries the facts needed to judge it', () => {
  it('names itself so a reader can tell it apart from any other file', async () => {
    const { model } = await trainedStore('pkg');
    const built = packageFor(model);

    expect(built.format).toBe(MODEL_PACKAGE_FORMAT);
    expect(built.packageVersion).toBe(MODEL_PACKAGE_VERSION);
  });

  it('records the version, target and method rather than restating them', async () => {
    const { model } = await trainedStore('pkg');
    const contract = packageFor(model).contract;

    expect(contract.modelId).toBe(model.id);
    expect(contract.version).toBe(model.version);
    expect(contract.languageId).toBe(LANGUAGE);
    expect(contract.modality).toBe('glove-sensor');
    expect(contract.algorithm).toBe('softmax-linear');
    expect(contract.algorithmDetail).toBe(DESCRIPTIONS.name);
    expect(contract.publicationStatus).toBe(model.status);
  });

  it('carries the whole feature layout, not just its version', async () => {
    const { model } = await trainedStore('pkg');
    const contract = packageFor(model).contract;

    expect(contract.featureCount).toBe(model.parameters.featureSpec.names.length);
    expect(contract.featureNames).toEqual(model.parameters.featureSpec.names);
    expect(contract.featureSpecVersion).toBe(model.parameters.featureSpec.version);
    expect(contract.preprocessingVersion).toBe(model.preprocessingVersion);
    expect(contract.datasetVersion).toBe(model.datasetVersion);
  });

  it('says the glove protocol is unverified instead of implying a glove was used', async () => {
    const { model } = await trainedStore('pkg');
    const contract = packageFor(model).contract;

    expect(contract.gloveProtocol.state).toBe('unverified');
    expect(contract.gloveProtocol.reason).toMatch(/no BLE transport/i);
  });

  it('does not claim its decision thresholds were measured', async () => {
    const { model } = await trainedStore('pkg');
    const contract = packageFor(model).contract;

    expect(contract.decoding.calibrated).toBe(false);
    expect(contract.decoding.note).toMatch(/chosen, not measured/i);
    expect(contract.decoding.unknownScore).toBe(0.5);
  });
});

/* ----------------------------------------------------- hand configuration */

describe('the hand a version was made for', () => {
  it('reads the hand off the samples that match the version’s target', async () => {
    const { store, model } = await trainedStore('hand');
    const { samples } = await store.loadAllSamples();

    const derived = deriveHandConfiguration(samples, model);

    expect(derived.basis).toBe('derived-from-matching-samples-on-this-phone');
    expect(derived.matchingSampleCount).toBe(model.sampleCount);
    // Every fixture window was captured from the right glove.
    expect(derived.contexts).toEqual(['right']);
    expect(derived.ambiguous).toBe(false);
  });

  it('says it cannot tell, rather than guessing, when the samples are gone', async () => {
    const { model } = await trainedStore('hand');
    const derived = deriveHandConfiguration([], model);

    expect(derived.basis).toBe('no-matching-samples-still-present');
    expect(derived.matchingSampleCount).toBe(0);
    expect(derived.contexts).toEqual([]);
  });

  it('flags a version fitted across two different hand configurations', async () => {
    const { store, model } = await trainedStore('hand');
    const { samples } = await store.loadAllSamples();
    const mixed = samples.map((sample, index) => ({
      ...sample,
      handContext: index % 2 === 0 ? ('right' as const) : ('both' as const),
    }));

    const derived = deriveHandConfiguration(mixed, model);

    expect(derived.contexts).toEqual(['both', 'right']);
    expect(derived.ambiguous).toBe(true);
  });

  it('ignores samples that are not this version’s target', async () => {
    const { store, model } = await trainedStore('hand');
    const { samples } = await store.loadAllSamples();

    const unrelated = samples.map((sample) => ({ ...sample, languageId: 'asl' }));

    expect(deriveHandConfiguration(unrelated, model).matchingSampleCount).toBe(0);
  });

  it('ignores windows that were never confirmed', async () => {
    const { store, model } = await trainedStore('hand');
    const { samples } = await store.loadAllSamples();
    const unapproved = samples.map((sample) => ({ ...sample, approval: 'pending' as const }));

    expect(deriveHandConfiguration(unapproved, model).matchingSampleCount).toBe(0);
  });

  it('warns, but does not refuse, when the hand cannot be established', async () => {
    const { model } = await trainedStore('hand');
    const contract = packageFor(model, { samples: [] }).contract;

    const findings = assessCompatibility(contract, localCapabilities());

    expect(findings.some((finding) => finding.severity === 'blocks')).toBe(false);
    expect(findings.filter((finding) => finding.severity === 'warns').map((f) => f.message).join(' ')).toMatch(
      /no longer holds the recordings/i,
    );
  });

  it('warns when a version was fitted across more than one hand configuration', async () => {
    const { store, model } = await trainedStore('hand');
    const { samples } = await store.loadAllSamples();
    const mixed = samples.map((sample, index) => ({
      ...sample,
      handContext: index % 2 === 0 ? ('right' as const) : ('both' as const),
    }));

    const contract = packageFor(model, { samples: mixed }).contract;
    const findings = assessCompatibility(contract, localCapabilities());

    expect(findings.some((finding) => finding.message.match(/more than one hand configuration/i))).toBe(
      true,
    );
  });
});

/* --------------------------------------------------------- vocabulary */

describe('the label set a version answers in', () => {
  it('carries the words as well as the ids', async () => {
    const { model } = await trainedStore('vocab');
    const vocabulary = packageFor(model).contract.vocabulary;

    expect(vocabulary.labelIds).toEqual(model.labelIds);
    expect(vocabulary.labelTexts['sign-a']).toBe('SIGN-A');
  });

  it('fingerprints a label set independently of the order it is listed in', () => {
    const texts = { a: 'A', b: 'B', c: 'C' };

    expect(vocabularyFingerprint(['a', 'b', 'c'], texts)).toBe(
      vocabularyFingerprint(['c', 'a', 'b'], texts),
    );
  });

  it('tells apart two phones that renamed the same sign', () => {
    expect(vocabularyFingerprint(['a'], { a: 'Hello' })).not.toBe(
      vocabularyFingerprint(['a'], { a: 'Thank you' }),
    );
  });

  it('tells apart two phones that define different signs', () => {
    expect(vocabularyFingerprint(['a'], { a: 'A' })).not.toBe(
      vocabularyFingerprint(['a', 'b'], { a: 'A', b: 'B' }),
    );
  });
});

/* ------------------------------------------------------------ refusals */

describe('what the receiving phone refuses, and why', () => {
  it('accepts a package this build produced', async () => {
    const { model } = await trainedStore('ok');
    const verdict = verifyModelPackage({
      package: packageFor(model),
      local: localCapabilities(),
    });

    expect(verdict.ok).toBe(true);
  });

  it('refuses a file that is not a package at all', () => {
    const verdict = verifyModelPackage({ package: { hello: 'world' }, local: localCapabilities() });

    expect(verdict.ok).toBe(false);
  });

  it('refuses a package whose weights changed after it was written', async () => {
    const { model } = await trainedStore('tamper');
    const built = packageFor(model);
    const tampered: ModelPackage = {
      ...built,
      parameters: {
        ...built.parameters,
        weights: built.parameters.weights.map((row, index) =>
          index === 0 ? row.map((weight) => weight + 1) : row,
        ),
      },
    };

    const verdict = verifyModelPackage({ package: tampered, local: localCapabilities() });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/altered|incomplete/i);
  });

  it('refuses a package written in a format version it does not understand', async () => {
    const { model } = await trainedStore('format');
    const built = packageFor(model);
    const future = { ...built, packageVersion: MODEL_PACKAGE_VERSION + 1 };

    const verdict = verifyModelPackage({ package: future, local: localCapabilities() });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/format version/i);
  });

  it('refuses weights fitted against a different window pipeline', async () => {
    const { model } = await trainedStore('pipeline');
    const foreign = packageWithContract(model, { preprocessingVersion: 'glove-window/0' });

    const verdict = verifyModelPackage({ package: foreign, local: localCapabilities() });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/different window pipeline/i);
  });

  it('refuses a package expecting a different feature layout', async () => {
    const { model } = await trainedStore('layout');
    const foreign = packageWithContract(model, { featureSpecVersion: 'glove-features/0' });

    const verdict = verifyModelPackage({ package: foreign, local: localCapabilities() });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/feature layout/i);
  });

  it('refuses a layout that claims this version but lists different statistics', async () => {
    /*
     * The version matches and the names do not. That is a build that changed the
     * layout without bumping its version, and every column would be read against
     * the wrong statistic — a failure with no symptom other than wrong answers.
     */
    const { model } = await trainedStore('names');
    const renamed = packageWithContract(model, {
      featureNames: model.parameters.featureSpec.names.map((name, index) =>
        index === 0 ? `${name}-moved` : name,
      ),
    });

    const verdict = verifyModelPackage({ package: renamed, local: localCapabilities() });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/cannot be lined up/i);
  });

  it('refuses a package fitted by an algorithm this build cannot load', async () => {
    const { model } = await trainedStore('algo');
    const foreign = packageWithContract(model, {
      algorithm: 'neural-net' as ModelCompatibilityContract['algorithm'],
    });

    const verdict = verifyModelPackage({ package: foreign, local: localCapabilities() });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/cannot load/i);
  });

  it('refuses a package that is not a glove model', async () => {
    const { model } = await trainedStore('modality');
    const foreign = packageWithContract(model, { modality: 'vision' });

    const verdict = verifyModelPackage({ package: foreign, local: localCapabilities() });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/not a glove model/i);
  });

  it('reports every blocking fault at once rather than one at a time', async () => {
    const { model } = await trainedStore('many');
    const foreign = packageWithContract(model, {
      preprocessingVersion: 'glove-window/0',
      algorithm: 'neural-net' as ModelCompatibilityContract['algorithm'],
    });

    const verdict = verifyModelPackage({ package: foreign, local: localCapabilities() });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/window pipeline/i);
    expect(verdict.reason).toMatch(/cannot load/i);
  });
});

/* -------------------------------------------------- moving one across */

describe('taking a version in through the store', () => {
  it('stores it, and reports what it could not check', async () => {
    const { store: source, model } = await trainedStore('from');
    const built = packageFor(model);

    const { store: receiving } = await storeWithDataset({ prefix: 'to' });
    const result = await receiving.importModel(built);

    expect(result.ok ? 'taken in' : result.error).toBe('taken in');
    if (!result.ok) return;

    expect(receiving.getSnapshot().models).toHaveLength(1);
    const stored = receiving.getSnapshot().models[0]!;
    expect(stored.labelIds).toEqual(model.labelIds);
    expect(stored.trainedOn).toEqual(model.trainedOn);
    expect(stored.sampleCount).toBe(model.sampleCount);
    expect(stored.evaluation?.accuracy).toBe(model.evaluation?.accuracy ?? null);
    expect(source).toBeDefined();
  });

  it('keeps the number it carried on the other phone, so it can be traced back', async () => {
    const { model } = await trainedStore('trace');
    const built = packageFor(model);

    const { store: receiving } = await storeWithDataset({ prefix: 'to' });
    const result = await receiving.importModel(built);
    if (!result.ok) throw new Error(result.error);

    const stored = receiving.getSnapshot().models[0]!;
    expect(stored.importedFrom?.sourceVersion).toBe(model.version);
    expect(stored.importedFrom?.exportedAtMs).toBe(built.exportedAtMs);
    expect(stored.importedFrom?.exportedByAppVersion).toBe('test-build (1)');
  });

  it('numbers it in this phone’s own sequence rather than reusing the other’s', async () => {
    const { model } = await trainedStore('numbering');
    const first = packageFor(model);

    // A phone that has already fitted a version of its own.
    const { store: receiving } = await storeWithDataset({ prefix: 'to' });
    const own = await receiving.train();
    if (!own.ok) throw new Error(own.reason);

    const result = await receiving.importModel(first);
    if (!result.ok) throw new Error(result.error);

    expect(result.data.summary.version).toBe(own.model.version + 1);
  });

  it('never puts an imported version in use', async () => {
    const { model } = await trainedStore('from');
    const first = packageFor(model);

    const { store: receiving } = await storeWithDataset({ prefix: 'to' });
    const own = await receiving.train();
    if (!own.ok) throw new Error(own.reason);
    const before = activeModel(receiving.getSnapshot().models as ModelRecord[], LANGUAGE, 'glove-sensor');
    expect(before?.id).toBe(own.model.id);

    const result = await receiving.importModel(first);
    if (!result.ok) throw new Error(result.error);

    const after = activeModel(receiving.getSnapshot().models as ModelRecord[], LANGUAGE, 'glove-sensor');
    expect(after?.id).toBe(own.model.id);
    expect(result.data.summary.status).toBe('candidate');
  });

  it('says plainly why it was not put in use, in the record', async () => {
    const { model } = await trainedStore('reason');
    const built = packageFor(model);

    const { store: receiving } = await storeWithDataset({ prefix: 'to' });
    const result = await receiving.importModel(built);
    if (!result.ok) throw new Error(result.error);

    const reason = result.data.summary.statusReason ?? '';
    expect(reason).toMatch(/never puts a version in use/i);
    expect(reason).toMatch(/examples stayed on the phone that fitted it/i);
  });

  it('does not re-run the local data requirements against a version fitted elsewhere', async () => {
    /*
     * The receiving phone has no windows at all here. The activation gate counts
     * the examples a version was *fitted on*, which are on the other phone — so
     * applying it here would refuse a version fitted on four hundred windows for
     * having none. The record says the gate was not applied rather than implying
     * it was passed.
     */
    const { model } = await trainedStore('gate');
    const built = packageFor(model);

    const storage = createInMemoryStorage();
    await storage.setJson(ML_KEYS.labels, makeLabels(SIGNS, LANGUAGE));
    const empty = new MlStore({
      storage,
      newId: idFactory('empty'),
      now: () => 1_000,
      defaultLanguageId: LANGUAGE,
    });
    await empty.start();
    expect(empty.getSnapshot().headers).toHaveLength(0);

    const result = await empty.importModel(built);

    expect(result.ok ? 'taken in' : result.error).toBe('taken in');
    if (!result.ok) return;
    expect(result.data.summary.statusReason).toMatch(/not applied to it/i);
  });

  it('reports signs it has no definition for, and adds none to suit the file', async () => {
    const { model } = await trainedStore('from');
    const built = packageFor(model);

    const { store: receiving } = await storeWithDataset({
      prefix: 'to',
      signs: ['sign-a'],
    });
    const result = await receiving.importModel(built);

    expect(result.ok ? 'taken in' : result.error).toBe('taken in');
    if (!result.ok) return;

    expect(result.data.summary.importedFrom?.labelsNotDefinedHere).toEqual(['sign-b', 'sign-c']);
    expect(receiving.getSnapshot().labels.map((label) => label.id)).toEqual(['sign-a']);
    expect(result.data.findings.some((finding) => finding.message.match(/not defined on this phone/i))).toBe(
      true,
    );
  });

  it('does not report undefined signs when the two phones agree on the vocabulary', async () => {
    const { model } = await trainedStore('from');
    const built = packageFor(model);

    const { store: receiving } = await storeWithDataset({ prefix: 'to' });
    const result = await receiving.importModel(built);
    if (!result.ok) throw new Error(result.error);

    expect(result.data.summary.importedFrom?.labelsNotDefinedHere).toEqual([]);
    expect(result.data.findings.some((finding) => finding.message.match(/not defined on this phone/i))).toBe(
      false,
    );
  });

  it('carries the weights across unchanged, so the same window scores the same', async () => {
    const { model } = await trainedStore('weights');
    const built = packageFor(model);

    const { store: receiving } = await storeWithDataset({ prefix: 'to' });
    const result = await receiving.importModel(built);
    if (!result.ok) throw new Error(result.error);

    const stored = await receiving.loadModel(result.data.summary.id);
    if (stored === null) throw new Error('the imported weights could not be read back');

    const vector = extractFeatures(windowFor('sign-a'));
    if (vector === null) throw new Error('the fixture window produced no features');
    const onSource = predict(model.parameters, vector);
    const onReceiving = predict(stored.parameters, vector);

    expect(onReceiving?.bestLabelId).toBe(onSource?.bestLabelId);
    expect(onReceiving?.scores).toEqual(onSource?.scores);
  });

  it('survives being written out and read back through the index', async () => {
    const { model } = await trainedStore('restart');
    const built = packageFor(model);

    const storage = createInMemoryStorage();
    const { store: receiving } = await storeWithDataset({ prefix: 'to', storage });
    const result = await receiving.importModel(built);
    if (!result.ok) throw new Error(result.error);

    // A second store over the same storage is what a relaunch looks like.
    const relaunched = new MlStore({
      storage,
      newId: idFactory('again'),
      now: () => 3_000,
      defaultLanguageId: LANGUAGE,
    });
    await relaunched.start();

    const stored = relaunched.getSnapshot().models[0]!;
    expect(stored.id).toBe(result.data.summary.id);
    expect(stored.importedFrom?.sourceVersion).toBe(model.version);
    expect(stored.status).toBe('candidate');
  });

  it('refuses a package it cannot verify, and stores nothing', async () => {
    const { store: receiving } = await storeWithDataset({ prefix: 'to' });

    const result = await receiving.importModel({ not: 'a package' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(receiving.getSnapshot().models).toHaveLength(0);
  });

  it('refuses an incompatible package rather than storing unusable weights', async () => {
    const { model } = await trainedStore('foreign');
    const foreign = packageWithContract(model, { preprocessingVersion: 'glove-window/0' });

    const { store: receiving } = await storeWithDataset({ prefix: 'to' });
    const result = await receiving.importModel(foreign);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/window pipeline/i);
    expect(receiving.getSnapshot().models).toHaveLength(0);
  });
});

/* ------------------------------------------------------------- exporting */

describe('writing a version out', () => {
  it('refuses a version that is not stored', async () => {
    const { store } = await storeWithDataset({ prefix: 'export' });

    const result = await store.exportModel('no-such-version');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no longer stored/i);
  });

  it('refuses when the weights cannot be read, rather than writing a package without them', async () => {
    const { model } = await trainedStore('export');
    const { store: receiving, storage } = await storeWithDataset({ prefix: 'to' });

    const taken = await receiving.importModel(packageFor(model));
    if (!taken.ok) throw new Error(taken.error);

    await storage.removeKey(ML_KEYS.model(taken.data.summary.id));

    const result = await receiving.exportModel(taken.data.summary.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/weights could not be read/i);
  });

  it('writes a package the same build will accept on the other side', async () => {
    const { store, model } = await trainedStore('export');

    const result = await store.exportModel(model.id);

    expect(result.ok ? 'written' : result.error).toBe('written');
    if (!result.ok) return;

    const verdict = verifyModelPackage({
      package: result.data,
      local: localCapabilities(),
    });
    expect(verdict.ok).toBe(true);
  });

  it('states the hand from the samples it still holds', async () => {
    const { store, model } = await trainedStore('export');

    const result = await store.exportModel(model.id);
    if (!result.ok) throw new Error(result.error);

    expect(result.data.contract.handConfiguration.basis).toBe(
      'derived-from-matching-samples-on-this-phone',
    );
    expect(result.data.contract.handConfiguration.contexts).toEqual(['right']);
  });

  it('says it cannot state the hand when the samples are no longer here', async () => {
    const { store, model } = await trainedStore('export');
    const ids = store.getSnapshot().headers.map((header) => header.id);
    await store.deleteSamples(ids);

    const result = await store.exportModel(model.id);
    if (!result.ok) throw new Error(result.error);

    expect(result.data.contract.handConfiguration.basis).toBe('no-matching-samples-still-present');
  });
});
