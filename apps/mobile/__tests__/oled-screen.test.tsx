/**
 * OLED Studio, as a user operates it.
 *
 * Driven through the real app: the tab bar, the rows, the editor sheet and the
 * confirmation dialog. The behaviour under test is the part of the brief that
 * is easy to claim and hard to honour — that hiding is not deleting, that a
 * reset which discards customisation asks first, that a preset survives a
 * restart, and that nothing on this screen pretends a physical panel changed.
 */
import ReactTestRenderer from 'react-test-renderer';

import { TextField } from '../src/components/TextField';
import { featureKeys } from '../src/storage';
import { createInMemoryStorage, type Storage } from '../src/storage';
import {
  pressByLabel,
  renderApp,
  renderedText,
  teardown,
} from './support';

/* ------------------------------------------------------------------ helpers */

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

async function openStudio(
  renderer: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await pressByLabel(renderer, 'OLED');
}

/**
 * Hides the Battery row, which is the shortest path to a customised layout.
 *
 * Battery because its value is permanently `--`, so hiding it changes nothing
 * about what the panel shows — the test is about the layout model, not about
 * the reading.
 */
async function hideBatteryRow(
  renderer: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await pressByLabel(renderer, 'Battery');
  await pressByLabel(renderer, 'Show Battery on the panel');
  await pressByLabel(renderer, 'Done');
}

/** Types into the only field on screen, standing in for a keystroke per character. */
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

/** Flushes the studio's coalesced write to storage. */
async function flushWrite(ms = 500): Promise<void> {
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
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
});

/* ------------------------------------------------------- hiding and restoring */

describe('hidden items', () => {
  it('hides an item without losing it, and offers to bring it back', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideBatteryRow(renderer);

    const output = renderedText(renderer);

    // The row is still in the list — hiding is not deleting.
    expect(output).toContain('Battery');
    expect(output).toContain('hidden');
    expect(output).toContain(RESTORE_ONE);

    await teardown(renderer);
  });

  it('restores every hidden item, and then stops offering to', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideBatteryRow(renderer);

    await pressByLabel(renderer, RESTORE_ONE);

    expect(offersRestore(renderer)).toBe(false);
    expect(renderedText(renderer)).toContain('shown');

    await teardown(renderer);
  });

  it('survives a restart, because the layout is written as it is edited', async () => {
    jest.useFakeTimers();
    const storage = createInMemoryStorage();

    const first = await renderApp({ skipIntro: true, storage });
    expect(first.storage).toBe(storage);
    await openStudio(first.renderer);
    await hideBatteryRow(first.renderer);
    await flushWrite();
    await teardown(first.renderer);

    // What was stored is a layout with a hidden row, not a flag about one.
    const stored = await storage.getJson<{ items: Array<{ kind: string; visible: boolean }> }>(
      featureKeys.oledLayout,
    );
    const battery = stored?.items.find((entry) => entry.kind === 'battery');
    expect(battery?.visible).toBe(false);

    // A restart is a new tree over the same storage.
    const second = await renderApp({ skipIntro: true, storage });
    await flushWrite();
    await openStudio(second.renderer);

    expect(renderedText(second.renderer)).toContain(RESTORE_ONE);

    await teardown(second.renderer);
    jest.useRealTimers();
  });
});

/* ------------------------------------------------------------------- reset */

describe('reset', () => {
  it('asks before discarding customisation, and says what is lost', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideBatteryRow(renderer);

    await pressByLabel(renderer, 'Reset layout to defaults');

    const output = renderedText(renderer);
    expect(output).toContain('Reset layout?');
    expect(output).toContain('including bringing back 1 hidden item');
    expect(output).toContain('Keep my layout');

    await teardown(renderer);
  });

  it('keeps the layout when the user declines', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideBatteryRow(renderer);
    await pressByLabel(renderer, 'Reset layout to defaults');

    await pressByLabel(renderer, 'Keep my layout');

    // Untouched: the hidden row is still hidden.
    expect(renderedText(renderer)).toContain(RESTORE_ONE);

    await teardown(renderer);
  });

  it('restores the defaults, hidden items included, when confirmed', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);
    await hideBatteryRow(renderer);
    await pressByLabel(renderer, 'Reset layout to defaults');

    await pressByLabel(renderer, 'Reset');

    const output = renderedText(renderer);
    expect(offersRestore(renderer)).toBe(false);
    // Back to the default layout: every item shown, wordmark and all.
    expect(output).toContain('4 shown');
    expect(output).toContain('SANKET VAANNI');

    await teardown(renderer);
  });

  it('does not offer a reset on a layout that is already at its defaults', async () => {
    // Offering it would imply there is something to discard.
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    const reset = renderer.root.findAllByProps({
      accessibilityLabel: 'Reset layout to defaults',
    })[0];
    expect(reset).toBeDefined();
    expect(isDisabledByLabel(renderer, 'Reset layout to defaults')).toBe(true);

    await teardown(renderer);
  });
});

/* ------------------------------------------------------------------ presets */

describe('presets', () => {
  it('saves the current layout and brings it back later', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    // A customised layout, saved…
    await hideBatteryRow(renderer);
    await pressByLabel(renderer, 'Save current layout as a preset');
    await typeInto(renderer, 'Preset name', 'Evening class');
    await pressByLabel(renderer, 'Save preset');

    expect(renderedText(renderer)).toContain('Evening class');

    // …then undone…
    await pressByLabel(renderer, RESTORE_ONE);
    expect(offersRestore(renderer)).toBe(false);

    // …then restored from the preset.
    await pressByLabel(renderer, 'Load preset Evening class');
    expect(renderedText(renderer)).toContain(RESTORE_ONE);

    await teardown(renderer);
  });

  it('will not save an unnamed preset', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    await pressByLabel(renderer, 'Save current layout as a preset');

    expect(isDisabledByLabel(renderer, 'Save preset')).toBe(true);

    await teardown(renderer);
  });

  it('keeps a preset separate from the layout it was copied from', async () => {
    // The preset is a snapshot: editing afterwards must not rewrite it.
    const { renderer } = await renderApp({ skipIntro: true });
    await openStudio(renderer);

    await hideBatteryRow(renderer);
    await pressByLabel(renderer, 'Save current layout as a preset');
    await typeInto(renderer, 'Preset name', 'Snapshot');
    await pressByLabel(renderer, 'Save preset');

    // Reset to the defaults, then load the preset back.
    await pressByLabel(renderer, 'Reset layout to defaults');
    await pressByLabel(renderer, 'Reset');
    expect(offersRestore(renderer)).toBe(false);
    expect(renderedText(renderer)).toContain('4 shown');

    await pressByLabel(renderer, 'Load preset Snapshot');
    expect(renderedText(renderer)).toContain(RESTORE_ONE);

    await teardown(renderer);
  });
});

/* ------------------------------------------------------------- storage hygiene */

describe('what reaches storage', () => {
  it('stores the layout under its own key and nothing else', async () => {
    jest.useFakeTimers();
    const storage: Storage = createInMemoryStorage();

    const { renderer } = await renderApp({ skipIntro: true, storage });
    await openStudio(renderer);
    await hideBatteryRow(renderer);
    await flushWrite();

    const layout = await storage.getJson<{ version: number; items: unknown[] }>(
      featureKeys.oledLayout,
    );
    expect(layout?.version).toBe(1);
    expect(layout?.items).toHaveLength(4);
    // No panel command, no serialised frame — the studio has no such concept.
    expect(Object.keys(layout ?? {})).not.toContain('commands');

    await teardown(renderer);
    jest.useRealTimers();
  });
});
