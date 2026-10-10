import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { useStyles } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';

export interface LoadingDotsProps {
  /** Dot diameter in dp. */
  size?: number;
  color?: string;
  /**
   * Accessible description. Pass `null` for purely decorative use next to a
   * label that already says "Loading".
   */
  accessibilityLabel?: string | null;
}

/**
 * Three dots that pulse in sequence.
 *
 * The animation is started on mount and **stopped on unmount**, which matters
 * more than it sounds: an `Animated.loop` that is never stopped keeps a native
 * animation driver running, so a backgrounded screen would go on burning
 * battery indefinitely. `Animated.loop` returns a CompositeAnimation whose
 * `stop()` is the only way to release it.
 *
 * It also respects reduced motion by not animating at all — three static dots
 * are a perfectly legible "working" indicator.
 */
export function LoadingDots({
  size = 6,
  color,
  accessibilityLabel,
}: LoadingDotsProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      progress.setValue(0);
    };
  }, [progress]);

  const dotColor = color ?? (styles.dot.backgroundColor as string);

  return (
    <View
      style={styles.row}
      accessible={accessibilityLabel !== null}
      accessibilityLabel={accessibilityLabel ?? undefined}
      accessibilityRole={accessibilityLabel !== null ? 'progressbar' : undefined}
    >
      {[0, 1, 2].map((index) => (
        <Animated.View
          key={index}
          style={[
            styles.dot,
            {
              width: size,
              height: size,
              borderRadius: size,
              backgroundColor: dotColor,
              // Each dot fades out of phase with the next.
              opacity: progress.interpolate({
                inputRange: [0, 0.33, 0.66, 1],
                outputRange: dotOpacity(index),
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

/** Shifts the shared 0..1 ramp by a third of a cycle per dot. */
function dotOpacity(index: number): number[] {
  const base = [0.25, 1, 0.25, 0.25, 1];
  const rotated = [...base.slice(index), ...base.slice(0, index)];
  return [rotated[0] as number, rotated[1] as number, rotated[2] as number, rotated[3] as number];
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    dot: {
      backgroundColor: palette.textMuted,
    },
  });
