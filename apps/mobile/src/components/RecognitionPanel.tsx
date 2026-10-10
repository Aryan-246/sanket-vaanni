import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { Icon } from './Icon';
import { isSimulatedLink } from '../ble/link';
import type { GloveSnapshot } from '../ble/controller';
import type { RecognitionOutcome } from '../recognition/outcome';
import { OUTCOME_HEADLINE, outcomeConfidence, outcomeText } from '../recognition/outcome';
import type { SignLanguageProfile } from '../recognition/profiles';
import { formatPercent, sideWord } from '../app/format';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { letterSpacing, radii, spacing } from '../theme';

export interface RecognitionPanelProps {
  side: 'left' | 'right';
  outcome: RecognitionOutcome;
  profile: SignLanguageProfile;
  glove: GloveSnapshot;
  testID?: string;
}

/**
 * The recognition result.
 *
 * ## The design decision this component is built on
 *
 * "Nothing recognised" is five different situations, and the panel shows five
 * different things, because the honest answer to "why is there no sign?" is
 * different in each:
 *
 *  - **unavailable** — the model does not exist. A capability gap, saying so
 *    plainly is the only useful answer.
 *  - **idle** — no reading has been evaluated. The user needs to know that the
 *    missing piece is a *glove*, not a gesture.
 *  - **no-result** — a reading was evaluated and nothing matched. Only reachable
 *    once a model exists, and it means something different again.
 *  - **uncertain** — something matched, weakly. The label is shown *as* a
 *    weaker match, not as a result.
 *  - **result** — a match above the presentation threshold.
 *
 * Collapsing these into one "Waiting…" is the single most common way this kind
 * of app misleads people, so the panel never does it.
 *
 * ## Confidence
 *
 * Rendered only when the recogniser produced a number, and rendered as
 * *measured* when it does — with the percentage and a note that it is the
 * model's own output. When there is none, the row says so explicitly rather than
 * disappearing, so "no confidence available" and "confidence not shown" cannot
 * be confused.
 */
export function RecognitionPanel({
  side,
  outcome,
  profile,
  glove,
  testID,
}: RecognitionPanelProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const confidence = outcomeConfidence(outcome);
  const simulated = isSimulatedLink(glove.link);

  return (
    <Card testID={testID} style={styles.card} accentBorder={confidence !== null}>
      <View style={styles.headerRow}>
        <AppText variant="overline" overline color={palette.textMuted}>
          Recognised sign · {sideWord(side)}
        </AppText>

        <View style={styles.badges}>
          {simulated && <Badge label="Demo Mode" tone="demo" dot />}
          {glove.source === 'none' && <Badge label="No sensor input" tone="neutral" />}
        </View>
      </View>

      <View style={styles.stage}>
        <AppText variant="caption" color={palette.textMuted}>
          {OUTCOME_HEADLINE[outcome.kind]}
        </AppText>

        {outcome.kind === 'result' || outcome.kind === 'uncertain' ? (
          <AppText
            variant="result"
            color={outcome.kind === 'result' ? palette.textPrimary : palette.warning}
            style={styles.headline}
            numberOfLines={3}
          >
            {outcomeText(outcome) ?? '—'}
          </AppText>
        ) : (
          <AppText variant="title" color={palette.textSecondary} style={styles.headline}>
            {placeholderFor(outcome)}
          </AppText>
        )}

        <AppText variant="body" color={palette.textSecondary} style={styles.explanation}>
          {explanationFor(outcome, glove)}
        </AppText>
      </View>

      {outcome.kind === 'uncertain' && (
        <View style={[styles.notice, { backgroundColor: palette.warningSurface }]}>
          <Icon name="warning" size={14} color={palette.warning} />
          <AppText variant="caption" color={palette.warning} style={styles.noticeText}>
            Below the presentation threshold, so it is shown as a guess rather than as a
            result. The threshold itself has no empirical basis yet.
          </AppText>
        </View>
      )}

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
        <AppText variant="caption" color={palette.textMuted} style={styles.footerText}>
          {profile.name}
          {profile.nativeName !== null ? ` · ${profile.nativeName}` : ''} ·{' '}
          {profile.vocabularySize} signs
        </AppText>
      </View>
    </Card>
  );
}

/** The large text when there is no candidate to show. */
function placeholderFor(outcome: RecognitionOutcome): string {
  switch (outcome.kind) {
    case 'idle':
      return 'Waiting for a gesture';
    case 'no-result':
      return 'No match';
    case 'unavailable':
      return 'Not implemented';
    default:
      return '—';
  }
}

/**
 * The sentence under the headline.
 *
 * Every branch states a fact about this build. None of them implies that holding
 * a hand still for longer would help, because in the `unavailable` case it would
 * not.
 */
function explanationFor(outcome: RecognitionOutcome, glove: GloveSnapshot): string {
  switch (outcome.kind) {
    case 'unavailable':
      return outcome.reason;
    case 'idle':
      return glove.link.kind === 'connected'
        ? 'The glove is connected but no sensor frame has been evaluated yet.'
        : 'No glove is connected, so there is nothing to evaluate. Recognition never runs on a reading it does not have.';
    case 'no-result':
      return 'A reading was evaluated and matched nothing in this profile’s vocabulary.';
    case 'uncertain':
      return 'A candidate matched, but not confidently enough to present as a result.';
    case 'result':
      return '';
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
    badges: {
      flexDirection: 'row',
      gap: spacing.xs,
      flexShrink: 0,
    },
    stage: {
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      minHeight: 104,
      justifyContent: 'center',
    },
    headline: {
      letterSpacing: letterSpacing.display,
    },
    explanation: {
      marginTop: spacing.xs,
    },
    notice: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.sm,
    },
    noticeText: {
      flex: 1,
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
      gap: 2,
    },
    footerText: {
      // Sits under the confidence rule without a second divider competing with
      // it — the panel should read as one block, not three.
      marginTop: -spacing.xs,
    },
  });
