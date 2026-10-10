import React from 'react';
import { StyleSheet, Text, type TextProps, type TextStyle } from 'react-native';

import { colors, letterSpacing, typography } from '../theme';

type Variant = keyof typeof typography;

export interface AppTextProps extends TextProps {
  variant?: Variant;
  color?: string;
  /** Applies the tracked, uppercase treatment used for section labels. */
  overline?: boolean;
  center?: boolean;
}

/**
 * Typography primitive.
 *
 * Every string in the app goes through this so the scale stays consistent and
 * `maxFontSizeMultiplier` is capped centrally — the layout is dense, and
 * uncapped dynamic type would break it. Users who need larger text still get a
 * meaningful increase (1.4×).
 */
export function AppText({
  variant = 'body',
  color = colors.textPrimary,
  overline = false,
  center = false,
  style,
  ...rest
}: AppTextProps): React.JSX.Element {
  const base = typography[variant] as TextStyle;

  return (
    <Text
      maxFontSizeMultiplier={1.4}
      style={[
        base,
        { color },
        overline && styles.overline,
        center && styles.center,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  overline: {
    letterSpacing: letterSpacing.overline,
    textTransform: 'uppercase',
  },
  center: {
    textAlign: 'center',
  },
});
