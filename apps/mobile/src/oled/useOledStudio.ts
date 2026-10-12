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
 * Saving is a whole-profile commit, not a keystroke, so the debounce now
 * coalesces *saves* rather than edits. It is kept because a save can still be
 * followed immediately by another (switch profile, then rename), and because
 * the flush on unmount must not lose a commit that has already been made.
 *
 * ## Why editing is transactional
 *
 * Every editor on this screen used to write straight through: one tap, one
 * keystroke, one committed profile, and a debounced write to storage. That made
 * "close the editor" and "keep what I just changed" the same action — the X
 * button persisted whatever the user had been experimenting with, which is the
 * opposite of what an X means.
 *
 * So edits now land in a `draft`. It is seeded from the saved configuration,
 * every control on the screen renders it, and nothing reaches storage until the
 * user presses Save. `save` commits the whole profile in one action; `discard`
 * drops the draft and restores what was last saved.
 *
 * The draft is deliberately a single object for the whole studio rather than one
 * per sheet: the main screen's controls (on/off, intro, loading, animation) edit
 * the same profile the item editor does, and two independent drafts over one
 * profile would let one editor silently undo the other.
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
  sameSettings,
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

  /**
   * The working copy being edited, and what every preview renders.
   *
   * It is the same object as `active` until the first edit, so an untouched
   * studio carries no extra state. Edits below move this and nothing else —
   * nothing reaches storage until `save`.
   */
  readonly draft: OledProfile;
  /**
   * True when the draft's settings differ from the last saved configuration.
   *
   * By value, not by identity — see `sameSettings`. An edit that is undone by
   * hand leaves the profile as it was stored, and the studio should say so.
   */
  readonly isDirty: boolean;
  /** Commits the draft into the active profile, atomically. */
  readonly save: () => void;
  /** Throws the draft away and restores the last saved configuration. */
  readonly discard: () => void;

  /** Edits the draft's layout for one hand. Not persisted until `save`. */
  readonly run: (side: GloveSide, intent: OledIntent) => void;
  /** Sets one hand's *desired* on/off. Not evidence the panel is on. */
  readonly setEnabled: (side: GloveSide, enabled: boolean) => void;
  readonly setIntro: (side: GloveSide, patch: Partial<OledIntro>) => void;
  /**
   * Replaces one hand's whole layout in the draft.
   *
   * Exists so a nested editor can cancel: it snapshots the layout when it opens
   * and puts it back if the user leaves without keeping the changes. Draft-only,
   * like every other edit here.
   */
  readonly setLayout: (side: GloveSide, layout: OledLayout) => void;

  readonly createProfile: (name: string) => void;
  readonly saveAsNew: (name: string) => void;
  readonly renameProfile: (id: string, name: string) => void;
  readonly duplicateProfile: (id: string) => void;
  readonly switchProfile: (id: string) => void;
  /** Refuses to remove the last profile. */
  readonly deleteProfile: (id: string) => void;
  /**
   * Restores the active profile's two hands to the defaults, keeping its name.
   *
   * Draft-only, like every other edit: a restore is a change to the
   * configuration, so it has to be undoable by Discard. Committing it on the
   * spot would mean Discard brought back the customisation it had just
   * confirmed the loss of — the user would read that as Discard being broken.
   */
  readonly restoreActive: () => void;
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

  /**
   * The committed profile being edited.
   *
   * Derived rather than stored, so it always tracks the profile set: a load, a
   * rename, a restore or a switch all move it, and the draft below follows it.
   */
  const active =
    data.profiles.find((profile) => profile.id === data.activeId) ??
    (data.profiles[0] as OledProfile);

  // The working copy. Starts as the committed profile itself, so an untouched
  // studio carries no second copy of anything.
  const [draft, setDraft] = useState<OledProfile>(active);
  const draftRef = useRef(draft);

  /*
   * Re-seed the draft whenever the committed active profile is replaced: the
   * first load, a profile switch, a rename, a restore, or a save.
   *
   * Keyed on the profile *object*, not its id: an edit moves the draft and
   * leaves `data` alone, so this does not fire while the user is editing — and
   * on save the committed object becomes the draft itself, which React treats
   * as no change at all.
   */
  useEffect(() => {
    draftRef.current = active;
    setDraft(active);
  }, [active]);

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

  /**
   * The only way the draft changes.
   *
   * Deliberately never touches `data`, so no edit made through here can reach
   * storage on its own — persistence happens in `save` and nowhere else.
   */
  const amend = useCallback((update: (profile: OledProfile) => OledProfile) => {
    if (!loadedRef.current) return;
    const next = update(draftRef.current);
    if (next === draftRef.current) return;
    draftRef.current = next;
    setDraft(next);
  }, []);

  /** Commits the draft into the active profile, as one atomic replacement. */
  const save = useCallback(() => {
    if (!loadedRef.current) return;
    const next = replaceActive(dataRef.current, () => draftRef.current);
    // `null` means the draft is identical to what is stored: nothing to do.
    if (next === null) return;
    commit(next, true);
  }, [commit]);

  /** Drops the draft and restores the last saved configuration. */
  const discard = useCallback(() => {
    const current = dataRef.current;
    const committed =
      current.profiles.find((profile) => profile.id === current.activeId) ??
      (current.profiles[0] as OledProfile);
    draftRef.current = committed;
    setDraft(committed);
  }, []);

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
      amend((profile) =>
        withHand(profile, side, (hand) => {
          const layout: OledLayout = oledReducer(hand.layout, action);
          return layout === hand.layout ? hand : { ...hand, layout };
        }),
      );
    },
    [amend],
  );

  const setEnabled = useCallback(
    (side: GloveSide, enabled: boolean) =>
      amend((profile) => {
        const hand = profile[side];
        if (hand.enabled === enabled) return profile;
        const next = { ...profile, updatedAtMs: nowRef.current() };
        return side === 'left'
          ? { ...next, left: { ...hand, enabled } }
          : { ...next, right: { ...hand, enabled } };
      }),
    [amend],
  );

  const setIntro = useCallback(
    (side: GloveSide, patch: Partial<OledIntro>) =>
      amend((profile) =>
        withHand(profile, side, (hand) => {
          const intro = { ...hand.intro, ...patch };
          if (intro.durationMs === hand.intro.durationMs && intro.animate === hand.intro.animate) {
            return hand;
          }
          return { ...hand, intro };
        }),
      ),
    [amend],
  );

  const setLayout = useCallback(
    (side: GloveSide, layout: OledLayout) =>
      amend((profile) =>
        withHand(profile, side, (hand) => (hand.layout === layout ? hand : { ...hand, layout })),
      ),
    [amend],
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
      /*
       * Copied from the *draft*, not from the committed profile.
       *
       * "Save as a new profile" means "keep what I am looking at, under another
       * name". Copying the committed version instead would silently drop the
       * very edits that prompted the action — and would leave a new profile
       * identical to the old one, which is never what was wanted.
       *
       * The source profile is left untouched: this only ever adds.
       */
      const source = draftRef.current;

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

  const restoreActive = useCallback(
    () =>
      amend((profile) => {
        // Fresh objects per hand, not one hand reused twice: two references to a
        // single item array would make the two panels edit each other.
        const hands = { left: copyHand(defaultHandConfig()), right: copyHand(defaultHandConfig()) };
        return { ...profile, ...hands, updatedAtMs: nowRef.current() };
      }),
    [amend],
  );

  return {
    profiles: data.profiles,
    active,
    isLoaded,
    draft,
    isDirty: !sameSettings(draft, active),
    save,
    discard,
    run,
    setEnabled,
    setIntro,
    setLayout,
    createProfile,
    saveAsNew,
    renameProfile,
    duplicateProfile,
    switchProfile,
    deleteProfile,
    restoreActive,
  };
}

export { MAX_PROFILE_NAME, MAX_PROFILES };
