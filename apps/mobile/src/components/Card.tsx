import React from 'react';
import { StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '../theme';

export interface CardProps extends ViewProps {
  /** Slightly lighter surface, for nested or emphasised groups. */
  raised?: boolean;
  /** Tints the border to draw attention. Does not convey meaning on its own. */
  accentBorder?: boolean;
  style?: ViewStyle | ViewStyle[];
}

export function Card({
  raised = false,
  accentBorder = false,
  style,
  children,
  ...rest
}: CardProps): React.JSX.Element {
  return (
    <View
      style={[
        styles.card,
        raised && styles.raised,
        accentBorder && styles.accentBorder,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  raised: {
    backgroundColor: colors.surfaceRaised,
  },
  accentBorder: {
    borderColor: colors.accent,
    borderWidth: 1,
  },
});
