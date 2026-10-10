import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { MockTransport } from '../ble/mockTransport';
import type { GloveTransport, GloveSide, TransportStatus } from '../ble/types';
import { DEFAULT_PROFILE_ID, findProfile, UnimplementedRecogniser } from '../recognition';
import type { SignLanguageProfile } from '../recognition';
import { createDemoCalibration, type CalibrationProfile } from '../sensors/calibration';
import { createProcessingPipeline } from '../sensors/processing';
import type { RawSample, SensorSample } from '../sensors/types';
import { UnavailableSpeaker } from '../speech';
import { createAsyncStorage, type Storage } from '../storage';

/** How often the UI is allowed to re-render from the sample stream. */
const UI_SAMPLE_HZ = 12;

export interface AppStateValue {
  readonly transport: GloveTransport;
  readonly status: TransportStatus;
  readonly storage: Storage;
  readonly profile: SignLanguageProfile;
  readonly calibration: CalibrationProfile;
  /** Latest processed sample, or null before the first frame. */
  readonly sample: SensorSample | null;
  /** True when on-screen readings are simulated (Demo Mode). */
  readonly isDemo: boolean;
  readonly recognitionAvailable: boolean;
  readonly recognitionUnavailableReason: string | null;
  readonly speechAvailable: boolean;
  readonly speechUnavailableReason: string | null;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export interface AppStateProviderProps {
  children: React.ReactNode;
  /** Injected in tests to avoid timers and native modules. */
  transport?: GloveTransport;
  storage?: Storage;
  side?: GloveSide;
}

/**
 * Single source of truth for the app's runtime objects.
 *
 * The transport is constructed here and disposed on unmount, which is what
 * keeps the mock's interval from leaking across a fast refresh.
 */
export function AppStateProvider({
  children,
  transport,
  storage,
  side = 'right',
}: AppStateProviderProps): React.JSX.Element {
  const transportRef = useRef<GloveTransport | null>(null);
  if (transportRef.current === null) {
    transportRef.current = transport ?? new MockTransport(side);
  }
  const activeTransport = transportRef.current;

  const storageRef = useRef<Storage | null>(null);
  if (storageRef.current === null) {
    storageRef.current = storage ?? createAsyncStorage();
  }
  const activeStorage = storageRef.current;

  const [status, setStatus] = useState<TransportStatus>(activeTransport.getStatus());
  const [sample, setSample] = useState<SensorSample | null>(null);

  const calibration = useMemo(() => createDemoCalibration(side), [side]);
  const profile = useMemo(
    () => findProfile(DEFAULT_PROFILE_ID) ?? { id: DEFAULT_PROFILE_ID, name: 'Unknown' } as SignLanguageProfile,
    [],
  );

  const recogniser = useMemo(() => new UnimplementedRecogniser(profile), [profile]);
  const speaker = useMemo(() => new UnavailableSpeaker(), []);

  useEffect(() => {
    const unsubscribeStatus = activeTransport.onStatusChange(setStatus);
    return unsubscribeStatus;
  }, [activeTransport]);

  useEffect(() => {
    const pipeline = createProcessingPipeline(calibration);
    let lastEmit = 0;

    const unsubscribe = activeTransport.subscribe((raw: RawSample) => {
      const now = Date.now();
      // Throttle UI updates. Processing still runs per sample; only the render
      // is rate-limited, which keeps a 20 Hz stream from forcing 20 renders.
      if (now - lastEmit < 1000 / UI_SAMPLE_HZ) return;
      lastEmit = now;
      setSample(pipeline.process(raw));
    });

    return () => {
      unsubscribe();
      pipeline.reset();
    };
  }, [activeTransport, calibration]);

  useEffect(() => {
    return () => {
      const disposable = activeTransport as GloveTransport & { dispose?: () => void };
      disposable.dispose?.();
    };
  }, [activeTransport]);

  const value = useMemo<AppStateValue>(
    () => ({
      transport: activeTransport,
      status,
      storage: activeStorage,
      profile,
      calibration,
      sample,
      isDemo: activeTransport.isSynthetic,
      recognitionAvailable: recogniser.isAvailable,
      recognitionUnavailableReason: recogniser.unavailableReason,
      speechAvailable: speaker.isAvailable,
      speechUnavailableReason: speaker.unavailableReason,
    }),
    [activeTransport, status, activeStorage, profile, calibration, sample, recogniser, speaker],
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
