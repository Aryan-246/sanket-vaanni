/**
 * The More screen, as a settings page.
 *
 * The brief's requirements for this screen are mostly about what must *not* be
 * there: no account card, no sign-in placeholder, no wall of "Not implemented"
 * rows repeating what the Audit tab already says, and no control that appears to
 * do something it cannot. Those are the properties asserted below, alongside the
 * entry points that do have to work.
 */
import ReactTestRenderer from 'react-test-renderer';

import { AUDIT_MARKER, OLED_MARKER, has, pressByLabel, renderApp, renderedText, teardown } from './support';

/** Reads More, which is where these settings live. */
async function openMore(renderer: ReactTestRenderer.ReactTestRenderer): Promise<string> {
  await pressByLabel(renderer, 'More');
  return renderedText(renderer);
}

/** Whether any node carries this accessibility label — i.e. is a control. */
function isControl(
  renderer: ReactTestRenderer.ReactTestRenderer,
  accessibilityLabel: string,
): boolean {
  return renderer.root.findAllByProps({ accessibilityLabel }).length > 0;
}

describe('what More does not contain', () => {
  it('has no account section, sign-in row or credential field', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    // A row that opened an empty login form would be a dead end, and a large
    // placeholder would be a promise the app cannot keep.
    for (const claim of ['Account', 'Sign in', 'Sign up', 'Log in', 'Email', 'Password']) {
      expect(output).not.toContain(claim);
    }

    await teardown(renderer);
  });

  it('does not repeat the audit as a wall of "Not implemented" rows', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    // These belong to the Audit tab, grouped by component. Repeating them here
    // made a settings page read as a broken product.
    for (const row of ['Accounts and sync', 'Recognition model', 'OLED commands']) {
      expect(output).not.toContain(row);
    }
    // And what remains is a pointer to where they are described.
    expect(output).toContain('Component status');

    await teardown(renderer);
  });

  it('offers no control for a setting it does not implement', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openMore(renderer);

    // The app follows the phone for these three. They are stated, not offered:
    // an override the app does not honour would be a control that silently does
    // nothing, which is what the brief rules out.
    for (const label of ['App language', 'Text size', 'Reduce motion']) {
      expect(isControl(renderer, label)).toBe(false);
    }

    await teardown(renderer);
  });
});

describe('what More says', () => {
  it('names the interface language and admits there is only one', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain('App language');
    expect(output).toContain('English');
    expect(output).toContain('No other language pack exists yet');

    await teardown(renderer);
  });

  it('reports that text size and motion follow the phone, with reasons', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain("phone's font size setting");
    expect(output).toContain('reduced motion');

    await teardown(renderer);
  });

  it('marks the glove speaker Coming soon rather than offering a switch', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain('Glove speaker');
    expect(output).toContain('Coming soon');
    // A toggle here would claim to change hardware that has no verified command
    // set, so there must be no control for it.
    expect(isControl(renderer, 'Glove speaker')).toBe(false);

    await teardown(renderer);
  });

  it('keeps the two language settings separate and says they are', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain('Sign language input');
    expect(output).toContain('Output language');
    expect(output).toContain('two independent settings');
    // Nothing implies that reading a glove alone identifies a sign language —
    // ISL, ASL and BSL do not share one dictionary.
    for (const claim of ['detects your sign language', 'identifies your sign language', 'any sign language']) {
      expect(output).not.toContain(claim);
    }

    await teardown(renderer);
  });

  it('says preferences are local and that nothing is uploaded', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain("local storage");
    expect(output).toContain('Nothing on this screen is uploaded anywhere');

    await teardown(renderer);
  });
});

describe('the entry points on More', () => {
  it('opens the OLED Studio from the Devices section', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openMore(renderer);

    await pressByLabel(renderer, 'OLED layout');

    expect(has(renderer, OLED_MARKER)).toBe(true);

    await teardown(renderer);
  });

  it('opens the Audit from the Component status row', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openMore(renderer);

    await pressByLabel(renderer, 'Component status');

    expect(has(renderer, AUDIT_MARKER)).toBe(true);

    await teardown(renderer);
  });

  it('offers the sign-language and output language pickers', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openMore(renderer);

    await pressByLabel(renderer, 'Sign language input');
    expect(renderedText(renderer)).toContain('Which vocabulary the glove would be read against.');

    await teardown(renderer);
  });

  it('keeps the theme, voice and replay controls', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain('Replay intro');
    expect(output).toContain('Phone voice');
    // The three theme options are the control the theme tests drive.
    for (const option of ['System', 'Dark', 'Light']) {
      expect(isControl(renderer, option)).toBe(true);
    }

    await teardown(renderer);
  });
});
