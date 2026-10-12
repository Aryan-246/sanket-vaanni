/**
 * OLED Studio and its profiles, as a user operates them.
 *
 * Driven through the real app: the tab bar, the panel switch, the rows, the
 * editor sheet, the profile sheet and the confirmation dialogs. The behaviour
 * under test is the part of the brief that is easy to claim and hard to honour —
 * that the two panels are configured independently, that hiding is not deleting,
 * that a reset which discards customisation asks first, that a profile survives a
 * restart, that operating on one profile does not alter another, and that nothing
 * on this screen pretends a physical panel changed.
 */
import ReactTestRenderer from 'react-test-renderer';

import { TextField } from '../src/components/TextField';
import { featureKeys, createInMemoryStorage, type Storage } from '../src/storage';
import { defaultLayout } from '../src/oled/layout';
import { pressByLabel, renderApp, renderedText, teardown } from './support';

/* ------------------------------------------------------------------ helpers */

/**
 * Timers are fake for the whole file, and back to real afterwards.
 *
 * This is not about the coalesced write, though it flushes that too. It is about
 * every control on this screen that dismisses through an animation: a `Sheet`
 * stays mounted until its exit animation finishes, and under real timers that
 * animation can still be in flight when the test ends — firing its state update
 * into a torn-down environment and failing whichever test happened to finish
 * first. Faking the clock makes the exit deterministic instead of racy.
 *
 * Restoring real timers afterwards is equally deliberate: without it, a
 * *failing* case would skip its own `jest.useRealTimers()` and hand fake timers
 * to the next file's tests.
 */
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * The restore control's label, which is singular for one hidden item.
 *
 * Named once because it is asserted in several places, and because the count is
 * part of the wording — a plural here would describe a control the user never
 * sees.
 */
const RESTORE_ONE = 'Restore 1 hidden item';

/** Whether the studio is offering to restore a hidden item. */
function offersRestore(renderer: ReactTestRenderer.ReactTestRenderer): boolean {
  return /Restore \d+ hidden/.test(renderedText(renderer));
}

/**
 * Whether the control with this accessible name is currently disabled.
 *
 * Props thread through `ActionButton` to `Pressable` to the host `View`, so the
 * label lands on several nodes and only some carry the accessibility state. Any
 * one of them saying disabled is the answer.
 */
function isDisabledByLabel(
  renderer: ReactTestRenderer.ReactTestRenderer,
  accessibilityLabel: string,
): boolean {
  return renderer.root
    .findAllByProps({ accessibilityLabel })
    .some((node) => node.props.accessibilityState?.disabled === true);
}

/**
 * Whether a segmented option is the selected one.
 *
 * Read from the control's own accessibility state rather than from a style, so
 * this asserts what the screen *announces* — which is what a screen-reader user
 * has to go on, and what a colour-only difference would fail to convey.
 */
function isSelectedByLabel(
  renderer: ReactTestRenderer.ReactTestRenderer,
  accessibilityLabel: string,
): boolean {
  return renderer.root
    .findAllByProps({ accessibilityLabel })
    .some((node) => node.props.accessibilityState?.selected === true);
}

async function openStudio(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await pressByLabel(renderer, 'OLED');
}

async function openProfiles(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await pressByLabel(renderer, 'Manage OLED profiles');
}

/**
 * Hides one item's row, which is the shortest path to a customised layout.
 *
 * `Status` because it is in the default layout and its value is not what the
 * test is about — hiding it changes nothing except the layout.
 */
async function hideStatusRow(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await pressByLabel(renderer, 'Status');
  await pressByLabel(renderer, 'Show Status on the panel');
  await pressByLabel(renderer, 'Done');
}

/** Types into the field with this label, standing in for a keystroke per character. */
async function typeInto(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
  text: string,
): Promise<void> {
  const field = renderer.root
    .findAllByType(TextField)
    .find((candidate) => candidate.props.label === label);

  if (field === undefined) throw new Error(`No text field labelled "${label}".`);

  await ReactTestRenderer.act(async () => {
    field.props.onChangeText(text);
  });
}

/**
 * Commits the studio's draft.
 *
 * Every edit on this screen is transactional: it moves the working copy that
 * the preview renders and touches nothing else. Only Save — the pinned bar —
 * replaces the stored profile. A case that asserts on storage therefore has to
 * press it, and a case that does not is asserting that nothing was written.
 */
async function saveProfile(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await pressByLabel(renderer, 'Save this profile');
}

/** Flushes the studio's coalesced write to storage. */
async function flushWrite(ms = 500): Promise<void> {
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

/** The persisted profile set, or null when nothing has been written. */
async function storedProfiles(
  storage: Storage,
): Promise<{ activeId: string; profiles: Array<Record<string, never>> } | null> {
  return storage.getJson<{ activeId: string; profiles: Array<Record<string, never>> }>(
    featureKeys.oledProfiles,
  );
}

/** One hand as it reached storage. */
interface StoredHand {
  enabled: boolean;
  layout: { loadingStyle: string; items: Array<{ kind: string; visible: boolean }> };
}

/** Narrows the stored payload enough to assert on one hand. */
async function storedHand(
  storage: Storage,
  profileIndex: number,
  side: 'left' | 'right',
): Promise<StoredHand | null> {
  const stored = await storage.getJson<{
    profiles: Array<Record<string, StoredHand>>;
  }>(featureKeys.oledProfiles);
  return stored?.profiles[profileIndex]?.[side] ?? null;
}

/* ---------------------------------------------------------------- the preview */

describe('the preview says what it is', () => {
  it('labels itself a Demo Preview and says a physical panel will not change', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    const output = renderedText(renderer);

    expect(output).toContain('Demo Preview');
    expect(output).toContain('physical panel will not change until firmware exists');

    await teardown(renderer);
  });

  it('never reports having written to a panel', async () => {
    // The rule the whole screen is built around: no verified firmware protocol
    // exists, so no control here can have sent anything.
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    const output = renderedText(renderer);

    for (const claim of ['Sent to', 'Uploaded', 'Panel updated', 'Written to', 'Applied to your']) {
      expect(output).not.toContain(claim);
    }

    await teardown(renderer);
  });

  it('reports how much of the eight-row panel the layout uses', async () => {
    // The preview cannot show a layout the panel could not draw, so the count
    // is on screen rather than left to be inferred.
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    expect(renderedText(renderer)).toContain('rows used');

    await teardown(renderer);
  });

  it('says the on/off is desired, and refuses to report the panel as on', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    const output = renderedText(renderer);

    expect(output).toContain('A saved On is a desired setting, not a report from the hardware.');
    // The panel's actual state has no source, and says so rather than inferring
    // it from the flag the user just set.
    expect(output).toContain('Not reported');
    expect(output).toContain('cannot know whether this panel is lit');

    await teardown(renderer);
  });

  it('does not claim that image or frame-sequence conversion exists', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    const output = renderedText(renderer);

    expect(output).toContain('Not implemented');
    expect(output).toContain('conversion is not part of this build');
    // The one thing that is arithmetic rather than a measurement.
    expect(output).toContain('1024 bytes');

    await teardown(renderer);
  });

  it('offers no battery reading, because no pack has ever reported one', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    // The kind is offered — a layout waiting for telemetry is legitimate — but
    // the default layout does not lead with a placeholder, and the row itself is
    // marked as having no source.
    expect(renderedText(renderer)).toContain('Battery is the one item with no source');
    expect(renderedText(renderer)).toContain('SANKET VAANNI');

    await teardown(renderer);
  });
});

/* --------------------------------------------------------------- the panels */

describe('the two panels are configured separately', () => {
  it('edits the left panel without touching the right', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    // The running view, on the right, uses dots.
    expect(isSelectedByLabel(renderer, 'Dots')).toBe(true);

    // Switch to the left panel and give it the bar indicator.
    await pressByLabel(renderer, 'Left');
    await pressByLabel(renderer, 'Bar');
    expect(isSelectedByLabel(renderer, 'Bar')).toBe(true);

    // Switching back shows the right panel's own setting, untouched.
    await pressByLabel(renderer, 'Right');
    expect(isSelectedByLabel(renderer, 'Dots')).toBe(true);
    expect(isSelectedByLabel(renderer, 'Bar')).toBe(false);

    await saveProfile(renderer);
    await flushWrite();
    expect((await storedHand(storage, 0, 'left'))?.layout.loadingStyle).toBe('bar');
    expect((await storedHand(storage, 0, 'right'))?.layout.loadingStyle).toBe('dots');

    await teardown(renderer);
    jest.useRealTimers();
  });

  it('keeps a hidden row on the panel it was hidden on', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Left');
    await hideStatusRow(renderer);
    expect(offersRestore(renderer)).toBe(true);

    await saveProfile(renderer);
    await flushWrite();
    const left = await storedHand(storage, 0, 'left');
    const right = await storedHand(storage, 0, 'right');

    expect(left?.layout.items.find((item) => item.kind === 'status')?.visible).toBe(false);
    expect(right?.layout.items.find((item) => item.kind === 'status')?.visible).toBe(true);

    await teardown(renderer);
    jest.useRealTimers();
  });

  it('stores the desired on/off per hand', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Desired: right panel on');
    await saveProfile(renderer);
    await flushWrite();

    expect((await storedHand(storage, 0, 'right'))?.enabled).toBe(true);
    // The other panel was not switched on by association.
    expect((await storedHand(storage, 0, 'left'))?.enabled).toBe(false);

    await teardown(renderer);
    jest.useRealTimers();
  });
});

/* ------------------------------------------------------------------ the views */

describe('the startup view', () => {
  it('moves a row between the two views and stops drawing it in the running one', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    // The wordmark is in the running view to begin with.
    expect(renderedText(renderer)).toContain('SANKET VAANNI');

    await pressByLabel(renderer, 'Title');
    await pressByLabel(renderer, 'Startup only');
    await pressByLabel(renderer, 'Done');

    // Now the running view says so, rather than silently drawing less.
    expect(renderedText(renderer)).toContain('1 item belongs to the startup view');

    // And the startup view draws it. Asserted on the canvas itself rather than on
    // the caption, because the caption would still read "Startup view" if the
    // frame were empty.
    await pressByLabel(renderer, 'Startup view');
    expect(isSelectedByLabel(renderer, 'Startup view')).toBe(true);
    expect(renderer.root.findAllByProps({ testID: 'oled-canvas' }).length).toBeGreaterThan(0);

    await teardown(renderer);
  });

  it('warns when a hold would show nothing the running view does not', async () => {
    // A duration with no startup-only item means the panel sits on a view it was
    // going to show anyway — a setting that does nothing.
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    expect(renderedText(renderer)).not.toContain('this hold changes nothing');

    await typeInto(renderer, 'Exact hold, in milliseconds', '2000');

    expect(renderedText(renderer)).toContain('this hold changes nothing');

    await teardown(renderer);
  });

  it('stops warning once a row is actually in the startup view', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    await typeInto(renderer, 'Exact hold, in milliseconds', '2000');
    await pressByLabel(renderer, 'Title');
    await pressByLabel(renderer, 'Startup only');
    await pressByLabel(renderer, 'Done');

    expect(renderedText(renderer)).not.toContain('this hold changes nothing');

    await teardown(renderer);
  });
});

/* ------------------------------------------------------- hiding and restoring */

describe('hidden items', () => {
  it('hides an item without losing it, and offers to bring it back', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideStatusRow(renderer);

    const output = renderedText(renderer);

    // The row is still in the list — hiding is not deleting.
    expect(output).toContain('Status');
    expect(output).toContain('hidden');
    expect(output).toContain(RESTORE_ONE);

    await teardown(renderer);
  });

  it('restores every hidden item, and then stops offering to', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideStatusRow(renderer);

    await pressByLabel(renderer, RESTORE_ONE);

    expect(offersRestore(renderer)).toBe(false);
    expect(renderedText(renderer)).toContain('shown');

    await teardown(renderer);
  });
});

/* ------------------------------------------------------------------- reset */

describe('restoring defaults', () => {
  it('does not offer it on a profile that is already at its defaults', async () => {
    // Offering it would imply there is something to discard.
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    expect(isDisabledByLabel(renderer, "Restore this profile's defaults")).toBe(true);

    await teardown(renderer);
  });

  it('asks before discarding, and says what is lost', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideStatusRow(renderer);

    await pressByLabel(renderer, "Restore this profile's defaults");

    const output = renderedText(renderer);
    expect(output).toContain('Restore defaults?');
    expect(output).toContain('including bringing back 1 hidden item');
    // And it says what is *not* lost, because that is the real question.
    expect(output).toContain('Other profiles are kept.');
    expect(output).toContain('Keep my layout');

    await teardown(renderer);
  });

  it('keeps the layout when the user declines', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideStatusRow(renderer);
    await pressByLabel(renderer, "Restore this profile's defaults");

    await pressByLabel(renderer, 'Keep my layout');

    expect(renderedText(renderer)).toContain(RESTORE_ONE);

    await teardown(renderer);
  });

  it('restores the defaults, hidden items included, when confirmed', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideStatusRow(renderer);
    await pressByLabel(renderer, "Restore this profile's defaults");

    await pressByLabel(renderer, 'Restore');

    const output = renderedText(renderer);
    expect(offersRestore(renderer)).toBe(false);
    expect(output).toContain('4 shown');
    expect(output).toContain('SANKET VAANNI');

    await teardown(renderer);
  });

  it('restores both hands, not just the one on screen', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    // Customise the right panel, then the left one, and save each — so the
    // *stored* profile is non-default on both hands before the restore.
    await pressByLabel(renderer, 'Bar');
    await saveProfile(renderer);
    await pressByLabel(renderer, 'Left');
    await pressByLabel(renderer, 'Bar');
    await saveProfile(renderer);

    await flushWrite();
    expect((await storedHand(storage, 0, 'right'))?.layout.loadingStyle).toBe('bar');
    expect((await storedHand(storage, 0, 'left'))?.layout.loadingStyle).toBe('bar');

    // The restore is reached from the right panel, but it applies to both: the
    // left one is not on screen and must be reset anyway.
    await pressByLabel(renderer, 'Right');
    await pressByLabel(renderer, "Restore this profile's defaults");
    await pressByLabel(renderer, 'Restore');

    // A restore is a change to the working copy like any other, so it is the
    // Save that puts it in storage.
    await saveProfile(renderer);
    await flushWrite();
    expect((await storedHand(storage, 0, 'right'))?.layout.loadingStyle).toBe('dots');
    expect((await storedHand(storage, 0, 'left'))?.layout.loadingStyle).toBe('dots');

    await teardown(renderer);
    jest.useRealTimers();
  });
});

/* ----------------------------------------------------------------- profiles */

describe('profiles', () => {
  it('starts with one profile holding both panels', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    expect(renderedText(renderer)).toContain('Default');
    expect(renderedText(renderer)).toContain('1 of 8');

    await openProfiles(renderer);
    expect(renderedText(renderer)).toContain('Desired: left off, right off');

    await teardown(renderer);
  });

  it('refuses to delete the last profile, and says why', async () => {
    // Every hand must have a configuration, and an empty set has no active
    // member, so this is refused rather than papered over with a new default.
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await openProfiles(renderer);

    expect(isDisabledByLabel(renderer, 'Delete the active profile')).toBe(true);
    expect(renderedText(renderer)).toContain('The last profile cannot be deleted');

    await teardown(renderer);
  });

  it('creates a profile, makes it active, and names it', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await openProfiles(renderer);

    await pressByLabel(renderer, 'Create a new profile');
    await typeInto(renderer, 'Profile name', 'Evening class');
    await pressByLabel(renderer, 'Save profile');

    expect(renderedText(renderer)).toContain('Evening class');
    expect(renderedText(renderer)).toContain('2 of 8');

    await teardown(renderer);
  });

  it('will not save a profile with no name', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');

    expect(isDisabledByLabel(renderer, 'Save profile')).toBe(true);

    await teardown(renderer);
  });

  it('starts a new profile from the defaults rather than from the active one', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    // Customise the default profile…
    await pressByLabel(renderer, 'Bar');
    expect(isSelectedByLabel(renderer, 'Bar')).toBe(true);
    await saveProfile(renderer);

    // …then create a second one, which must not inherit the customisation.
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');
    await typeInto(renderer, 'Profile name', 'Fresh');
    await pressByLabel(renderer, 'Save profile');

    expect(isSelectedByLabel(renderer, 'Dots')).toBe(true);
    expect(isSelectedByLabel(renderer, 'Bar')).toBe(false);

    await teardown(renderer);
  });

  it('switching profiles switches both panels back to that profile', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Bar');
    await saveProfile(renderer);
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');
    await typeInto(renderer, 'Profile name', 'Evening class');
    await pressByLabel(renderer, 'Save profile');
    expect(isSelectedByLabel(renderer, 'Dots')).toBe(true);

    // Back to the first profile, whose bar indicator must have been kept.
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Default');

    expect(isSelectedByLabel(renderer, 'Bar')).toBe(true);

    await teardown(renderer);
  });

  it('renames the active profile and leaves the others alone', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');
    await typeInto(renderer, 'Profile name', 'Evening class');
    await pressByLabel(renderer, 'Save profile');

    await openProfiles(renderer);
    await pressByLabel(renderer, 'Rename profile Evening class');
    await typeInto(renderer, 'Profile name', 'Evening class 2');
    await pressByLabel(renderer, 'Rename');

    const output = renderedText(renderer);
    expect(output).toContain('Evening class 2');
    // The other profile still has its own name.
    expect(output).toContain('Default');

    await teardown(renderer);
  });

  it('duplicates a profile into an independent copy', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });

    await openStudio(renderer);
    // Customise the profile that is about to be duplicated, so the copy has
    // something to carry. Duplication is offered on the rows that are *not*
    // active, so this has to happen before the second profile is created.
    await pressByLabel(renderer, 'Bar');
    await saveProfile(renderer);

    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');
    await typeInto(renderer, 'Profile name', 'Evening class');
    await pressByLabel(renderer, 'Save profile');

    await openProfiles(renderer);
    await pressByLabel(renderer, 'Duplicate profile Default');

    expect(renderedText(renderer)).toContain('Default copy');
    expect(renderedText(renderer)).toContain('3 of 8');

    // The duplicate became active and carried the customisation with it.
    await pressByLabel(renderer, 'Close');
    expect(isSelectedByLabel(renderer, 'Bar')).toBe(true);

    await flushWrite();
    // Three profiles, and the duplicate is a copy rather than a reference: its
    // item array is its own.
    const profiles = (await storedProfiles(storage))?.profiles ?? [];
    expect(profiles).toHaveLength(3);

    await teardown(renderer);
    jest.useRealTimers();
  });

  it('deletes a profile after confirming, and keeps the other', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');
    await typeInto(renderer, 'Profile name', 'Evening class');
    await pressByLabel(renderer, 'Save profile');

    await openProfiles(renderer);
    await pressByLabel(renderer, 'Delete the active profile');

    expect(renderedText(renderer)).toContain('Delete this profile?');
    expect(renderedText(renderer)).toContain('No other profile is changed');

    await pressByLabel(renderer, 'Delete');

    const output = renderedText(renderer);
    expect(output).toContain('1 of 8');
    // The profile that was not deleted is the one still there.
    expect(output).toContain('Default');
    expect(output).not.toContain('2 of 8');

    await teardown(renderer);
  });

  it('keeps a profile that the user declined to delete', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');
    await typeInto(renderer, 'Profile name', 'Evening class');
    await pressByLabel(renderer, 'Save profile');

    await openProfiles(renderer);
    await pressByLabel(renderer, 'Delete the active profile');
    await pressByLabel(renderer, 'Keep it');
    await pressByLabel(renderer, 'Close');

    expect(renderedText(renderer)).toContain('2 of 8');

    await teardown(renderer);
  });
});

/* ---------------------------------------------------- transactional editing */

/**
 * The reported defect, as a set of cases.
 *
 * The studio used to write through: every tap and keystroke committed the whole
 * profile and queued a storage write. So closing an editor with the X kept
 * whatever the user had been experimenting with — an X that saved. These cases
 * pin the replacement: edits land in a draft the preview renders, storage is
 * untouched until Save, and every way out of an editor means "undo".
 */
describe('unsaved changes are explicit', () => {
  it('shows an edit in the preview without writing it to storage', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Bar');
    expect(isSelectedByLabel(renderer, 'Bar')).toBe(true);

    await flushWrite();
    // The preview moved; the stored profile did not.
    expect((await storedHand(storage, 0, 'right'))?.layout.loadingStyle).toBe('dots');

    await teardown(renderer);
    jest.useRealTimers();
  });

  it('offers Save and Discard only while there is something to commit', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    expect(renderedText(renderer)).not.toContain('Unsaved changes');

    await pressByLabel(renderer, 'Bar');
    const dirty = renderedText(renderer);
    expect(dirty).toContain('Unsaved changes');
    expect(dirty).toContain('is not stored yet');

    await pressByLabel(renderer, 'Discard unsaved changes');
    expect(renderedText(renderer)).not.toContain('Unsaved changes');

    await teardown(renderer);
  });

  it('puts the preview back to the saved version when the draft is discarded', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Bar');
    await pressByLabel(renderer, 'Discard unsaved changes');

    expect(isSelectedByLabel(renderer, 'Dots')).toBe(true);
    expect(isSelectedByLabel(renderer, 'Bar')).toBe(false);

    await flushWrite();
    expect((await storedHand(storage, 0, 'right'))?.layout.loadingStyle).toBe('dots');

    await teardown(renderer);
    jest.useRealTimers();
  });

  it('commits every edit of the profile in one Save', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Bar');
    await pressByLabel(renderer, 'Desired: right panel on');
    await saveProfile(renderer);

    // One save, both edits, and the bar goes away because there is nothing left
    // to commit.
    expect(renderedText(renderer)).not.toContain('Unsaved changes');

    await flushWrite();
    const right = await storedHand(storage, 0, 'right');
    expect(right?.layout.loadingStyle).toBe('bar');
    expect(right?.enabled).toBe(true);
    // The other panel was not swept up in it.
    expect((await storedHand(storage, 0, 'left'))?.layout.loadingStyle).toBe('dots');

    await teardown(renderer);
    jest.useRealTimers();
  });

  it('does not resurrect an unsaved draft on the next launch', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();

    const first = await renderApp({ skipIntro: true, storage });
    await openStudio(first.renderer);
    await pressByLabel(first.renderer, 'Bar');
    await flushWrite();
    await teardown(first.renderer);

    // A restart is a new tree over the same storage. The draft was never
    // committed, so it must not be there.
    const second = await renderApp({ skipIntro: true, storage });
    await openStudio(second.renderer);
    expect(isSelectedByLabel(second.renderer, 'Dots')).toBe(true);

    await teardown(second.renderer);
    jest.useRealTimers();
  });
});

/* --------------------------------------------------------------- the editor */

describe('the item editor cancels rather than saves', () => {
  it('undoes the row when the sheet is closed with the X', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Status');
    await pressByLabel(renderer, 'Show Status on the panel');
    expect(offersRestore(renderer)).toBe(true);

    await pressByLabel(renderer, 'Close');

    // The hide is undone along with everything else the sheet changed, and
    // nothing was left behind for Save to commit.
    expect(offersRestore(renderer)).toBe(false);
    expect(renderedText(renderer)).not.toContain('Unsaved changes');

    await teardown(renderer);
  });

  it('routes the Android back button to the same cancellation', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Status');
    await pressByLabel(renderer, 'Show Status on the panel');
    expect(offersRestore(renderer)).toBe(true);

    // Back reaches the sheet as `onRequestClose`, exactly as it does on device.
    const modal = renderer.root.findAllByProps({ transparent: true })[0];
    if (modal === undefined) throw new Error('No sheet modal is mounted.');
    await ReactTestRenderer.act(async () => {
      modal.props.onRequestClose();
    });

    expect(offersRestore(renderer)).toBe(false);

    await teardown(renderer);
  });

  it('keeps the row in the draft — still unsaved — when the user presses Done', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Status');
    await pressByLabel(renderer, 'Show Status on the panel');
    await pressByLabel(renderer, 'Done');

    // Done means "keep this row's edit", not "save it": the hide is still in
    // the draft, and the studio says so.
    expect(offersRestore(renderer)).toBe(true);
    expect(renderedText(renderer)).toContain('Unsaved changes');

    await flushWrite();
    expect(
      (await storedHand(storage, 0, 'right'))?.layout.items.find((item) => item.kind === 'status')
        ?.visible,
    ).toBe(true);

    await saveProfile(renderer);
    await flushWrite();
    expect(
      (await storedHand(storage, 0, 'right'))?.layout.items.find((item) => item.kind === 'status')
        ?.visible,
    ).toBe(false);

    await teardown(renderer);
    jest.useRealTimers();
  });

  it('removes the row for good when Delete is used, rather than restoring it', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Status');
    await pressByLabel(renderer, 'Delete Status');

    // Deleting closes the sheet. If closing meant "undo", the row would come
    // straight back — the deletion and the snapshot would cancel out.
    expect(renderedText(renderer)).not.toContain('1 of 4');

    await saveProfile(renderer);
    await flushWrite();
    const items = (await storedHand(storage, 0, 'right'))?.layout.items ?? [];
    expect(items.some((item) => item.kind === 'status')).toBe(false);

    await teardown(renderer);
    jest.useRealTimers();
  });
});

/* --------------------------------------------------- the discard dialog */

describe('discarding by leaving', () => {
  it('asks before an action that would drop the draft, and keeps it when declined', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Bar');
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');

    // Creating a profile moves the active one, which would drop the draft, so it
    // does not happen until the user has answered.
    expect(renderedText(renderer)).toContain('Discard unsaved changes?');
    await pressByLabel(renderer, 'Keep editing');

    const kept = renderedText(renderer);
    expect(kept).not.toContain('Discard unsaved changes?');
    // Still the original profile, still holding the edit.
    expect(isSelectedByLabel(renderer, 'Bar')).toBe(true);
    expect(kept).toContain('1 of 8');

    await teardown(renderer);
  });

  it('carries out the deferred action once the user discards', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Bar');
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');
    expect(renderedText(renderer)).toContain('Discard unsaved changes?');

    await pressByLabel(renderer, 'Discard changes');

    // The action that was held back — creating a profile — now happens.
    expect(renderedText(renderer)).toContain('New profile');
    await typeInto(renderer, 'Profile name', 'Evening class');
    await pressByLabel(renderer, 'Save profile');

    const output = renderedText(renderer);
    expect(output).toContain('Evening class');
    expect(output).toContain('2 of 8');
    // The new profile starts from the defaults, and the draft that was thrown
    // away did not come with it.
    expect(isSelectedByLabel(renderer, 'Dots')).toBe(true);

    await teardown(renderer);
  });

  it('does not ask at all when there is nothing unsaved', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await openProfiles(renderer);
    await pressByLabel(renderer, 'Create a new profile');

    const output = renderedText(renderer);
    expect(output).not.toContain('Discard unsaved changes?');
    // Straight to the name, with no warning in between.
    expect(output).toContain('New profile');
    expect(output).toContain('Profile name');

    await teardown(renderer);
  });
});

/* ------------------------------------------------------------- persistence */

describe('what reaches storage', () => {
  it('stores both hands of a profile under its own key', async () => {
    jest.useFakeTimers();
    const storage: Storage = createInMemoryStorage();

    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);
    await hideStatusRow(renderer);
    await saveProfile(renderer);
    await flushWrite();

    const stored = await storedProfiles(storage);
    expect(stored?.profiles).toHaveLength(1);
    expect(stored?.activeId).toBe('pr0');
    // Both hands are present, and neither carries a serialised frame or command.
    expect(stored?.profiles[0]).toHaveProperty('left');
    expect(stored?.profiles[0]).toHaveProperty('right');
    expect(Object.keys(stored?.profiles[0] ?? {})).not.toContain('commands');
    // Nothing is written under the legacy keys any more.
    expect(await storage.getJson(featureKeys.oledLayout)).toBeNull();

    await teardown(renderer);
    jest.useRealTimers();
  });

  it('survives a restart, including which profile is active', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();

    const first = await renderApp({ skipIntro: true, storage });
    await openStudio(first.renderer);
    await openProfiles(first.renderer);
    await pressByLabel(first.renderer, 'Create a new profile');
    await typeInto(first.renderer, 'Profile name', 'Evening class');
    await pressByLabel(first.renderer, 'Save profile');
    await pressByLabel(first.renderer, 'Bar');
    await saveProfile(first.renderer);
    await flushWrite();
    await teardown(first.renderer);

    // A restart is a new tree over the same storage.
    const second = await renderApp({ skipIntro: true, storage });
    await openStudio(second.renderer);

    const output = renderedText(second.renderer);
    expect(output).toContain('Evening class');
    expect(output).toContain('2 of 8');
    // The active profile came back with its own customisation intact.
    expect(isSelectedByLabel(second.renderer, 'Bar')).toBe(true);

    await teardown(second.renderer);
    jest.useRealTimers();
  });

  it('migrates a pre-profile install instead of discarding it', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();

    // The old studio's two keys: one live layout with a hidden row, one preset.
    const legacy = defaultLayout();
    await storage.setJson(featureKeys.oledLayout, {
      ...legacy,
      items: legacy.items.map((item) =>
        item.kind === 'status' ? { ...item, visible: false } : item,
      ),
    });
    await storage.setJson(featureKeys.oledPresets, [
      { id: 'p1', name: 'Evening class', createdAtMs: 1, layout: legacy },
    ]);

    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    // The live layout came back, hidden row and all, as the active profile.
    expect(renderedText(renderer)).toContain(RESTORE_ONE);
    await openProfiles(renderer);
    expect(renderedText(renderer)).toContain('Evening class');

    await flushWrite();
    // And the migration was written, so the legacy keys are read exactly once.
    const stored = await storedProfiles(storage);
    expect(stored?.profiles).toHaveLength(2);
    expect(stored?.activeId).toBe('pr0');

    await teardown(renderer);
    jest.useRealTimers();
  });

  it('repairs a corrupt stored payload rather than failing to open', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();
    await storage.setJson(featureKeys.oledProfiles, { profiles: 'not an array' });

    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);

    // The screen that exists to repair a bad config has to open.
    expect(renderedText(renderer)).toContain('Default');
    expect(renderedText(renderer)).toContain('SANKET VAANNI');

    await teardown(renderer);
    jest.useRealTimers();
  });
});
