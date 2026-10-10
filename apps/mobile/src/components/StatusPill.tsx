import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { colors, radii, spacing } from '../theme';

export type StatusKind = 'connected' | 'demo' | 'idle' | 'error' | 'unavailable';

export interface StatusPillProps {
  kind: StatusKind;
  label: string;
}

const DOT_COLOR: Record<StatusKind, string> = {
  connected: colors.success,
  demo: colors.demo,
  idle: colors.textMuted,
  error: colors.danger,
  unavailable: colors.textMuted,
};

/**
 * Connection state as a dot plus a word.
 *
 * The label always names the state; the dot only reinforces it. Status must
 * never be conveyed by colour alone.
 */
export function StatusPill({ kind, label }: StatusPillProps): React.JSX.Element {
  return (
    <View style={styles.pill} accessibilityRole="text" accessibilityLabel={`Status: ${label}`}>
      <View style={[styles.dot, { backgroundColor: DOT_COLOR[kind] }]} />
      <AppText variant="caption" color={colors.textSecondary}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
