/**
 * Standalone Speech Output Waveform Component.
 *
 * Faithfully integrated from the approved Google Stitch design specification:
 * (Sanket Vaanni Standalone Speech Output Waveform Component, screen 8b5629d475fd4fc193289b18e4217e30)
 *
 * ## Features:
 * - 36 vertical luminous bars with pill border radiuses.
 * - Restrained 52pt viewport with center zero-energy guide line.
 * - Dynamic harmonic wave modulation when `speaking` is true.
 * - Organic Gaussian resting envelope when speech is enabled and idle.
 * - Muted dormant profile when speech is disabled or in error.
 * - Driven by shared theme tokens (`palette.accent`, `palette.accentSoft`, `palette.accentGlow`).
 * - Respects `reduceMotion` (accessible, battery-friendly).
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { useReduceMotion } from '../hooks/useReduceMotion';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii } from '../theme';

export const WAVEFORM_BAR_COUNT = 36;

export interface SpeechOutputWaveformProps {
  /** Whether speech output is toggled on. */
  enabled: boolean;
  /** Whether audio is currently being spoken aloud. */
  speaking: boolean;
  /** Whether speech output is in an unavailable or error state. */
  blocked?: boolean;
  testID?: string;
}

export function SpeechOutputWaveform({
  enabled,
  speaking,
  blocked = false,
  testID,
}: SpeechOutputWaveformProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const reduceMotion = useReduceMotion();

  // Animation drivers:
  // - phase: 0 -> 1 loop continuously driving speaking harmonic waves
  // - breath: 0 -> 1 -> 0 loop driving calm resting respiration
  const phase = useRef(new Animated.Value(0)).current;
  const breath = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion || !speaking) {
      phase.setValue(0);
      return;
    }

    const speakingLoop = Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );

    speakingLoop.start();
    return () => speakingLoop.stop();
  }, [phase, speaking, reduceMotion]);

  useEffect(() => {
    if (reduceMotion || !enabled || speaking || blocked) {
      breath.setValue(0);
      return;
    }

    const breathingLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 2400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: false,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 2400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: false,
        }),
      ]),
    );

    breathingLoop.start();
    return () => breathingLoop.stop();
  }, [breath, enabled, speaking, blocked, reduceMotion]);

  // Base Gaussian curve profile for resting state
  const baseHeights = useMemo(() => {
    const list: number[] = [];
    const mid = WAVEFORM_BAR_COUNT / 2;
    for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
      const distFromCenter = Math.abs(i - mid) / mid;
      // Gaussian bell: 4pt at edges, up to 11pt in center
      const bell = Math.exp(-3.2 * distFromCenter * distFromCenter);
      const h = 4 + bell * 7;
      list.push(h);
    }
    return list;
  }, []);

  // Compute interpolated heights or static resting values for each bar
  const bars = useMemo(() => {
    return baseHeights.map((baseH, i) => {
      if (!enabled || blocked) {
        // Dormant flat profile
        return {
          height: 3.5,
          opacity: 0.22,
          color: palette.textMuted,
        };
      }

      if (speaking && !reduceMotion) {
        // Speaking state: harmonic sine envelope
        const harmonicFactor = Math.sin((i / WAVEFORM_BAR_COUNT) * Math.PI);
        const minH = 5;
        const maxH = 8 + harmonicFactor * 28;

        const dynamicHeight = phase.interpolate({
          inputRange: [0, 0.25, 0.5, 0.75, 1],
          outputRange: [
            minH + Math.sin(i * 0.45) * (maxH - minH) * 0.4,
            minH + Math.sin(i * 0.45 + Math.PI / 2) * (maxH - minH) * 0.9,
            minH + Math.sin(i * 0.45 + Math.PI) * (maxH - minH) * 0.5,
            minH + Math.sin(i * 0.45 + (3 * Math.PI) / 2) * (maxH - minH) * 0.95,
            minH + Math.sin(i * 0.45 + 2 * Math.PI) * (maxH - minH) * 0.4,
          ],
        });

        return {
          height: dynamicHeight,
          opacity: 0.95,
          color: palette.accent,
        };
      }

      // Enabled, resting: breathing Gaussian distribution
      if (!reduceMotion) {
        const breathingHeight = breath.interpolate({
          inputRange: [0, 1],
          outputRange: [baseH, baseH * 1.35],
        });
        return {
          height: breathingHeight,
          opacity: 0.75,
          color: palette.accent,
        };
      }

      return {
        height: baseH,
        opacity: 0.75,
        color: palette.accent,
      };
    });
  }, [baseHeights, enabled, speaking, blocked, reduceMotion, phase, breath, palette]);

  return (
    <View style={styles.viewport} testID={testID}>
      {/* Zero-energy center guide line */}
      <View style={styles.centerGuide} />

      {/* 36 Vertical Luminous Bars */}
      <View style={styles.barsContainer}>
        {bars.map((bar, index) => (
          <Animated.View
            key={index}
            style={[
              styles.bar,
              {
                height: bar.height,
                backgroundColor: bar.color,
                opacity: bar.opacity,
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    viewport: {
      position: 'relative',
      height: 52,
      width: '100%',
      borderRadius: radii.md,
      backgroundColor: palette.surfaceSunken,
      borderWidth: 1,
      borderColor: palette.border,
      justifyContent: 'center',
      paddingHorizontal: 12,
      overflow: 'hidden',
    },
    centerGuide: {
      position: 'absolute',
      left: 12,
      right: 12,
      top: 25.5,
      height: 1,
      backgroundColor: 'rgba(255, 255, 255, 0.05)',
    },
    barsContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: '100%',
      width: '100%',
    },
    bar: {
      width: 3.5,
      borderRadius: radii.pill,
    },
  });
