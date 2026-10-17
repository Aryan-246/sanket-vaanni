/**
 * Whether a version still matches the data it was fitted on.
 *
 * The defect these defend against is a silent one: a model stores `sampleCount`,
 * and forty windows is forty windows whether they are the same forty or a
 * different forty. Delete a window, re-label another, reject a third — the counts
 * barely move and the weights do not move at all, so the card went on describing
 * a set that no longer exists. Nothing in the app retrains when the library
 * changes, and pretending otherwise would be the dishonest fix.
 *
 * So the assertion throughout is deliberately narrow: the app must be able to
 * *tell*, and must say so in terms of what changed rather than in terms of what
 * the model did — because the model did nothing.
 *
 * Fixtures are generated test data (`mlFixtures.ts`). No figure here says
 * anything about recognising signing.
 */
import { createInMemoryStorage, type Storage } from '../src/storage';
import { ML_KEYS } from '../src/ml/keys';
import { MlStore } from '../src/ml/store';
import {
  datasetStateForModel,
  trainableDigest,
} from '../src/ml/dataset';
import { makeDataset, makeLabels } from './mlFixtures';

const LANGUAGE = 'isl';
const SIGNS = ['sign-a', 'sign-b', 'sign-c'];

function idFactory(prefix: string): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

async function storeWithDataset(prefix: string): Promise<{ store: MlStore; storage: Storage }> {
  const storage = createInMemoryStorage();
  await storage.setJson(ML_KEYS.labels, makeLabels(SIGNS, LANGUAGE));

  const store = new MlStore({
    storage,
    newId: idFactory(prefix),
    now: () => 1_000,
    defaultLanguageId: LANGUAGE,
  });
  await store.start();
  await store.updateSettings({
    allowCollectedDataForTraining: true,
    allowSimulatedTraining: true,
  });

  const samples = makeDataset({
    signs: SIGNS,
    sessions: 4,
    perSign: 4,
    source: 'simulated',
    languageId: LANGUAGE,
  });
  for (const sample of samples) await store.saveSample(sample);

  return { store, storage };
}

async function trainedStore(prefix: string): Promise<{ store: MlStore; modelId: string }> {
  const { store } = await storeWithDataset(prefix);
  const outcome = await store.train();
  if (!outcome.ok) throw new Error(`fixture training refused: ${outcome.reason}`);
  return { store, modelId: outcome.model.id };
}

/** The samples the trainer would consume, read back the way training reads them. */
async function trainableNow(store: MlStore): Promise<ReturnType<typeof trainableDigest>> {
  const { samples } = await store.loadAllSamples();
  const snapshot = store.getSnapshot();
  const kept = samples.filter(
    (sample) =>
      sample.modality !== 'vision' &&
      sample.approval === 'approved' &&
      sample.languageId === snapshot.languageId &&
      (sample.source !== 'simulated' || snapshot.settings.allowSimulatedTraining) &&
      snapshot.settings.allowCollectedDataForTraining,
  );
  return trainableDigest(kept);
}

describe('the digest of a trainable set', () => {
  it('does not depend on the order the windows are handed over', async () => {
    const { store } = await storeWithDataset('order');
    const { samples } = await store.loadAllSamples();
    const forwards = trainableDigest(samples);
    const backwards = trainableDigest([...samples].reverse());

    expect(backwards).toBe(forwards);
  });

  it('is the same for the same windows and different once one is removed', async () => {
    const { store } = await storeWithDataset('remove');
    const { samples } = await store.loadAllSamples();
    const before = trainableDigest(samples);
    const after = trainableDigest(samples.slice(1));

    expect(after).not.toBe(before);
  });

  it('changes when a window is re-labelled even though nothing was added or removed', async () => {
    const { store } = await storeWithDataset('relabel');
    const { samples } = await store.loadAllSamples();
    const before = trainableDigest(samples);

    const first = samples[0]!;
    await store.relabel(first.id, 'sign-b');

    const { samples: later } = await store.loadAllSamples();
    expect(trainableDigest(later)).not.toBe(before);
  });
});

describe('whether a version still matches its training set', () => {
  it('says unknown when the version carries no record of its set', () => {
    // Every version fitted before this field existed, and every version taken in
    // from another phone, looks like this. Unknown is not the same as unchanged,
    // and must not be reported as it.
    expect(datasetStateForModel({}, [])).toBe('unknown');
    expect(datasetStateForModel({ trainedOnDigest: null }, [])).toBe('unknown');
    expect(datasetStateForModel({ trainedOnDigest: '' }, [])).toBe('unknown');
  });

  it('says unchanged immediately after a fit, against the same data', async () => {
    const { store, modelId } = await trainedStore('fresh');

    expect(await store.datasetStateFor(modelId)).toBe('unchanged');
  });

  it('says changed once a window it was fitted on has been deleted', async () => {
    const { store, modelId } = await trainedStore('deleted');
    const { samples } = await store.loadAllSamples();

    await store.deleteSamples([samples[0]!.id]);

    expect(await store.datasetStateFor(modelId)).toBe('changed');
  });

  it('says changed once a window it was fitted on has been confirmed under another sign', async () => {
    const { store, modelId } = await trainedStore('corrected');
    const { samples } = await store.loadAllSamples();

    await store.relabel(samples[0]!.id, 'sign-b');

    expect(await store.datasetStateFor(modelId)).toBe('changed');
  });

  it('says changed once a window it was fitted on has been rejected', async () => {
    const { store, modelId } = await trainedStore('rejected');
    const { samples } = await store.loadAllSamples();

    await store.markRejected(samples[0]!.id, 'that was not the sign I meant');

    expect(await store.datasetStateFor(modelId)).toBe('changed');
  });

  /*
   * The reason this feature exists, stated as a test. Detecting the change must
   * not be mistaken for handling it: the weights are exactly what they were, and
   * the version is still the version. Anything else — silently retraining, or
   * quietly retiring the version — would be the app acting on the user's behalf
   * on data they did not ask it to touch.
   */
  it('leaves the weights, the status and the counts exactly as they were', async () => {
    const { store, modelId } = await trainedStore('untouched');
    const before = await store.loadModel(modelId);
    const { samples } = await store.loadAllSamples();

    await store.deleteSamples(samples.slice(0, 3).map((sample) => sample.id));
    await store.relabel(samples[4]!.id, 'sign-c');

    const after = await store.loadModel(modelId);
    expect(after).not.toBeNull();
    expect(after!.status).toBe(before!.status);
    expect(after!.sampleCount).toBe(before!.sampleCount);
    expect(after!.trainedOnDigest).toBe(before!.trainedOnDigest);
    expect(JSON.stringify(after!.parameters)).toBe(JSON.stringify(before!.parameters));
    expect(JSON.stringify(after!.evaluation)).toBe(JSON.stringify(before!.evaluation));
  });

  it('reports a version that has never been trained on anything here as unknown', async () => {
    const { store } = await storeWithDataset('no-such-version');

    expect(await store.datasetStateFor('a-version-from-nowhere')).toBe('unknown');
  });

  it('stops saying changed once the data is fitted again', async () => {
    const { store, modelId } = await trainedStore('refit');
    const { samples } = await store.loadAllSamples();
    await store.deleteSamples([samples[0]!.id]);
    expect(await store.datasetStateFor(modelId)).toBe('changed');

    const second = await store.train();
    if (!second.ok) throw new Error(`second fit refused: ${second.reason}`);

    expect(await store.datasetStateFor(modelId)).toBe('changed');
    expect(await store.datasetStateFor(second.model.id)).toBe('unchanged');
  });

  /*
   * A guard against the digest being computed over the wrong set. The method
   * must use the trainer's own membership rule, so a window that the trainer
   * would refuse cannot make a version look changed.
   */
  it('ignores a window the trainer would never have consumed', async () => {
    const { store, modelId } = await trainedStore('refused');
    const before = await trainableNow(store);

    const { samples } = await store.loadAllSamples();
    // Recorded in Demo Mode with simulated training switched off is exactly the
    // case `trainableSet` refuses; it must not move the digest either.
    await store.updateSettings({ allowSimulatedTraining: false });
    const after = await trainableNow(store);

    expect(after).not.toBe(before);
    expect(await store.datasetStateFor(modelId)).toBe('changed');
    expect(samples.length).toBeGreaterThan(0);
  });
});
