import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState as RNAppState } from 'react-native';

import type { AppPreferences } from './preferences';
import { DEFAULT_PREFERENCES } from './preferences';
import { GloveController, type GloveSnapshot } from '../ble/controller';
import { MockTransport } from '../ble/mockTransport';
import type { GloveSide, GloveTransport, SuspendableTransport } from '../ble/types';
import { DEFAULT_PROFILE_ID, findProfile, UnimplementedRecogniser } from '../recognition';
import type { SignLanguageProfile } from '../recognition';
import type { Recogniser } from '../recognition';
import { planInput, type InputAvailability, type InputPlan } from '../recognition/input';
import { evaluateRecognition, type RecognitionOutcome } from '../recognition/outcome';
import { useViewerFrame } from '../hands/usePose';
import type { PoseSource } from '../hands/pose';
import type { ViewerFrame } from '../hands/viewer';
import { createDemoCalibration, type CalibrationProfile } from '../sensors/calibration';
import { PoseStream } from '../hands/stream';
import { UnavailableSpeaker } from '../speech';
import type { Speaker } from '../speech';
import { createAsyncStorage, type Storage } from '../storage';
import { UnimplementedTranslator, type Translator } from '../translation';

export interface AppStateValue {
  readonly storage: Storage;
  readonly preferences: AppPreferences;
  readonly updatePreferences: (patch: Partial<AppPreferences>) => void;
  /** One controller per glove. Stable identities for the process lifetime. */
  readonly controllers: Readonly<Record<GloveSide, GloveController>>;
  /**
   * One pose stream per glove.
   *
   * Held here rather than in the viewer component so that every reader of a
   * hand's pose shares a single smoothing filter — see `hands/usePose.ts`.
   */
  readonly poseStreams: Readonly<Record<GloveSide, PoseStream>>;
  readonly profile: SignLanguageProfile;
  readonly calibration: Readonly<Record<GloveSide, CalibrationProfile>>;
  readonly recogniser: Recogniser;
  readonly speaker: Speaker;
  readonly translator: Translator;
  readonly recognitionAvailable: boolean;
  readonly recognitionUnavailableReason: string | null;
  readonly speechAvailable: boolean;
  readonly speechUnavailableReason: string | null;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export interface AppStateProviderProps {
  children: React.ReactNode;
  /** Right-hand transport. Injected in tests to avoid timers and native modules. */
  transport?: GloveTransport;
  /** Left-hand transport. Defaults to a simulator for the left hand. */
  leftTransport?: GloveTransport;
  storage?: Storage;
}

/**
 * Single source of truth for the app's runtime objects.
 *
 * ## What is deliberately *not* in the context value
 *
 * Live sensor readings. The context carries stable references only — the two
 * controllers, storage, preferences, the recogniser — so a component that
 * reads context does not re-render when a glove emits a frame. Components that
 * need live values subscribe to their own controller through `useGlove`, which
 * means a 20 Hz stream only ever re-renders the handful of views that display
 * numbers.
 *
 * ## Cleanup
 *
 * Both controllers are disposed on unmount, which is what keeps a simulator's
 * interval from outliving the app or leaking across a fast refresh. Streaming
 * is additionally suspended while the app is backgrounded: the link is kept,
 * but no frames are produced, so a glove is not silently disconnected while
 * the user is elsewhere.
 */
export function AppStateProvider({
  children,
  transport,
  leftTransport,
  storage,
}: AppStateProviderProps): React.JSX.Element {
  const controllersRef = useRef<Record<GloveSide, GloveController> | null>(null);
  if (controllersRef.current === null) {
    controllersRef.current = {
      right: new GloveController('right', transport ?? new MockTransport('right')),
      left: new GloveController(
        'left',
        leftTransport ?? new MockTransport('left', { sideOffsetMs: 0 }),
      ),
    };
  }
  const controllers = controllersRef.current;

  const poseStreamsRef = useRef<Record<GloveSide, PoseStream> | null>(null);
  if (poseStreamsRef.current === null) {
    poseStreamsRef.current = {
      right: new PoseStream('right'),
      left: new PoseStream('left'),
    };
  }
  const poseStreams = poseStreamsRef.current;

  const storageRef = useRef<Storage | null>(null);
  if (storageRef.current === null) {
    storageRef.current = storage ?? createAsyncStorage();
  }
  const activeStorage = storageRef.current;

  const [preferences, setPreferencesState] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;

  const updatePreferences = useCallback(
    (patch: Partial<AppPreferences>) => {
      const next = { ...prefsRef.current, ...patch };
      prefsRef.current = next;
      setPreferencesState(next);
      // Fire-and-forget: the UI has already moved, and a failed write only
      // costs the preference on next launch.
      void activeStorage.setPreferences(next).catch(() => undefined);
    },
    [activeStorage],
  );

  useEffect(() => {
    let cancelled = false;
    activeStorage
      .getPreferences()
      .then((stored) => {
        if (cancelled || stored === null) return;
        prefsRef.current = stored;
        setPreferencesState(stored);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeStorage]);

  const calibration = useMemo<Readonly<Record<GloveSide, CalibrationProfile>>>(
    () => ({ left: createDemoCalibration('left'), right: createDemoCalibration('right') }),
    [],
  );

  const profile = useMemo(
    () =>
      findProfile(preferences.signProfileId) ??
      findProfile(DEFAULT_PROFILE_ID) ?? {
        id: DEFAULT_PROFILE_ID,
        name: 'Unknown',
      } as SignLanguageProfile,
    [preferences.signProfileId],
  );

  const recogniser = useMemo(() => new UnimplementedRecogniser(profile), [profile]);
  const speaker = useMemo(() => new UnavailableSpeaker(), []);
  const translator = useMemo(() => new UnimplementedTranslator(), []);

  // Dispose on unmount so no simulator interval survives the provider.
  useEffect(() => {
    const active = controllers;
    const streams = poseStreams;
    return () => {
      active.left.dispose();
      active.right.dispose();
      streams.left.reset();
      streams.right.reset();
    };
  }, [controllers, poseStreams]);

  /**
   * Suspend frame production while backgrounded.
   *
   * Only transports that declare themselves suspendable are paused; anything
   * else is left alone rather than being disconnected on the user's behalf.
   */
  useEffect(() => {
    const subscription = RNAppState.addEventListener('change', (next) => {
      const paused = next !== 'active';
      controllers.left.pause(paused);
      controllers.right.pause(paused);
    });

    return () => {
      subscription.remove();
    };
  }, [controllers]);

  const value = useMemo<AppStateValue>(
    () => ({
      storage: activeStorage,
      preferences,
      updatePreferences,
      controllers,
      poseStreams,
      profile,
      calibration,
      recogniser,
      speaker,
      translator,
      recognitionAvailable: recogniser.isAvailable,
      recognitionUnavailableReason: recogniser.unavailableReason,
      speechAvailable: speaker.isAvailable,
      speechUnavailableReason: speaker.unavailableReason,
    }),
    [
      activeStorage,
      preferences,
      updatePreferences,
      controllers,
      poseStreams,
      profile,
      calibration,
      recogniser,
      speaker,
      translator,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (value === null) {
    throw new Error('useAppState must be used inside an <AppStateProvider>');
  }
  return value;
}

/**
 * Live snapshot for one glove.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: it reads the
 * store during render, so there is no frame where the UI shows a stale value
 * after a change, and no subscription gap that could drop an update.
 */
export function useGlove(side: GloveSide): GloveSnapshot {
  const { controllers } = useAppState();
  const controller = controllers[side];

  const subscribe = useCallback(
    (onChange: () => void) => controller.subscribe(onChange),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

export interface GloveActions {
  scan: () => Promise<void>;
  connect: (deviceId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  retry: () => Promise<void>;
}

/** The imperative actions for one glove. Stable across renders. */
export function useGloveActions(side: GloveSide): GloveActions {
  const { controllers } = useAppState();
  const controller = controllers[side];

  return useMemo(
    () => ({
      scan: async () => {
        await controller.scan();
      },
      connect: async (deviceId: string) => {
        await controller.connect(deviceId);
      },
      disconnect: async () => {
        await controller.disconnect();
      },
      retry: async () => {
        await controller.retry();
      },
    }),
    [controller],
  );
}

/**
 * Where the numbers on screen came from, across both gloves at once.
 *
 * A single glove cannot be `mixed`, but the pair can be — one real glove and one
 * simulator is a configuration this app permits, and calling that either `real`
 * or `simulated` would misdescribe half of it. `mixed` exists so that case has
 * an honest name instead of being rounded to the more flattering one.
 */
export type DataProvenance = 'real' | 'simulated' | 'mixed' | 'none';

/**
 * Everything the Dashboard's live experience needs, from one place.
 *
 * ## Why this is one hook and not four
 *
 * The screen it feeds — one result panel, one viewer, one set of finger
 * readings — has exactly one state, so it is computed once. The previous
 * implementation asked for a hand first and then evaluated only that hand, which
 * is why the Dashboard needed a selector and why a two-handed sign could never
 * have been recognised even with a model present.
 *
 * ## What it deliberately does not do
 *
 * It does not decide anything the vocabulary should decide. Which hands are fed
 * to the recogniser comes from `planInput`, which reads the profile's
 * vocabulary; the connection state only says which hands are *available*. If a
 * profile's signs are single-hand, this never concatenates two hands into one
 * input to look more capable than it is.
 */
export interface LiveTranslation {
  readonly plan: InputPlan;
  readonly outcome: RecognitionOutcome;
  readonly availability: InputAvailability;
  /** True per glove when that glove is actually delivering frames. */
  readonly live: Readonly<Record<GloveSide, boolean>>;
  /** The renderer input for each glove, resting when a glove has no data. */
  readonly frames: Readonly<Record<GloveSide, ViewerFrame>>;
  readonly provenance: DataProvenance;
}

export function useLiveTranslation(): LiveTranslation {
  const { recogniser, profile } = useAppState();

  const left = useGlove('left');
  const right = useGlove('right');
  const leftFrame = useViewerFrame('left');
  const rightFrame = useViewerFrame('right');

  const availability = useMemo<InputAvailability>(
    () => ({
      connected: {
        left: left.link.kind === 'connected',
        right: right.link.kind === 'connected',
      },
      streaming: { left: left.calibrated !== null, right: right.calibrated !== null },
    }),
    [left.link.kind, left.calibrated, right.link.kind, right.calibrated],
  );

  const plan = useMemo(() => planInput(profile, availability), [profile, availability]);

  const samples = useMemo(
    () => ({ left: left.calibrated, right: right.calibrated }),
    [left.calibrated, right.calibrated],
  );

  const outcome = useMemo(
    () => evaluateRecognition(recogniser, profile, plan, samples),
    [recogniser, profile, plan, samples],
  );

  const frames = useMemo(
    () => ({ left: leftFrame, right: rightFrame }),
    [leftFrame, rightFrame],
  );

  const live = useMemo(
    () => ({
      left: availability.streaming.left,
      right: availability.streaming.right,
    }),
    [availability],
  );

  const provenance = useMemo<DataProvenance>(() => {
    const sources: readonly PoseSource[] = (['left', 'right'] as const)
      .filter((side) => availability.streaming[side])
      .map((side) => (side === 'left' ? left.source : right.source));

    if (sources.length === 0) return 'none';
    if (sources.every((source) => source === 'real')) return 'real';
    if (sources.every((source) => source === 'simulated')) return 'simulated';
    return 'mixed';
  }, [availability, left.source, right.source]);

  return { plan, outcome, availability, live, frames, provenance };
}

export type { SuspendableTransport };
