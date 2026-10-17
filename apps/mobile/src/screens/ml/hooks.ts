/**
 * Reading the learning centre from a screen.
 *
 * The centre is a store with `subscribe`/`getSnapshot`, so every screen reads it
 * through `useSyncExternalStore` and re-renders only when it actually changes.
 * Three hooks, because there are three different things to read and conflating
 * them would re-render a list of windows every time a capture phase ticked.
 *
 * `useMl` alone returns the object and subscribes to nothing — for calling
 * methods, so an action does not re-render the screen that triggered it.
 */
import { useSyncExternalStore } from 'react';

import { useAppState } from '../../app/AppState';
import type { MlCentre, MlCentreSnapshot, MlSnapshot } from '../../ml';

/** The centre itself. Does not subscribe, so it is safe in an event handler. */
export function useMl(): MlCentre {
  return useAppState().ml;
}

/**
 * The centre's live state: capture phase, live inference, active model, training.
 *
 * Changes many times a second while a window is being recorded, so only the
 * component that displays a count should call this.
 */
export function useMlSnapshot(): MlCentreSnapshot {
  const ml = useMl();
  return useSyncExternalStore(ml.subscribe, ml.getSnapshot, ml.getSnapshot);
}

/**
 * The stored data: signs, windows, sessions, models and settings.
 *
 * Re-read on the same notification as `useMlSnapshot`, but returned separately
 * because these are the values a list renders and they change only when
 * something is written.
 */
export function useMlData(): MlSnapshot {
  const ml = useMl();
  useSyncExternalStore(ml.subscribe, ml.getSnapshot, ml.getSnapshot);
  return ml.dataset;
}
