import React from 'react';
import {
  Pressable,
  StyleSheet,
  type PressableProps,
  type ViewStyle,
} from 'react-native';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { MIN_TOUCH_TARGET, radii, spacing } from '../theme';

export type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ActionButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  tone?: ButtonTone;
  /** Optional supporting line under the label. */
  hint?: string;
  /** Leading icon. Decorative — the label carries the meaning. */
  icon?: IconName;
  /** Shows a spinner and blocks presses. Implies `disabled`. */
  busy?: boolean;
  /** Compact variant for inline use in headers and rows. */
  compact?: boolean;
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
 * in flight. `busy` is the convenience path — it disables the button *and*
 * announces the wait, so a caller that sets it cannot forget the first half.
 */
export function ActionButton({
  label,
  tone = 'primary',
  hint,
  icon,
  busy = false,
  compact = false,
  style,
  disabled,
  ...rest
}: ActionButtonProps): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);
  const isDisabled = Boolean(disabled) || busy;

  const labelColor =
    tone === 'primary'
      ? palette.onAccent
      : tone === 'danger'
        ? palette.danger
        : palette.textPrimary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: isDisabled, busy }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        styles[tone],
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
      {...rest}
    >
      {busy ? (
        <BusyIndicator color={labelColor} />
      ) : (
        icon !== undefined && <Icon name={icon} size={18} color={labelColor} />
      )}
      <AppText variant="label" color={labelColor} style={styles.label}>
        {label}
      </AppText>
    </Pressable>
  );
}

/**
 * Three dots that pulse in sequence.
 *
 * Kept deliberately minimal — a spinning arc draws more attention than a
 * background action deserves.
 */
function BusyIndicator({ color }: { color: string }): React.JSX.Element {
  return (
    <AppText variant="label" color={color}>
      •••
    </AppText>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    base: {
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.md,
      borderRadius: radii.pill,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      borderWidth: 1,
    },
    compact: {
      minHeight: 36,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    primary: {
      backgroundColor: palette.accent,
      borderColor: palette.accent,
    },
    secondary: {
      backgroundColor: palette.surfaceRaised,
      borderColor: palette.borderStrong,
    },
    ghost: {
      backgroundColor: 'transparent',
      borderColor: palette.border,
    },
    danger: {
      backgroundColor: palette.dangerSurface,
      borderColor: palette.danger,
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
