import React from 'react';
import { StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';

import { elevationStyle, useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface CardProps extends ViewProps {
  /** Slightly lighter surface, for nested or emphasised groups. */
  raised?: boolean;
  /** Recessed surface, for canvases and wells. */
  sunken?: boolean;
  /** Tints the border to draw attention. Does not convey meaning on its own. */
  accentBorder?: boolean;
  /** 0 = flat (border only), 1 = resting, 2 = floating. */
  elevation?: 0 | 1 | 2;
  style?: ViewStyle | ViewStyle[];
}

export function Card({
  raised = false,
  sunken = false,
  accentBorder = false,
  elevation = 0,
  style,
  children,
  ...rest
}: CardProps): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);

  return (
    <View
      style={[
        styles.card,
        raised && styles.raised,
        sunken && styles.sunken,
        accentBorder && styles.accentBorder,
        elevationStyle(palette, elevation),
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: palette.surface,
      borderRadius: radii.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      padding: spacing.lg,
    },
    raised: {
      backgroundColor: palette.surfaceRaised,
    },
    sunken: {
      backgroundColor: palette.surfaceSunken,
    },
    accentBorder: {
      borderColor: palette.accent,
      borderWidth: 1,
    },
  });
