import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { colors, radii, spacing } from '../theme';

export interface FlexBarProps {
  label: string;
  /** Normalised 0..1. Values outside the range are clamped for display. */
  value: number;
}

const TRACK_HEIGHT = 96;

/**
 * A single finger's flexion, as a vertical bar.
 *
 * Animated with `scaleY` and `useNativeDriver: true`, so the 20 Hz update runs
 * on the UI thread rather than crossing the bridge on every sample. That is
 * what keeps a streaming display from stuttering while the JS thread is busy
 * calibrating.
 *
 * The numeric value is rendered as text as well as shown as a bar height, so
 * the reading does not depend on being able to see fine visual differences.
 */
export function FlexBar({ label, value }: FlexBarProps): React.JSX.Element {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const scale = useRef(new Animated.Value(clamped)).current;

  useEffect(() => {
    Animated.timing(scale, {
      toValue: clamped,
      duration: 90,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [clamped, scale]);

  return (
    <View style={styles.container} accessibilityElementsHidden>
      <View style={styles.track}>
        <Animated.View
          style={[
            styles.fill,
            {
              transform: [
                { translateY: TRACK_HEIGHT / 2 },
                { scaleY: scale },
                { translateY: -TRACK_HEIGHT / 2 },
              ],
            },
          ]}
        />
      </View>
      <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
        {label.slice(0, 3)}
      </AppText>
      <AppText variant="caption" color={colors.textSecondary}>
        {clamped.toFixed(2)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
  },
  track: {
    width: '100%',
    height: TRACK_HEIGHT,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.sm,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  fill: {
    width: '100%',
    height: TRACK_HEIGHT,
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
  },
});
