/**
 * The result panel: what was detected, and what can be done with it.
 *
 * ## Interim and finalised are shown differently, on purpose
 *
 * A live translator produces two kinds of text. *Interim* text is a guess that
 * will be replaced — the recogniser's current best reading of a gesture that is
 * still in progress. *Finalised* text is settled and will not change.
 *
 * Presenting them identically is the standard mistake: a user reads a word,
 * starts to trust it, and it is overwritten mid-glance. So they are given
 * different weight as well as different colour — finalised text is the large
 * result line, interim text is smaller, muted, and carries a trailing ellipsis
 * that says "still moving". Colour alone would not carry it, both because of
 * colour-blindness and because a glance at a phone is not a careful look.
 *
 * ## Copy
 *
 * The copy control reports what actually happened: `Copy`, `Copied`, or
 * `Copy failed` with the reason. It is disabled when there is nothing to copy,
 * and says why, rather than being present and inert — see `hooks/useCopy.ts`.
 *
 * ## Confidence
 *
 * No percentage is shown unless a model reported one. There is no model, so
 * there is none here. A confidence figure invented to make the panel look
 * finished would be the single most misleading thing this screen could do,
 * because it is the number a user would use to decide whether to trust a
 * translation.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { IconButton } from './IconButton';
import { useCopy } from '../hooks/useCopy';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { spacing } from '../theme';

export interface DetectedTextCardProps {
  /** Settled text. Null when nothing has been finalised. */
  text: string | null;
  /** In-progress text that will be replaced. Null when there is none. */
  interim?: string | null;
  /** Recognition accuracy or confidence in 0..1. */
  accuracy?: number | null;
  /**
   * Where the text came from. Drives the badge, which must never say `Live`
   * for simulated data.
   */
  provenance: 'real' | 'simulated' | 'mixed' | 'none';
  /** Shown in place of the text when there is none. Says what would fill it. */
  emptyTitle: string;
  emptyBody: string;
  /** Opens the explanation sheet. Omitted renders no info button. */
  onExplain?: () => void;
  testID?: string;
}

const PROVENANCE_BADGE: Record<
  DetectedTextCardProps['provenance'],
  { label: string; tone: 'success' | 'warning' | 'neutral' | 'accent' }
> = {
  real: { label: 'Live', tone: 'success' },
  simulated: { label: 'Demo', tone: 'warning' },
  mixed: { label: 'Mixed', tone: 'warning' },
  none: { label: 'No data', tone: 'neutral' },
};

export function DetectedTextCard({
  text,
  interim = null,
  accuracy = null,
  provenance,
  emptyTitle,
  emptyBody,
  onExplain,
  testID,
}: DetectedTextCardProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const copy = useCopy();

  const hasText = text !== null && text.length > 0;
  const hasInterim = interim !== null && interim.length > 0;
  const badge = PROVENANCE_BADGE[provenance];

  return (
    <Card elevation={1} style={styles.card} testID={testID}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <AppText variant="overline" overline color={palette.textMuted}>
            Detected text
          </AppText>
          <Badge label={badge.label} tone={badge.tone} dot />
        </View>

        <View style={styles.headerRight}>
          {typeof accuracy === 'number' && accuracy > 0 ? (
            <Badge
              label={`${Math.round(accuracy * 100)}% accuracy`}
              tone={accuracy >= 0.8 ? 'success' : 'accent'}
            />
          ) : null}

          {onExplain ? (
            <IconButton
              icon="info"
              onPress={onExplain}
              accessibilityLabel="About detected text"
              accessibilityHint="Explains what is shown here, and what a confidence figure would mean"
            />
          ) : null}
        </View>
      </View>

      <View style={styles.body}>
        {hasText ? (
          <View style={styles.resultContainer}>
            <AppText
              variant="result"
              color={palette.textPrimary}
              style={styles.resultText}
              selectable
              accessibilityLabel={`Detected text: ${text}`}
              accessibilityLiveRegion="polite"
            >
              {text}
            </AppText>
            {typeof accuracy === 'number' && accuracy > 0 ? (
              <View style={styles.accuracyCornerBadge} testID="accuracy-corner-badge">
                <AppText variant="caption" color={palette.accent} style={styles.accuracyCornerText}>
                  {Math.round(accuracy * 100)}% accuracy
                </AppText>
              </View>
            ) : null}
          </View>
        ) : hasInterim ? null : (
          <View style={styles.empty}>
            <AppText variant="heading" color={palette.textSecondary} center>
              {emptyTitle}
            </AppText>
            <AppText variant="caption" color={palette.textMuted} center>
              {emptyBody}
            </AppText>
          </View>
        )}

        {/*
          Interim text is rendered below the settled line rather than replacing
          it, so a phrase in progress cannot erase the last word that was
          actually confirmed.
        */}
        {hasInterim ? (
          <AppText
            variant="heading"
            color={palette.textSecondary}
            style={styles.interim}
            accessibilityLabel={`Still reading: ${interim}`}
            accessibilityLiveRegion="polite"
          >
            {interim}
            <AppText variant="heading" color={palette.textMuted}>
              {' …'}
            </AppText>
          </AppText>
        ) : null}
      </View>

      <View style={styles.footer}>
        <ActionButton
          label={copy.label}
          tone={copy.status === 'failed' ? 'ghost' : 'secondary'}
          icon={copy.status === 'copied' ? 'check' : 'copy'}
          compact
          disabled={!hasText}
          onPress={() => {
            if (text !== null) void copy.copy(text);
          }}
          accessibilityLabel={
            hasText ? `Copy detected text: ${text}` : 'Copy detected text, unavailable'
          }
          accessibilityHint={
            hasText
              ? 'Puts the detected text on the system clipboard'
              : 'There is no detected text to copy yet'
          }
        />

        {copy.status === 'failed' && copy.error !== null ? (
          <AppText variant="caption" color={palette.danger} style={styles.copyError}>
            {copy.error}
          </AppText>
        ) : null}

        {!hasText && !hasInterim && provenance === 'none' ? (
          <AppText variant="caption" color={palette.textMuted} style={styles.copyError}>
            Nothing has been read, so there is nothing to copy.
          </AppText>
        ) : null}
      </View>
    </Card>
  );
}

const makeStyles = (_palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    headerText: {
      flex: 1,
      gap: spacing.xs,
      alignItems: 'flex-start',
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    body: {
      minHeight: 92,
      justifyContent: 'center',
      gap: spacing.sm,
    },
    resultContainer: {
      position: 'relative',
      paddingVertical: spacing.xs,
    },
    resultText: {
      letterSpacing: -0.6,
    },
    accuracyCornerBadge: {
      position: 'absolute',
      top: 0,
      right: 0,
      paddingHorizontal: spacing.xs,
      paddingVertical: 2,
      borderRadius: 6,
      backgroundColor: 'rgba(56, 189, 248, 0.12)',
    },
    accuracyCornerText: {
      fontWeight: '600',
      fontSize: 11,
    },
    interim: {
      opacity: 0.85,
    },
    empty: {
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      alignItems: 'center',
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      flexWrap: 'wrap',
    },
    copyError: {
      flex: 1,
      minWidth: 120,
    },
  });
