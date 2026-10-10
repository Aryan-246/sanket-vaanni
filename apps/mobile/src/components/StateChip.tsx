import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { useStyles } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';
import { HEALTH_LABEL, type HealthState } from '../audit/status';

/** Icon per state. Paired with a word, always. */
const ICON: Record<HealthState, IconName> = {
  healthy: 'check',
  warning: 'warning',
  disconnected: 'link',
  unavailable: 'info',
  unknown: 'info',
};

/**
 * A component's health, as a chip.
 *
 * The label is mandatory and comes from `HEALTH_LABEL`, so no caller can
 * invent friendlier wording — "Connected" for a state that is really
 * "unknown" is exactly the failure this prevents.
 */
export function StateChip({
  state,
  /** Overrides the default wording. Use only to add specificity. */
  label,
}: {
  state: HealthState;
  label?: string;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);

  const fg: Record<HealthState, string> = {
    healthy: styles.healthyText.color,
    warning: styles.warningText.color,
    disconnected: styles.disconnectedText.color,
    unavailable: styles.unavailableText.color,
    unknown: styles.unknownText.color,
  };

  const colour = fg[state];

  return (
    <View
      style={[styles.chip, styles[state]]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Status: ${label ?? HEALTH_LABEL[state]}`}
    >
      <Icon name={ICON[state]} size={12} color={colour} weight={2} />
      <AppText variant="caption" color={colour} numberOfLines={1}>
        {label ?? HEALTH_LABEL[state]}
      </AppText>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderRadius: radii.pill,
      borderWidth: 1,
      alignSelf: 'flex-start',
      flexShrink: 1,
    },
    healthy: {
      backgroundColor: palette.successSurface,
      borderColor: palette.success,
    },
    healthyText: { color: palette.success },
    warning: {
      backgroundColor: palette.warningSurface,
      borderColor: palette.warning,
    },
    warningText: { color: palette.warning },
    disconnected: {
      backgroundColor: palette.dangerSurface,
      borderColor: palette.danger,
    },
    disconnectedText: { color: palette.danger },
    unavailable: {
      backgroundColor: palette.surfaceRaised,
      borderColor: palette.borderStrong,
    },
    unavailableText: { color: palette.textSecondary },
    unknown: {
      backgroundColor: palette.unknownSurface,
      borderColor: palette.border,
    },
    unknownText: { color: palette.unknown },
  });
