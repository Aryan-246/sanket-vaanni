import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface FlexBarProps {
  /** Display name, e.g. "Thumb". */
  label: string;
  /**
   * Calibrated bend, 0..1, or null when no reading is available.
   *
   * Null is a real state, not an error: an uncalibrated channel or a
   * disconnected glove has no bend, and rendering that as `0.00` would claim
   * the finger is extended, which is a measurement we do not have.
   */
  calibrated: number | null;
  /** Raw channel value as reported by the transport, or null. */
  raw: number | null;
  /** Right-aligned hint, e.g. the source of the reading. */
  note?: string;
  /**
   * Bar colour. `demo` for a simulated stream.
   *
   * A second, redundant signal alongside the Demo Mode label. It exists because
   * a screenshot of a simulated reading and a screenshot of a real one should
   * not be identical — someone comparing two screenshots, or glancing at a
   * screen from across a room, is the case the label alone does not cover.
   */
  tone?: 'accent' | 'demo';
}

/**
 * One finger's bend, as a horizontal bar plus its two readings.
 *
 * ## Why horizontal
 *
 * Ten vertical bars (five fingers, two hands) forced narrow tracks with
 * three-character labels, and the numeric value had to sit under each one. A
 * row per finger gives the label its full word and puts both the calibrated
 * and raw figures on the same line as the bar they describe, which is what
 * makes the pair readable at a glance.
 *
 * ## Animation
 *
 * The fill is a full-width bar scaled on X from its left edge, animated on the
 * native driver so the 12 Hz sample rate does not put layout work on the JS
 * thread. `transformOrigin` is what pins the scale to the left edge; without
 * it the bar would grow from the centre and read as a different value.
 */
export function FlexBar({
  label,
  calibrated,
  raw,
  note,
  tone = 'accent',
}: FlexBarProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const available = calibrated !== null && Number.isFinite(calibrated);
  const clamped = available ? Math.min(1, Math.max(0, calibrated)) : 0;

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
    <View
      style={styles.row}
      accessible
      accessibilityLabel={
        available
          ? `${label}, bend ${(clamped * 100).toFixed(0)} percent`
          : `${label}, no reading available`
      }
    >
      <AppText variant="caption" color={styles.label.color} style={styles.label} numberOfLines={1}>
        {label}
      </AppText>

      <View style={styles.track}>
        {available && (
          <Animated.View
            style={[
              styles.fill,
              {
                backgroundColor: tone === 'demo' ? palette.demo : palette.accent,
                transform: [{ scaleX: scale }],
              },
            ]}
          />
        )}
      </View>

      <View style={styles.values}>
        <AppText variant="reading" color={available ? styles.value.color : styles.none.color}>
          {available ? clamped.toFixed(2) : '—'}
        </AppText>
        <AppText variant="caption" color={styles.raw.color} numberOfLines={1}>
          {raw === null ? 'raw —' : `raw ${formatRaw(raw)}`}
          {note !== undefined ? ` · ${note}` : ''}
        </AppText>
      </View>
    </View>
  );
}

/** Raw values have no fixed scale, so they are shown verbatim but bounded. */
function formatRaw(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    label: {
      width: 52,
      color: palette.textSecondary,
    },
    track: {
      flex: 1,
      height: 8,
      borderRadius: radii.pill,
      backgroundColor: palette.surfaceSunken,
      overflow: 'hidden',
    },
    fill: {
      width: '100%',
      height: '100%',
      borderRadius: radii.pill,
      backgroundColor: palette.accent,
      /*
       * Scaling from the left edge is what makes the bar grow from its start
       * rather than its middle. It lives here rather than inline with the
       * animated transform because it never changes — only `scaleX` does.
       */
      transformOrigin: 'left',
    },
    values: {
      width: 92,
      alignItems: 'flex-end',
      gap: 1,
    },
    value: {
      color: palette.textPrimary,
    },
    none: {
      color: palette.textMuted,
    },
    raw: {
      color: palette.textMuted,
    },
  });
