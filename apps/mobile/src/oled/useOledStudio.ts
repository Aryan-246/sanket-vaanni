/**
 * OLED Studio state: the layout, the presets, and their persistence.
 *
 * ## Why the writes are debounced
 *
 * Editing text means one keystroke per character, and each keystroke changes the
 * layout. Writing on every change would hit AsyncStorage dozens of times a
 * second while the user types, which is wasted work on a phone that is also
 * streaming sensor frames. Writes are therefore coalesced, and flushed
 * immediately on unmount so switching tabs cannot lose the last edit.
 *
 * ## Why nothing here has a timer that runs on its own
 *
 * The loading animation's frame counter lives in the canvas, not here. This hook
 * produces a layout; the canvas decides how often to redraw it, and only while
 * the OLED tab is the active one — because only the active tab is mounted.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  defaultLayout,
  MAX_PRESETS,
  oledReducer,
  parseLayout,
  parsePresets,
  type OledAction,
  type OledLayout,
  type OledPreset,
} from './layout';
import { featureKeys, type Storage } from '../storage';

/** How long a burst of edits is coalesced before a write. */
export const PERSIST_DEBOUNCE_MS = 400;

/**
 * `Omit` applied across a union member by member.
 *
 * Plain `Omit<OledAction, 'atMs'>` distributes over the union's *common* keys
 * only, which for a discriminated union means it collapses to almost nothing —
 * every member would lose `type` and none of the specific fields would survive.
 * This keeps each variant intact with just the timestamp removed, so a caller
 * cannot pass an `atMs` and cannot omit one either.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Actions whose `atMs` this hook supplies. */
export type OledIntent = DistributiveOmit<OledAction, 'atMs'>;

export interface OledStudio {
  readonly layout: OledLayout;
  readonly presets: readonly OledPreset[];
  /**
   * False until storage has been read once. The studio renders the default
   * layout meanwhile rather than blocking, on the same reasoning as the launch
   * gate: a spinner over an editor that already has safe defaults is worse than
   * the editor.
   */
  readonly isLoaded: boolean;
  readonly run: (intent: OledIntent) => void;
  readonly savePreset: (name: string) => void;
  readonly applyPreset: (id: string) => void;
  readonly deletePreset: (id: string) => void;
}

export function useOledStudio(storage: Storage, now: () => number = Date.now): OledStudio {
  const [layout, setLayout] = useState<OledLayout>(defaultLayout);
  const [presets, setPresets] = useState<readonly OledPreset[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Mirrors so callbacks can read the current value without being recreated on
  // every edit — which would defeat the memoisation on every downstream row.
  const layoutRef = useRef(layout);
  const presetsRef = useRef(presets);
  presetsRef.current = presets;

  const pendingRef = useRef<OledLayout | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const write = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const value = pendingRef.current;
    pendingRef.current = null;
    if (value === null) return;
    void storage.setJson(featureKeys.oledLayout, value).catch(() => undefined);
  }, [storage]);

  const persist = useCallback(
    (next: OledLayout) => {
      pendingRef.current = next;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(write, PERSIST_DEBOUNCE_MS);
    },
    [write],
  );

  // Load once, then flush whatever is outstanding when the tab goes away.
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      storage.getJson<unknown>(featureKeys.oledLayout),
      storage.getJson<unknown>(featureKeys.oledPresets),
    ])
      .then(([storedLayout, storedPresets]) => {
        if (cancelled) return;
        const next = parseLayout(storedLayout);
        layoutRef.current = next;
        setLayout(next);
        setPresets(parsePresets(storedPresets));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsLoaded(true);
      });

    return () => {
      cancelled = true;
      write();
    };
  }, [storage, write]);

  const run = useCallback(
    (intent: OledIntent) => {
      /*
       * `reset` is the one action that carries no timestamp: it restores the
       * default layout wholesale, whose `updatedAtMs` is 0 by definition, so
       * stamping one would put a field in the action the reducer never reads.
       * Every other action is timestamped here rather than by the caller, so no
       * screen has to know what time it is.
       */
      const action: OledAction = intent.type === 'reset' ? intent : { ...intent, atMs: now() };
      const next = oledReducer(layoutRef.current, action);
      if (next === layoutRef.current) return;
      layoutRef.current = next;
      setLayout(next);
      persist(next);
    },
    [now, persist],
  );

  const savePreset = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) return;

      const existing = presetsRef.current;
      const preset: OledPreset = {
        // Time-based rather than sequential: presets can be deleted, and a
        // sequential id would collide with a surviving older one.
        id: `p${now()}`,
        name: trimmed,
        createdAtMs: now(),
        // A deep copy, so a later edit to the live layout cannot rewrite the
        // snapshot the user saved.
        layout: { ...layoutRef.current, items: layoutRef.current.items.map((i) => ({ ...i })) },
      };

      const next = [...existing, preset].slice(-MAX_PRESETS);
      presetsRef.current = next;
      setPresets(next);
      void storage.setJson(featureKeys.oledPresets, next).catch(() => undefined);
    },
    [now, storage],
  );

  const applyPreset = useCallback(
    (id: string) => {
      const preset = presetsRef.current.find((candidate) => candidate.id === id);
      if (preset === undefined) return;

      // Re-parsed rather than spread: a preset was serialised to disk, so it
      // gets the same validation as anything else read from storage.
      const next = parseLayout(preset.layout);
      layoutRef.current = next;
      setLayout(next);
      persist(next);
    },
    [persist],
  );

  const deletePreset = useCallback(
    (id: string) => {
      const next = presetsRef.current.filter((preset) => preset.id !== id);
      if (next.length === presetsRef.current.length) return;
      presetsRef.current = next;
      setPresets(next);
      void storage.setJson(featureKeys.oledPresets, next).catch(() => undefined);
    },
    [storage],
  );

  return { layout, presets, isLoaded, run, savePreset, applyPreset, deletePreset };
}
