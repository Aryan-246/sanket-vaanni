/**
 * The OLED layout model.
 *
 * Pure functions, so this runs without a renderer. The properties asserted here
 * are the ones that keep the preview honest about the physical panel:
 *
 *  - the panel is 128×64 in a 6×8 glyph grid, so the model refuses to show a
 *    layout the panel could not draw — overlong lines are cut *and flagged*,
 *    and rows that do not fit are reported instead of being dropped;
 *  - a bound value that has not reported renders as `--`, never as a zero and
 *    never as a blank row;
 *  - nothing here encodes a command or claims a panel was written to.
 */
import {
  ANIMATION_SPEEDS,
  DEFAULT_ANIMATION_MS,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  MAX_ANIMATION_MS,
  MAX_ITEM_COUNT,
  MAX_LABEL_LENGTH,
  MAX_PRESETS,
  MIN_ANIMATION_MS,
  OLED_COLUMNS,
  OLED_HEIGHT,
  OLED_NO_VALUE,
  OLED_ROWS,
  OLED_WIDTH,
  UNREPORTED_VALUES,
  buildFrame,
  clampAnimation,
  columnsFor,
  defaultLayout,
  hiddenCount,
  isCustomised,
  loadingGlyphs,
  nextItemId,
  oledReducer,
  parseLayout,
  parsePresets,
  rowsFor,
  type OledItem,
  type OledLayout,
} from '../src/oled/layout';
import { oledValuesFrom } from '../src/oled/values';
import { INITIAL_LINK, type LinkState } from '../src/ble/link';
import { MOCK_DEVICE_NAME } from '../src/ble/types';
import type { GloveSnapshot } from '../src/ble/controller';

/* ------------------------------------------------------------------ fixtures */

/** An item, defaulted so each case states only what it is about. */
function item(overrides: Partial<OledItem> = {}): OledItem {
  return {
    id: 'o0',
    kind: 'text',
    label: 'HELLO',
    visible: true,
    size: 'normal',
    align: 'left',
    // The running view, which is what most cases are about. The startup view has
    // its own block below.
    timing: 'always',
    ...overrides,
  };
}

/** A layout with just the items given, so frames are easy to reason about. */
function layout(items: OledItem[], overrides: Partial<OledLayout> = {}): OledLayout {
  return {
    version: 1,
    items,
    loadingStyle: 'dots',
    animationMs: DEFAULT_ANIMATION_MS,
    updatedAtMs: 0,
    ...overrides,
  };
}

const NO_VALUES = UNREPORTED_VALUES;

/* --------------------------------------------------------------- geometry */

describe('panel geometry', () => {
  it('models a 128×64 panel as a 21×8 glyph grid', () => {
    // 6×8 is the SSD1306 text-mode cell, and the grid is what a layout has to be
    // expressible in for the firmware to draw it.
    expect(OLED_WIDTH).toBe(128);
    expect(OLED_HEIGHT).toBe(64);
    expect(GLYPH_WIDTH * OLED_COLUMNS).toBeLessThanOrEqual(OLED_WIDTH);
    expect(GLYPH_HEIGHT * OLED_ROWS).toBe(OLED_HEIGHT);
  });

  it('halves the character budget for a double-height line', () => {
    expect(columnsFor('normal')).toBe(OLED_COLUMNS);
    expect(columnsFor('large')).toBe(Math.floor(OLED_COLUMNS / 2));
  });

  it('counts a double-height item as two rows and an indicator as one', () => {
    expect(rowsFor(item({ size: 'large' }))).toBe(2);
    expect(rowsFor(item({ size: 'normal' }))).toBe(1);
    // The indicator is deliberately one row however it is styled, so adding it
    // cannot push a layout over the panel's height by surprise.
    expect(rowsFor(item({ kind: 'loading', size: 'large' }))).toBe(1);
  });
});

/* ---------------------------------------------------------------- the frame */

describe('buildFrame', () => {
  it('places visible items at increasing row offsets', () => {
    const frame = buildFrame(
      layout([item({ id: 'o0' }), item({ id: 'o1', kind: 'status', size: 'large' })]),
      NO_VALUES,
    );

    expect(frame.rows.map((row) => row.row)).toEqual([0, 1]);
    expect(frame.rows[0]?.size).toBe('normal');
    expect(frame.rows[1]?.rows).toBe(2);
    expect(frame.rowsUsed).toBe(3);
  });

  it('skips hidden items without leaving a gap', () => {
    // Hiding is not deleting: the item stays in the layout but occupies no
    // space on the panel.
    const frame = buildFrame(
      layout([
        item({ id: 'o0' }),
        item({ id: 'o1', visible: false }),
        item({ id: 'o2', label: 'THIRD' }),
      ]),
      NO_VALUES,
    );

    expect(frame.rows.map((row) => row.itemId)).toEqual(['o0', 'o2']);
    expect(frame.rows.map((row) => row.row)).toEqual([0, 1]);
  });

  it('reports items that do not fit instead of dropping them silently', () => {
    // Nine single-height rows into an eight-row panel.
    const items = Array.from({ length: 9 }, (_unused, index) => item({ id: `o${index}` }));
    const frame = buildFrame(layout(items), NO_VALUES);

    expect(frame.rowsUsed).toBe(OLED_ROWS);
    expect(frame.rows).toHaveLength(8);
    expect(frame.overflow.map((overflowed) => overflowed.id)).toEqual(['o8']);
  });

  it('cuts a line to the panel width and says that it cut it', () => {
    const long = 'A'.repeat(40);
    const frame = buildFrame(layout([item({ label: long })]), NO_VALUES);
    const row = frame.rows[0]!;

    expect(row.text).toHaveLength(OLED_COLUMNS);
    expect(row.truncated).toBe(true);
  });

  it('does not flag a line that happened to fit exactly', () => {
    const exact = 'B'.repeat(OLED_COLUMNS);
    const row = buildFrame(layout([item({ label: exact })]), NO_VALUES).rows[0]!;

    expect(row.text).toBe(exact);
    expect(row.truncated).toBe(false);
  });

  it('draws a bound value with no reading as the placeholder, never as a zero', () => {
    // The whole reason `OLED_NO_VALUE` exists. A blank row and a row with
    // nothing behind it must not look the same, and `0` would be a reading
    // nobody took.
    const frame = buildFrame(
      layout([
        item({ id: 'o0', kind: 'battery' }),
        item({ id: 'o1', kind: 'status' }),
        item({ id: 'o2', kind: 'recognised' }),
      ]),
      NO_VALUES,
    );

    expect(frame.rows.map((row) => row.text)).toEqual([
      OLED_NO_VALUE,
      OLED_NO_VALUE,
      OLED_NO_VALUE,
    ]);
    expect(frame.rows.some((row) => row.text === '0')).toBe(false);
  });

  it('shows a bound value once one is reported', () => {
    const frame = buildFrame(layout([item({ id: 'o0', kind: 'recognised' })]), {
      recognisedText: 'नमस्ते',
      statusText: 'DEMO',
      batteryText: null,
    });

    expect(frame.rows[0]?.text).toBe('नमस्ते');
  });

  it('ignores an authored label on a bound kind', () => {
    // A bound kind reads from the glove. A stale authored string must never be
    // what the panel shows.
    const frame = buildFrame(
      layout([item({ kind: 'status', label: 'NOT THIS' })]),
      NO_VALUES,
    );

    expect(frame.rows[0]?.text).toBe(OLED_NO_VALUE);
  });

  it('uses the authored label for title and text', () => {
    const frame = buildFrame(
      layout([item({ id: 'o0', kind: 'title', label: 'SANKET' }), item({ id: 'o1', label: 'HI' })]),
      NO_VALUES,
    );

    expect(frame.rows.map((row) => row.text)).toEqual(['SANKET', 'HI']);
  });

  it('is empty for an empty layout rather than failing', () => {
    const frame = buildFrame(layout([]), NO_VALUES);

    expect(frame.rows).toEqual([]);
    expect(frame.rowsUsed).toBe(0);
    expect(frame.overflow).toEqual([]);
  });
});

/* ------------------------------------------------------------- the indicator */

describe('loadingGlyphs', () => {
  it('cycles one, two and three dots', () => {
    expect(loadingGlyphs('dots', 0)).toBe('.');
    expect(loadingGlyphs('dots', 1)).toBe('..');
    expect(loadingGlyphs('dots', 2)).toBe('...');
    expect(loadingGlyphs('dots', 3)).toBe('.');
  });

  it('sweeps a four-cell block across an eight-cell track', () => {
    const at = (frame: number): string => loadingGlyphs('bar', frame);

    expect(at(0)).toBe('####----');
    expect(at(4)).toBe('----####');
    // Ten frames, so the sweep closes without a jump.
    expect(at(10)).toBe(at(0));
  });

  it('contributes nothing when the style is none', () => {
    // An empty string here is a real choice: the row still occupies its place,
    // so turning the indicator off does not reflow the panel.
    expect(loadingGlyphs('none', 5)).toBe('');
  });

  it('puts the indicator on the panel as text', () => {
    // An SSD1306 has no shapes, so a dotted indicator *is* a series of glyphs.
    const frame = buildFrame(
      layout([item({ kind: 'loading' })], { loadingStyle: 'dots' }),
      NO_VALUES,
      1,
    );

    expect(frame.rows[0]?.text).toBe('..');
  });
});

/* --------------------------------------------------------------- the reducer */

describe('oledReducer', () => {
  it('appends a new item with a fresh id and stamps the change', () => {
    const next = oledReducer(layout([item({ id: 'o0' })]), {
      type: 'add',
      kind: 'battery',
      atMs: 500,
    });

    expect(next.items).toHaveLength(2);
    expect(next.items[1]?.id).toBe('o1');
    expect(next.items[1]?.kind).toBe('battery');
    expect(next.updatedAtMs).toBe(500);
  });

  it('refuses to grow past the item limit', () => {
    const full = layout(
      Array.from({ length: MAX_ITEM_COUNT }, (_unused, index) => item({ id: `o${index}` })),
    );
    const next = oledReducer(full, { type: 'add', kind: 'text', atMs: 500 });

    expect(next).toBe(full);
  });

  it('derives the next id from the layout, so a loaded preset cannot collide', () => {
    expect(nextItemId(defaultLayout())).toBe('o4');
    expect(nextItemId(layout([item({ id: 'o9' })]))).toBe('o10');
    // An id that does not match the pattern does not shift the counter.
    expect(nextItemId(layout([item({ id: 'custom' })]))).toBe('o0');
  });

  it('removes an item', () => {
    const next = oledReducer(
      layout([item({ id: 'o0' }), item({ id: 'o1' })]),
      { type: 'remove', id: 'o0', atMs: 500 },
    );

    expect(next.items.map((entry) => entry.id)).toEqual(['o1']);
  });

  it('moves an item one position, and does not move past either end', () => {
    const two = layout([item({ id: 'o0' }), item({ id: 'o1' })]);

    expect(oledReducer(two, { type: 'move', id: 'o0', direction: 'down', atMs: 1 }).items.map((i) => i.id)).toEqual(['o1', 'o0']);
    expect(oledReducer(two, { type: 'move', id: 'o0', direction: 'up', atMs: 1 })).toBe(two);
    expect(oledReducer(two, { type: 'move', id: 'o1', direction: 'down', atMs: 1 })).toBe(two);
  });

  it('steps over a hidden item, so one press is always one visible position', () => {
    // With straight visible-index arithmetic a move could hop a hidden row and
    // look like it did nothing.
    const three = layout([
      item({ id: 'o0' }),
      item({ id: 'o1', visible: false }),
      item({ id: 'o2' }),
    ]);
    const next = oledReducer(three, { type: 'move', id: 'o0', direction: 'down', atMs: 1 });

    expect(next.items.map((entry) => entry.id)).toEqual(['o1', 'o0', 'o2']);
    expect(next.items[1]?.visible).toBe(true);
  });

  it('ignores a move for an unknown id', () => {
    const base = layout([item({ id: 'o0' })]);
    expect(oledReducer(base, { type: 'move', id: 'nope', direction: 'up', atMs: 1 })).toBe(base);
  });

  it('edits a label', () => {
    const next = oledReducer(layout([item({ id: 'o0' })]), {
      type: 'setLabel',
      id: 'o0',
      label: 'CHANGED',
      atMs: 1,
    });

    expect(next.items[0]?.label).toBe('CHANGED');
  });

  it('keeps an item in place when its kind changes', () => {
    // The point of the control: turning a text line into a status line should
    // not send it to the bottom of the panel.
    const next = oledReducer(
      layout([item({ id: 'o0' }), item({ id: 'o1', kind: 'text' })]),
      { type: 'setKind', id: 'o1', kind: 'status', atMs: 1 },
    );

    expect(next.items[1]?.kind).toBe('status');
    expect(next.items[1]?.id).toBe('o1');
  });

  it('drops the authored label when the kind becomes bound', () => {
    // A bound kind's text comes from the glove, so keeping a stale string would
    // be data the editor could never reach.
    const next = oledReducer(
      layout([item({ id: 'o0', kind: 'text', label: 'HELLO' })]),
      { type: 'setKind', id: 'o0', kind: 'battery', atMs: 1 },
    );

    expect(next.items[0]?.label).toBe('');
  });

  it('keeps the label when the kind stays authored', () => {
    const next = oledReducer(
      layout([item({ id: 'o0', kind: 'text', label: 'HELLO' })]),
      { type: 'setKind', id: 'o0', kind: 'title', atMs: 1 },
    );

    expect(next.items[0]?.label).toBe('HELLO');
  });

  it('is a no-op when the kind is unchanged', () => {
    const base = layout([item({ id: 'o0', kind: 'text' })]);
    expect(oledReducer(base, { type: 'setKind', id: 'o0', kind: 'text', atMs: 1 })).toBe(base);
  });

  it('hides an item without removing it, and brings it back', () => {
    const hidden = oledReducer(layout([item({ id: 'o0' })]), {
      type: 'setVisible',
      id: 'o0',
      visible: false,
      atMs: 1,
    });

    expect(hidden.items).toHaveLength(1);
    expect(hidden.items[0]?.visible).toBe(false);
    expect(hiddenCount(hidden)).toBe(1);

    const restored = oledReducer(hidden, { type: 'setVisible', id: 'o0', visible: true, atMs: 2 });
    expect(restored.items[0]?.visible).toBe(true);
  });

  it('restores every hidden item at once, and does nothing when none are hidden', () => {
    const mixed = layout([
      item({ id: 'o0', visible: false }),
      item({ id: 'o1', visible: false }),
      item({ id: 'o2' }),
    ]);
    const restored = oledReducer(mixed, { type: 'restoreAllHidden', atMs: 9 });

    expect(restored.items.every((entry) => entry.visible)).toBe(true);
    expect(hiddenCount(restored)).toBe(0);
    // Identity, not equality: a redundant state update would re-render the
    // whole list for nothing.
    expect(oledReducer(restored, { type: 'restoreAllHidden', atMs: 10 })).toBe(restored);
  });

  it('sets size and alignment independently', () => {
    const base = layout([item({ id: 'o0' })]);
    const sized = oledReducer(base, { type: 'setSize', id: 'o0', size: 'large', atMs: 1 });
    const aligned = oledReducer(sized, { type: 'setAlign', id: 'o0', align: 'right', atMs: 2 });

    expect(aligned.items[0]?.size).toBe('large');
    expect(aligned.items[0]?.align).toBe('right');
  });

  it('sets the indicator style and the frame period', () => {
    const base = layout([]);
    const styled = oledReducer(base, { type: 'setLoadingStyle', style: 'bar', atMs: 1 });

    expect(styled.loadingStyle).toBe('bar');

    for (const ms of ANIMATION_SPEEDS) {
      expect(oledReducer(base, { type: 'setAnimationMs', ms, atMs: 1 }).animationMs).toBe(ms);
    }
  });

  it('clamps the frame period, and ignores one that is already in force', () => {
    expect(clampAnimation(1)).toBe(MIN_ANIMATION_MS);
    expect(clampAnimation(999_999)).toBe(MAX_ANIMATION_MS);
    expect(clampAnimation(Number.NaN)).toBe(DEFAULT_ANIMATION_MS);
    expect(clampAnimation(400.4)).toBe(400);

    const base = layout([], { animationMs: MIN_ANIMATION_MS });
    // A value inside the clamp is stored as-is; one below it lands on the
    // floor, which is what is already set, so no update happens at all.
    expect(oledReducer(base, { type: 'setAnimationMs', ms: 10, atMs: 1 })).toBe(base);
  });

  it('returns the defaults on reset, discarding customisation', () => {
    const custom = oledReducer(defaultLayout(), { type: 'remove', id: 'o1', atMs: 1 });
    const reset = oledReducer(custom, { type: 'reset' });

    expect(reset).toEqual(defaultLayout());
    expect(reset.updatedAtMs).toBe(0);
  });

  it('never mutates the layout it was given', () => {
    const base = layout([item({ id: 'o0' }), item({ id: 'o1' })]);
    const snapshot = JSON.stringify(base);

    oledReducer(base, { type: 'remove', id: 'o0', atMs: 1 });
    oledReducer(base, { type: 'move', id: 'o0', direction: 'down', atMs: 1 });
    oledReducer(base, { type: 'setVisible', id: 'o0', visible: false, atMs: 1 });

    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

/* -------------------------------------------------------------- customisation */

describe('defaults, and knowing when they have changed', () => {
  it('uses a modest default layout with a working control for every item', () => {
    const base = defaultLayout();

    expect(base.items).toHaveLength(4);
    expect(base.items.every((entry) => entry.visible)).toBe(true);
    expect(base.loadingStyle).toBe('dots');
    expect(isCustomised(base)).toBe(false);
  });

  it('leaves the bottom half of the panel free by default', () => {
    // Four rows used of eight, so a user adding an item is not immediately over
    // the panel's height.
    expect(buildFrame(defaultLayout(), NO_VALUES).rowsUsed).toBeLessThan(OLED_ROWS);
  });

  it('notices any user-visible change', () => {
    const base = defaultLayout();

    expect(isCustomised(oledReducer(base, { type: 'remove', id: 'o1', atMs: 1 }))).toBe(true);
    expect(isCustomised(oledReducer(base, { type: 'setVisible', id: 'o1', visible: false, atMs: 1 }))).toBe(true);
    expect(isCustomised(oledReducer(base, { type: 'setAlign', id: 'o1', align: 'center', atMs: 1 }))).toBe(true);
    expect(isCustomised(oledReducer(base, { type: 'setLoadingStyle', style: 'none', atMs: 1 }))).toBe(true);
    expect(isCustomised(oledReducer(base, { type: 'setAnimationMs', ms: 1200, atMs: 1 }))).toBe(true);
  });

  it('does not count the timestamp as a customisation', () => {
    // Every edit stamps `updatedAtMs`; if that counted, the reset control would
    // be offered on an untouched layout.
    const base = defaultLayout();
    expect(isCustomised({ ...base, updatedAtMs: 1_700_000_000_000 })).toBe(false);
  });
});

/* -------------------------------------------------------------- stored layout */

describe('parseLayout', () => {
  it('falls back to the defaults for anything unreadable', () => {
    for (const raw of [null, undefined, 42, 'layout', true]) {
      expect(parseLayout(raw)).toEqual(defaultLayout());
    }
  });

  it('drops an unreadable item rather than poisoning the whole layout', () => {
    // The same rule as `parsePreferences`: one bad entry must not cost the user
    // everything, especially on the screen that exists to repair it.
    const parsed = parseLayout({
      items: [
        { id: 'o0', kind: 'text', label: 'KEEP' },
        { id: '', kind: 'text' },
        { kind: 'text' },
        { id: 'o2', kind: 'not-a-kind' },
        'nonsense',
        null,
        { id: 'o3', kind: 'status' },
      ],
    });

    expect(parsed.items.map((entry) => entry.id)).toEqual(['o0', 'o3']);
  });

  it('drops a duplicate id, which would break the list key', () => {
    const parsed = parseLayout({
      items: [
        { id: 'o0', kind: 'text', label: 'FIRST' },
        { id: 'o0', kind: 'status' },
      ],
    });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.label).toBe('FIRST');
  });

  it('treats a lost visibility flag as visible', () => {
    // A missing flag must not make an item disappear silently.
    const parsed = parseLayout({ items: [{ id: 'o0', kind: 'text' }, { id: 'o1', kind: 'text', visible: false }] });

    expect(parsed.items[0]?.visible).toBe(true);
    expect(parsed.items[1]?.visible).toBe(false);
  });

  it('substitutes defaults for an unusable size or alignment', () => {
    const parsed = parseLayout({ items: [{ id: 'o0', kind: 'text', size: 'huge', align: 'middle' }] });

    expect(parsed.items[0]?.size).toBe('normal');
    expect(parsed.items[0]?.align).toBe('left');
  });

  it('caps a label rather than storing unbounded text', () => {
    const parsed = parseLayout({ items: [{ id: 'o0', kind: 'text', label: 'x'.repeat(500) }] });

    expect(parsed.items[0]?.label).toHaveLength(MAX_LABEL_LENGTH);
  });

  it('caps the item count', () => {
    const parsed = parseLayout({
      items: Array.from({ length: 40 }, (_unused, index) => ({ id: `o${index}`, kind: 'text' })),
    });

    expect(parsed.items).toHaveLength(MAX_ITEM_COUNT);
  });

  it('uses the default items when none survived, so the panel is never empty', () => {
    expect(parseLayout({ items: [] }).items).toEqual(defaultLayout().items);
    expect(parseLayout({ items: [{ id: 'o0', kind: 'bogus' }] }).items).toEqual(defaultLayout().items);
  });

  it('clamps a stored frame period and rejects an unusable style', () => {
    const parsed = parseLayout({ items: [], loadingStyle: 'flashing', animationMs: 999_999 });

    expect(parsed.loadingStyle).toBe('dots');
    expect(parsed.animationMs).toBe(MAX_ANIMATION_MS);
  });

  it('round-trips a real layout through JSON unchanged', () => {
    // What is written must be what is read back, or every restart quietly
    // rewrites the user's layout.
    const custom = oledReducer(
      oledReducer(defaultLayout(), { type: 'add', kind: 'loading', atMs: 1 }),
      { type: 'setAlign', id: 'o0', align: 'right', atMs: 2 },
    );

    expect(parseLayout(JSON.parse(JSON.stringify(custom)))).toEqual(custom);
  });
});

/* ------------------------------------------------------------------ presets */

describe('parsePresets', () => {
  it('reads presets and caps how many it will keep', () => {
    const raw = Array.from({ length: 10 }, (_unused, index) => ({
      id: `p${index}`,
      name: `Preset ${index}`,
      createdAtMs: index,
      layout: defaultLayout(),
    }));

    const presets = parsePresets(raw);
    expect(presets).toHaveLength(MAX_PRESETS);
    expect(presets[0]?.name).toBe('Preset 0');
  });

  it('skips an entry that is not a preset', () => {
    const presets = parsePresets([
      null,
      { id: 'p0' },
      { name: 'no id' },
      { id: 'p1', name: 'Good', layout: defaultLayout() },
      // A preset with no layout behind it is not a preset: there would be
      // nothing to apply.
      { id: 'p2', name: 'No layout' },
    ]);

    expect(presets.map((preset) => preset.id)).toEqual(['p1']);
    // A missing timestamp is not a reason to lose the preset.
    expect(presets[0]?.createdAtMs).toBe(0);
  });

  it('repairs a preset whose layout is unreadable', () => {
    const presets = parsePresets([{ id: 'p0', name: 'Broken', layout: 'nonsense' }]);

    expect(presets[0]?.layout).toEqual(defaultLayout());
  });

  it('returns nothing for a non-array', () => {
    expect(parsePresets(null)).toEqual([]);
    expect(parsePresets({})).toEqual([]);
  });
});

/* ------------------------------------------------------------------- values */

describe('oledValuesFrom', () => {
  const link = (overrides: Partial<LinkState>): LinkState => ({ ...INITIAL_LINK, ...overrides });

  function glove(overrides: Partial<GloveSnapshot> = {}): GloveSnapshot {
    return {
      side: 'right',
      link: INITIAL_LINK,
      source: 'none',
      raw: null,
      calibrated: null,
      lastPacketAtMs: null,
      packetCount: 0,
      transportName: 'test',
      synthetic: false,
      available: false,
      ...overrides,
    };
  }

  it('always reports no battery, because no pack has ever reported one', () => {
    // A full battery glyph would be a claim about hardware nobody measured.
    expect(oledValuesFrom(glove(), { kind: 'idle' }).batteryText).toBeNull();
  });

  it('puts only a presented result on the panel', () => {
    // An uncertain candidate is not text the user has been shown. Presenting it
    // on the display would be showing a guess as a result.
    const uncertain = oledValuesFrom(glove(), {
      kind: 'uncertain',
      profileId: 'isl',
      candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.42 },
      hands: ['right'],
    });
    const result = oledValuesFrom(glove(), {
      kind: 'result',
      profileId: 'isl',
      candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.93 },
      hands: ['right'],
    });

    expect(uncertain.recognisedText).toBeNull();
    expect(result.recognisedText).toBe('नमस्ते');
  });

  it('does not put another hand’s sign on this glove’s panel', () => {
    // Recognition is no longer per-glove: there is one shared outcome. Without
    // the side check a left-hand sign would be drawn on the right glove's
    // display as well, which would be the panel claiming a measurement its own
    // hand never produced.
    const leftOnly = oledValuesFrom(glove(), {
      kind: 'result',
      profileId: 'isl',
      candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.93 },
      hands: ['left'],
    });
    const both = oledValuesFrom(glove(), {
      kind: 'result',
      profileId: 'isl',
      candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.93 },
      hands: ['left', 'right'],
    });

    expect(leftOnly.recognisedText).toBeNull();
    // A two-handed sign belongs to both panels, so this one does show it.
    expect(both.recognisedText).toBe('नमस्ते');
  });

  it('carries the demo warning onto the panel', () => {
    // A glove whose readings are simulated must say so on its own display, not
    // only on the phone.
    const simulated = oledValuesFrom(
      glove({
        link: link({ kind: 'connected', deviceId: 'demo-right', deviceName: MOCK_DEVICE_NAME }),
        source: 'simulated',
      }),
      { kind: 'idle' },
    );

    expect(simulated.statusText).toBe('DEMO');
  });

  it('uses a short status that fits the narrowest line the panel can draw', () => {
    const states: LinkState['kind'][] = [
      'idle',
      'nearby',
      'scanning',
      'connecting',
      'disconnected',
      'unavailable',
      'error',
    ];

    for (const kind of states) {
      const values = oledValuesFrom(glove({ link: link({ kind }) }), { kind: 'idle' });
      expect(values.statusText).not.toBeNull();
      // A double-height row holds ten characters and is the narrowest a layout
      // can produce, so a status that fits it can never be truncated.
      expect(values.statusText!.length).toBeLessThanOrEqual(columnsFor('large'));
    }
  });
});
