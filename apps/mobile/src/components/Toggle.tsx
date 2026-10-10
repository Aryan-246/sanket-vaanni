import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet } from 'react-native';

import { useStyles } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { motion } from '../theme';

export interface ToggleProps {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  /** Announced to screen readers. Required in practice — the switch has no text. */
  accessibilityLabel: string;
  accessibilityHint?: string;
}

const TRACK_WIDTH = 46;
const TRACK_HEIGHT = 28;
const KNOB = 22;
const TRAVEL = TRACK_WIDTH - KNOB - 6;

/**
 * A switch.
 *
 * Built rather than using React Native's `Switch`, because the platform switch
 * cannot be themed to match either palette — it renders in the system accent
 * colour, which in the dark theme is the one element that would not match.
 *
 * The animation runs on the native driver and, importantly, is driven from the
 * `value` prop on every change rather than only on press. That means a
 * programmatic change — a reset, or a restored preference — animates
 * identically to a tap, and the knob cannot end up out of step with the state.
 */
export function Toggle({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
}: ToggleProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: motion.fast,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [value, progress]);

  const trackColor = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [styles.trackOff.backgroundColor as string, styles.trackOn.backgroundColor as string],
  });

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      // A switch is a small target by nature; the hit area is padded out to
      // the 48dp minimum without enlarging the visual control.
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      style={styles.hit}
    >
      <Animated.View
        style={[
          styles.track,
          { backgroundColor: trackColor },
          disabled && styles.disabled,
          value && styles.trackBorderOn,
        ]}
      >
        <Animated.View
          style={[
            styles.knob,
            {
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [3, 3 + TRAVEL],
                  }),
                },
              ],
            },
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    hit: {
      paddingVertical: 2,
    },
    track: {
      width: TRACK_WIDTH,
      height: TRACK_HEIGHT,
      borderRadius: TRACK_HEIGHT / 2,
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: palette.borderStrong,
    },
    trackOff: {
      backgroundColor: palette.surfaceSunken,
    },
    trackOn: {
      backgroundColor: palette.accent,
    },
    trackBorderOn: {
      borderColor: palette.accent,
    },
    knob: {
      width: KNOB,
      height: KNOB,
      borderRadius: KNOB / 2,
      backgroundColor: '#FFFFFF',
      // A hairline keeps the knob visible against the light theme's white card.
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(0,0,0,0.12)',
    },
    disabled: {
      opacity: 0.4,
    },
  });
