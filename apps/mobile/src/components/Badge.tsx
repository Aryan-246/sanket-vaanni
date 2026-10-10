import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export type BadgeTone = 'neutral' | 'demo' | 'accent' | 'warning' | 'danger' | 'success';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  /** Leading dot in the tone colour, for pill-style status. */
  dot?: boolean;
  /** Leading icon. Ignored when `dot` is set. */
  icon?: IconName;
  style?: ViewStyle;
}

/**
 * Status badge.
 *
 * Colour is never the only signal — the label always carries the meaning, so
 * the badge still works for a user who cannot distinguish the hues.
 */
export function Badge({ label, tone = 'neutral', dot = false, icon, style }: BadgeProps): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);

  const fg: Record<BadgeTone, string> = {
    neutral: palette.textSecondary,
    demo: palette.demo,
    accent: palette.accent,
    warning: palette.warning,
    danger: palette.danger,
    success: palette.success,
  };

  const colour = fg[tone];

  return (
    <View style={[styles.badge, styles[tone], style]}>
      {dot && <View style={[styles.dot, { backgroundColor: colour }]} />}
      {!dot && icon !== undefined && <Icon name={icon} size={12} color={colour} />}
      <AppText variant="overline" color={colour} overline numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    badge: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
      borderRadius: radii.pill,
      borderWidth: 1,
      flexShrink: 1,
    },
    dot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },
    neutral: {
      backgroundColor: palette.surfaceRaised,
      borderColor: palette.borderStrong,
    },
    demo: {
      backgroundColor: palette.demoSurface,
      borderColor: palette.demo,
    },
    accent: {
      backgroundColor: palette.accentSurface,
      borderColor: palette.accent,
    },
    warning: {
      backgroundColor: palette.warningSurface,
      borderColor: palette.warning,
    },
    danger: {
      backgroundColor: palette.dangerSurface,
      borderColor: palette.danger,
    },
    success: {
      backgroundColor: palette.successSurface,
      borderColor: palette.success,
    },
  });
