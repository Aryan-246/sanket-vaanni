import React from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { AppText } from './AppText';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH_TARGET, radii, spacing } from '../theme';

export interface TextFieldProps
  extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
  /** Visible label above the field. Always provide one. */
  label: string;
  /** Supporting line under the field — used for limits and errors. */
  hint?: string;
  /** Set when the hint reports a problem, so it is coloured as one. */
  invalid?: boolean;
}

/**
 * Text input.
 *
 * The label is required rather than optional: a placeholder alone disappears the
 * moment someone types, which leaves a filled field with no indication of what it
 * holds, and is invisible to a screen reader that reads the value.
 *
 * `accessibilityLabel` defaults to the label, so the two cannot disagree.
 */
export function TextField({
  label,
  hint,
  invalid = false,
  accessibilityLabel,
  ...rest
}: TextFieldProps): React.JSX.Element {
  const { palette } = useTheme();

  return (
    <View style={styles.host}>
      <AppText variant="caption" color={palette.textSecondary}>
        {label}
      </AppText>

      <TextInput
        accessibilityLabel={accessibilityLabel ?? label}
        placeholderTextColor={palette.textMuted}
        selectionColor={palette.accent}
        style={[
          styles.input,
          {
            color: palette.textPrimary,
            backgroundColor: palette.surfaceSunken,
            borderColor: invalid ? palette.danger : palette.border,
          },
        ]}
        {...rest}
      />

      {hint !== undefined && (
        <AppText
          variant="caption"
          color={invalid ? palette.danger : palette.textMuted}
        >
          {hint}
        </AppText>
      )}
    </View>
  );
}

/**
 * Static geometry only.
 *
 * Every colour here comes from an inline style over the top, because the border
 * colour depends on `invalid` and the rest on the palette — so the sheet holds
 * only what is the same in both themes and both validity states.
 */
const styles = StyleSheet.create({
  host: {
    gap: spacing.xs,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    fontSize: 15,
  },
});
