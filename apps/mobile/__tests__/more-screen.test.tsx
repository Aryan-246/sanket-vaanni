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

import { setSupabaseDisabledForTesting } from '../src/supabase/client';
import { AUDIT_MARKER, OLED_MARKER, has, pressByLabel, renderApp, renderedText, teardown } from './support';

/** Reads More, which is where these settings live. */
async function openMore(renderer: ReactTestRenderer.ReactTestRenderer): Promise<string> {
  await pressByLabel(renderer, 'Settings');
  return renderedText(renderer);
}

/** Whether any node carries this accessibility label — i.e. is a control. */
function isControl(
  renderer: ReactTestRenderer.ReactTestRenderer,
  accessibilityLabel: string,
): boolean {
  return renderer.root.findAllByProps({ accessibilityLabel }).length > 0;
}

describe('the cloud account entry point on Settings', () => {
  afterEach(() => {
    // The flag is module state, so it would otherwise leak into the rest of the
    // file. `false` restores the ambient build configuration rather than
    // asserting a value.
    setSupabaseDisabledForTesting(false);
  });

  it('reports the account state honestly and opens the real account sheet', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain('Cloud & Account');
    // "Local only" is the honest label while signed out, in any build: a spinner
    // or a "Connected" here would be a claim the app cannot support.
    expect(output).toContain('Local only');

    /*
     * The description has two honest forms, and which one is correct depends on
     * whether an account service is configured — a property of the *build*, not
     * of this test. Asserting only one of them made this test pass or fail on
     * whatever `.env` happened to exist on the machine running it: `.env` is
     * gitignored, so a fresh clone took the unconfigured branch and a developer
     * machine with credentials took the configured one, and only the first was
     * ever asserted. Both are honest; the unconfigured one is now asserted
     * deterministically below, where its premise is actually established.
     */
    expect(output).toMatch(
      /Everything lives on this phone\. Tap to sign in and carry it across devices\.|No account service is configured, so everything stays on this phone\. Tap for details\./,
    );

    // Tapping it opens the real account sheet, not a placeholder.
    await pressByLabel(renderer, 'Local only');
    const sheetOutput = renderedText(renderer);
    expect(sheetOutput).toContain('Sign In to Sanket Vaanni');
    expect(sheetOutput).toContain('Email address');

    await teardown(renderer);
  });

  it('says the service is missing rather than inviting a sign-in that cannot happen', async () => {
    setSupabaseDisabledForTesting(true);
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain('Local only');
    expect(output).toContain('No account service is configured');
    // The invitation is the half that would be false here: there is nothing on
    // this build to sign in to, so offering it would promise what cannot happen.
    expect(output).not.toContain('Tap to sign in');

    await teardown(renderer);
  });
});

describe('what More does not contain', () => {

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

  it('names the build honestly rather than inventing a version', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain('offline-first');
    /*
     * The version is either the one the installed package reports or the honest
     * "unknown on this platform" marker. A plausible-looking number is the one
     * thing it must never be — see VERSION_UNKNOWN in config/app.ts.
     */
    expect(output).toMatch(/Sanket Vaanni (Unknown on this platform|[0-9])/);
    expect(output).not.toContain('Sanket Vaanni 0.1.0');

    await teardown(renderer);
  });

  it('explains that preferences stay on the phone', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = await openMore(renderer);

    expect(output).toContain('lives in this device’s local storage');

    await teardown(renderer);
  });
});

describe('entry points on More', () => {
  it('offers a replay intro action that returns to the launch sequence', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openMore(renderer);

    expect(isControl(renderer, 'Replay intro')).toBe(true);

    await teardown(renderer);
  });

  it('offers OLED layout and opens the OLED Studio', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openMore(renderer);

    await pressByLabel(renderer, 'OLED layout');
    expect(has(renderer, OLED_MARKER)).toBe(true);

    await teardown(renderer);
  });

  it('offers Component status and opens the audit view', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openMore(renderer);

    await pressByLabel(renderer, 'Component status');
    expect(has(renderer, AUDIT_MARKER)).toBe(true);

    await teardown(renderer);
  });

  it('offers a choice of themes via segmented control', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openMore(renderer);

    expect(isControl(renderer, 'Theme')).toBe(true);

    await teardown(renderer);
  });

  it('offers Sign language input and Output language sheets', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await openMore(renderer);

    expect(isControl(renderer, 'Sign language input')).toBe(true);
    expect(isControl(renderer, 'Output language')).toBe(true);

    await teardown(renderer);
  });
});
