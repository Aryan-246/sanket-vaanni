/**
 * The OLED profile model.
 *
 * Pure functions, so this runs without a renderer. What it pins down is the part
 * of the brief that is easy to state and easy to get wrong:
 *
 *  - a profile holds *both* hands, and nothing about editing one hand reaches the
 *    other;
 *  - "desired on" is a stored preference and never becomes a claim about
 *    hardware, so an unreadable value falls back to *off*;
 *  - a stored payload that is corrupt, duplicated or oversized is repaired rather
 *    than either accepted blindly or thrown away wholesale;
 *  - upgrading from the old single-layout install does not lose the user's work.
 */
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  INTRO_DURATION_PRESETS,
  MAX_INTRO_MS,
  MAX_PROFILES,
  MAX_PROFILE_NAME,
  clampIntroMs,
  copyProfile,
  defaultHandConfig,
  defaultProfile,
  migrateLegacy,
  nextProfileId,
  parseHand,
  parseProfile,
  parseStudio,
  startupViewIsDistinct,
  type OledProfile,
} from '../src/oled/profiles';
import { defaultLayout, type OledLayout } from '../src/oled/layout';

/* ------------------------------------------------------------------ fixtures */

function profile(overrides: Partial<OledProfile> = {}): OledProfile {
  return { ...defaultProfile(() => 1_000), ...overrides };
}

/** A layout distinguishable from the default, so ancestry is easy to assert. */
function customLayout(label: string): OledLayout {
  const base = defaultLayout();
  return {
    ...base,
    items: base.items.map((item, index) =>
      index === 0 ? { ...item, label } : { ...item },
    ),
  };
}

/* ------------------------------------------------------------------ defaults */

describe('the default profile', () => {
  it('exists before anything has been saved, with both hands off', () => {
    const fallback = defaultProfile(() => 5_000);

    expect(fallback.id).toBe(DEFAULT_PROFILE_ID);
    expect(fallback.name).toBe(DEFAULT_PROFILE_NAME);
    // Off, not on. A default that claimed to be on would be a claim about two
    // panels nobody has ever switched on.
    expect(fallback.left.enabled).toBe(false);
    expect(fallback.right.enabled).toBe(false);
  });

  it('gives each hand its own item array', () => {
    const fallback = defaultProfile();

    expect(fallback.left.layout.items).not.toBe(fallback.right.layout.items);
    expect(fallback.left.layout).not.toBe(fallback.right.layout);
  });

  it('has no battery row, because nothing has ever reported a percentage', () => {
    // The battery item kind still exists and can still be added — it is honest,
    // it draws `--`. What a *default* must not do is lead with a placeholder.
    const kinds = defaultLayout().items.map((item) => item.kind);

    expect(kinds).not.toContain('battery');
    expect(kinds).toContain('title');
    expect(kinds).toContain('status');
    expect(kinds).toContain('loading');
  });

  it('welcomes every hand to the running view, not the startup view', () => {
    // A default item in the startup view would disappear a moment after launch.
    for (const item of defaultLayout().items) {
      expect(item.timing).toBe('always');
    }
  });
});

/* ------------------------------------------------------------- intro clamping */

describe('the startup hold', () => {
  it('is bounded at both ends', () => {
    expect(clampIntroMs(-1)).toBe(0);
    expect(clampIntroMs(MAX_INTRO_MS + 5_000)).toBe(MAX_INTRO_MS);
    expect(clampIntroMs(1_500)).toBe(1_500);
  });

  it('falls back to a real number when handed a non-number', () => {
    expect(Number.isFinite(clampIntroMs(Number.NaN))).toBe(true);
    expect(Number.isFinite(clampIntroMs(Number.POSITIVE_INFINITY))).toBe(true);
  });

  it('offers Off as one of the presets, because no startup view is a choice', () => {
    expect(INTRO_DURATION_PRESETS).toContain(0);
  });

  it('knows when a hold would show nothing the running view does not', () => {
    const base = defaultLayout();
    expect(startupViewIsDistinct(base)).toBe(false);

    const withStartup = {
      ...base,
      items: base.items.map((item, index) =>
        index === 0 ? { ...item, timing: 'startup' as const } : item,
      ),
    };
    expect(startupViewIsDistinct(withStartup)).toBe(true);

    // Hidden startup items do not count: the panel would not draw them either.
    const hiddenStartup = {
      ...base,
      items: base.items.map((item) =>
        item.timing === 'startup' ? { ...item, visible: false } : item,
      ),
    };
    expect(startupViewIsDistinct(hiddenStartup)).toBe(false);
  });
});

/* ------------------------------------------------------------------ copying */

describe('copying a profile', () => {
  it('shares nothing with the original', () => {
    const original = profile();
    const copy = copyProfile(original);

    // Equal in value, different in identity — which is what makes editing the
    // copy unable to reach the original.
    expect(copy).toEqual(original);
    expect(copy.left.layout.items).not.toBe(original.left.layout.items);
    expect(copy.left.layout.items[0]).not.toBe(original.left.layout.items[0]);
    expect(copy.right.layout.items[0]).not.toBe(original.right.layout.items[0]);
    expect(copy.left.intro).not.toBe(original.left.intro);
  });
});

describe('profile ids', () => {
  it('never collides with an id already in use', () => {
    const existing = [profile({ id: 'pr100' }), profile({ id: 'pr100-1' })];
    const id = nextProfileId(existing, () => 100);

    expect(existing.map((entry) => entry.id)).not.toContain(id);
  });
});

/* --------------------------------------------------------------- reading disk */

describe('parseStudio', () => {
  it('reports nothing usable rather than inventing a profile', () => {
    // `null` is the signal to fall back to the defaults *and* to check the legacy
    // keys — not an error to paper over.
    expect(parseStudio(null)).toBeNull();
    expect(parseStudio(undefined)).toBeNull();
    expect(parseStudio('nonsense')).toBeNull();
    expect(parseStudio({})).toBeNull();
    expect(parseStudio({ profiles: [] })).toBeNull();
    expect(parseStudio({ profiles: 'not an array' })).toBeNull();
  });

  it('reads a stored set back', () => {
    const stored = {
      profiles: [
        { id: 'a', name: 'Class', left: { enabled: true }, right: { enabled: false } },
        { id: 'b', name: 'Home', left: {}, right: {} },
      ],
      activeId: 'b',
    };

    const parsed = parseStudio(stored);

    expect(parsed?.profiles.map((entry) => entry.name)).toEqual(['Class', 'Home']);
    expect(parsed?.activeId).toBe('b');
    expect(parsed?.profiles[0]?.left.enabled).toBe(true);
    expect(parsed?.profiles[0]?.right.enabled).toBe(false);
  });

  it('falls back to the first profile when the active id names nothing', () => {
    // A dangling active id must not produce a set with no active member, which
    // would leave the editor with nothing to edit.
    const parsed = parseStudio({
      profiles: [{ id: 'a', name: 'Class' }, { id: 'b', name: 'Home' }],
      activeId: 'deleted-already',
    });

    expect(parsed?.activeId).toBe('a');
  });

  it('drops entries it cannot use instead of losing the whole set', () => {
    const parsed = parseStudio({
      profiles: [
        null,
        'nonsense',
        { name: 'no id' },
        { id: '', name: 'empty id' },
        { id: 'ok', name: 'Kept' },
      ],
      activeId: 'ok',
    });

    expect(parsed?.profiles).toHaveLength(1);
    expect(parsed?.profiles[0]?.name).toBe('Kept');
  });

  it('keeps the first of two profiles sharing an id, and caps the list', () => {
    const many = Array.from({ length: MAX_PROFILES + 4 }, (_unused, index) => ({
      id: `p${index}`,
      name: `Profile ${index}`,
    }));

    const parsed = parseStudio({ profiles: [...many, { id: 'p0', name: 'Impostor' }] });

    expect(parsed?.profiles).toHaveLength(MAX_PROFILES);
    expect(parsed?.profiles.filter((entry) => entry.id === 'p0')).toHaveLength(1);
    expect(parsed?.profiles[0]?.name).toBe('Profile 0');
  });

  it('truncates an overlong name rather than rejecting the profile', () => {
    const parsed = parseStudio({
      profiles: [{ id: 'a', name: 'x'.repeat(200) }],
    });

    expect(parsed?.profiles[0]?.name).toHaveLength(MAX_PROFILE_NAME);
  });

  it('substitutes a name for a blank one, because a profile must be addressable', () => {
    const parsed = parseStudio({ profiles: [{ id: 'a', name: '   ' }] });

    expect(parsed?.profiles[0]?.name).toBe(DEFAULT_PROFILE_NAME);
  });
});

describe('parseHand', () => {
  it('is off and at its defaults when there is nothing to read', () => {
    const hand = parseHand(undefined);

    expect(hand.enabled).toBe(false);
    expect(hand.intro).toEqual(defaultHandConfig().intro);
    expect(hand.layout.items).toEqual(defaultLayout().items);
  });

  it('treats only an explicit true as on', () => {
    // Anything else is a corrupt or absent byte, and turning one into a claim
    // about a physical panel is exactly what this app must not do.
    expect(parseHand({ enabled: true }).enabled).toBe(true);
    expect(parseHand({ enabled: 'true' }).enabled).toBe(false);
    expect(parseHand({ enabled: 1 }).enabled).toBe(false);
    expect(parseHand({ enabled: false }).enabled).toBe(false);
  });

  it('keeps a bad intro from taking the layout down with it', () => {
    const hand = parseHand({
      enabled: true,
      intro: { durationMs: 'soon', animate: 'yes' },
      layout: { items: [{ id: 'o0', kind: 'text', label: 'KEPT' }] },
    });

    expect(hand.intro.durationMs).toBe(defaultHandConfig().intro.durationMs);
    expect(hand.layout.items).toHaveLength(1);
    expect(hand.layout.items[0]?.label).toBe('KEPT');
  });

  it('treats a missing animation flag as animating rather than as still', () => {
    // A lost flag must not silently stop the one animation the panel has.
    expect(parseHand({ intro: {} }).intro.animate).toBe(true);
    expect(parseHand({ intro: { animate: false } }).intro.animate).toBe(false);
  });

  it('clamps a stored hold that is out of range', () => {
    expect(parseHand({ intro: { durationMs: 999_999 } }).intro.durationMs).toBe(MAX_INTRO_MS);
    expect(parseHand({ intro: { durationMs: -4 } }).intro.durationMs).toBe(0);
  });

  it('treats an item written before the startup view existed as always shown', () => {
    const hand = parseHand({
      layout: { items: [{ id: 'o0', kind: 'title', label: 'OLD' }] },
    });

    // Not merely a safe fallback: those items *were* drawn for the whole session.
    expect(hand.layout.items[0]?.timing).toBe('always');
  });

  it('reads a startup item back as startup', () => {
    const hand = parseHand({
      layout: { items: [{ id: 'o0', kind: 'title', label: 'BOOT', timing: 'startup' }] },
    });

    expect(hand.layout.items[0]?.timing).toBe('startup');
  });
});

describe('parseProfile', () => {
  it('refuses an entry with no id, because it could not be addressed', () => {
    expect(parseProfile(null)).toBeNull();
    expect(parseProfile({ name: 'No id' })).toBeNull();
    expect(parseProfile({ id: '' })).toBeNull();
    expect(parseProfile({ id: 'a' })).not.toBeNull();
  });
});

/* ---------------------------------------------------------------- migration */

describe('migrating a pre-profile install', () => {
  it('yields one default profile when there is nothing to migrate', () => {
    const migrated = migrateLegacy(null, null, () => 1_000);

    expect(migrated.profiles).toHaveLength(1);
    expect(migrated.profiles[0]?.id).toBe(DEFAULT_PROFILE_ID);
    expect(migrated.activeId).toBe(DEFAULT_PROFILE_ID);
  });

  it('keeps the live layout as the active profile, on both hands', () => {
    const migrated = migrateLegacy(customLayout('FROM THE OLD STUDIO'), null, () => 1_000);

    expect(migrated.profiles).toHaveLength(1);
    expect(migrated.activeId).toBe(DEFAULT_PROFILE_ID);
    // The old studio applied its one layout to whichever hand you were
    // previewing, so "both" is what a migration to two hands means.
    expect(migrated.profiles[0]?.left.layout.items[0]?.label).toBe('FROM THE OLD STUDIO');
    expect(migrated.profiles[0]?.right.layout.items[0]?.label).toBe('FROM THE OLD STUDIO');
  });

  it('does not let the two migrated hands share an item array', () => {
    const migrated = migrateLegacy(customLayout('SHARED?'), null, () => 1_000);
    const head = migrated.profiles[0] as OledProfile;

    expect(head.left.layout.items).not.toBe(head.right.layout.items);
    expect(head.left.layout.items[0]).not.toBe(head.right.layout.items[0]);
  });

  it('turns each preset into a profile of its own', () => {
    const migrated = migrateLegacy(
      customLayout('LIVE'),
      [
        { id: 'p1', name: 'Evening class', layout: customLayout('EVENING') },
        { id: 'p2', name: 'Morning', layout: customLayout('MORNING') },
      ],
      () => 1_000,
    );

    expect(migrated.profiles.map((entry) => entry.name)).toEqual([
      DEFAULT_PROFILE_NAME,
      'Evening class',
      'Morning',
    ]);
    // The live layout stays active: it is what the user was looking at.
    expect(migrated.activeId).toBe(DEFAULT_PROFILE_ID);
    expect(migrated.profiles[1]?.left.layout.items[0]?.label).toBe('EVENING');
    expect(migrated.profiles[2]?.right.layout.items[0]?.label).toBe('MORNING');
  });

  it('still migrates presets when the live layout is missing', () => {
    const migrated = migrateLegacy(null, [
      { id: 'p1', name: 'Only presets', layout: customLayout('PRESET') },
    ]);

    expect(migrated.profiles).toHaveLength(2);
    expect(migrated.profiles[1]?.name).toBe('Only presets');
  });

  it('ignores junk in the preset list and stays within the profile limit', () => {
    const presets = [
      null,
      { name: 'no id' },
      ...Array.from({ length: 20 }, (_unused, index) => ({
        id: `p${index}`,
        name: `Preset ${index}`,
        layout: customLayout(`P${index}`),
      })),
    ];

    const migrated = migrateLegacy(customLayout('LIVE'), presets, () => 1_000);

    expect(migrated.profiles.length).toBeLessThanOrEqual(MAX_PROFILES);
    // Always at least the live layout, whatever the presets looked like.
    expect(migrated.profiles[0]?.id).toBe(DEFAULT_PROFILE_ID);
  });
});
