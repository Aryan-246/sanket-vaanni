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
 * Voice output.
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
 * available" is more informative than "this control is unavailable". The
 * alternative of turning it on and saying nothing is the failure the brief
 * names.
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
        <AppText variant="heading">Voice output</AppText>
        <Badge
          label={!enabled ? 'Off' : blocked ? 'Unavailable' : 'Ready'}
          tone={!enabled ? 'neutral' : blocked ? 'warning' : 'success'}
          dot
        />
      </View>

      <View style={styles.toggleRow}>
        <View style={styles.toggleText}>
          <AppText variant="body">Speak recognised signs</AppText>
          <AppText variant="caption" color={palette.textMuted}>
            Uses the device's text-to-speech engine for the output language.
          </AppText>
        </View>
        <Toggle
          value={enabled}
          onValueChange={onToggle}
          accessibilityLabel="Speak recognised signs"
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
        >
          {phrase ?? 'Nothing yet'}
        </AppText>
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
  });
