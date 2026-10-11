/**
 * OLED Studio state: the profile set, the active profile, and persistence.
 *
 * ## What changed and why
 *
 * This hook used to own one layout and a flat list of presets. It now owns a set
 * of *profiles*, each holding a left and a right hand config with its own
 * desired on/off — because that is what the product is: two physical panels,
 * configured separately, saved together. See `./profiles.ts` for the model.
 *
 * ## Why the writes are debounced
 *
 * Editing text means one keystroke per character, and each keystroke changes the
 * layout. Writing on every change would hit AsyncStorage dozens of times a
 * second while the user types, which is wasted work on a phone that is also
 * streaming sensor frames. Writes are therefore coalesced, and flushed
 * immediately on unmount so switching tabs cannot lose the last edit.
 *
 * ## Why nothing is accepted before the first read completes
 *
 * Every mutator here is a no-op until storage has been read once, and the screen
 * disables its controls meanwhile. The alternative — accepting an edit against
 * the in-memory defaults and then having the load land on top of it — silently
 * discards the user's change, and the window in which that can happen is not
 * something the user can see or reason about. `isLoaded` is surfaced so the
 * editor can say why it is briefly unavailable instead of appearing broken.
 *
 * ## Why the load never writes
 *
 * The one exception is the migration path: when a pre-profile install is found
 * and converted, the converted set is written immediately so the legacy keys are
 * not consulted again. That write happens after a successful read of the legacy
 * keys, never before, so a failed read cannot overwrite anything.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { featureKeys, type Storage } from '../storage';
import {
  copyHand,
  copyProfile,
  defaultHandConfig,
  defaultProfile,
  MAX_PROFILE_NAME,
  MAX_PROFILES,
  migrateLegacy,
  nextProfileId,
  parseStudio,
  type OledHandConfig,
  type OledIntro,
  type OledProfile,
  type OledStudioData,
} from './profiles';
import { oledReducer, type OledAction, type OledLayout } from './layout';
import type { GloveSide } from '../ble/types';

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
  readonly profiles: readonly OledProfile[];
  readonly active: OledProfile;
  /** False until storage has been read once. Mutators are inert until then. */
  readonly isLoaded: boolean;

  /** Edits the active profile's layout for one hand. */
  readonly run: (side: GloveSide, intent: OledIntent) => void;
  /** Sets one hand's *desired* on/off. Not evidence the panel is on. */
  readonly setEnabled: (side: GloveSide, enabled: boolean) => void;
  readonly setIntro: (side: GloveSide, patch: Partial<OledIntro>) => void;

  readonly createProfile: (name: string) => void;
  readonly saveAsNew: (name: string) => void;
  readonly renameProfile: (id: string, name: string) => void;
  readonly duplicateProfile: (id: string) => void;
  readonly switchProfile: (id: string) => void;
  /** Refuses to remove the last profile. */
  readonly deleteProfile: (id: string) => void;
  /** Restores both of that profile's hands to the defaults, keeping its name. */
  readonly restoreProfile: (id: string) => void;
}

/** One hand replaced, the other carried over untouched. */
function withHand(
  profile: OledProfile,
  side: GloveSide,
  update: (hand: OledHandConfig) => OledHandConfig,
): OledProfile {
  const hand = update(profile[side]);
  if (hand === profile[side]) return profile;
  return side === 'left' ? { ...profile, left: hand } : { ...profile, right: hand };
}

/** Replaces the active profile, leaving every other profile object identical. */
function replaceActive(
  data: OledStudioData,
  update: (profile: OledProfile) => OledProfile,
): OledStudioData | null {
  const index = data.profiles.findIndex((profile) => profile.id === data.activeId);
  if (index === -1) return null;

  const before = data.profiles[index] as OledProfile;
  const after = update(before);
  if (after === before) return null;

  const profiles = [...data.profiles];
  profiles[index] = after;
  return { profiles, activeId: data.activeId };
}

export function useOledStudio(storage: Storage, now: () => number = Date.now): OledStudio {
  const [data, setData] = useState<OledStudioData>(() => {
    const profile = defaultProfile(now);
    return { profiles: [profile], activeId: profile.id };
  });
  const [isLoaded, setIsLoaded] = useState(false);

  // Mirrors so callbacks can read the current value without being recreated on
  // every edit — which would defeat the memoisation on every downstream row.
  const dataRef = useRef(data);
  const loadedRef = useRef(false);

  /*
   * The clock is held in a ref and deliberately kept out of the load effect's
   * dependencies. A caller that passes an inline arrow — `now={() => 1000}` —
   * would otherwise give the effect a new dependency on every render and make it
   * re-read storage and re-commit the profile set, discarding in-flight edits.
   */
  const nowRef = useRef(now);
  nowRef.current = now;

  const pendingRef = useRef<OledStudioData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const write = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const value = pendingRef.current;
    pendingRef.current = null;
    if (value === null) return;
    void storage.setJson(featureKeys.oledProfiles, value).catch(() => undefined);
  }, [storage]);

  const persist = useCallback(
    (next: OledStudioData) => {
      pendingRef.current = next;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(write, PERSIST_DEBOUNCE_MS);
    },
    [write],
  );

  /** The one place state is committed. Load applies without persisting. */
  const commit = useCallback(
    (next: OledStudioData, shouldPersist: boolean) => {
      dataRef.current = next;
      setData(next);
      if (shouldPersist) persist(next);
    },
    [persist],
  );

  // Load once, then flush whatever is outstanding when the tab goes away.
  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const stored = parseStudio(await storage.getJson<unknown>(featureKeys.oledProfiles));

      if (stored !== null) {
        if (cancelled) return;
        commit(stored, false);
        return;
      }

      // Nothing under the profile key: this device either has never saved an
      // OLED configuration, or it has one from before profiles existed.
      const [legacyLayout, legacyPresets] = await Promise.all([
        storage.getJson<unknown>(featureKeys.oledLayout),
        storage.getJson<unknown>(featureKeys.oledPresets),
      ]);
      if (cancelled) return;

      const migrated = migrateLegacy(legacyLayout, legacyPresets, nowRef.current);
      commit(migrated, false);
      // Written straight away so the legacy keys are consulted exactly once.
      // Only reached after both legacy reads resolved, so a failed read cannot
      // overwrite a set that was there.
      void storage.setJson(featureKeys.oledProfiles, migrated).catch(() => undefined);
    };

    void load()
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        loadedRef.current = true;
        setIsLoaded(true);
      });

    return () => {
      cancelled = true;
      write();
    };
  }, [storage, commit, write]);

  /* ------------------------------------------------------------- mutations */

  const updateActive = useCallback(
    (update: (profile: OledProfile) => OledProfile) => {
      if (!loadedRef.current) return;
      const next = replaceActive(dataRef.current, update);
      if (next !== null) commit(next, true);
    },
    [commit],
  );

  const run = useCallback(
    (side: GloveSide, intent: OledIntent) => {
      /*
       * `reset` is the one action that carries no timestamp: it restores the
       * default layout wholesale, whose `updatedAtMs` is 0 by definition, so
       * stamping one would put a field in the action the reducer never reads.
       * Every other action is timestamped here rather than by the caller, so no
       * screen has to know what time it is.
       */
      const action: OledAction =
        intent.type === 'reset' ? intent : { ...intent, atMs: nowRef.current() };
      updateActive((profile) =>
        withHand(profile, side, (hand) => {
          const layout: OledLayout = oledReducer(hand.layout, action);
          return layout === hand.layout ? hand : { ...hand, layout };
        }),
      );
    },
    [updateActive],
  );

  const setEnabled = useCallback(
    (side: GloveSide, enabled: boolean) =>
      updateActive((profile) => {
        const hand = profile[side];
        if (hand.enabled === enabled) return profile;
        const next = { ...profile, updatedAtMs: nowRef.current() };
        return side === 'left'
          ? { ...next, left: { ...hand, enabled } }
          : { ...next, right: { ...hand, enabled } };
      }),
    [updateActive],
  );

  const setIntro = useCallback(
    (side: GloveSide, patch: Partial<OledIntro>) =>
      updateActive((profile) =>
        withHand(profile, side, (hand) => {
          const intro = { ...hand.intro, ...patch };
          if (intro.durationMs === hand.intro.durationMs && intro.animate === hand.intro.animate) {
            return hand;
          }
          return { ...hand, intro };
        }),
      ),
    [updateActive],
  );

  /* --------------------------------------------------------- profile set ops */

  /** Adds a profile and makes it active. Returns without changing anything if full. */
  const add = useCallback(
    (profile: OledProfile) => {
      if (!loadedRef.current) return;
      const current = dataRef.current;
      if (current.profiles.length >= MAX_PROFILES) return;
      commit(
        { profiles: [...current.profiles, profile], activeId: profile.id },
        true,
      );
    },
    [commit],
  );

  const createProfile = useCallback(
    (name: string) => {
      const trimmed = name.trim().slice(0, MAX_PROFILE_NAME);
      const current = dataRef.current;
      const at = nowRef.current();
      // A deep copy per hand: the two hands of one profile must not share an
      // item array, or editing the left panel would edit the right one.
      const left = defaultHandConfig();
      const right = defaultHandConfig();
      add({
        id: nextProfileId(current.profiles, nowRef.current),
        name: trimmed.length > 0 ? trimmed : 'New profile',
        createdAtMs: at,
        updatedAtMs: at,
        left: copyHand(left),
        right: copyHand(right),
      });
    },
    [add],
  );

  const saveAsNew = useCallback(
    (name: string) => {
      const trimmed = name.trim().slice(0, MAX_PROFILE_NAME);
      const current = dataRef.current;
      const source = current.profiles.find((profile) => profile.id === current.activeId);
      if (source === undefined) return;

      const at = nowRef.current();
      const copy = copyProfile(source);
      add({
        ...copy,
        id: nextProfileId(current.profiles, nowRef.current),
        name: trimmed.length > 0 ? trimmed : `${source.name} copy`,
        createdAtMs: at,
        updatedAtMs: at,
      });
    },
    [add],
  );

  const renameProfile = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim().slice(0, MAX_PROFILE_NAME);
      // An empty name is rejected rather than accepted-and-defaulted: a rename
      // to nothing is a slip, and silently substituting a name would hide it.
      if (trimmed.length === 0) return;
      if (!loadedRef.current) return;

      const current = dataRef.current;
      if (!current.profiles.some((profile) => profile.id === id)) return;

      commit(
        {
          profiles: current.profiles.map((profile) =>
            profile.id === id
              ? { ...profile, name: trimmed, updatedAtMs: nowRef.current() }
              : profile,
          ),
          activeId: current.activeId,
        },
        true,
      );
    },
    [commit],
  );

  const duplicateProfile = useCallback(
    (id: string) => {
      const current = dataRef.current;
      const source = current.profiles.find((profile) => profile.id === id);
      if (source === undefined) return;

      const at = nowRef.current();
      const copy = copyProfile(source);
      // The name is truncated *after* the suffix is appended, so a profile at
      // the name limit cannot produce an overlong one.
      const name = `${source.name} copy`.slice(0, MAX_PROFILE_NAME);
      add({
        ...copy,
        id: nextProfileId(current.profiles, nowRef.current),
        name,
        createdAtMs: at,
        updatedAtMs: at,
      });
    },
    [add],
  );

  const switchProfile = useCallback(
    (id: string) => {
      if (!loadedRef.current) return;
      const current = dataRef.current;
      if (current.activeId === id) return;
      if (!current.profiles.some((profile) => profile.id === id)) return;
      commit({ profiles: current.profiles, activeId: id }, true);
    },
    [commit],
  );

  const deleteProfile = useCallback(
    (id: string) => {
      if (!loadedRef.current) return;
      const current = dataRef.current;
      // Every hand must have a configuration, and a profile set with no active
      // member has none. Removing the last profile is therefore refused rather
      // than papered over by resurrecting a default.
      if (current.profiles.length <= 1) return;

      const profiles = current.profiles.filter((profile) => profile.id !== id);
      if (profiles.length === current.profiles.length) return;

      const activeId =
        current.activeId === id ? (profiles[0] as OledProfile).id : current.activeId;
      commit({ profiles, activeId }, true);
    },
    [commit],
  );

  const restoreProfile = useCallback(
    (id: string) => {
      if (!loadedRef.current) return;
      const current = dataRef.current;
      const profile = current.profiles.find((candidate) => candidate.id === id);
      if (profile === undefined) return;

      // Fresh objects per hand, not one hand reused twice: two references to a
      // single item array would make the two panels edit each other.
      const hands = { left: copyHand(defaultHandConfig()), right: copyHand(defaultHandConfig()) };

      commit(
        {
          profiles: current.profiles.map((candidate) =>
            candidate.id === id
              ? { ...candidate, ...hands, updatedAtMs: nowRef.current() }
              : candidate,
          ),
          activeId: current.activeId,
        },
        true,
      );
    },
    [commit],
  );

  const active =
    data.profiles.find((profile) => profile.id === data.activeId) ??
    (data.profiles[0] as OledProfile);

  return {
    profiles: data.profiles,
    active,
    isLoaded,
    run,
    setEnabled,
    setIntro,
    createProfile,
    saveAsNew,
    renameProfile,
    duplicateProfile,
    switchProfile,
    deleteProfile,
    restoreProfile,
  };
}

export { MAX_PROFILE_NAME, MAX_PROFILES };
