/**
 * The rules the shared design system is supposed to hold, asserted.
 *
 * These are not styling preferences. Each case pins a defect that was found on a
 * real screenshot and fixed, and each one is the kind that comes back silently —
 * a status word creeping back into the section-label treatment, or a placeholder
 * creeping back up to the reading size — because nothing else in the suite looks
 * at type at all.
 *
 * The assertions read the *resolved* style rather than the props, so a component
 * that reaches the uppercase treatment some other way still fails.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import type ReactTestRenderer from 'react-test-renderer';

import { Badge } from '../src/components/Badge';
import { FlexBar } from '../src/components/FlexBar';
import { LanguageSelector } from '../src/components/LanguageSelector';
import { RecognitionPanel } from '../src/components/RecognitionPanel';
import { VoicePanel } from '../src/components/VoicePanel';
import { findProfile } from '../src/recognition/profiles';
import type { InputPlan } from '../src/recognition/input';
import type { RecognitionOutcome } from '../src/recognition/outcome';
import { pressByLabel, renderApp, renderThemed, renderedText, teardown } from './support';

const PROFILE = findProfile('isl')!;

const RIGHT_PLAN: InputPlan = {
  kind: 'ready',
  mode: { kind: 'single', side: 'right' },
  connectedSides: ['right'],
  streamingSides: ['right'],
};

interface AppTextInfo {
  /** The size the caller asked for. */
  variant: string | undefined;
  text: string;
  /** Whether the section-label treatment landed on the rendered host `Text`. */
  uppercase: boolean;
  letterSpacing: number | undefined;
}

/** The visible text of one instance's subtree. */
function textOf(node: ReactTestRenderer.ReactTestInstance): string {
  const parts: string[] = [];

  const walk = (child: ReactTestRenderer.ReactTestInstance | string): void => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    for (const grandchild of child.children) walk(grandchild);
  };

  for (const child of node.children) walk(child);
  return parts.join('');
}

/**
 * Every `AppText` in the tree, with what it actually renders as.
 *
 * `AppText` destructures `variant` and `overline` off before spreading the rest
 * onto the host `Text`, so neither prop reaches the host — checking the props
 * alone would prove nothing about the pixels. The host's flattened style is
 * where `textTransform` and the overline tracking would show up if anything put
 * them there.
 */
function appTexts(renderer: ReactTestRenderer.ReactTestRenderer): AppTextInfo[] {
  return renderer.root
    .findAll((node) => typeof node.type === 'function' && node.type.name === 'AppText')
    .map((node) => {
      const host = node.children.find(
        (child): child is ReactTestRenderer.ReactTestInstance => typeof child !== 'string',
      );
      const style = host === undefined ? undefined : StyleSheet.flatten(host.props.style);

      return {
        variant: node.props.variant as string | undefined,
        text: textOf(node),
        uppercase: style?.textTransform === 'uppercase',
        letterSpacing: style?.letterSpacing as number | undefined,
      };
    });
}

/**
 * Whether an instance is the host `Text`, not the `AppText` wrapper.
 *
 * `ElementType` is a union that `@types/react-native` does not narrow against a
 * string literal, so the comparison needs the assertion. Every `AppText` in this
 * file is found by its `variant` prop or its function name instead; this is only
 * for reaching the node the styles actually land on.
 */
function isTextHost(node: ReactTestRenderer.ReactTestInstance): boolean {
  return (node.type as unknown as string) === 'Text';
}

describe('the status badge', () => {
  it('is a caption, not the tracked uppercase section treatment', async () => {
    /*
     * The defect: `Badge` rendered through `AppText`'s `overline` prop, which is
     * `textTransform: 'uppercase'` plus 1.4 tracking — the app's *section
     * eyebrow*. Every status in the app therefore read "RESTING", "NO DATA",
     * "UNAVAILABLE" in a wide pill that took more room than the line it
     * annotated.
     */
    const renderer = await renderThemed(<Badge label="Resting" tone="neutral" />);
    const nodes = appTexts(renderer);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.variant).toBe('caption');
    // The two things `overline` does, refused explicitly.
    expect(nodes[0]?.uppercase).toBe(false);
    expect(nodes[0]?.letterSpacing).not.toBe(1.4);
    // The words are the label as given, so the casing on screen is the casing here.
    expect(nodes[0]?.text).toBe('Resting');

    await teardown(renderer);
  });

  it('still carries the state in words when the tone is the only other signal', async () => {
    // Colour is never the only signal: the label is mandatory and is not
    // abbreviated to fit the smaller pill.
    const renderer = await renderThemed(<Badge label="Unavailable" tone="warning" />);
    expect(renderedText(renderer)).toContain('Unavailable');
    await teardown(renderer);
  });
});

describe('the result panel', () => {
  async function panel(outcome: RecognitionOutcome): Promise<AppTextInfo[]> {
    const renderer = await renderThemed(
      <RecognitionPanel
        outcome={outcome}
        plan={RIGHT_PLAN}
        profile={PROFILE}
        provenance="none"
        onExplain={() => undefined}
      />,
    );
    const nodes = appTexts(renderer);
    await teardown(renderer);
    return nodes;
  }

  it('reserves the reading size for an actual recognised phrase', async () => {
    /*
     * `result` is 30/38/700 — sized so a phrase can be read at arm's length
     * across a table. That is the point of this panel, and only real output
     * earns it.
     */
    const nodes = await panel({
      kind: 'result',
      profileId: 'isl',
      candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.94 },
      hands: ['right'],
    });

    expect(nodes.find((node) => node.text === 'नमस्ते')?.variant).toBe('result');
  });

  it('does not shout a build-level caveat at the reading size', async () => {
    // The defect: "Not implemented" was rendered at `variant="result"`, making
    // the loudest text in the app a statement that nothing works — on the same
    // screen as the hand viewer, which it pushed further down.
    const nodes = await panel({
      kind: 'unavailable',
      reason: 'No recognition model is available.',
    });

    const headline = nodes.find((node) => node.text === 'Not implemented');
    expect(headline).toBeDefined();
    expect(headline?.variant).not.toBe('result');
    expect(headline?.variant).toBe('heading');
  });

  it('keeps the states a user can act on above the caveat', async () => {
    const nodes = await panel({
      kind: 'blocked',
      blocker: 'no-gloves',
      reason: 'No glove is connected.',
    });

    expect(nodes.find((node) => node.text === 'No glove connected')?.variant).toBe('title');
  });
});

describe('the voice panel heading', () => {
  it('prints the word once when the caller already has a section header', async () => {
    // On More the panel sits under `SectionHeader label="Voice"`, so drawing its
    // own heading printed the same word twice, thirty points apart.
    const renderer = await renderThemed(
      <VoicePanel
        enabled={false}
        onToggle={() => undefined}
        available={false}
        unavailableReason={null}
        phrase={null}
        showTitle={false}
      />,
    );

    expect(renderedText(renderer)).not.toContain('Voice');
    // The state is not the label, so suppressing the heading must not suppress it.
    expect(renderedText(renderer)).toContain('Off');

    await teardown(renderer);
  });

  it('titles itself when it stands alone, as on the Dashboard', async () => {
    const renderer = await renderThemed(
      <VoicePanel
        enabled={false}
        onToggle={() => undefined}
        available={false}
        unavailableReason={null}
        phrase={null}
      />,
    );

    expect(renderedText(renderer)).toContain('Speech output');
    expect(renderedText(renderer)).toContain('Off');

    await teardown(renderer);
  });
});

describe('text under accessibility font scaling', () => {
  /*
   * The app caps scaling at 1.4×, so the question is never "does the text fit at
   * 100%" — it is "does it still fit at 140%".
   *
   * A `Text` given a hard `width` does not care about either: it is told how wide
   * it is and the glyphs are clipped or, where `numberOfLines={1}` is also set,
   * silently replaced with an ellipsis. Four columns were written that way,
   * because at 100% a fixed width and a minimum look identical. They are not:
   * `minWidth` sizes the box to its content once the content outgrows the floor,
   * so it renders pixel-for-pixel the same at 100% and simply grows at 140%.
   *
   * This walks every rendered `Text` on every tab rather than naming the four,
   * so a fifth added later fails here instead of on someone's phone.
   */
  it('never gives a text column a hard width, on any tab', async () => {
    const { renderer } = await renderApp({ skipIntro: true });

    const offenders: string[] = [];
    const inspect = (tab: string): void => {
      for (const node of renderer.root.findAll(isTextHost)) {
        const style = StyleSheet.flatten(node.props.style);
        if (typeof style?.width === 'number') {
          offenders.push(`${tab}: "${textOf(node).slice(0, 40)}" is fixed at ${style.width}`);
        }
      }
    };

    // All five tabs, because `RootNavigator` mounts only the active one.
    inspect('Dashboard');
    for (const tab of ['OLED', 'Textboard', 'History', 'Settings']) {
      await pressByLabel(renderer, tab);
      inspect(tab);
    }

    expect(offenders).toEqual([]);

    await teardown(renderer);
  });

  it('grows a finger label rather than truncating it', async () => {
    /*
     * The worst of the four, because it lost the most: "Middle" is one word, so
     * there is no wrap point and `numberOfLines={1}` turned it into "Mid…".
     */
    const renderer = await renderThemed(
      <FlexBar label="Middle" calibrated={0.5} raw={512} tone="accent" />,
    );

    const label = appTexts(renderer).find((node) => node.text === 'Middle');
    expect(label).toBeDefined();

    const host = renderer.root
      .findAll(isTextHost)
      .find((node) => textOf(node) === 'Middle');
    const style = StyleSheet.flatten(host?.props.style);

    expect(style?.width).toBeUndefined();
    expect(style?.minWidth).toBe(52);

    await teardown(renderer);
  });
});

describe('the language list', () => {
  it('gives the native name a line of its own instead of the Latin name’s', async () => {
    /*
     * Both lines are `numberOfLines={1}`, and `Indian Sign Language  ·  भारतीय
     * सांकेतिक भाषा` is about 360 points of text in a row with roughly 250. So
     * the tail was cut, and the tail was the native name — the one fact this
     * column exists to carry, truncated in its own script. The Latin name now
     * stands alone on the first line and the native name opens the second, so
     * neither is competing for the same space.
     */
    const renderer = await renderThemed(
      <LanguageSelector axis="sign" value="isl" onChange={() => undefined} />,
    );

    const nodes = appTexts(renderer);

    // The Latin name, whole, with nothing appended to it.
    expect(nodes.some((node) => node.text === 'Indian Sign Language')).toBe(true);
    // The native name, present and leading its line.
    expect(nodes.some((node) => node.text.startsWith('भारतीय सांकेतिक भाषा'))).toBe(true);

    await teardown(renderer);
  });

  it('still states the profile’s state on the row, beside the native name', async () => {
    // Moving the native name must not quietly drop the fact that the profile has
    // no vocabulary — that is the honest half of the row.
    const renderer = await renderThemed(
      <LanguageSelector axis="sign" value="isl" onChange={() => undefined} />,
    );

    expect(renderedText(renderer)).toContain('No vocabulary defined');

    await teardown(renderer);
  });
});
