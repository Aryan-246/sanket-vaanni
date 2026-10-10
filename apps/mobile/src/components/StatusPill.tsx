import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export type StatusKind = 'connected' | 'demo' | 'idle' | 'error' | 'unavailable' | 'unknown';

export interface StatusPillProps {
  kind: StatusKind;
  label: string;
}

/**
 * Connection state as a dot plus a word.
 *
 * The label always names the state; the dot only reinforces it. Status must
 * never be conveyed by colour alone.
 *
 * Newer surfaces should prefer `StateChip`, which enforces the shared status
 * vocabulary in `audit/status.ts`. This pill predates it and is kept for
 * continuity on the intro-era layouts.
 */
export function StatusPill({ kind, label }: StatusPillProps): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);

  const dotColour: Record<StatusKind, string> = {
    connected: palette.success,
    demo: palette.demo,
    idle: palette.textMuted,
    error: palette.danger,
    unavailable: palette.textMuted,
    unknown: palette.unknown,
  };

  return (
    <View
      style={styles.pill}
      accessibilityRole="text"
      accessibilityLabel={`Status: ${label}`}
    >
      <View style={[styles.dot, { backgroundColor: dotColour[kind] }]} />
      <AppText variant="caption" color={palette.textSecondary}>
        {label}
      </AppText>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xs + 2,
      paddingHorizontal: spacing.md,
      borderRadius: radii.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      alignSelf: 'flex-start',
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
  });
