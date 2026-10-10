import React from 'react';
import {
  Pressable,
  StyleSheet,
  type PressableProps,
  type ViewStyle,
} from 'react-native';

import { AppText } from './AppText';
import { colors, MIN_TOUCH_TARGET, radii, spacing } from '../theme';

export type ButtonTone = 'primary' | 'secondary' | 'ghost';

export interface ActionButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  tone?: ButtonTone;
  /** Optional supporting line under the label. */
  hint?: string;
  style?: ViewStyle;
}

/**
 * Button primitive.
 *
 * Touch feedback is driven by `Pressable`'s pressed state rather than a timed
 * animation, so it stays in step with the platform's own gesture handling and
 * cannot get stuck in a pressed state.
 *
 * Async actions and double-taps: `disabled` is the caller's responsibility via
 * `onPress` + `disabled`, because only the caller knows whether its action is
 * in flight.
 */
export function ActionButton({
  label,
  tone = 'primary',
  hint,
  style,
  disabled,
  ...rest
}: ActionButtonProps): React.JSX.Element {
  const isPrimary = tone === 'primary';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        styles[tone],
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
      {...rest}
    >
      <AppText
        variant="label"
        color={isPrimary ? colors.onAccent : colors.textPrimary}
        style={styles.label}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  primary: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  secondary: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.borderStrong,
  },
  ghost: {
    backgroundColor: 'transparent',
    borderColor: colors.border,
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.985 }],
  },
  disabled: {
    opacity: 0.4,
  },
  label: {
    textAlign: 'center',
  },
});
