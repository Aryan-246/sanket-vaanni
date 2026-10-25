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
import { DEFAULT_PROFILE_ID, findProfile, MlRecogniser, UnimplementedRecogniser } from '../recognition';
import type { SignLanguageProfile } from '../recognition';
import type { Recogniser } from '../recognition';
import { planInput, type InputAvailability, type InputPlan } from '../recognition/input';
import { evaluateRecognition, type RecognitionOutcome } from '../recognition/outcome';
import { useViewerFrame } from '../hands/usePose';
import { createDefaultNeutralPose, type PoseSource } from '../hands/pose';
import type { ViewerFrame } from '../hands/viewer';
import {
  createDemoCalibration,
  createHardwareDefaultCalibration,
  isCalibrationUsable,
  type CalibrationProfile,
} from '../sensors/calibration';
import {
  createDefaultOrientationProfile,
  type OrientationCalibrationProfile,
} from '../sensors/orientationCalibration';
import { PoseStream } from '../hands/stream';
import { createSpeaker } from '../speech/createSpeaker';
import type { Speaker, SpeechState } from '../speech';
import { SpeechController } from '../speech';
import { CaptionsController } from '../captions';
import type { CaptionsState } from '../captions';
import { MaintenanceController } from '../maintenance';
import type { MaintenanceState } from '../maintenance';
import { createIdFactory, MlCentre } from '../ml';
import { UnavailablePicker } from '../ml/media';
import { AnnouncementsReader } from '../announcements';
import type { AnnouncementsState } from '../announcements';
import { PushController } from '../notifications';
import type { PushState } from '../notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiClient } from '../api/client';
import { createAsyncStorage, type Storage } from '../storage';
import { DirectVocabularyTranslator, UnimplementedTranslator, type Translator } from '../translation';

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
  readonly updateCalibration: (side: GloveSide, profile: CalibrationProfile) => Promise<void>;
  readonly orientationCalibration: Readonly<Record<GloveSide, OrientationCalibrationProfile>>;
  readonly updateOrientationCalibration: (side: GloveSide, profile: OrientationCalibrationProfile) => Promise<void>;
  readonly recogniser: Recogniser;
  readonly speaker: Speaker;
  /**
   * Speech output state: whether audio is genuinely playing, what was last
   * spoken, and why the last attempt failed. One writer, many readers.
   */
  readonly speech: SpeechController;
  /**
   * The running transcript: what the microphone heard, what the glove produced,
   * and what was typed, each line tagged with which of the three it came from.
   */
  readonly captions: CaptionsController;
  /**
   * Maintenance mode, as the database last reported it.
   *
   * Read from `app_settings`, which signed-out clients may read, because the
   * whole purpose is to stop a sign-in and a check that runs after
   * authentication cannot do that. See `maintenance/controller.ts`.
   */
  readonly maintenance: MaintenanceController;
  /**
   * Notices — published announcements, and which of them this device dismissed.
   *
   * Read from `announcements` under the policy that makes published rows readable
   * by `anon` as well as `authenticated`, so a guest who has never signed in
   * still sees them. It cannot send anything: nothing dispatches an announcement
   * as a notification, and `components/NoticesCard.tsx` says so on screen. See
   * `announcements/reader.ts`.
   */
  readonly announcements: AnnouncementsReader;
  /**
   * Push notifications.
   *
   * Holds this install's Firebase registration token and which account it is
   * recorded against. It cannot send a notification — see
   * `notifications/controller.ts` for why that is a server operation and not a
   * client one.
   */
  readonly push: PushController;
  /**
   * The learning centre.
   *
   * Owns the sample store, the window recorder and live inference, and is
   * subscribed to every calibrated frame from both gloves. It is constructed
   * here rather than in the screen for the same reason the glove controllers
   * are: the recorder has to survive the screen being closed, or a window being
   * recorded would be thrown away by navigating away from it.
   *
   * It does not know which account is signed in — the account provider is
   * mounted *inside* this one. `MlAccountSync` in `RootNavigator.tsx` tells it,
   * the same way `PushAccountSync` tells the push controller.
   */
  readonly ml: MlCentre;
  readonly translator: Translator;
  readonly recognitionAvailable: boolean;
  readonly recognitionUnavailableReason: string | null;
  /*
   * There is no `speechAvailable` here on purpose. Whether the device can speak
   * is answered asynchronously by the platform engine, so a value captured when
   * this provider renders would go stale the moment the engine came up — and it
   * would go stale in the direction that makes a working feature look broken.
   * Components read `useSpeechState()`, which subscribes to the live answer.
   */
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
    const leftCal =
      leftTransport && !leftTransport.isSynthetic
        ? createHardwareDefaultCalibration('left')
        : createDemoCalibration('left');
    const rightCal =
      transport && !transport.isSynthetic
        ? createHardwareDefaultCalibration('right')
        : createDemoCalibration('right');

    controllersRef.current = {
      right: new GloveController('right', transport ?? new MockTransport('right'), {
        calibration: rightCal,
      }),
      left: new GloveController(
        'left',
        leftTransport ?? new MockTransport('left', { sideOffsetMs: 0 }),
        { calibration: leftCal },
      ),
    };
  }
  const controllers = controllersRef.current;

  const poseStreamsRef = useRef<Record<GloveSide, PoseStream> | null>(null);
  if (poseStreamsRef.current === null) {
    poseStreamsRef.current = {
      right: new PoseStream('right', { neutral: createDefaultNeutralPose('right') }),
      left: new PoseStream('left', { neutral: createDefaultNeutralPose('left') }),
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

  const [calibrationState, setCalibrationState] = useState<Readonly<Record<GloveSide, CalibrationProfile>>>(() => ({
    left:
      leftTransport && !leftTransport.isSynthetic
        ? createHardwareDefaultCalibration('left')
        : createDemoCalibration('left'),
    right:
      transport && !transport.isSynthetic
        ? createHardwareDefaultCalibration('right')
        : createDemoCalibration('right'),
  }));

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      activeStorage.getCalibration('left'),
      activeStorage.getCalibration('right'),
    ])
      .then(([storedLeft, storedRight]) => {
        if (cancelled) return;
        setCalibrationState((prev) => {
          const next = { ...prev };
          if (storedLeft && isCalibrationUsable(storedLeft)) {
            next.left = storedLeft;
            controllers.left.setCalibration(storedLeft);
          } else if (storedLeft) {
            // Self-heal: stored calibration was corrupted or zero-span, replace with hardware default
            const clean = createHardwareDefaultCalibration('left');
            next.left = clean;
            controllers.left.setCalibration(clean);
            activeStorage.setCalibration(clean).catch(() => undefined);
          }
          if (storedRight && isCalibrationUsable(storedRight)) {
            next.right = storedRight;
            controllers.right.setCalibration(storedRight);
          } else if (storedRight) {
            // Self-heal: stored calibration was corrupted or zero-span, replace with hardware default
            const clean = createHardwareDefaultCalibration('right');
            next.right = clean;
            controllers.right.setCalibration(clean);
            activeStorage.setCalibration(clean).catch(() => undefined);
          }
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeStorage, controllers]);

  const updateCalibration = useCallback(
    async (side: GloveSide, profile: CalibrationProfile) => {
      controllers[side].setCalibration(profile);
      setCalibrationState((prev) => ({
        ...prev,
        [side]: profile,
      }));
      await activeStorage.setCalibration(profile);
    },
    [activeStorage, controllers],
  );

  const [orientationCalibrationState, setOrientationCalibrationState] = useState<
    Readonly<Record<GloveSide, OrientationCalibrationProfile>>
  >(() => ({
    left: createDefaultOrientationProfile('left'),
    right: createDefaultOrientationProfile('right'),
  }));

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      activeStorage.getOrientationCalibration('left'),
      activeStorage.getOrientationCalibration('right'),
    ])
      .then(([storedLeft, storedRight]) => {
        if (cancelled) return;
        setOrientationCalibrationState((prev) => {
          const next = { ...prev };
          if (storedLeft) {
            next.left = storedLeft;
            poseStreams.left.setNeutral({
              fingers: [0, 0, 0, 0, 0],
              wrist: {
                pitch: (storedLeft.restPitch * Math.PI) / 180,
                roll: (storedLeft.restRoll * Math.PI) / 180,
                yaw: null,
              },
              pitchSign: storedLeft.pitchSign,
              rollSign: storedLeft.rollSign,
            });
          }
          if (storedRight) {
            next.right = storedRight;
            poseStreams.right.setNeutral({
              fingers: [0, 0, 0, 0, 0],
              wrist: {
                pitch: (storedRight.restPitch * Math.PI) / 180,
                roll: (storedRight.restRoll * Math.PI) / 180,
                yaw: null,
              },
              pitchSign: storedRight.pitchSign,
              rollSign: storedRight.rollSign,
            });
          }
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeStorage, poseStreams]);

  const updateOrientationCalibration = useCallback(
    async (side: GloveSide, profile: OrientationCalibrationProfile) => {
      poseStreams[side].setNeutral({
        fingers: [0, 0, 0, 0, 0],
        wrist: {
          pitch: (profile.restPitch * Math.PI) / 180,
          roll: (profile.restRoll * Math.PI) / 180,
          yaw: null,
        },
        pitchSign: profile.pitchSign,
        rollSign: profile.rollSign,
      });
      setOrientationCalibrationState((prev) => ({
        ...prev,
        [side]: profile,
      }));
      await activeStorage.setOrientationCalibration(profile);
    },
    [activeStorage, poseStreams],
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

  /**
   * The learning centre.
   *
   * Built once and held in a ref, like the glove controllers, rather than in a
   * `useMemo`. That is not a style choice: the recorder holds a session in
   * progress, and a dependency that changed while someone was recording would
   * construct a second centre and drop the windows the first one had collected.
   * The sign language is a *default* here and is kept in step by the effect
   * below, so changing it re-points the same centre instead of replacing it.
   */
  const mlRef = useRef<MlCentre | null>(null);
  if (mlRef.current === null) {
    mlRef.current = new MlCentre({
      storage: activeStorage,
      newId: createIdFactory(),
      now: () => Date.now(),
      defaultLanguageId: profile.id,
      sources: { left: controllers.left, right: controllers.right },
      gloveInfo: (side) => {
        const glove = controllers[side].getSnapshot();
        return {
          connected: glove.source !== 'none',
          real: !glove.synthetic,
          transportName: glove.transportName,
          calibrationVersion: controllers[side].getCalibration().version,
        };
      },
      picker: new UnavailablePicker(),
    });
  }
  const ml = mlRef.current;

  const recogniser = useMemo(() => new MlRecogniser(profile, ml), [profile, ml]);
  /**
   * The device's own speech engine where one exists, otherwise a speaker that
   * says why it cannot speak. Chosen at runtime, because whether a phone can
   * talk depends on the phone rather than on the build.
   */
  const speaker = useMemo(() => createSpeaker(), []);
  const translator = useMemo(() => new DirectVocabularyTranslator(), []);

  /**
   * Speech state, shared by everything that needs to know whether the app is
   * talking. See `speech/controller.ts` for why this is a store rather than a
   * piece of component state.
   */
  const speech = useMemo(() => new SpeechController(speaker), [speaker]);

  /**
   * Live captions. Constructed eagerly because it asks the platform — once —
   * whether a speech recognition service exists at all, and the Textboard needs
   * that answer the first time it is opened rather than after a probe.
   */
  const captions = useMemo(() => new CaptionsController(), []);

  /**
   * Maintenance mode.
   *
   * Constructed here and checked from an effect rather than a constructor, so
   * that building the provider has no side effect. The check runs from the
   * composed `useEffect` below, next to the other lifecycle work.
   */
  const maintenance = useMemo(() => new MaintenanceController(activeStorage), [activeStorage]);

  /**
   * Notices — the announcements an administrator has published.
   *
   * Constructed here, beside maintenance, because it is the same kind of thing: a
   * read of public server state that has to work before anyone signs in, cached
   * so an offline launch still knows what it last saw. It reads the database
   * directly under the announcements policy, not through the admin API — see
   * `../announcements/reader.ts` for why that is the only way a guest can see a
   * notice at all.
   */
  const announcements = useMemo(
    () => new AnnouncementsReader({ storage: activeStorage }),
    [activeStorage],
  );

  /**
   * Push notifications.
   *
   * Constructed eagerly, like captions, because its constructor is what asks the
   * platform whether Firebase exists in this build and attaches the listeners
   * for token rotation and notification taps. A notification tapped to launch
   * the app has to be read at start, not the first time somebody opens a
   * settings screen.
   *
   * It does not ask for permission here. Nothing is requested from the user
   * until they turn notifications on — see `notifications/controller.ts`.
   */
  const push = useMemo(() => new PushController({ storage: activeStorage }), [activeStorage]);

  // Dispose on unmount so no simulator interval survives the provider.
  useEffect(() => {
    const active = controllers;
    const streams = poseStreams;
    const speechController = speech;
    const captionsController = captions;
    const maintenanceController = maintenance;
    const pushController = push;
    const announcementsReader = announcements;
    const mlCentre = ml;
    return () => {
      active.left.dispose();
      active.right.dispose();
      streams.left.reset();
      streams.right.reset();
      // Stops any utterance in flight and drops subscribers, so a hot reload
      // does not leave the phone talking to a component that no longer exists.
      speechController.dispose();
      // Closes the microphone. A poll timer that outlived the provider would
      // keep reading a recogniser nobody is displaying.
      captionsController.dispose();
      maintenanceController.dispose();
      // Detaches the Firebase listeners. Leaving them attached across a hot
      // reload would deliver each message to every generation of the provider.
      pushController.dispose();
      // Drops the notice subscribers and stops any read in flight from writing
      // state into a provider that no longer exists.
      announcementsReader.dispose();
      // Detaches the frame taps. A listener left attached across a hot reload
      // would feed every generation of the centre the same frames.
      mlCentre.dispose();
    };
  }, [controllers, poseStreams, speech, captions, maintenance, push, announcements, ml]);

  /**
   * Reads the stored dataset, attaches the frame taps, and loads the live model.
   *
   * The centre keeps working while its screen is closed — a window being
   * recorded is not abandoned by navigating away — which is only true because
   * this runs at the provider rather than at the screen.
   */
  useEffect(() => {
    void ml.start();
  }, [ml]);

  /**
   * Keeps the centre pointed at the sign language the app is set to.
   *
   * The preference is the app's single answer to that question; the centre
   * having its own would let it file windows under a language the rest of the
   * app is not showing.
   */
  useEffect(() => {
    ml.setLanguage(profile.id);
  }, [ml, profile.id]);

  /**
   * Published Model Sync:
   * Fetches the globally published model from the backend for the active language profile.
   * If a new version is published and matches the language, auto-imports and activates it
   * for live glove inference on both Normal User and Guest clients.
   * Caches the package in AsyncStorage for offline resilience.
   */
  useEffect(() => {
    let cancelled = false;
    const syncPublishedModel = async () => {
      try {
        const cacheKey = `@sanket_vaanni:published_model_${profile.id}`;
        let modelPkgToImport: unknown = null;

        const res = await apiClient.getPublishedModel(profile.id);
        if (!cancelled && res.ok && res.data.published && res.data.modelPackage) {
          modelPkgToImport = res.data.modelPackage;
          void AsyncStorage.setItem(cacheKey, JSON.stringify(res.data.modelPackage)).catch(() => undefined);
        } else if (!cancelled) {
          const cachedStr = await AsyncStorage.getItem(cacheKey).catch(() => null);
          if (cachedStr) {
            try {
              modelPkgToImport = JSON.parse(cachedStr);
            } catch {
              // ignore parse failure
            }
          }
        }

        if (cancelled || !modelPkgToImport) return;

        const pkg = modelPkgToImport as { contract?: { version?: number; languageId?: string } };
        if (pkg.contract?.languageId !== profile.id) return;

        const existingModels = ml.store.getSnapshot().models;
        const alreadyPresent = existingModels.some(
          (m) =>
            m.languageId === profile.id &&
            (m.importedFrom?.sourceVersion === pkg.contract?.version ||
              (m.status === 'active' && m.importedFrom?.sourceVersion === pkg.contract?.version)),
        );

        if (!alreadyPresent) {
          const importRes = await ml.store.importModel(modelPkgToImport);
          if (importRes.ok) {
            await ml.activate(importRes.data.summary.id);
          }
        }
      } catch {
        // network or storage failure - silent graceful fallback
      }
    };

    void syncPublishedModel();

    return () => {
      cancelled = true;
    };
  }, [ml, profile.id]);

  /**
   * The maintenance check, and the re-check on resume.
   *
   * Resume is handled here rather than in the gate component because the answer
   * belongs to the whole app: a user who leaves mid-session and returns after an
   * operator has closed the app must meet the closed app, not a screen that
   * decided once at launch and never asked again.
   */
  useEffect(() => {
    void maintenance.refresh();
    /*
     * Notices are read here too, on the same schedule and for the same reason: a
     * notice published while the app was backgrounded should be there when the
     * user comes back, not only after they find Settings and reload it. The two
     * share one listener rather than each adding their own, so returning to the
     * app makes one pass over the effects rather than two independent ones.
     */
    void announcements.refresh();

    const subscription = RNAppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void maintenance.refresh();
        void announcements.refresh();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [maintenance, announcements]);

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
      calibration: calibrationState,
      updateCalibration,
      orientationCalibration: orientationCalibrationState,
      updateOrientationCalibration,
      recogniser,
      speaker,
      speech,
      captions,
      maintenance,
      announcements,
      push,
      ml,
      translator,
      recognitionAvailable: recogniser.isAvailable,
      recognitionUnavailableReason: recogniser.unavailableReason,
    }),
    [
      activeStorage,
      preferences,
      updatePreferences,
      controllers,
      poseStreams,
      profile,
      calibrationState,
      updateCalibration,
      orientationCalibrationState,
      updateOrientationCalibration,
      recogniser,
      speaker,
      speech,
      captions,
      maintenance,
      announcements,
      push,
      ml,
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

/**
 * Live speech state.
 *
 * Same `useSyncExternalStore` shape as `useGlove`, and for the same reason: a
 * component that shows whether the app is talking must not render a stale
 * answer, and must not miss a transition between "started" and "finished".
 */
export function useSpeechState(): SpeechState {
  const { speech } = useAppState();
  return useSyncExternalStore(speech.subscribe, speech.getSnapshot);
}

/**
 * Live caption state.
 *
 * Separate from `useSpeechState` rather than folded into it because the two
 * change at completely different rates: captions update several times a second
 * while the microphone is open, and speech changes twice per utterance. One
 * combined subscription would re-render the speech controls on every interim
 * word.
 */
export function useCaptionsState(): CaptionsState {
  const { captions } = useAppState();
  return useSyncExternalStore(captions.subscribe, captions.getSnapshot, captions.getSnapshot);
}

/**
 * Live push notification state.
 *
 * A subscription rather than a value read once, because almost everything in it
 * arrives asynchronously and from outside the app: permission comes back from
 * the system dialog, the token comes back from Firebase, and a token can be
 * rotated by Google at any time while the app is running. A screen that read
 * this once would show "no token" forever to a user whose token had just
 * arrived.
 */
export function usePushState(): PushState {
  const { push } = useAppState();
  return useSyncExternalStore(push.subscribe, push.getSnapshot, push.getSnapshot);
}

/**
 * Live maintenance state.
 *
 * Same store shape as the two above. Read by the gate that closes the app, by
 * the account sheet so that a sign-in respects it, and by Settings so an
 * administrator can see what the app currently believes.
 */
export function useMaintenanceState(): MaintenanceState {
  const { maintenance } = useAppState();
  return useSyncExternalStore(
    maintenance.subscribe,
    maintenance.getSnapshot,
    maintenance.getSnapshot,
  );
}

/**
 * Live notice state.
 *
 * Same store shape again. A subscription rather than a value read once, because
 * the answer arrives asynchronously — and because a failed read replaces notices
 * the user was reading with a dated copy of the same list, which only a
 * subscriber will see.
 */
export function useNoticesState(): AnnouncementsState {
  const { announcements } = useAppState();
  return useSyncExternalStore(
    announcements.subscribe,
    announcements.getSnapshot,
    announcements.getSnapshot,
  );
}

export interface GloveActions {
  scan: () => Promise<void>;
  connect: (deviceId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  retry: () => Promise<void>;
  sendOledCommand?: (command: Record<string, unknown>) => Promise<void>;
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
      sendOledCommand: async (command: Record<string, unknown>) => {
        await controller.sendOledCommand(command);
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
