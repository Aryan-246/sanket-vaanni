/**
 * OLED profiles: one saved configuration covering *both* gloves.
 *
 * ## Why profiles replaced presets
 *
 * A preset was a snapshot of the single layout the studio held. That model could
 * not express the product: a left glove and a right glove have separate panels,
 * they can be switched on and off separately, and "show the wordmark on the left
 * and nothing on the right" is an ordinary thing to want. A preset had nowhere
 * to put any of that.
 *
 * A profile therefore holds a left config and a right config, each with its own
 * items, its own startup behaviour and its own desired on/off. Switching
 * profiles switches both panels together, because that is what a saved setup
 * means — and because two independent switchers over one list of names is a UI
 * nobody can predict.
 *
 * ## Desired is not observed
 *
 * `enabled` is what the user *wants*, stored locally. Nothing in this file — and
 * nothing that reads it — may present that as the panel's state. No OLED command
 * set and no BLE characteristic has been verified, so there is no read-back and
 * no way to know whether a panel is lit. Every surface that shows `enabled` says
 * "desired" next to it, and the audit reports the physical state as unknown
 * rather than inferring it from this flag.
 *
 * ## Purity
 *
 * No React, no storage, no timers. Serialising is the caller's job; this module
 * owns the shape and the validation of anything that comes back off disk.
 */
import {
  defaultLayout,
  parseLayout,
  type OledLayout,
  type OledPhase,
} from './layout';

/** How many profiles can exist at once, and how long a name can be. */
export const MAX_PROFILES = 8;
export const MAX_PROFILE_NAME = 24;

/** The profile that exists before the user has saved anything. */
export const DEFAULT_PROFILE_ID = 'pr0';
export const DEFAULT_PROFILE_NAME = 'Default';

/* -------------------------------------------------------------------- intro */

/**
 * How a hand's panel behaves when the firmware powers it up.
 *
 * `durationMs` of 0 means there is no startup view at all: the panel goes
 * straight to the running view. That is the honest way to express "no intro",
 * because it does not pretend the panel has a startup phase it spends no time
 * in.
 */
export interface OledIntro {
  /** How long the startup view is held before the running view takes over. */
  readonly durationMs: number;
  /**
   * Whether the loading indicator animates during the startup view.
   *
   * A boolean rather than a choice of animations, because the loading indicator
   * is the only motion an SSD1306 can express without a bitmap sequence — and a
   * bitmap sequence needs the conversion step that does not exist yet.
   */
  readonly animate: boolean;
}

/** Durations the UI offers, in ms. 0 is "no startup view". */
export const INTRO_DURATION_PRESETS = [0, 1000, 2000, 5000] as const;
export const MIN_INTRO_MS = 0;
export const MAX_INTRO_MS = 10_000;
export const DEFAULT_INTRO_MS = 2000;

export function clampIntroMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_INTRO_MS;
  return Math.min(MAX_INTRO_MS, Math.max(MIN_INTRO_MS, Math.round(ms)));
}

export function defaultIntro(): OledIntro {
  return { durationMs: 0, animate: true };
}

/* ----------------------------------------------------------------- profiles */

/** One glove's desired configuration. */
export interface OledHandConfig {
  /**
   * The user's desired on/off for this panel — **not** its state. See the
   * module note: no read-back exists, so "on" here means "when firmware
   * arrives, this is what it should do".
   */
  readonly enabled: boolean;
  readonly layout: OledLayout;
  readonly intro: OledIntro;
}

export interface OledProfile {
  readonly id: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly left: OledHandConfig;
  readonly right: OledHandConfig;
}

/** The default configuration for a hand. Both hands start identical. */
export function defaultHandConfig(): OledHandConfig {
  return {
    // Off, not on. A profile that starts "on" would be claiming a panel state the
    // moment the user opens the app having configured nothing.
    enabled: false,
    layout: defaultLayout(),
    intro: defaultIntro(),
  };
}

export function defaultProfile(now: () => number = Date.now): OledProfile {
  const at = now();
  return {
    id: DEFAULT_PROFILE_ID,
    name: DEFAULT_PROFILE_NAME,
    createdAtMs: at,
    updatedAtMs: at,
    left: defaultHandConfig(),
    right: defaultHandConfig(),
  };
}

/**
 * A free profile id.
 *
 * Derived from the existing ids rather than from a counter, so that loading a
 * stored set cannot produce a collision — and, unlike a timestamp alone, so that
 * two profiles created inside the same millisecond stay distinct.
 */
export function nextProfileId(profiles: readonly OledProfile[], now: () => number): string {
  const taken = new Set(profiles.map((profile) => profile.id));
  let candidate = `pr${now()}`;
  let attempt = 0;
  while (taken.has(candidate)) {
    attempt += 1;
    candidate = `pr${now()}-${attempt}`;
  }
  return candidate;
}

/** A deep copy, so editing one profile can never reach into another. */
export function copyHand(hand: OledHandConfig): OledHandConfig {
  return {
    enabled: hand.enabled,
    layout: {
      ...hand.layout,
      items: hand.layout.items.map((item) => ({ ...item })),
    },
    intro: { ...hand.intro },
  };
}

export function copyProfile(profile: OledProfile): OledProfile {
  return {
    ...profile,
    left: copyHand(profile.left),
    right: copyHand(profile.right),
  };
}

/* ------------------------------------------------------------ validation ---- */

/**
 * Whether the startup view would show anything the running view does not.
 *
 * A hold duration with no startup-only item means the panel sits on a view it
 * was going to show anyway — a setting that does nothing. The editor warns
 * rather than refusing, because the user may be about to add the item.
 */
export function startupViewIsDistinct(layout: OledLayout): boolean {
  return layout.items.some((item) => item.timing === 'startup' && item.visible);
}

/** Items this view draws, for the editor's per-view summary. */
export function countInPhase(layout: OledLayout, phase: OledPhase): number {
  return layout.items.filter(
    (item) => item.visible && (item.timing === 'always' || phase === 'startup'),
  ).length;
}

/* --------------------------------------------------------- deserialisation -- */

function pickName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, MAX_PROFILE_NAME);
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Coerces untrusted stored JSON into a hand config.
 *
 * Each field falls back independently, on the same reasoning as `parseLayout`:
 * a corrupt intro must not be able to take the layout down with it, and the
 * screen that exists to repair a bad config must be able to open.
 */
export function parseHand(raw: unknown): OledHandConfig {
  const base = defaultHandConfig();
  if (raw === null || typeof raw !== 'object') return base;
  const record = raw as Record<string, unknown>;

  const introRaw = record.intro;
  const intro: OledIntro =
    introRaw !== null && typeof introRaw === 'object'
      ? {
          durationMs:
            typeof (introRaw as Record<string, unknown>).durationMs === 'number'
              ? clampIntroMs((introRaw as Record<string, unknown>).durationMs as number)
              : base.intro.durationMs,
          // Anything other than an explicit `false` is treated as animating, so a
          // lost flag cannot silently stop the one animation the panel has.
          animate: (introRaw as Record<string, unknown>).animate !== false,
        }
      : base.intro;

  return {
    // Anything other than an explicit `true` is off. Defaulting an unreadable
    // value to *on* would turn a corrupt byte into a claim about hardware.
    enabled: record.enabled === true,
    layout: parseLayout(record.layout),
    intro,
  };
}

export function parseProfile(raw: unknown): OledProfile | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;

  return {
    id: record.id,
    name: pickName(record.name, DEFAULT_PROFILE_NAME),
    createdAtMs: typeof record.createdAtMs === 'number' ? record.createdAtMs : 0,
    updatedAtMs: typeof record.updatedAtMs === 'number' ? record.updatedAtMs : 0,
    left: parseHand(record.left),
    right: parseHand(record.right),
  };
}

/** The studio's whole persisted payload. */
export interface OledStudioData {
  readonly profiles: readonly OledProfile[];
  readonly activeId: string;
}

/**
 * Reads the persisted payload, or `null` when there is nothing usable.
 *
 * `null` is not an error: it is the signal to the caller that this device has
 * never saved a profile, and that the defaults (or a legacy migration) should be
 * used instead. Reporting it as a distinct outcome from "here are your profiles"
 * is what lets the caller avoid *overwriting* real data with defaults.
 *
 * A duplicate or oversized id list is repaired rather than rejected: the first
 * occurrence of an id wins, and the list is capped at `MAX_PROFILES`.
 */
export function parseStudio(raw: unknown): OledStudioData | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.profiles)) return null;

  const profiles: OledProfile[] = [];
  const seen = new Set<string>();
  for (const entry of record.profiles) {
    const profile = parseProfile(entry);
    if (profile === null || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
    if (profiles.length >= MAX_PROFILES) break;
  }

  if (profiles.length === 0) return null;

  const wanted = typeof record.activeId === 'string' ? record.activeId : '';
  const active = profiles.find((profile) => profile.id === wanted) ?? (profiles[0] as OledProfile);

  return { profiles, activeId: active.id };
}

/* -------------------------------------------------------------- migration --- */

/**
 * Converts a pre-profile install into profiles.
 *
 * This exists for one reason: an upgrade must not discard work the user already
 * did. The old studio held one live layout plus up to six presets, none of which
 * recorded which glove they were for. The conversion is therefore:
 *
 *  - the live layout becomes the first profile, applied to **both** hands,
 *    because the old studio applied it to whichever hand was being previewed —
 *    so both is what it meant;
 *  - each preset becomes a profile of its own, same rule;
 *  - the live layout's profile is the active one, which is what the user was
 *    looking at before the upgrade.
 *
 * The legacy keys are only read here and are never written again. They are left
 * on disk rather than deleted, because a downgrade or a bug in this function
 * should still leave the original data recoverable.
 */
export function migrateLegacy(
  legacyLayout: unknown,
  legacyPresets: unknown,
  now: () => number = Date.now,
): OledStudioData {
  const at = now();

  /**
   * One hand, with its own copy of the layout.
   *
   * The copy is not decoration: both hands of a migrated profile start from the
   * same layout, and handing the same object to both would mean an edit to one
   * panel's item array was an edit to the other's. The reducer is pure today, so
   * nothing would break yet — which is exactly the kind of latent sharing that
   * breaks later, silently, in one direction only.
   */
  const hand = (layout: OledLayout): OledHandConfig => ({
    enabled: false,
    layout: { ...layout, items: layout.items.map((item) => ({ ...item })) },
    intro: defaultIntro(),
  });

  const fromLayout = (name: string, layout: OledLayout, id: string): OledProfile => ({
    id,
    name,
    createdAtMs: at,
    updatedAtMs: at,
    left: hand(layout),
    right: hand(layout),
  });

  const hasLayout = legacyLayout !== null && typeof legacyLayout === 'object';
  const presets = Array.isArray(legacyPresets) ? legacyPresets : [];

  if (!hasLayout && presets.length === 0) {
    const profile = defaultProfile(now);
    return { profiles: [profile], activeId: profile.id };
  }

  const profiles: OledProfile[] = [];
  const seen = new Set<string>();

  // Presets first so that the live layout can claim the default id — the primary
  // profile keeps a stable, memorable id across the migration.
  for (const entry of presets) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || seen.has(`pr-${record.id}`)) continue;
    seen.add(`pr-${record.id}`);
    profiles.push(
      fromLayout(
        pickName(record.name, DEFAULT_PROFILE_NAME),
        parseLayout(record.layout),
        `pr-${record.id}`,
      ),
    );
    if (profiles.length >= MAX_PROFILES - 1) break;
  }

  const live = hasLayout ? parseLayout(legacyLayout) : defaultLayout();
  const head = fromLayout(DEFAULT_PROFILE_NAME, live, DEFAULT_PROFILE_ID);

  return { profiles: [head, ...profiles], activeId: head.id };
}
