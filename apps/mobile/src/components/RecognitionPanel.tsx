import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { IconButton } from './IconButton';
import { outcomeConfidence, outcomeHandWords, outcomeText } from '../recognition/outcome';
import type { RecognitionOutcome } from '../recognition/outcome';
import type { InputPlan } from '../recognition/input';
import type { SignLanguageProfile } from '../recognition/profiles';
import { formatPercent } from '../app/format';
import type { DataProvenance } from '../app/AppState';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { letterSpacing, spacing } from '../theme';

export interface RecognitionPanelProps {
  outcome: RecognitionOutcome;
  plan: InputPlan;
  profile: SignLanguageProfile;
  provenance: DataProvenance;
  /** Opens the explanation sheet. The panel states; it does not lecture. */
  onExplain: () => void;
  testID?: string;
}

/**
 * The one place a result appears.
 *
 * ## Why there is a single panel and not one per hand
 *
 * A result is a property of the conversation, not of a glove. Two panels meant
 * a user could read the left hand's guess beside the right hand's and have no
 * way to tell which one the app would actually speak — and it made a two-handed
 * sign impossible to display at all, because it belongs to neither panel.
 *
 * So there is one panel, and when a candidate exists it names the hand that
 * produced it (`Left hand`, `Both hands`) rather than relying on the user having
 * selected one.
 *
 * ## Short lines here, the full explanation behind the button
 *
 * The panel says what happened in a few words. The paragraphs — why a blocked
 * state is blocked, what a confidence means, what the vocabulary gap is — live
 * in the sheet the ⓘ button opens. That split is deliberate: the reason a user
 * looks at this panel mid-conversation is to read the result, and a wall of
 * technical prose pushes the result off the screen.
 */
export function RecognitionPanel({
  outcome,
  plan,
  profile,
  provenance,
  onExplain,
  testID,
}: RecognitionPanelProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const confidence = outcomeConfidence(outcome);
  const hands = outcomeHandWords(outcome);
  const candidate = outcomeText(outcome);

  return (
    <Card
      testID={testID}
      style={styles.card}
      accentBorder={outcome.kind === 'result'}
    >
      <View style={styles.headerRow}>
        <AppText variant="overline" overline color={palette.textMuted}>
          Live translation
        </AppText>

        <View style={styles.headerRight}>
          <ProvenanceBadge provenance={provenance} />
          <IconButton
            icon="info"
            onPress={onExplain}
            accessibilityLabel="What this panel is showing"
          />
        </View>
      </View>

      <View style={styles.stage}>
        <AppText variant="caption" color={palette.textMuted}>
          {OUTCOME_HEADLINE_SHORT[outcome.kind]}
        </AppText>

        {/*
          The display size belongs to a *result*.

          `result` is 30/38/700 — the size chosen so a recognised phrase can be
          read at arm's length across a table, which is the whole point of this
          panel. Applying it to a state word as well made "Not implemented" the
          largest thing on the Dashboard: the loudest text in the app said that
          nothing works, and it pushed the actual hand viewer further down the
          screen. A placeholder is a caption in the layout's terms, not a
          headline, so it is set as one — `title` for states the user can act on
          (waiting, blocked, no match) and `heading` for the build-level caveat,
          which is information rather than a call to action.
        */}
        <AppText
          variant={headlineVariant(outcome, candidate !== null)}
          color={headlineColor(outcome, palette)}
          style={candidate !== null ? styles.headline : undefined}
          numberOfLines={3}
        >
          {candidate ?? shortState(outcome)}
        </AppText>

        {hands !== null && (
          <AppText variant="label" color={palette.textSecondary}>
            {hands}
          </AppText>
        )}
      </View>

      {/*
        Confidence is rendered even when there is none. Hiding the row would make
        "no model has reported a confidence" indistinguishable from "the panel
        forgot to show one", and the first is a fact worth stating.
      */}
      <View style={styles.confidenceRow}>
        <AppText variant="caption" color={palette.textMuted}>
          Model confidence
        </AppText>
        <AppText
          variant="reading"
          color={confidence === null ? palette.textMuted : palette.textPrimary}
        >
          {confidence === null ? 'Not available' : `${formatPercent(confidence)} measured`}
        </AppText>
      </View>

      <View style={styles.footer}>
        <AppText variant="caption" color={palette.textMuted} numberOfLines={2}>
          {profile.name} · {profile.vocabularySize} signs · {inputSummary(plan)}
        </AppText>
      </View>
    </Card>
  );
}

/**
 * One-line state labels.
 *
 * Shorter than `OUTCOME_HEADLINE` on purpose: that map is used where the state
 * is the whole message, this one sits above a large line and only needs to set
 * it up.
 */
const OUTCOME_HEADLINE_SHORT: Record<RecognitionOutcome['kind'], string> = {
  unavailable: 'Recognition',
  blocked: 'Cannot start',
  idle: 'Waiting',
  'no-result': 'No match',
  uncertain: 'Low confidence',
  result: 'Recognised',
};

/**
 * The large line when there is no candidate.
 *
 * Every branch is a fact about this build. None of them suggests that holding a
 * hand still for longer would help, because in the blocked states it would not.
 */
function shortState(outcome: RecognitionOutcome): string {
  switch (outcome.kind) {
    case 'unavailable':
      return 'Not implemented';
    case 'blocked':
      return BLOCKER_SHORT[outcome.blocker];
    case 'idle':
      return 'Waiting for a gesture';
    case 'no-result':
      return 'No match';
    case 'uncertain':
    case 'result':
      return '—';
  }
}

const BLOCKER_SHORT: Record<
  Extract<RecognitionOutcome, { kind: 'blocked' }>['blocker'],
  string
> = {
  'no-vocabulary': 'No vocabulary yet',
  'no-gloves': 'No glove connected',
  'awaiting-frames': 'Waiting for sensor data',
  'needs-both-hands': 'Both hands needed',
  'unsupported-sides': 'Hand not in vocabulary',
};

function headlineColor(outcome: RecognitionOutcome, palette: Palette): string {
  switch (outcome.kind) {
    case 'result':
      return palette.textPrimary;
    case 'uncertain':
      return palette.warning;
    default:
      return palette.textSecondary;
  }
}

/**
 * How large the panel's one line should be.
 *
 * `hasCandidate` is passed rather than derived from `outcome.kind` so the size
 * follows the thing actually being rendered: a real recognised phrase gets the
 * reading size even if the outcome is still being classified as uncertain.
 */
function headlineVariant(
  outcome: RecognitionOutcome,
  hasCandidate: boolean,
): 'result' | 'title' | 'heading' {
  if (hasCandidate) return 'result';
  return outcome.kind === 'unavailable' ? 'heading' : 'title';
}

/** How the recogniser is being fed, in three words. */
function inputSummary(plan: InputPlan): string {
  if (plan.kind === 'blocked') return 'no input';
  switch (plan.mode.kind) {
    case 'single':
      return `${plan.mode.side} hand`;
    case 'bimanual':
      return 'both hands';
    case 'parallel-single':
      return `${plan.mode.sides.length} hands, separate`;
  }
}

/**
 * What the numbers on this panel came from.
 *
 * `mixed` is not a technicality — one real glove beside one simulator produces
 * two readings of different trustworthiness on the same screen, and a badge that
 * called that either `Live` or `Demo Mode` would misdescribe half of it.
 */
function ProvenanceBadge({ provenance }: { provenance: DataProvenance }): React.JSX.Element {
  switch (provenance) {
    case 'real':
      return <Badge label="Live" tone="success" dot />;
    case 'simulated':
      return <Badge label="Demo Mode" tone="demo" dot />;
    case 'mixed':
      return <Badge label="Mixed data" tone="warning" dot />;
    default:
      return <Badge label="No data" tone="neutral" />;
  }
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.md,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      flexShrink: 0,
    },
    stage: {
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      /*
       * Enough to hold either shape this stage takes, so the card does not jump
       * when a result arrives: caption + label + hand line for a placeholder, or
       * caption + the 38 pt reading line for a result. It was 96 when the
       * placeholder was drawn at the reading size too; with the placeholder back
       * at heading size, 80 is what the content actually needs and the other 16
       * points were an empty band on a screen that has a hand viewer below it.
       */
      minHeight: 80,
      justifyContent: 'center',
    },
    headline: {
      letterSpacing: letterSpacing.display,
    },
    confidenceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingTop: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    footer: {
      marginTop: -spacing.xs,
    },
  });
