import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { MIN_TOUCH_TARGET, radii, spacing } from '../theme';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Announced as the group's purpose. */
  accessibilityLabel: string;
  disabled?: boolean;
  /**
   * Uses the caption size and a tighter horizontal padding.
   *
   * For bars with many short choices — the six administration areas, the five
   * learning-centre areas — where equal segments on a 360 dp content width are
   * narrower than a label at the label size. Truncating "Overview" to
   * "Overvi…" hides the name of a destination the user has to choose between,
   * so the bar spends size on the labels instead: the touch target is
   * unchanged, and the accessibility label was never truncated.
   */
  dense?: boolean;
}

/**
 * A row of mutually exclusive choices.
 *
 * Used where the choice is small, fixed and worth showing all at once — theme
 * mode, glove side, audit filter. The selected segment is marked by both a
 * raised surface *and* a weight change on the label, so the state does not
 * depend on being able to see a subtle background difference.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  disabled = false,
  dense = false,
}: SegmentedControlProps<T>): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);

  return (
    <View
      style={[styles.track, dense && styles.trackDense, disabled && styles.disabled]}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segment,
              dense && styles.segmentDense,
              selected && styles.segmentSelected,
              pressed && !disabled && styles.pressed,
            ]}
          >
            <AppText
              variant={dense ? 'caption' : 'label'}
              color={selected ? palette.textPrimary : palette.textSecondary}
              center
              numberOfLines={1}
            >
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    track: {
      flexDirection: 'row',
      backgroundColor: palette.surfaceSunken,
      borderRadius: radii.md,
      padding: 3,
      gap: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    segment: {
      flex: 1,
      /*
       * 44, not `MIN_TOUCH_TARGET - 12`. The segment is the thing the user
       * actually taps; the 3 pt of track padding around it is not part of the
       * target, so a 36 pt segment left the control under the 44 pt a fingertip
       * needs even though the track looked deep enough. The selected segment is
       * still marked by surface *and* label weight, so this changes reach, not
       * legibility.
       */
      minHeight: MIN_TOUCH_TARGET - 4,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      borderRadius: radii.sm + 2,
    },
    segmentSelected: {
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.borderStrong,
    },
    segmentDense: {
      paddingHorizontal: spacing.xs / 2,
    },
    /*
     * A hair less padding between and around the segments, spent on the labels
     * instead. Six segments on a 360 dp column leave ~57 dp each; at the
     * caption size "Overview" needs almost exactly that, so 4 dp of track and
     * gap is the difference between the whole word and "Overvie…".
     */
    trackDense: {
      padding: 2,
      gap: 2,
    },
    pressed: {
      opacity: 0.7,
    },
    disabled: {
      opacity: 0.45,
    },
  });
