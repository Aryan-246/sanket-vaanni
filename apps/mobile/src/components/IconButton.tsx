import React from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Icon, type IconName } from './Icon';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii } from '../theme';

export interface IconButtonProps {
  icon: IconName;
  onPress: () => void;
  /** Required: an icon alone has nothing for a screen reader to read. */
  accessibilityLabel: string;
  accessibilityHint?: string;
  disabled?: boolean;
  /** `accent` for the affirmative action in a pair, `danger` for a destructive one. */
  tone?: 'default' | 'accent' | 'danger';
  testID?: string;
}

/**
 * A square icon-only button.
 *
 * ## Touch target
 *
 * The visual box is 36dp, which is deliberately smaller than the 48dp minimum.
 * The *hit area* is not: `hitSlop` extends it by 8dp on every side, giving a
 * 52dp target. That is the right trade for a row of reorder arrows, where four
 * 48dp boxes would not fit on a phone — and the measured target is what matters,
 * not the drawn one.
 */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  tone = 'default',
  testID,
}: IconButtonProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const color =
    tone === 'accent'
      ? palette.accent
      : tone === 'danger'
        ? palette.danger
        : palette.textSecondary;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon name={icon} size={17} color={color} />
    </Pressable>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    button: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radii.sm,
      backgroundColor: palette.surfaceSunken,
    },
    pressed: {
      opacity: 0.6,
      transform: [{ scale: 0.96 }],
    },
    disabled: {
      opacity: 0.35,
    },
  });
