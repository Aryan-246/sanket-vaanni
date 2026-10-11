/**
 * OLED Studio layout model.
 *
 * ## What this models
 *
 * The physical panel is an SSD1306: 128×64 pixels, one bit per pixel, no
 * greyscale. Almost all such panels are driven in *text mode* with a 6×8 glyph
 * cell, which gives a 21×8 character grid. That grid — not a bitmap — is what
 * this module models, because that is what the layout actually has to be
 * expressible in for the firmware to draw it.
 *
 * Modelling the grid means the preview cannot show a layout the panel could not
 * display: a line that is too long overflows and is flagged, and a layout with
 * too many rows reports which items do not fit rather than silently dropping
 * them.
 *
 * ## What this deliberately does not do
 *
 * There is no command encoding here. No byte sequence is produced, and nothing
 * in this file claims a panel was written to. When the firmware's command set
 * is verified, a serialiser can be written against this model — and it will be
 * a new file, because the framebuffer offsets below are a *presentation* model
 * that has not been checked against real `SSD1306` addressing (the panel's page
 * addressing wraps every 8 rows, which a naive row-offset serialiser would get
 * wrong).
 *
 * Everything here is pure: no React, no storage, no timers. The timer that
 * drives the loading animation lives in the canvas component, which is the only
 * part that needs one.
 */

/** Panel geometry, in pixels. */
export const OLED_WIDTH = 128;
export const OLED_HEIGHT = 64;

/** 6×8 glyph cell — the standard SSD1306 text mode. */
export const GLYPH_WIDTH = 6;
export const GLYPH_HEIGHT = 8;

/** Usable character grid. `floor(128/6) = 21`, `floor(64/8) = 8`. */
export const OLED_COLUMNS = 21;
export const OLED_ROWS = 8;

/** A double-height line is two glyph cells wide per character. */
export const OLED_LARGE_SCALE = 2;

export type OledAlign = 'left' | 'center' | 'right';
export const OLED_ALIGNS: readonly OledAlign[] = ['left', 'center', 'right'];

export type OledTextSize = 'normal' | 'large';
export const OLED_TEXT_SIZES: readonly OledTextSize[] = ['normal', 'large'];

export type OledLoadingStyle = 'dots' | 'bar' | 'none';
export const OLED_LOADING_STYLES: readonly OledLoadingStyle[] = ['dots', 'bar', 'none'];

/**
 * Which of the panel's two views an item belongs to.
 *
 * A glove's display has a startup view — what it shows while the firmware is
 * bringing the radio up — and a running view. `always` items appear in both;
 * `startup` items appear only in the startup view, which is what makes a
 * boot banner possible without it occupying a row for the rest of the session.
 */
export type OledItemTiming = 'always' | 'startup';
export const OLED_ITEM_TIMINGS: readonly OledItemTiming[] = ['always', 'startup'];

export const OLED_TIMING_LABEL: Record<OledItemTiming, string> = {
  always: 'Always',
  startup: 'Startup only',
};

/** The panel view being assembled or previewed. */
export type OledPhase = 'startup' | 'persistent';

/**
 * What a row shows.
 *
 * `bound` kinds read from live values, so the studio can show what the panel
 * would display without the studio having to know where those values came from.
 * Every bound value can be `null`, which renders as the explicit placeholder
 * `--` rather than as a zero or a blank — a blank row and a row with no data
 * behind it must not look the same.
 */
export type OledItemKind =
  | 'title'
  /** User-authored static text. */
  | 'text'
  /** Latest recognised text. `null` when recognition is unavailable. */
  | 'recognised'
  /** Link status. `null` when nothing has reported. */
  | 'status'
  /** Battery. `null` — no pack has ever reported to this app. */
  | 'battery'
  /** Animated indicator. */
  | 'loading';

export const OLED_ITEM_KINDS: readonly OledItemKind[] = [
  'title',
  'text',
  'recognised',
  'status',
  'battery',
  'loading',
];

export const OLED_KIND_LABEL: Record<OledItemKind, string> = {
  title: 'Title',
  text: 'Text',
  recognised: 'Recognised text',
  status: 'Status',
  battery: 'Battery',
  loading: 'Loading indicator',
};

/**
 * Kinds whose value no hardware has ever reported.
 *
 * They are still offered, because a layout that is *waiting* for telemetry is a
 * legitimate thing to design — but the editor marks them, so a row that will
 * draw `--` forever is never mistaken for one that is about to come alive.
 */
export const OLED_KIND_NEEDS_TELEMETRY: ReadonlySet<OledItemKind> = new Set<OledItemKind>([
  'battery',
]);

/** Placeholder for a bound value that has not reported. Never a fake reading. */
export const OLED_NO_VALUE = '--';

export interface OledItem {
  /** Unique within a layout, stable across reorder and visibility changes. */
  readonly id: string;
  readonly kind: OledItemKind;
  /** Authored text for `title`/`text`. Ignored by bound kinds. */
  readonly label: string;
  /**
   * Whether the item is currently shown. Hidden items stay in the layout so
   * they can be restored — hiding is not deleting, and there is deliberately no
   * separate "hidden items" store that could drift out of sync.
   */
  readonly visible: boolean;
  readonly size: OledTextSize;
  readonly align: OledAlign;
  /**
   * Whether the item belongs to the startup view, the running view, or both.
   *
   * Adding a field rather than a separate startup list is deliberate: a second
   * list could hold an item id the main list has deleted, and the two would
   * drift. One list, one flag, no possible disagreement.
   */
  readonly timing: OledItemTiming;
}

export interface OledLayout {
  readonly version: 1;
  readonly items: readonly OledItem[];
  readonly loadingStyle: OledLoadingStyle;
  /** Frame period for the loading animation, in ms. */
  readonly animationMs: number;
  /** When the user last changed the layout. Presets show this. */
  readonly updatedAtMs: number;
}

/** Longest line the panel can show, in characters, for a given text size. */
export function columnsFor(size: OledTextSize): number {
  return size === 'large'
    ? Math.floor(OLED_WIDTH / (GLYPH_WIDTH * OLED_LARGE_SCALE))
    : OLED_COLUMNS;
}

/** Rows a single item occupies. */
export function rowsFor(item: OledItem): number {
  return item.kind === 'loading' ? 1 : item.size === 'large' ? OLED_LARGE_SCALE : 1;
}

/** Frame periods the UI offers, in ms. */
export const ANIMATION_SPEEDS = [200, 400, 700, 1200] as const;
export const MIN_ANIMATION_MS = 120;
export const MAX_ANIMATION_MS = 4000;

export const DEFAULT_ANIMATION_MS = 400;

/**
 * Safe defaults.
 *
 * Deliberately modest: a wordmark, the two live readouts that actually have
 * data behind them, and a loading indicator. Everything a user adds beyond this
 * is their choice, and everything here has a working control — there is no item
 * in the default layout that the editor cannot remove or edit.
 *
 * ## Why there is no battery row here
 *
 * There used to be one. It drew `--` on every frame, because no pack has ever
 * reported a percentage to this app, and a default layout that leads with a
 * placeholder reads as a broken reading rather than as an absent one. The
 * battery item kind still exists and can still be added — it is honest, it
 * draws `--` and it is marked as awaiting telemetry — but a *default* should
 * show what works, and battery is the one bound kind with no source.
 *
 * Note the sizes: the title is the only double-height row, so the default
 * layout uses 5 of the 8 rows and leaves three free.
 */
export function defaultLayout(): OledLayout {
  return {
    version: 1,
    items: [
      {
        id: 'o0',
        kind: 'title',
        label: 'SANKET VAANNI',
        visible: true,
        size: 'large',
        align: 'center',
        timing: 'always',
      },
      {
        id: 'o1',
        kind: 'recognised',
        label: '',
        visible: true,
        size: 'normal',
        align: 'left',
        timing: 'always',
      },
      {
        id: 'o2',
        kind: 'status',
        label: '',
        visible: true,
        size: 'normal',
        align: 'left',
        timing: 'always',
      },
      {
        id: 'o3',
        kind: 'loading',
        label: '',
        visible: true,
        size: 'normal',
        align: 'left',
        timing: 'always',
      },
    ],
    loadingStyle: 'dots',
    animationMs: DEFAULT_ANIMATION_MS,
    updatedAtMs: 0,
  };
}

/** Upper bound on items, so a layout cannot grow without limit. */
export const MAX_ITEM_COUNT = 12;

/**
 * Next free item id.
 *
 * Derived from the layout rather than from a module counter, so that loading a
 * preset cannot produce an id that collides with an existing item — and so the
 * function stays pure and testable.
 */
export function nextItemId(layout: OledLayout): string {
  let highest = -1;
  for (const item of layout.items) {
    const match = /^o(\d+)$/.exec(item.id);
    if (match !== null) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `o${highest + 1}`;
}

/**
 * Reorders only *within* the visible set of positions held by each item.
 *
 * Straight index swapping would let a move hop over a hidden item and appear to
 * do nothing, because the hidden item occupies no space on the panel. So a move
 * swaps with the next item in that direction regardless of visibility: the
 * visible result of one move is always exactly one position, which is what a
 * user pressing an arrow expects.
 */
export function oledReducer(layout: OledLayout, action: OledAction): OledLayout {
  switch (action.type) {
    case 'add': {
      if (layout.items.length >= MAX_ITEM_COUNT) return layout;
      const id = nextItemId(layout);
      const item: OledItem = {
        id,
        kind: action.kind,
        label: action.kind === 'text' ? 'New text' : action.kind === 'title' ? 'TITLE' : '',
        visible: true,
        size: 'normal',
        align: 'left',
        // New items join the running view. Starting an item in the startup view
        // would make it vanish from the panel a moment after it was added, which
        // reads as a bug rather than as a setting.
        timing: 'always',
      };
      return { ...layout, items: [...layout.items, item], updatedAtMs: action.atMs };
    }

    case 'remove':
      return {
        ...layout,
        items: layout.items.filter((item) => item.id !== action.id),
        updatedAtMs: action.atMs,
      };

    case 'move': {
      const index = layout.items.findIndex((item) => item.id === action.id);
      if (index === -1) return layout;
      const target = action.direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= layout.items.length) return layout;

      const items = [...layout.items];
      const moving = items[index] as OledItem;
      items[index] = items[target] as OledItem;
      items[target] = moving;
      return { ...layout, items, updatedAtMs: action.atMs };
    }

    case 'setLabel':
      return {
        ...layout,
        items: layout.items.map((item) =>
          item.id === action.id ? { ...item, label: action.label } : item,
        ),
        updatedAtMs: action.atMs,
      };

    /**
     * Changing kind keeps the item's position, which is what makes it worth
     * having: turning a text line into a status line should not move it to the
     * bottom of the panel.
     *
     * The label is dropped when moving to a bound kind, because a bound kind's
     * text comes from the glove and a stale authored string would never be shown
     * — leaving it stored would just be dead data the editor could not reach.
     */
    case 'setKind': {
      const item = layout.items.find((candidate) => candidate.id === action.id);
      if (item === undefined || item.kind === action.kind) return layout;
      const bound = action.kind !== 'title' && action.kind !== 'text';
      return {
        ...layout,
        items: layout.items.map((candidate) =>
          candidate.id === action.id
            ? { ...candidate, kind: action.kind, label: bound ? '' : candidate.label }
            : candidate,
        ),
        updatedAtMs: action.atMs,
      };
    }

    case 'setVisible':
      return {
        ...layout,
        items: layout.items.map((item) =>
          item.id === action.id ? { ...item, visible: action.visible } : item,
        ),
        updatedAtMs: action.atMs,
      };

    case 'setSize':
      return {
        ...layout,
        items: layout.items.map((item) =>
          item.id === action.id ? { ...item, size: action.size } : item,
        ),
        updatedAtMs: action.atMs,
      };

    case 'setAlign':
      return {
        ...layout,
        items: layout.items.map((item) =>
          item.id === action.id ? { ...item, align: action.align } : item,
        ),
        updatedAtMs: action.atMs,
      };

    case 'setTiming':
      return {
        ...layout,
        items: layout.items.map((item) =>
          item.id === action.id ? { ...item, timing: action.timing } : item,
        ),
        updatedAtMs: action.atMs,
      };

    case 'restoreAllHidden': {
      if (layout.items.every((item) => item.visible)) return layout;
      return {
        ...layout,
        items: layout.items.map((item) => ({ ...item, visible: true })),
        updatedAtMs: action.atMs,
      };
    }

    case 'setLoadingStyle':
      return { ...layout, loadingStyle: action.style, updatedAtMs: action.atMs };

    case 'setAnimationMs': {
      const ms = clampAnimation(action.ms);
      if (ms === layout.animationMs) return layout;
      return { ...layout, animationMs: ms, updatedAtMs: action.atMs };
    }

    case 'reset':
      return defaultLayout();

    default:
      return layout;
  }
}

export type OledAction =
  | { type: 'add'; kind: OledItemKind; atMs: number }
  | { type: 'remove'; id: string; atMs: number }
  | { type: 'move'; id: string; direction: 'up' | 'down'; atMs: number }
  | { type: 'setLabel'; id: string; label: string; atMs: number }
  | { type: 'setKind'; id: string; kind: OledItemKind; atMs: number }
  | { type: 'setVisible'; id: string; visible: boolean; atMs: number }
  | { type: 'setSize'; id: string; size: OledTextSize; atMs: number }
  | { type: 'setAlign'; id: string; align: OledAlign; atMs: number }
  | { type: 'setTiming'; id: string; timing: OledItemTiming; atMs: number }
  | { type: 'restoreAllHidden'; atMs: number }
  | { type: 'setLoadingStyle'; style: OledLoadingStyle; atMs: number }
  | { type: 'setAnimationMs'; ms: number; atMs: number }
  | { type: 'reset' };

export function clampAnimation(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_ANIMATION_MS;
  return Math.min(MAX_ANIMATION_MS, Math.max(MIN_ANIMATION_MS, Math.round(ms)));
}

/** Live values a bound item reads. All `null` until something reports. */
export interface OledValues {
  readonly recognisedText: string | null;
  readonly statusText: string | null;
  readonly batteryText: string | null;
}

/**
 * The values used before any hardware exists.
 *
 * There is no battery in the telemetry the firmware sends, and no glyph for
 * one, so `batteryText` is `null` here and stays null — see
 * `docs/ble-protocol.md`. Rendering a full battery icon would be a claim about
 * hardware nobody has measured.
 */
export const UNREPORTED_VALUES: OledValues = {
  recognisedText: null,
  statusText: null,
  batteryText: null,
};

/** One positioned row of panel text. */
export interface OledRow {
  readonly itemId: string;
  readonly row: number;
  /** 1, or 2 for a double-height line. */
  readonly rows: number;
  readonly size: OledTextSize;
  readonly align: OledAlign;
  readonly text: string;
  /** True when `text` was cut to fit the panel's width. */
  readonly truncated: boolean;
}

export interface OledFrame {
  readonly rows: readonly OledRow[];
  /** Items that did not fit in the panel's 8 rows. Never silently dropped. */
  readonly overflow: readonly OledItem[];
  /** Rows used, 0..8. */
  readonly rowsUsed: number;
  /** The view this frame was built for. */
  readonly phase: OledPhase;
}

/**
 * The items a given view draws, in panel order.
 *
 * Exported because two callers need the same answer and must not disagree: the
 * frame builder below, and the animation timer, which has to know whether this
 * view actually contains a loading indicator before it schedules a wake-up.
 */
export function visibleItems(layout: OledLayout, phase: OledPhase): OledItem[] {
  return layout.items.filter(
    (item) => item.visible && (item.timing === 'always' || phase === 'startup'),
  );
}

/**
 * Places the layout's visible items on the panel grid, for one of its two views.
 *
 * `frame` is the animation frame index, passed in rather than read from a
 * clock, which keeps this pure and makes the loading animation testable at an
 * exact frame.
 *
 * `phase` defaults to the running view, because that is what the panel shows
 * for all but the first seconds of a session, and because a caller that has
 * never heard of the startup view should get the ordinary one.
 */
export function buildFrame(
  layout: OledLayout,
  values: OledValues,
  frame = 0,
  phase: OledPhase = 'persistent',
): OledFrame {
  const rows: OledRow[] = [];
  const overflow: OledItem[] = [];
  let cursor = 0;

  for (const item of visibleItems(layout, phase)) {
    const height = rowsFor(item);
    if (cursor + height > OLED_ROWS) {
      overflow.push(item);
      continue;
    }

    const maxChars = columnsFor(item.size);
    const raw = textFor(item, layout, values, frame);
    const text = raw.length > maxChars ? raw.slice(0, maxChars) : raw;

    rows.push({
      itemId: item.id,
      row: cursor,
      rows: height,
      size: item.size,
      align: item.align,
      text,
      truncated: text.length < raw.length,
    });

    cursor += height;
  }

  return { rows, overflow, rowsUsed: cursor, phase };
}

/**
 * The text an item contributes.
 *
 * Bound kinds fall back to `OLED_NO_VALUE` when their value is null, which is
 * the whole point: the panel says `--`, not `0` and not an empty row, because
 * "no reading" is a fact that deserves to be on screen.
 */
function textFor(
  item: OledItem,
  layout: OledLayout,
  values: OledValues,
  frame: number,
): string {
  switch (item.kind) {
    case 'title':
    case 'text':
      return item.label;
    case 'recognised':
      return values.recognisedText ?? OLED_NO_VALUE;
    case 'status':
      return values.statusText ?? OLED_NO_VALUE;
    case 'battery':
      return values.batteryText ?? OLED_NO_VALUE;
    case 'loading':
      return loadingGlyphs(layout.loadingStyle, frame);
  }
}

/**
 * The loading indicator, as characters.
 *
 * Returned as text rather than as a shape because the panel has no shapes — a
 * dotted indicator on an SSD1306 *is* a series of glyphs, so modelling it as
 * text means the preview and the panel agree by construction.
 */
export function loadingGlyphs(style: OledLoadingStyle, frame: number): string {
  switch (style) {
    case 'dots': {
      const count = (frame % 3) + 1;
      return '.'.repeat(count);
    }
    case 'bar': {
      // A four-cell block sweeping across an eight-cell track.
      const position = frame % 10;
      const cells = Array.from({ length: 8 }, (_unused, index) =>
        index >= position && index < position + 4 ? '#' : '-',
      );
      return cells.join('');
    }
    case 'none':
      return '';
  }
}

/** True when a layout differs from the defaults in any user-visible way. */
export function isCustomised(layout: OledLayout): boolean {
  const base = defaultLayout();
  return JSON.stringify({ ...layout, updatedAtMs: 0 }) !== JSON.stringify(base);
}

/** How many items are hidden, for the restore control's label. */
export function hiddenCount(layout: OledLayout): number {
  return layout.items.reduce((total, item) => (item.visible ? total : total + 1), 0);
}

/* ------------------------------------------------------------------ presets */

/**
 * ## Legacy: superseded by profiles
 *
 * A preset was a flat snapshot of the one layout the studio held. It could not
 * say which glove it was for, and it had no per-hand on/off, which is what the
 * product needs — a left and a right panel are configured separately.
 *
 * These three exports are kept for exactly one reason: a phone that has saved
 * presets must not lose them on the upgrade. `useOledStudio` reads them once,
 * converts each into a profile, and never writes them again. Nothing new
 * should call `parsePresets`; see `./profiles.ts` for the model that replaced
 * it.
 */
export const MAX_PRESETS = 6;

export interface OledPreset {
  readonly id: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly layout: OledLayout;
}

export function parsePresets(raw: unknown): OledPreset[] {
  if (!Array.isArray(raw)) return [];
  const presets: OledPreset[] = [];

  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string') continue;
    if (record.layout === undefined) continue;
    presets.push({
      id: record.id,
      name: record.name,
      createdAtMs: typeof record.createdAtMs === 'number' ? record.createdAtMs : 0,
      layout: parseLayout(record.layout),
    });
    if (presets.length >= MAX_PRESETS) break;
  }

  return presets;
}

/* ------------------------------------------------------------ deserialising */

const KIND_SET = new Set<string>(OLED_ITEM_KINDS);
const ALIGN_SET = new Set<string>(OLED_ALIGNS);
const SIZE_SET = new Set<string>(OLED_TEXT_SIZES);
const LOADING_SET = new Set<string>(OLED_LOADING_STYLES);
const TIMING_SET = new Set<string>(OLED_ITEM_TIMINGS);

function pickString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  return value.slice(0, maxLength);
}

/** Longest label the editor will store. The panel truncates anyway. */
export const MAX_LABEL_LENGTH = 32;

/**
 * Coerces untrusted stored JSON into a usable layout.
 *
 * Every field falls back independently, and an unreadable *item* is dropped
 * rather than poisoning the whole layout — the same rule as `parsePreferences`.
 * A stored layout is only ever produced by this app, but it is also only ever
 * read from disk, and a corrupt value must not be able to break the screen that
 * exists to repair it.
 */
export function parseLayout(raw: unknown): OledLayout {
  const base = defaultLayout();
  if (raw === null || typeof raw !== 'object') return base;
  const record = raw as Record<string, unknown>;

  const items: OledItem[] = [];
  if (Array.isArray(record.items)) {
    const seen = new Set<string>();
    for (const entry of record.items) {
      if (entry === null || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== 'string' || item.id.length === 0) continue;
      if (seen.has(item.id)) continue;
      if (typeof item.kind !== 'string' || !KIND_SET.has(item.kind)) continue;
      seen.add(item.id);

      items.push({
        id: item.id,
        kind: item.kind as OledItemKind,
        label: pickString(item.label, '', MAX_LABEL_LENGTH),
        // Anything other than an explicit `false` is treated as visible: a
        // lost flag must not make an item disappear silently.
        visible: item.visible !== false,
        size:
          typeof item.size === 'string' && SIZE_SET.has(item.size)
            ? (item.size as OledTextSize)
            : 'normal',
        align:
          typeof item.align === 'string' && ALIGN_SET.has(item.align)
            ? (item.align as OledAlign)
            : 'left',
        // A layout written before the startup view existed has no timing on any
        // item, and every one of those items was drawn for the whole session —
        // so `always` is not merely the safe fallback here, it is what those
        // items actually did.
        timing:
          typeof item.timing === 'string' && TIMING_SET.has(item.timing)
            ? (item.timing as OledItemTiming)
            : 'always',
      });

      if (items.length >= MAX_ITEM_COUNT) break;
    }
  }

  return {
    version: 1,
    items: items.length > 0 ? items : base.items,
    loadingStyle:
      typeof record.loadingStyle === 'string' && LOADING_SET.has(record.loadingStyle)
        ? (record.loadingStyle as OledLoadingStyle)
        : base.loadingStyle,
    animationMs:
      typeof record.animationMs === 'number'
        ? clampAnimation(record.animationMs)
        : base.animationMs,
    updatedAtMs: typeof record.updatedAtMs === 'number' ? record.updatedAtMs : 0,
  };
}
