/**
 * Live captions: the transcript store, and the rules about what it may claim.
 *
 * Most of what this module has to get right is about *not* claiming things, so
 * that is most of what is tested here:
 *
 *  - captions are unavailable — and say so — when the device has no recogniser;
 *  - a microphone the user refused is reported as refused, and a permanent
 *    refusal is distinguished from a retryable one because the two need
 *    different words on screen;
 *  - the platform's answer about an on-device model is passed through as the
 *    platform's claim, never upgraded to a promise of privacy;
 *  - the microphone is asked for on the press that turns captions on, and
 *    never at construction;
 *  - a recogniser that stops reporting takes the microphone state down with it,
 *    rather than leaving a screen that says it is listening.
 *
 * The native bridge is mocked at its own boundary, so these are tests of the
 * controller's behaviour rather than of the native module's own guards.
 */
type CaptionsModule = typeof import('../src/captions');
/** An instance rather than the class, which is what callers actually hold. */
type Captions = InstanceType<CaptionsModule['CaptionsController']>;
type PermissionsAndroidShape = typeof import('react-native').PermissionsAndroid;

interface FakeNative {
  isRecognitionAvailable: () => Promise<boolean>;
  hasOnDeviceRecognition: () => Promise<boolean | null>;
  startRecognition: jest.Mock;
  stopRecognition: jest.Mock;
  clearTranscript: jest.Mock;
  getTranscript: jest.Mock;
}

/**
 * A stand-in for the native bridge.
 *
 * `undefined` means "this build has no such module", which is a state the
 * controller must handle rather than a test shortcut.
 */
function makeNative(overrides: Partial<FakeNative> = {}): FakeNative {
  return {
    isRecognitionAvailable: async () => true,
    hasOnDeviceRecognition: async () => null,
    startRecognition: jest.fn(async () => undefined),
    stopRecognition: jest.fn(async () => undefined),
    clearTranscript: jest.fn(async () => undefined),
    getTranscript: jest.fn(async () => ({
      isListening: true,
      partial: '',
      finalText: '',
      error: null,
      sessionId: 1,
    })),
    ...overrides,
  };
}

interface Loaded {
  readonly module: CaptionsModule;
  /**
   * React Native's permission API, taken from the same instance the controller
   * uses. Spying on an import taken outside `load` would land on a different
   * object and silently do nothing — see the note on `load`.
   */
  readonly permissions: PermissionsAndroidShape;
}

/**
 * Loads the module against a given native bridge.
 *
 * `jest.resetModules()` gives the module under test a *fresh* copy of
 * `react-native`, so everything the controller reads from it has to be pulled
 * from that same copy. A `Platform.OS` override or a spy applied to an import
 * taken at the top of this file would be applied to the previous copy and have
 * no effect at all.
 */
function load(bridge: FakeNative | undefined): Loaded {
  jest.resetModules();
  jest.doMock('../src/native/SanketVaanniNative', () => ({
    isNativeModuleAvailable: bridge !== undefined,
    nativeRecognitionAvailable: async () => (bridge ? bridge.isRecognitionAvailable() : false),
    nativeOnDeviceRecognition: async () => (bridge ? bridge.hasOnDeviceRecognition() : null),
    nativeStartRecognition: (...args: unknown[]) => bridge?.startRecognition(...args),
    nativeStopRecognition: (...args: unknown[]) => bridge?.stopRecognition(...args),
    nativeTranscript: async () => (bridge ? bridge.getTranscript() : null),
    nativeClearTranscript: (...args: unknown[]) => bridge?.clearTranscript(...args),
  }));

  const rn = require('react-native') as {
    Platform: { OS: string };
    PermissionsAndroid: PermissionsAndroidShape;
  };

  // Every case here is an Android case: the microphone path is Android-only,
  // and the permission request refuses on any other platform.
  Object.defineProperty(rn.Platform, 'OS', { value: 'android', configurable: true });

  return {
    module: require('../src/captions') as CaptionsModule,
    permissions: rn.PermissionsAndroid,
  };
}

/** Lets the constructor's probe settle before the state is read. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/* --------------------------------------------------------------- availability */

describe('what it reports when it cannot run', () => {
  it('says the module is missing from the build rather than failing quietly', async () => {
    const { module } = load(undefined);
    const controller = new module.CaptionsController();
    await settle();

    const state = controller.getSnapshot();
    expect(state.recognitionAvailable).toBe(false);
    expect(state.unavailableReason).toContain('not registered in this build');

    // And asking to listen anyway must fail loudly, not resolve into silence.
    await expect(controller.start()).rejects.toThrow(/not registered in this build/);
    expect(controller.getSnapshot().isListening).toBe(false);
    expect(controller.getSnapshot().listening).toBe('error');
  });

  it('says the device has no recogniser rather than blaming the app', async () => {
    const { module } = load(makeNative({ isRecognitionAvailable: async () => false }));
    const controller = new module.CaptionsController();
    await settle();

    const state = controller.getSnapshot();
    expect(state.recognitionAvailable).toBe(false);
    expect(state.unavailableReason).toContain('no speech recognition service');
    await expect(controller.start()).rejects.toThrow(/no speech recognition service/);
  });

  it("passes the platform's on-device answer through, and never upgrades it", async () => {
    const unknown = load(makeNative({ hasOnDeviceRecognition: async () => null }));
    const withUnknown = new unknown.module.CaptionsController();
    await settle();
    // Null is "the platform could not be asked". It must not become false
    // (which would claim there is no model) or true.
    expect(withUnknown.getSnapshot().onDeviceModel).toBeNull();

    const yes = load(makeNative({ hasOnDeviceRecognition: async () => true }));
    const withYes = new yes.module.CaptionsController();
    await settle();
    expect(withYes.getSnapshot().onDeviceModel).toBe(true);
  });
});

/* ----------------------------------------------------------------- permission */

describe('the microphone permission', () => {
  it('is not requested until the user asks for captions', async () => {
    const loaded = load(makeNative());
    const request = jest.spyOn(loaded.permissions, 'request');

    const controller = new loaded.module.CaptionsController();
    await settle();

    // Construction is a fact-finding step. Asking for the microphone there
    // would be asking every user who never wants captions at all.
    expect(request).not.toHaveBeenCalled();
    expect(controller.getSnapshot().permission).toBe('unknown');
    expect(controller.getSnapshot().isListening).toBe(false);
  });

  it('leaves the microphone closed when the user declines', async () => {
    const bridge = makeNative();
    const loaded = load(bridge);
    jest
      .spyOn(loaded.permissions, 'request')
      .mockResolvedValue(loaded.permissions.RESULTS.DENIED);

    const controller = new loaded.module.CaptionsController();
    await settle();
    await controller.start();

    const state = controller.getSnapshot();
    expect(state.permission).toBe('denied');
    expect(state.isListening).toBe(false);
    expect(state.listening).toBe('denied');
    // Nothing was opened, so nothing may be started on the device.
    expect(bridge.startRecognition).not.toHaveBeenCalled();
  });

  it('does not tell a permanently refused user to try again', async () => {
    const loaded = load(makeNative());
    jest
      .spyOn(loaded.permissions, 'request')
      .mockResolvedValue(loaded.permissions.RESULTS.NEVER_ASK_AGAIN);

    const controller = new loaded.module.CaptionsController();
    await settle();
    await controller.start();

    const state = controller.getSnapshot();
    expect(state.permission).toBe('blocked');
    expect(state.error).toContain('Settings');
    // "Try again" would be a lie: only a system setting can undo this.
    expect(state.error).not.toMatch(/try again/i);
  });
});

/* ------------------------------------------------------------------ the lines */

describe('the transcript', () => {
  it('keeps the origin of every line', async () => {
    const { module } = load(makeNative());
    const controller = new module.CaptionsController();
    await settle();

    controller.addTypedLine('typed by hand');
    controller.addGloveLine('read from the glove');

    expect(controller.getSnapshot().lines.map((line) => line.source)).toEqual([
      'typed',
      'glove',
    ]);
  });

  it('does not add a line for whitespace', async () => {
    const { module } = load(makeNative());
    const controller = new module.CaptionsController();
    await settle();

    controller.addTypedLine('   \n\t ');
    expect(controller.getSnapshot().lines).toHaveLength(0);
  });

  it('keeps only the most recent lines', async () => {
    const { module } = load(makeNative());
    const controller = new module.CaptionsController();
    await settle();

    const cap = module.MAX_CAPTION_LINES;
    for (let i = 0; i < cap + 10; i += 1) {
      controller.addTypedLine(`line ${i}`);
    }

    const lines = controller.getSnapshot().lines;
    expect(lines).toHaveLength(cap);
    // The survivors are the newest, and the oldest are gone.
    expect(lines[lines.length - 1]?.text).toBe(`line ${cap + 9}`);
    expect(lines[0]?.text).toBe('line 10');
  });
});

/* -------------------------------------------------------------- the listening */

describe('while the microphone is open', () => {
  /** Grants the permission and returns a controller already listening. */
  async function listening(bridge: FakeNative): Promise<Captions> {
    const loaded = load(bridge);
    jest
      .spyOn(loaded.permissions, 'request')
      .mockResolvedValue(loaded.permissions.RESULTS.GRANTED);

    const controller = new loaded.module.CaptionsController();
    await settle();
    await controller.start();
    return controller;
  }

  it('shows words still being revised without committing them', async () => {
    jest.useFakeTimers();
    const bridge = makeNative({
      getTranscript: jest.fn(async () => ({
        isListening: true,
        partial: 'hel',
        finalText: '',
        error: null,
        sessionId: 1,
      })),
    });

    const controller = await listening(bridge);
    expect(controller.getSnapshot().isListening).toBe(true);

    await jest.advanceTimersByTimeAsync(200);

    const state = controller.getSnapshot();
    expect(state.interim).toBe('hel');
    // Interim text is not a line. An utterance the service may still rewrite is
    // not something the user should find in their transcript.
    expect(state.lines).toHaveLength(0);
  });

  it('commits a settled utterance once, not once per poll', async () => {
    jest.useFakeTimers();
    const bridge = makeNative({
      getTranscript: jest.fn(async () => ({
        isListening: true,
        partial: '',
        finalText: 'good morning',
        error: null,
        sessionId: 1,
      })),
    });

    const controller = await listening(bridge);

    await jest.advanceTimersByTimeAsync(200);
    await jest.advanceTimersByTimeAsync(200);
    await jest.advanceTimersByTimeAsync(200);

    const lines = controller.getSnapshot().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('good morning');
    expect(lines[0]?.source).toBe('microphone');
  });

  it('stops claiming to listen when the recogniser stops reporting', async () => {
    jest.useFakeTimers();
    const bridge = makeNative({ getTranscript: jest.fn(async () => null) });

    const controller = await listening(bridge);
    await jest.advanceTimersByTimeAsync(200);

    const state = controller.getSnapshot();
    expect(state.isListening).toBe(false);
    expect(state.listening).toBe('error');
    expect(state.error).toContain('stopped reporting');

    // And the poll is gone: a timer that outlives the microphone is a battery
    // cost with nothing to show for it.
    const before = bridge.getTranscript.mock.calls.length;
    await jest.advanceTimersByTimeAsync(1000);
    expect(bridge.getTranscript.mock.calls.length).toBe(before);
  });

  it('takes the microphone down when the platform reports an error', async () => {
    jest.useFakeTimers();
    const bridge = makeNative({
      getTranscript: jest.fn(async () => ({
        isListening: false,
        partial: '',
        finalText: '',
        error: 'No match.',
        sessionId: 1,
      })),
    });

    const controller = await listening(bridge);
    await jest.advanceTimersByTimeAsync(200);

    const state = controller.getSnapshot();
    expect(state.listening).toBe('error');
    expect(state.isListening).toBe(false);
    expect(state.error).toBe('No match.');
  });

  it('closes the microphone through the bridge when stopped', async () => {
    jest.useFakeTimers();
    const bridge = makeNative();
    const controller = await listening(bridge);

    await controller.stop();

    expect(bridge.stopRecognition).toHaveBeenCalled();
    expect(controller.getSnapshot().isListening).toBe(false);
    expect(controller.getSnapshot().listening).toBe('idle');
  });
});
