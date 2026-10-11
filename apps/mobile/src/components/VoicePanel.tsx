import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { Icon } from './Icon';
import { Toggle } from './Toggle';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface VoicePanelProps {
  /** The user's intent — whether they *want* speech output. */
  enabled: boolean;
  onToggle: (next: boolean) => void;
  /** Whether speech output can actually run. */
  available: boolean;
  unavailableReason: string | null;
  /** Text that would be spoken, or null when nothing has been recognised. */
  phrase: string | null;
  testID?: string;
}

/**
 * Voice output, in two clearly separated halves.
 *
 * ## The deliberate contradiction
 *
 * The toggle records *intent*; the speaker reports *capability*. Those can
 * disagree, and today they always do — the preference can be on while no speech
 * engine exists. The panel shows both at once rather than resolving the
 * disagreement silently:
 *
 *  - turning it on does not disable itself or snap back;
 *  - the status line immediately says it cannot run, and why.
 *
 * The alternative — greying the toggle out — was rejected because it hides the
 * feature's existence, and because "the user asked for this and it is not
 * available" is more informative than "this control is unavailable".
 *
 * ## Why the glove's speaker is not beside the phone's
 *
 * They are different outputs on different hardware. The phone speaks through
 * Android's TTS engine; the glove would speak through a speaker on the glove,
 * driven over a BLE command protocol that does not exist yet. Presenting them as
 * one setting would imply that turning the phone's voice on did something to the
 * glove. The second row is therefore permanently `Coming soon` and is not a
 * control — there is nothing to switch.
 */
export function VoicePanel({
  enabled,
  onToggle,
  available,
  unavailableReason,
  phrase,
  testID,
}: VoicePanelProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const blocked = enabled && !available;

  return (
    <Card testID={testID} style={styles.card}>
      <View style={styles.headerRow}>
        <AppText variant="overline" overline color={palette.textMuted}>
          Voice
        </AppText>
        <Badge
          label={!enabled ? 'Off' : blocked ? 'Unavailable' : 'Ready'}
          tone={!enabled ? 'neutral' : blocked ? 'warning' : 'success'}
          dot
        />
      </View>

      <View style={styles.toggleRow}>
        <View style={styles.toggleText}>
          <AppText variant="body">Phone voice</AppText>
          <AppText variant="caption" color={palette.textMuted} numberOfLines={2}>
            Speaks recognised signs through the device's text-to-speech engine.
          </AppText>
        </View>
        <Toggle
          value={enabled}
          onValueChange={onToggle}
          accessibilityLabel="Speak recognised signs on the phone"
          accessibilityHint="Turns text-to-speech for recognised phrases on or off"
        />
      </View>

      {blocked && (
        <View style={[styles.notice, { backgroundColor: palette.warningSurface }]}>
          <Icon name="warning" size={14} color={palette.warning} />
          <AppText variant="caption" color={palette.warning} style={styles.noticeText}>
            On, but nothing can be spoken: {unavailableReason ?? 'no speech engine is available.'}
          </AppText>
        </View>
      )}

      <View style={styles.row}>
        <AppText variant="caption" color={palette.textMuted}>
          Would speak
        </AppText>
        <AppText
          variant="reading"
          color={phrase === null ? palette.textMuted : palette.textPrimary}
          numberOfLines={1}
          style={styles.rowValue}
        >
          {phrase ?? 'Nothing yet'}
        </AppText>
      </View>

      {/*
        Not a Toggle. A switch that is permanently off, or that flips to on and
        changes nothing, is the "button that appears functional but silently does
        nothing" the brief rules out. This is a statement, so it is rendered as
        one.
      */}
      <View style={styles.row}>
        <View style={styles.rowText}>
          <AppText variant="body" color={palette.textSecondary}>
            Glove speaker
          </AppText>
          <AppText variant="caption" color={palette.textMuted} numberOfLines={2}>
            Would play audio on the glove itself. Needs a verified command protocol.
          </AppText>
        </View>
        <Badge label="Coming soon" tone="neutral" />
      </View>
    </Card>
  );
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
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    toggleText: {
      flex: 1,
      gap: 2,
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
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingTop: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    rowText: {
      flex: 1,
      gap: 2,
    },
    rowValue: {
      flexShrink: 1,
      textAlign: 'right',
    },
  });
