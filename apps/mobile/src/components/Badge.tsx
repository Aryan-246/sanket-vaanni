import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { AppText } from './AppText';
import { colors, radii, spacing } from '../theme';

export type BadgeTone = 'neutral' | 'demo' | 'accent' | 'warning';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  style?: ViewStyle;
}

/**
 * Status badge.
 *
 * Colour is never the only signal — the label always carries the meaning, so
 * the badge still works for a user who cannot distinguish the hues.
 */
export function Badge({ label, tone = 'neutral', style }: BadgeProps): React.JSX.Element {
  const textColor =
    tone === 'demo' || tone === 'warning'
      ? colors.warning
      : tone === 'accent'
        ? colors.accent
        : colors.textSecondary;

  return (
    <View style={[styles.badge, styles[tone], style]}>
      <AppText variant="overline" color={textColor} overline>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  neutral: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.borderStrong,
  },
  demo: {
    backgroundColor: colors.demoSurface,
    borderColor: colors.demo,
  },
  accent: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.accent,
  },
  warning: {
    backgroundColor: colors.demoSurface,
    borderColor: colors.warning,
  },
});
