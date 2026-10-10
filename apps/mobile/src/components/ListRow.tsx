import React from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { MIN_TOUCH_TARGET, spacing } from '../theme';

export interface ListRowProps {
  label: string;
  /** Right-aligned value. Use for readings, not for actions. */
  value?: string;
  /** Colour for `value`; defaults to secondary text. */
  valueColor?: string;
  /** Second line under the label. */
  description?: string;
  icon?: IconName;
  onPress?: () => void;
  /** Trailing accessory instead of the chevron — e.g. a switch. */
  accessory?: React.ReactNode;
  /** Renders the row as non-interactive. */
  disabled?: boolean;
  /** Omit the bottom hairline, for the last row in a group. */
  last?: boolean;
  style?: ViewStyle;
  testID?: string;
}

/**
 * A settings-style row.
 *
 * The chevron only appears when the row actually does something — a row that
 * looks tappable and is not is worse than a plainly inert one.
 */
export function ListRow({
  label,
  value,
  valueColor,
  description,
  icon,
  onPress,
  accessory,
  disabled = false,
  last = false,
  style,
  testID,
}: ListRowProps): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);
  const interactive = onPress !== undefined && !disabled;

  const content = (
    <>
      {icon !== undefined && (
        <View style={styles.iconWell}>
          <Icon name={icon} size={17} color={palette.textSecondary} />
        </View>
      )}

      <View style={styles.text}>
        <AppText variant="body" color={disabled ? palette.textMuted : palette.textPrimary}>
          {label}
        </AppText>
        {description !== undefined && (
          <AppText variant="caption" color={palette.textMuted} style={styles.description}>
            {description}
          </AppText>
        )}
      </View>

      {value !== undefined && (
        <AppText
          variant="label"
          color={valueColor ?? palette.textSecondary}
          style={styles.value}
          numberOfLines={1}
        >
          {value}
        </AppText>
      )}

      {accessory}

      {interactive && (
        <Icon name="chevronRight" size={16} color={palette.textMuted} />
      )}
    </>
  );

  if (!interactive) {
    return (
      <View style={[styles.row, !last && styles.divider, style]} testID={testID}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ disabled }}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.row,
        !last && styles.divider,
        pressed && styles.pressed,
        style,
      ]}
    >
      {content}
    </Pressable>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: MIN_TOUCH_TARGET,
      paddingVertical: spacing.md,
    },
    divider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    pressed: {
      opacity: 0.6,
    },
    iconWell: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: palette.surfaceSunken,
      alignItems: 'center',
      justifyContent: 'center',
    },
    text: {
      flex: 1,
      gap: 2,
    },
    description: {
      marginTop: 1,
    },
    value: {
      flexShrink: 1,
      textAlign: 'right',
    },
  });
