/**
 * What the learning centre stores, and what it refuses to store.
 *
 * These tests run the real `MlStore` over the real in-memory `Storage`, and the
 * real `CaptureController` over the real store. The only things faked are the
 * clock, the id generator and the media picker — each of which is a native
 * dependency with no meaning off-device.
 *
 * The claim each test defends is in its name. Where a figure appears it comes
 * from `mlFixtures.ts`, which is generated test data and not a recording of
 * anybody signing.
 */
import { createInMemoryStorage, type Storage } from '../src/storage';
import { ML_KEYS } from '../src/ml/keys';
import { MlStore } from '../src/ml/store';
import { CaptureController } from '../src/ml/capture';
import { trainableSet } from '../src/ml/dataset';
import { importMedia, UnavailablePicker, type MediaPicker, type PickedMedia } from '../src/ml/media';
import { describeCapabilities, provenanceWarning } from '../src/ml/describe';
import { PREPROCESSING_VERSION, type MlSettings, type VisionSample } from '../src/ml/types';
import { makeDataset, makeRun, makeWindowSample } from './mlFixtures';

/** Lets every pending promise settle, so a fire-and-forget write has landed. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });
}

function idFactory(prefix = 'id'): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

/** A store with a controllable clock and ids that are readable in a failure. */
function makeStore(
  storage: Storage = createInMemoryStorage(),
  now: () => number = () => 1_000,
): { store: MlStore; storage: Storage } {
  const store = new MlStore({
    storage,
    newId: idFactory('sample'),
    now,
    defaultLanguageId: 'isl',
  });
  return { store, storage };
}

/* ----------------------------------------------------------- storage layer */

describe('the store', () => {
  it('starts empty rather than unready', async () => {
    const { store } = makeStore();
    expect(store.getSnapshot().ready).toBe(false);

    await store.start();

    const snapshot = store.getSnapshot();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.headers).toEqual([]);
    expect(snapshot.models).toEqual([]);
    expect(snapshot.error).toBeNull();
  });

  it('reports a read failure instead of appearing to hold no data', async () => {
    const base = createInMemoryStorage();
    const broken: Storage = {
      ...base,
      async getJson() {
        throw new Error('storage subsystem unavailable');
      },
    };

    const { store } = makeStore(broken);
    await store.start();

    const snapshot = store.getSnapshot();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.error).toMatch(/could not be read/i);
    expect(snapshot.error).toMatch(/storage subsystem unavailable/);
  });

  it('keeps a window and reads it back after a restart', async () => {
    const storage = createInMemoryStorage();
    const sample = makeWindowSample({ id: 'w1', labelId: 'sign-a', sessionId: 's1' });

    const first = makeStore(storage);
    await first.store.start();
    await first.store.saveSample(sample);

    // A second store over the same storage is what a relaunch does.
    const second = makeStore(storage);
    await second.store.start();

    expect(second.store.getSnapshot().headers).toHaveLength(1);
    const readBack = await second.store.loadSample('w1');
    expect(readBack?.modality).toBe('glove-sensor');
    if (readBack?.modality !== 'glove-sensor') throw new Error('the window did not come back as a sensor window');
    expect(readBack.frames).toHaveLength(30);
    expect(second.store.getSnapshot().damaged).toEqual([]);
  });

  it('refuses a window it already holds, and says which sign it belongs to', async () => {
    const { store } = makeStore();
    await store.start();
    await store.createLabel('Hello', null);

    const labelId = store.getSnapshot().labels[0]!.id;
    const first = makeWindowSample({ id: 'w1', labelId, sessionId: 's1' });
    const second = makeWindowSample({ id: 'w2', labelId, sessionId: 's1' });
    // Same motion, same session, same sign: the fingerprints match by design.
    expect(second.fingerprint).not.toBe(first.fingerprint); // ids differ in the fixture
    const twin = { ...first, id: 'w2' };

    await store.saveSample(first);
    await store.saveSample(twin);
    await settle();

    expect(store.getSnapshot().headers).toHaveLength(1);
    expect(store.getSnapshot().error).toMatch(/already saved as "Hello"/i);
  });

  it('reports a missing body as damaged rather than as an empty window', async () => {
    const storage = createInMemoryStorage();
    const { store } = makeStore(storage);
    await store.start();
    await store.createLabel('Hello', null);
    const labelId = store.getSnapshot().labels[0]!.id;

    await store.saveSample(makeWindowSample({ id: 'w1', labelId, sessionId: 's1' }));
    // What an interrupted delete leaves behind: a header with no frames.
    await storage.removeKey(ML_KEYS.sample('w1'));

    const restored = makeStore(storage);
    await restored.store.start();
    const { samples, damaged } = await restored.store.loadAllSamples();

    expect(samples).toEqual([]);
    expect(damaged).toEqual(['w1']);
    expect(restored.store.getSnapshot().damaged).toEqual(['w1']);
  });

  it('removes the frames before the header, so a half-delete is visible', async () => {
    const storage = createInMemoryStorage();
    const { store } = makeStore(storage);
    await store.start();
    await store.createLabel('Hello', null);
    const labelId = store.getSnapshot().labels[0]!.id;
    await store.saveSample(makeWindowSample({ id: 'w1', labelId, sessionId: 's1' }));

    const result = await store.deleteSamples(['w1']);

    expect(result.ok).toBe(true);
    expect(await storage.getJson(ML_KEYS.sample('w1'))).toBeNull();
    expect(store.getSnapshot().headers).toEqual([]);
  });

  it('refuses to delete when nothing was selected', async () => {
    const { store } = makeStore();
    await store.start();
    const result = await store.deleteSamples([]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Nothing was selected/);
  });

  it('counts what it is about to erase', async () => {
    const { store } = makeStore();
    await store.start();
    await store.createLabel('Hello', null);
    const labelId = store.getSnapshot().labels[0]!.id;
    await store.saveSample(makeWindowSample({ id: 'w1', labelId, sessionId: 's1' }));
    await store.saveSample(makeWindowSample({ id: 'w2', labelId, sessionId: 's1', startMs: 50_000 }));

    const erased = await store.deleteEverything();

    expect(erased.ok && erased.data).toEqual({ samples: 2, models: 0, labels: 1 });
    expect(store.getSnapshot().headers).toEqual([]);
    expect(store.getSnapshot().labels).toEqual([]);
  });

  it('replaces unreadable settings with the defaults rather than guessing', async () => {
    const storage = createInMemoryStorage();
    await storage.setJson(ML_KEYS.settings, {
      // A blob from an older build, or one that was damaged.
      allowCollectedDataForTraining: 'yes',
      allowSimulatedTraining: true,
      activation: { minSamplesPerClass: 999, minTestAccuracy: -4 },
      unknownScore: 12,
      unknownMargin: null,
    });

    const { store } = makeStore(storage);
    await store.start();
    const settings = store.getSnapshot().settings;

    // Training permission is the one that must fail closed.
    expect(settings.allowCollectedDataForTraining).toBe(false);
    expect(settings.allowSimulatedTraining).toBe(true);
    expect(settings.activation.minSamplesPerClass).toBe(50);
    expect(settings.activation.minTestAccuracy).toBe(0.1);
    expect(settings.unknownScore).toBe(1);
    expect(settings.unknownMargin).toBe(0.1);
  });

  it('stamps when consent was given, and clears it when it is withdrawn', async () => {
    const { store } = makeStore(createInMemoryStorage(), () => 4_242);
    await store.start();

    const given = await store.updateSettings({ allowCollectedDataForTraining: true });
    expect(given.ok && given.data.consentRecordedAtMs).toBe(4_242);

    const kept = await store.updateSettings({ unknownMargin: 0.2 });
    expect(kept.ok && kept.data.consentRecordedAtMs).toBe(4_242);

    const withdrawn = await store.updateSettings({ allowCollectedDataForTraining: false });
    expect(withdrawn.ok && withdrawn.data.consentRecordedAtMs).toBeNull();
  });
});

/* ----------------------------------------------------------------- labels */

describe('signs', () => {
  it('keeps the user’s own words and refuses a nameless sign', async () => {
    const { store } = makeStore();
    await store.start();

    const empty = await store.createLabel('   ', null);
    expect(empty.ok).toBe(false);

    const created = await store.createLabel('  Thank you  ', 'flat hand');
    expect(created.ok && created.data.text).toBe('Thank you');
    expect(created.ok && created.data.createdBy).toBe('user');
  });

  it('refuses a duplicate in the same sign language', async () => {
    const { store } = makeStore();
    await store.start();
    await store.createLabel('Hello', null);

    const again = await store.createLabel('hello', null);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/already exists/i);
  });

  it('will not file a new window under a retired sign', async () => {
    const { store } = makeStore();
    await store.start();
    const label = await store.createLabel('Hello', null);
    const labelId = label.ok ? label.data.id : '';

    await store.archiveLabel(labelId);
    await store.saveSample(makeWindowSample({ id: 'w1', labelId, sessionId: 's1' }));

    const relabel = await store.relabel('w1', labelId);
    expect(relabel.ok).toBe(false);
    expect(relabel.ok === false && relabel.error).toMatch(/has been retired/);
  });

  it('confirms a pending window and recomputes its fingerprint', async () => {
    const { store } = makeStore();
    await store.start();
    const label = await store.createLabel('Hello', null);
    const labelId = label.ok ? label.data.id : '';

    const pending = {
      ...makeWindowSample({ id: 'w1', labelId: '__unconfirmed__', sessionId: 's1', approval: 'pending' }),
    };
    await store.saveSample(pending);
    const before = store.getSnapshot().headers[0]!;
    expect(before.approval).toBe('pending');

    const confirmed = await store.relabel('w1', labelId);

    expect(confirmed.ok).toBe(true);
    const after = store.getSnapshot().headers[0]!;
    expect(after.approval).toBe('approved');
    expect(after.labelId).toBe(labelId);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('keeps a rejected window instead of deleting it', async () => {
    const { store } = makeStore();
    await store.start();
    await store.createLabel('Hello', null);
    const labelId = store.getSnapshot().labels[0]!.id;
    await store.saveSample(makeWindowSample({ id: 'w1', labelId, sessionId: 's1' }));

    await store.markRejected('w1', 'That was the other sign');

    const header = store.getSnapshot().headers[0]!;
    expect(header.approval).toBe('rejected');
    expect(header.rejectionReason).toBe('That was the other sign');
    expect(store.getSnapshot().headers).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- recording */

describe('recording a window', () => {
  function makeCapture(store: MlStore, now = () => 1_000) {
    return new CaptureController({
      sink: store,
      newId: idFactory('capture'),
      now,
    });
  }

  /** Feeds one full-length run into the controller, finishing the window. */
  function record(controller: CaptureController, signId = 'sign-a'): void {
    controller.beginWindow();
    for (const sample of makeRun(signId, 0, { frames: 40, hz: 20 })) {
      controller.pushFrame(sample);
    }
  }

  async function openSession(controller: CaptureController, store: MlStore): Promise<string> {
    await controller.startSession({
      languageId: 'isl',
      modality: 'glove-sensor',
      source: 'simulated',
      side: 'right',
      deviceLabel: 'Demo Mode (simulated)',
      calibrationVersion: 1,
      handContext: 'right',
    });
    const labelId = store.getSnapshot().labels[0]?.id ?? '';
    return labelId;
  }

  async function setUp() {
    const { store } = makeStore();
    await store.start();
    await store.createLabel('Hello', null);
    await store.createLabel('Thank you', null);
    const labels = store.getSnapshot().labels;
    const controller = makeCapture(store);
    await openSession(controller, store);
    return { store, controller, labels };
  }

  it('asks for a sign before it will save anything', async () => {
    const { store, controller, labels } = await setUp();

    record(controller);
    await settle();

    expect(controller.getSnapshot().phase).toBe('awaiting-label');
    expect(store.getSnapshot().headers).toEqual([]);

    const result = await controller.confirm(labels[0]!.id);
    expect(result.ok).toBe(true);
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(store.getSnapshot().headers).toHaveLength(1);
    expect(store.getSnapshot().headers[0]!.approval).toBe('approved');
    expect(store.getSnapshot().headers[0]!.source).toBe('simulated');
  });

  it('stores a window the user could not name as pending, not under a guess', async () => {
    const { store, controller } = await setUp();

    record(controller, 'sign-b');
    await settle();
    await controller.confirm(null);

    const header = store.getSnapshot().headers[0]!;
    expect(header.approval).toBe('pending');
    expect(header.labelId).toBe('__unconfirmed__');
    expect(store.labelText(header.labelId)).toBe('__unconfirmed__');
  });

  it('writes the window before asking for its label, so a crash loses nothing', async () => {
    const { store, controller } = await setUp();

    record(controller);
    await settle();

    const pending = store.getSnapshot().pendingWindow;
    expect(pending).not.toBeNull();
    expect(pending!.frames).toHaveLength(30);
    expect(pending!.sessionId).toBe(controller.getSnapshot().session!.id);
  });

  it('throws away a partial window rather than padding it', async () => {
    const { store, controller } = await setUp();

    controller.beginWindow();
    for (const sample of makeRun('sign-a', 0, { frames: 6, hz: 20 })) {
      controller.pushFrame(sample);
    }
    await controller.finishWindow();
    await settle();

    // Six frames cannot make a window, and a padded one never happened.
    expect(controller.getSnapshot().error).toMatch(/needs at least 8 readings/i);
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(controller.getSnapshot().pending).toBeNull();
    expect(store.getSnapshot().headers).toEqual([]);
  });

  it('clears a cancelled window out of storage', async () => {
    const { store, controller } = await setUp();

    record(controller);
    await settle();
    expect(store.getSnapshot().pendingWindow).not.toBeNull();

    await controller.cancel();

    expect(controller.getSnapshot().pending).toBeNull();
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(store.getSnapshot().pendingWindow).toBeNull();
    expect(store.getSnapshot().headers).toEqual([]);
  });

  it('refuses to start a second window while one is waiting for a sign', async () => {
    const { controller } = await setUp();

    record(controller);
    await settle();

    const second = controller.beginWindow();
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toMatch(/still needs a sign/);
  });

  it('ignores a frame from the other hand', async () => {
    const { controller } = await setUp();
    controller.beginWindow();

    // The session was opened for the right glove, so a left-hand glove's frames
    // are not part of this window — and nothing downstream could tell if a whole
    // window had been built from them.
    for (const sample of makeRun('sign-a', 0, { frames: 20, hz: 20 })) {
      controller.pushFrame({ ...sample, side: 'left' });
    }

    expect(controller.getSnapshot().frames).toBe(0);
  });

  it('records the hand the caller declared, not the one it guessed', async () => {
    const { store, controller, labels } = await setUp();

    record(controller);
    await settle();
    const pending = controller.getSnapshot().pending!;
    expect(pending.side).toBe('right');
    expect(pending.handContext).toBe('right');

    await controller.confirm(labels[0]!.id);
    expect(store.getSnapshot().headers[0]!.handContext).toBe('right');
  });

  it('keeps a two-handed sign recorded from one glove', async () => {
    /*
     * A two-handed sign captured from the right glove is normal: the person is
     * using both hands, the app has one sensor. Reading the context off the
     * motion would have recorded this as a right-handed sign, which is a claim
     * about what the person did rather than about what the app received.
     */
    const { store } = makeStore();
    await store.start();
    await store.createLabel('Together', null);
    const controller = makeCapture(store);

    await controller.startSession({
      languageId: 'isl',
      modality: 'glove-sensor',
      source: 'glove',
      side: 'right',
      deviceLabel: 'Left glove',
      calibrationVersion: 3,
      handContext: 'both',
    });

    record(controller, 'sign-c');
    await settle();
    await controller.confirm(store.getSnapshot().labels[0]!.id);

    const header = store.getSnapshot().headers[0]!;
    expect(header.handContext).toBe('both');

    // The header carries the declared hand context; the glove it came from is on
    // the window itself, because only the body needs it.
    const saved = await store.loadSample(header.id);
    expect(saved?.modality).toBe('glove-sensor');
    if (saved?.modality !== 'glove-sensor') throw new Error('the window was not stored as a sensor window');
    expect(saved.side).toBe('right');
    expect(saved.source).toBe('glove');
  });

  it('counts the window against the session it belongs to', async () => {
    const { store, controller, labels } = await setUp();

    record(controller);
    await settle();
    await controller.confirm(labels[0]!.id);

    const session = store.getSnapshot().sessions[0]!;
    expect(session.sampleCount).toBe(1);
    expect(session.deviceLabel).toBe('Demo Mode (simulated)');
    expect(session.preprocessingVersion).toBe(PREPROCESSING_VERSION);

    await controller.closeSession();
    const closed = store.getSnapshot().sessions[0]!;
    expect(closed.status).toBe('closed');
    expect(closed.endedAtMs).not.toBeNull();
  });

  it('recovers a session that a crash left open, without inventing an end time', async () => {
    const storage = createInMemoryStorage();
    const { store } = makeStore(storage);
    await store.start();
    await store.createLabel('Hello', null);
    const controller = makeCapture(store);
    await openSession(controller, store);

    record(controller, 'sign-a');
    await settle();
    await controller.confirm(store.getSnapshot().labels[0]!.id);

    // No closeSession: the process died with the session open.
    const relaunched = makeStore(storage);
    await relaunched.store.start();

    const session = relaunched.store.getSnapshot().sessions[0]!;
    expect(session.status).toBe('interrupted');
    expect(session.endedAtMs).toBeNull();
    // The window that was saved before the interruption is still there.
    expect(relaunched.store.getSnapshot().headers).toHaveLength(1);
    expect(session.sampleCount).toBe(1);
  });

  it('restores a window that was recorded but never labelled', async () => {
    const storage = createInMemoryStorage();
    const { store } = makeStore(storage);
    await store.start();
    await store.createLabel('Hello', null);
    const controller = makeCapture(store);
    await openSession(controller, store);

    record(controller);
    await settle();

    const relaunched = makeStore(storage);
    await relaunched.store.start();

    const restored = relaunched.store.getSnapshot().pendingWindow;
    expect(restored).not.toBeNull();
    expect(restored!.frames).toHaveLength(30);
    expect(restored!.languageId).toBe('isl');
  });

  it('refuses the same motion twice in a row', async () => {
    const { store, controller, labels } = await setUp();
    const labelId = labels[0]!.id;

    record(controller, 'sign-a');
    await settle();
    await controller.confirm(labelId);

    record(controller, 'sign-a');
    await settle();
    await controller.confirm(labelId);
    await settle();

    expect(store.getSnapshot().headers).toHaveLength(1);
    expect(store.getSnapshot().error).toMatch(/already saved/i);
  });

  it('stamps a window with the account that confirmed it', async () => {
    const { store } = makeStore();
    await store.start();
    await store.createLabel('Hello', null);

    let who: string | null = 'account-1';
    const controller = new CaptureController({
      sink: store,
      newId: idFactory('capture'),
      now: () => 1_000,
      currentOwnerId: () => who,
    });
    await openSession(controller, store);

    record(controller);
    await settle();
    await controller.confirm(store.getSnapshot().labels[0]!.id);

    expect(store.getSnapshot().headers[0]!.ownerId).toBe('account-1');
  });

  it('reads the account when the window is saved, not when the session opened', async () => {
    /*
     * A person can sign in between opening a session and confirming a window —
     * the account provider is mounted inside the state provider, so the centre
     * learns who it belongs to after it has already started. Reading the account
     * once at construction would stamp a guest's id on a signed-in person's
     * recording, which is the one direction of that mistake that loses data
     * ownership silently.
     */
    const { store } = makeStore();
    await store.start();
    await store.createLabel('Hello', null);

    let who: string | null = null;
    const controller = new CaptureController({
      sink: store,
      newId: idFactory('capture'),
      now: () => 1_000,
      currentOwnerId: () => who,
    });
    await openSession(controller, store);

    who = 'account-signed-in-later';
    record(controller);
    await settle();
    await controller.confirm(store.getSnapshot().labels[0]!.id);

    expect(store.getSnapshot().headers[0]!.ownerId).toBe('account-signed-in-later');
  });

  it('leaves a guest recording unowned rather than inventing an owner', async () => {
    const { store, controller } = await setUp();

    record(controller);
    await settle();
    await controller.confirm(store.getSnapshot().labels[0]!.id);

    expect(store.getSnapshot().headers[0]!.ownerId).toBeNull();
  });
});

/* -------------------------------------------------------- dataset gating */

describe('what may be trained on', () => {
  const permissive: MlSettings = {
    allowCollectedDataForTraining: true,
    consentRecordedAtMs: 1,
    allowSimulatedTraining: true,
    activation: { minSamplesPerClass: 3, minTestAccuracy: 0.6 },
    unknownScore: 0.5,
    unknownMargin: 0.1,
  };

  it('takes a confirmed, consented, real-glove window', async () => {
    const samples = makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2, source: 'glove' });
    const result = trainableSet({ samples, languageId: 'isl', settings: permissive });

    expect(result.samples).toHaveLength(4);
    expect(result.refused).toEqual([]);
    expect(result.blocked).toBeNull();
  });

  it('refuses an unconfirmed window and says why', () => {
    const samples = makeDataset({
      signs: ['sign-a'],
      sessions: 2,
      perSign: 2,
      source: 'glove',
      approval: 'pending',
    });
    const result = trainableSet({ samples, languageId: 'isl', settings: permissive });

    expect(result.samples).toEqual([]);
    expect(result.refused[0]!.code).toBe('not-confirmed');
    expect(result.blocked?.reason).toMatch(/waiting for you to confirm which sign/i);
  });

  it('applies consent to everything at once', () => {
    const samples = makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2, source: 'glove' });
    const result = trainableSet({
      samples,
      languageId: 'isl',
      settings: { ...permissive, allowCollectedDataForTraining: false },
    });

    expect(result.samples).toEqual([]);
    expect(result.blocked?.code).toBe('consent-missing');
    expect(result.blocked?.reason).toMatch(/you have not allowed it/i);
  });

  it('keeps Demo Mode windows out unless the user has allowed simulated training', () => {
    const samples = makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2, source: 'simulated' });
    const result = trainableSet({
      samples,
      languageId: 'isl',
      settings: { ...permissive, allowSimulatedTraining: false },
    });

    expect(result.samples).toEqual([]);
    expect(result.refused.map((refusal) => refusal.code)).toContain('simulated-not-permitted');
  });

  it('refuses a window recorded for another sign language', () => {
    const samples = makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2, languageId: 'asl' });
    const result = trainableSet({ samples, languageId: 'isl', settings: permissive });

    expect(result.samples).toEqual([]);
    expect(result.refused.map((refusal) => refusal.code)).toContain('wrong-language');
  });

  it('refuses a window from an older window pipeline', () => {
    const samples = makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2 }).map((sample) => ({
      ...sample,
      preprocessingVersion: 'glove-window/0',
    }));
    const result = trainableSet({ samples, languageId: 'isl', settings: permissive });

    expect(result.samples).toEqual([]);
    expect(result.refused.map((refusal) => refusal.code)).toContain('deprecated-preprocessing');
  });

  it('refuses a window that failed its own quality check', () => {
    const samples = makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2 }).map((sample) => ({
      ...sample,
      quality: { ...sample.quality, ok: false, flatChannels: [0, 1, 2, 3, 4] },
    }));
    const result = trainableSet({ samples, languageId: 'isl', settings: permissive });

    expect(result.samples).toEqual([]);
    expect(result.refused.map((refusal) => refusal.code)).toContain('quality-failed');
  });

  it('never mixes photos into the sensor pipeline', () => {
    const vision: VisionSample = {
      ...makeWindowSample({ id: 'p1', labelId: 'sign-a', sessionId: 's1' }),
      modality: 'vision',
      media: {
        kind: 'photo',
        uri: 'file:///device/photo.jpg',
        mimeType: 'image/jpeg',
        byteSize: 1_024,
        width: 640,
        height: 480,
        durationMs: null,
      },
      usedForTraining: false,
    } as unknown as VisionSample;

    const result = trainableSet({
      samples: [vision, ...makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2 })],
      languageId: 'isl',
      settings: permissive,
    });

    // The photo is refused by the vision rule before any sensor rule sees it, and
    // the sensor windows are unaffected.
    expect(result.refused[0]!.code).toBe('vision-not-trainable');
    expect(result.samples).toHaveLength(4);
    expect(result.samples.every((sample) => sample.modality === 'glove-sensor')).toBe(true);
  });

  it('warns when windows came from more than one calibration', () => {
    const samples = makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2 }).map((sample, index) => ({
      ...sample,
      calibrationVersion: index % 2,
    }));
    const result = trainableSet({ samples, languageId: 'isl', settings: permissive });

    expect(result.caveats.join(' ')).toMatch(/2 different calibrations/);
  });

  it('warns when the data it kept is simulated', () => {
    const samples = makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2, source: 'simulated' });
    const result = trainableSet({ samples, languageId: 'isl', settings: permissive });

    expect(result.caveats.join(' ')).toMatch(/not evidence of recognising real signing/i);
  });
});

/* ------------------------------------------------------------ training run */

describe('training through the store', () => {
  /** A store holding two sittings of three signs each, with permission given. */
  async function withDataset(options: { sessions?: number; perSign?: number } = {}) {
    const storage = createInMemoryStorage();
    const { store } = makeStore(storage);
    await store.start();
    await store.updateSettings({
      allowCollectedDataForTraining: true,
      allowSimulatedTraining: true,
    });

    for (const id of ['a', 'b', 'c']) await store.createLabel(id.toUpperCase(), null);
    const [first, second, third] = store.getSnapshot().labels;
    const languageId = 'isl';

    /*
     * The fixtures are generated under their own stable sign names — the name is
     * what selects which flex channel peaks, so passing the store's own ids here
     * would give every class the same waveform. The windows are repointed at the
     * ids the store issued afterwards.
     */
    const signs = ['sign-a', 'sign-b', 'sign-c'];
    const labelIdFor = new Map([
      ['sign-a', first!.id],
      ['sign-b', second!.id],
      ['sign-c', third!.id],
    ]);

    const samples = makeDataset({
      signs,
      sessions: options.sessions ?? 4,
      perSign: options.perSign ?? 4,
      source: 'simulated',
      languageId,
    }).map((sample) => {
      const labelId = labelIdFor.get(sample.labelId)!;
      return { ...sample, labelId, fingerprint: `${sample.id}-${labelId}` };
    });

    for (const sample of samples) await store.saveSample(sample);
    return { store, storage, labels: store.getSnapshot().labels, samples };
  }

  it('trains, measures and stores a version of its own', async () => {
    const { store } = await withDataset();
    const outcome = await store.train();

    expect(outcome.ok ? 'trained' : outcome.reason).toBe('trained');
    if (!outcome.ok) return;
    expect(store.getSnapshot().models).toHaveLength(1);

    const summary = store.getSnapshot().models[0]!;
    expect(summary.version).toBe(1);
    expect(summary.languageId).toBe('isl');
    expect(summary.modality).toBe('glove-sensor');
    expect(summary.trainedOn).toEqual(['simulated']);
    // The weights live beside the index, not inside it.
    expect('parameters' in summary).toBe(false);

    const full = await store.loadModel(summary.id);
    expect(full?.parameters.weights.length).toBeGreaterThan(0);
  });

  it('says it is training while it trains, and finishes', async () => {
    const { store } = await withDataset();
    expect(store.isTraining()).toBe(false);

    const seen: string[] = [];
    await store.train((progress) => seen.push(progress.phase));

    expect(seen).toContain('fitting');
    expect(seen.at(-1)).toBe('judging');
    expect(store.isTraining()).toBe(false);
    expect(store.getProgress()).toBeNull();
  });

  it('refuses a second run while one is going', async () => {
    const { store } = await withDataset();

    let reason: string | null = null;
    await store.train(async () => {
      if (reason !== null) return;
      const second = await store.train();
      if (!second.ok) reason = second.reason;
    });

    expect(reason).toMatch(/already going/i);
  });

  it('leaves the previous model in use when a run is stopped', async () => {
    const { store } = await withDataset();

    const first = await store.train();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await store.activate(first.model.id);
    const before = store.getSnapshot().models;

    const stopped = await store.train(() => {
      // The user pressed stop at the first measured epoch.
      store.cancelTraining();
    });

    expect(stopped.ok).toBe(false);
    expect(stopped.ok === false && stopped.reason).toMatch(/previous model is still in use/i);
    expect(store.getSnapshot().models).toEqual(before);
    expect(store.getSnapshot().models[0]!.status).toBe('active');
  });

  it('leaves the previous model in use when the data is not good enough', async () => {
    const { store } = await withDataset();
    const first = await store.train();
    if (!first.ok) throw new Error(first.reason);
    await store.activate(first.model.id);
    const before = store.getSnapshot().models;

    // Consent is withdrawn. Nothing is deleted — the model stays exactly as it
    // was, and the next run refuses before it fits anything.
    await store.updateSettings({ allowCollectedDataForTraining: false });
    const again = await store.train();

    expect(again.ok).toBe(false);
    expect(store.getSnapshot().models).toEqual(before);
    const live = await store.loadActiveModel('isl', 'glove-sensor');
    expect(live).not.toBeNull();
    expect(live!.id).toBe(first.model.id);
  });

  it('refuses to remove the version that is in use', async () => {
    const { store } = await withDataset();
    const first = await store.train();
    if (!first.ok) throw new Error(first.reason);
    await store.activate(first.model.id);

    const refused = await store.deleteModel(first.model.id);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toMatch(/Switch to another version/);
  });

  it('activates a version that passed its checks, and retires the one before', async () => {
    const { store } = await withDataset();

    const first = await store.train();
    if (!first.ok) throw new Error(first.reason);
    // Four sittings of four windows each: something is held out, the held-out
    // figure clears the floor, so this one goes live without being asked.
    expect(first.activated).toBe(true);
    expect(store.getSnapshot().models[0]!.status).toBe('active');

    const second = await store.train();
    if (!second.ok) throw new Error(second.reason);
    expect(second.model.version).toBe(2);
    expect(second.activated).toBe(true);

    const models = store.getSnapshot().models;
    expect(models.find((model) => model.id === second.model.id)!.status).toBe('active');
    // Exactly one version is ever in use.
    expect(models.filter((model) => model.status === 'active')).toHaveLength(1);
    expect(models.find((model) => model.id === first.model.id)!.status).toBe('retired');
  });

  it('swaps to a chosen version and can go back', async () => {
    // One sitting cannot be split, so this version is measured on nothing and is
    // stored as a candidate — which is what a held-back version looks like.
    const { store } = await withDataset({ sessions: 1, perSign: 4 });

    const first = await store.train();
    if (!first.ok) throw new Error(first.reason);
    expect(first.activated).toBe(false);
    expect(first.model.status).toBe('candidate');
    expect(first.model.statusReason).toMatch(/not been measured|held out/i);

    // Putting a version in use is the user's decision, taken in front of the
    // reason it was held back.
    const chosen = await store.activate(first.model.id);
    expect(chosen.ok && chosen.data.activate.id).toBe(first.model.id);

    const second = await store.train();
    if (!second.ok) throw new Error(second.reason);
    expect(second.model.version).toBe(2);

    const plan = await store.activate(second.model.id);
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.data.retire?.id).toBe(first.model.id);
    expect(plan.ok && plan.data.rollbackTo?.id).toBe(first.model.id);

    const models = store.getSnapshot().models;
    expect(models.find((model) => model.id === second.model.id)!.status).toBe('active');
    expect(models.find((model) => model.id === first.model.id)!.status).toBe('retired');

    const back = await store.rollback('isl', 'glove-sensor');
    expect(back.ok).toBe(true);
    expect(back.ok && back.data.id).toBe(first.model.id);
    expect((await store.loadActiveModel('isl', 'glove-sensor'))!.id).toBe(first.model.id);
  });

  it('has nothing to go back to on a first version', async () => {
    const { store } = await withDataset();
    const back = await store.rollback('isl', 'glove-sensor');
    expect(back.ok).toBe(false);
    expect(back.ok === false && back.error).toMatch(/no earlier version/i);
  });

  it('keeps a model’s weights out of the index and readable from storage', async () => {
    const { store, storage } = await withDataset();
    const outcome = await store.train();
    if (!outcome.ok) throw new Error(outcome.reason);

    const stored = await storage.getJson<{ parameters: { weights: number[][] } }>(
      ML_KEYS.model(outcome.model.id),
    );
    expect(stored).not.toBeNull();
    // One weight row per class, one column per feature.
    expect(stored!.parameters.weights).toHaveLength(3);
    expect(stored!.parameters.weights[0]).toHaveLength(55);
  });
});

/* ------------------------------------------------------------ export/import */

describe('export and import', () => {
  async function seeded() {
    const { store, storage } = makeStore();
    await store.start();
    for (const id of ['a', 'b']) await store.createLabel(id.toUpperCase(), null);
    const labels = store.getSnapshot().labels;
    const samples = makeDataset({ signs: ['sign-a'], sessions: 2, perSign: 2 }).map((sample, index) => ({
      ...sample,
      id: `w${index}`,
      labelId: labels[0]!.id,
      fingerprint: `fp-${index}`,
    }));
    for (const sample of samples) await store.saveSample(sample);
    return { store, storage, labels, samples };
  }

  it('writes a file that carries its own checksum and note', async () => {
    const { store } = await seeded();
    const exported = await store.exportDataset();

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.format).toBe('sanketvaanni.ml.dataset');
    expect(exported.data.datasetVersion).toBe(1);
    expect(exported.data.samples).toHaveLength(4);
    // A corruption check, not a security property: FNV-1a over the samples.
    expect(exported.data.checksum).toMatch(/^[0-9a-f]{8}$/);
    // The note has to say what the file is not, so a user does not read it as a
    // backup of their photos.
    expect(exported.data.note).toMatch(/not inside this file/i);
  });

  it('names the account the export was made under', async () => {
    /*
     * The one artefact that leaves the device has to say whose data it holds.
     * It previously carried a fixed null, so every export was equally unowned and
     * a file full of somebody's recordings said nothing about whose they were.
     */
    const { store: plain, labels } = await seeded();
    const anonymous = await plain.exportDataset();
    if (!anonymous.ok) throw new Error(anonymous.error);
    expect(anonymous.data.ownerId).toBeNull();
    expect(labels).toHaveLength(2);

    const storage = createInMemoryStorage();
    const owned = new MlStore({
      storage,
      newId: idFactory('owned'),
      now: () => 1_000,
      defaultLanguageId: 'isl',
      currentOwnerId: () => 'account-7',
    });
    await owned.start();
    const exported = await owned.exportDataset();

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.ownerId).toBe('account-7');
  });

  it('reads the owner when the export is written, not when the store was built', async () => {
    let who: string | null = null;
    const storage = createInMemoryStorage();
    const store = new MlStore({
      storage,
      newId: idFactory('live'),
      now: () => 1_000,
      defaultLanguageId: 'isl',
      currentOwnerId: () => who,
    });
    await store.start();

    who = 'account-after-start';
    const exported = await store.exportDataset();

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.ownerId).toBe('account-after-start');
  });

  it('adds nothing when the same file is imported twice', async () => {
    const { store } = await seeded();
    const exported = await store.exportDataset();
    if (!exported.ok) throw new Error('export failed');

    const target = makeStore();
    await target.store.start();

    const first = await target.store.importDataset(exported.data);
    expect(first.ok && first.data).toEqual({ added: 4, skipped: 0 });

    const second = await target.store.importDataset(exported.data);
    expect(second.ok && second.data).toEqual({ added: 0, skipped: 4 });
    expect(target.store.getSnapshot().headers).toHaveLength(4);
  });

  it('refuses a file whose contents do not match its checksum', async () => {
    const { store } = await seeded();
    const exported = await store.exportDataset();
    if (!exported.ok) throw new Error('export failed');

    const target = makeStore();
    await target.store.start();

    const tampered = {
      ...exported.data,
      samples: exported.data.samples.map((sample, index) =>
        index === 0 ? { ...sample, labelId: 'something-else' } : sample,
      ),
    };
    const result = await target.store.importDataset(tampered);

    expect(result.ok).toBe(false);
    expect(target.store.getSnapshot().headers).toEqual([]);
  });

  it('brings the labels a file depends on with it', async () => {
    const { store } = await seeded();
    const exported = await store.exportDataset();
    if (!exported.ok) throw new Error('export failed');

    const target = makeStore();
    await target.store.start();
    await target.store.importDataset(exported.data);

    expect(target.store.getSnapshot().labels.map((label) => label.text)).toEqual(['A', 'B']);
  });
});

/* --------------------------------------------------------------- media */

describe('importing photos and video', () => {
  /** Stands in for the native picker, which this build does not have. */
  function fakePicker(items: readonly PickedMedia[]): MediaPicker {
    return {
      isAvailable: () => true,
      unavailableReason: () => '',
      async pick() {
        return items;
      },
    };
  }

  const photo: PickedMedia = {
    kind: 'photo',
    uri: 'file:///device/sign.jpg',
    mimeType: 'image/jpeg',
    byteSize: 204_800,
    width: 1_080,
    height: 1_920,
    durationMs: null,
  };

  it('reports that this build has no picker, rather than an empty result', async () => {
    const result = await importMedia({
      picker: new UnavailablePicker(),
      kind: 'photo',
      languageId: 'isl',
      labelId: 'a',
      existingUris: [],
      consented: true,
      ownerId: null,
      nowMs: 0,
      newId: idFactory('m'),
    });

    expect(result.imported).toEqual([]);
    expect(result.totalFailure).toBe(true);
    expect(result.failed[0]!.code).toBe('picker-unavailable');
    expect(result.note).toMatch(/no photo or video picker installed/i);
  });

  it('imports nothing without explicit consent', async () => {
    const result = await importMedia({
      picker: fakePicker([photo]),
      kind: 'photo',
      languageId: 'isl',
      labelId: 'a',
      existingUris: [],
      consented: false,
      ownerId: null,
      nowMs: 0,
      newId: idFactory('m'),
    });

    expect(result.imported).toEqual([]);
    expect(result.failed[0]!.code).toBe('no-consent');
    expect(result.totalFailure).toBe(true);
  });

  it('keeps an accepted file as a labelled record that never trains the glove model', async () => {
    const result = await importMedia({
      picker: fakePicker([photo]),
      kind: 'photo',
      languageId: 'isl',
      labelId: 'a',
      existingUris: [],
      consented: true,
      ownerId: null,
      nowMs: 0,
      newId: idFactory('m'),
    });

    expect(result.imported).toHaveLength(1);
    const record = result.imported[0]!;
    expect(record.modality).toBe('vision');
    expect(record.usedForTraining).toBe(false);
    // Picked, but not yet confirmed by a person — the same rule as a recorded
    // window: an imported file is a record until somebody says what it shows.
    expect(record.approval).toBe('pending');
    expect(record.media.uri).toBe(photo.uri);
  });

  it('skips a file that is already in the library', async () => {
    const result = await importMedia({
      picker: fakePicker([photo]),
      kind: 'photo',
      languageId: 'isl',
      labelId: 'a',
      existingUris: [photo.uri],
      consented: true,
      ownerId: null,
      nowMs: 0,
      newId: idFactory('m'),
    });

    expect(result.imported).toEqual([]);
    expect(result.duplicates).toBe(1);
    expect(result.totalFailure).toBe(false);
  });

  it('keeps the accepted files when one of them is rejected', async () => {
    const tooBig: PickedMedia = { ...photo, uri: 'file:///device/huge.jpg', byteSize: 500 * 1024 * 1024 };
    const foreign: PickedMedia = { ...photo, uri: 'https://example.com/remote.jpg' };

    const result = await importMedia({
      picker: fakePicker([photo, tooBig, foreign]),
      kind: 'photo',
      languageId: 'isl',
      labelId: 'a',
      existingUris: [],
      consented: true,
      ownerId: null,
      nowMs: 0,
      newId: idFactory('m'),
    });

    expect(result.requested).toBe(3);
    expect(result.imported).toHaveLength(1);
    expect(result.failed.map((failure) => failure.code)).toEqual(['too-large', 'not-a-local-file']);
    expect(result.totalFailure).toBe(false);
  });
});

/* ------------------------------------------------------- honest description */

describe('what the centre says about itself', () => {
  it('describes a simulated dataset as simulated', async () => {
    const { store } = makeStore();
    await store.start();
    await store.createLabel('A', null);
    await store.saveSample(
      makeWindowSample({
        id: 'w1',
        labelId: store.getSnapshot().labels[0]!.id,
        sessionId: 's1',
        source: 'simulated',
      }),
    );

    const summary = store.summary();
    expect(summary.total).toBe(1);
    expect(summary.bySource.simulated).toBe(1);

    const warning = provenanceWarning(summary);
    expect(warning).toMatch(/must not be presented as recognising signing/i);

    const capabilities = describeCapabilities({
      transportSynthetic: true,
      transportName: 'Demo Mode (simulated)',
      linkConnected: true,
      pickerAvailable: false,
      pickerReason: 'This build has no photo or video picker installed.',
      settings: store.getSnapshot().settings,
      summary,
      activeModel: null,
      candidateCount: 0,
      signedIn: false,
    });

    const realGlove = capabilities.find((capability) => capability.id === 'real-glove')!;
    expect(realGlove.state).toBe('blocked');
    expect(realGlove.detail).toMatch(/It is not a glove/);

    const vision = capabilities.find((capability) => capability.id === 'vision')!;
    expect(vision.state).toBe('not-built');
    expect(vision.action).toBeNull();

    // Nothing in the list may claim a cloud backup, because there is none.
    const cloud = capabilities.find((capability) => capability.id === 'cloud')!;
    expect(cloud.state).toBe('not-built');
  });

  it('says training is off until the user has allowed it', async () => {
    const { store } = makeStore();
    await store.start();

    const capabilities = describeCapabilities({
      transportSynthetic: false,
      transportName: 'Glove',
      linkConnected: false,
      pickerAvailable: false,
      pickerReason: 'none',
      settings: store.getSnapshot().settings,
      summary: store.summary(),
      activeModel: null,
      candidateCount: 0,
      signedIn: false,
    });

    const training = capabilities.find((capability) => capability.id === 'training')!;
    expect(training.state).toBe('blocked');
    expect(training.detail).toMatch(/Training is off/);

    const capture = capabilities.find((capability) => capability.id === 'capture')!;
    expect(capture.state).toBe('blocked');
    expect(capture.action).toMatch(/Demo Mode/);
  });
});
