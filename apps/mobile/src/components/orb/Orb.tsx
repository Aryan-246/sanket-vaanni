/**
 * The central orb.
 *
 * ## What it is
 *
 * One luminous element at the centre of the Dashboard, whose colour and motion
 * are a direct readout of what the app is doing. It is the first thing the eye
 * lands on, which is why it is allowed to be the only thing on the screen that
 * moves without being asked to.
 *
 * ## Built from plain views
 *
 * There is no gradient or SVG dependency here. The bloom is three concentric
 * translucent circles — a cheap approximation of a radial falloff that costs
 * nothing at runtime and, at this size, is hard to tell from the real thing on
 * a phone screen. Adding a native gradient library to draw one circle would be
 * a large dependency for a small gain.
 *
 * ## Accessibility
 *
 * The orb is decorative in the literal sense: every state it shows is also
 * stated in words beside it, and it carries an `accessibilityLabel` naming that
 * state for a screen reader. Nothing depends on perceiving the colour — which
 * matters here more than usual, because the states are distinguished by hue.
 *
 * Under `reduceMotion` the animation stops entirely and the orb holds a static
 * shape in the state colour. The information is identical; only the motion is
 * gone.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { useReduceMotion } from '../../hooks/useReduceMotion';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import type { Palette } from '../../theme/palette';
import { OrbState } from './useOrbState';

export interface OrbStateAppearance {
  /** The colour of the core and rings. */
  readonly colour: (palette: Palette) => string;
  /** How brightly the bloom burns, 0–1. */
  readonly bloom: number;
  /** One full animation cycle, in milliseconds. */
  readonly periodMs: number;
  /** Peak scale of the bloom layer. Larger means a more insistent pulse. */
  readonly peakScale: number;
  /** Whether expanding ripples are drawn. Only the speaking state uses them. */
  readonly ripples: boolean;
  /** Short human description, used as the accessibility label. */
  readonly description: string;
}

/**
 * The visual character of each state.
 *
 * The periods are deliberate rather than arbitrary: a resting state breathes at
 * roughly the rate of a slow breath, and an active one beats faster than that,
 * so the difference is felt rather than compared. The error state is the only
 * one that is completely still — an alarming thing that also throbs reads as a
 * notification, and this is a fault.
 */
export const ORB_APPEARANCE: Record<OrbState, OrbStateAppearance> = {
  idle: {
    colour: (p) => p.unknown,
    bloom: 0.4,
    periodMs: 5200,
    peakScale: 1.02,
    ripples: false,
    description: 'Idle. No glove connected.',
  },
  connecting: {
    colour: (p) => p.warning,
    bloom: 0.7,
    periodMs: 1600,
    peakScale: 1.06,
    ripples: false,
    description: 'Connecting to a glove.',
  },
  ready: {
    colour: (p) => p.accent,
    bloom: 0.6,
    periodMs: 4200,
    peakScale: 1.03,
    ripples: false,
    description: 'Ready. Glove connected, waiting for a sign.',
  },
  receiving: {
    colour: (p) => p.accent,
    bloom: 1,
    periodMs: 1800,
    peakScale: 1.08,
    ripples: false,
    description: 'Receiving data from the glove.',
  },
  recognising: {
    colour: (p) => p.accentSoft,
    bloom: 1,
    periodMs: 900,
    peakScale: 1.1,
    ripples: false,
    description: 'Recognising a sign.',
  },
  'text-updating': {
    colour: (p) => p.accentSoft,
    bloom: 1,
    periodMs: 1100,
    peakScale: 1.12,
    ripples: false,
    description: 'Recognised text updated.',
  },
  speaking: {
    colour: (p) => p.accentSoft,
    bloom: 1,
    periodMs: 1400,
    peakScale: 1.06,
    ripples: true,
    description: 'Speaking the translated text aloud.',
  },
  error: {
    colour: (p) => p.danger,
    bloom: 0.85,
    periodMs: 0,
    peakScale: 1,
    ripples: false,
    description: 'Glove error.',
  },
};

import { OrbShader } from './OrbShader';

export interface OrbProps {
  state: OrbState;
  /** Diameter of the whole assembly, in points. */
  size?: number;
  /**
   * Overrides the spoken description. Used when the surrounding screen knows
   * something the orb does not — a glove name, or the reason a state is
   * unavailable.
   */
  accessibilityLabel?: string;
  testID?: string;
}

export function Orb({
  state,
  size = 200,
  accessibilityLabel,
  testID,
}: OrbProps): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);
  const reduceMotion = useReduceMotion();

  const appearance = ORB_APPEARANCE[state];
  const colour = appearance.colour(palette);

  /** 0 → 1 → 0 over one period, driving everything that moves. */
  const pulse = useRef(new Animated.Value(0)).current;
  /** 0 → 1 continuously, driving the speaking ripples. */
  const ripple = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion || appearance.periodMs === 0) {
      pulse.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: appearance.periodMs / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: appearance.periodMs / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    loop.start();
    return () => loop.stop();
  }, [pulse, appearance.periodMs, reduceMotion]);

  useEffect(() => {
    if (reduceMotion || !appearance.ripples) {
      ripple.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.timing(ripple, {
        toValue: 1,
        duration: appearance.periodMs,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );

    loop.start();
    return () => loop.stop();
  }, [ripple, appearance.periodMs, appearance.ripples, reduceMotion]);

  const geometry = useMemo(
    () => ({
      bloom: size,
      ring: Math.round(size * 0.72),
      core: Math.round(size * 0.44),
      lit: Math.round(size * 0.22),
      rippleStart: Math.round(size * 0.44),
      shader: Math.round(size * 0.74),
    }),
    [size],
  );

  const bloomOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [appearance.bloom * 0.12, appearance.bloom * 0.28],
  });

  const bloomScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, appearance.peakScale],
  });

  const ringOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [appearance.bloom * 0.28, appearance.bloom * 0.5],
  });

  return (
    <View
      style={[styles.root, { width: size, height: size }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? appearance.description}
      testID={testID}
    >
      {/* Outer atmospheric aura bloom — the luminous light the orb throws. */}
      <Animated.View
        style={[
          styles.layer,
          {
            width: geometry.bloom,
            height: geometry.bloom,
            borderRadius: geometry.bloom / 2,
            backgroundColor: colour,
            opacity: bloomOpacity,
            transform: [{ scale: bloomScale }],
          },
        ]}
      />

      {/* Spherical drop shadow underneath the volumetric core */}
      <View
        style={[
          styles.layer,
          styles.dropShadow,
          {
            width: geometry.shader * 0.75,
            bottom: -size * 0.08,
            backgroundColor: palette.scheme === 'dark' ? 'rgba(0, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.15)',
          },
        ]}
      />

      {/* Ripple rings, speaking only. */}
      {appearance.ripples && !reduceMotion
        ? [0, 0.5].map((offset) => (
            <Animated.View
              key={offset}
              style={[
                styles.layer,
                styles.rippleRing,
                {
                  width: geometry.rippleStart * 2,
                  height: geometry.rippleStart * 2,
                  borderRadius: geometry.rippleStart,
                  borderColor: colour,
                  opacity: ripple.interpolate({
                    inputRange: [0, 0.15, 1],
                    outputRange: [
                      0,
                      offset === 0 ? 0.5 : 0,
                      offset === 0 ? 0 : 0.5,
                    ],
                    extrapolate: 'clamp',
                  }),
                  transform: [
                    {
                      scale: ripple.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, size / geometry.rippleStart],
                        extrapolate: 'clamp',
                      }),
                    },
                  ],
                },
              ]}
            />
          ))
        : null}

      {/* Inner ring — the boundary of the lit core. */}
      <Animated.View
        style={[
          styles.layer,
          styles.coreRing,
          {
            width: geometry.ring,
            height: geometry.ring,
            borderRadius: geometry.ring / 2,
            borderColor: colour,
            opacity: ringOpacity,
          },
        ]}
      />

      {/* High-fidelity Volumetric WebGL Fluid Shader from Google Stitch */}
      <View
        pointerEvents="none"
        style={[
          styles.layer,
          {
            width: geometry.shader,
            height: geometry.shader,
            borderRadius: geometry.shader / 2,
            overflow: 'hidden',
          },
        ]}
      >
        <OrbShader state={state} size={geometry.shader} />
      </View>

      {/* Base lit core for fallback and depth */}
      <View
        pointerEvents="none"
        style={[
          styles.layer,
          {
            width: geometry.lit,
            height: geometry.lit,
            borderRadius: geometry.lit / 2,
            backgroundColor: palette.accentSoft,
            opacity: 0.18,
          },
        ]}
      />
    </View>
  );
}

const makeStyles = (_palette: Palette) =>
  StyleSheet.create({
    root: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    layer: {
      position: 'absolute',
    },
    /*
     * The two ring thicknesses, named here rather than written inline. They are
     * fixed values, so they belong with the rest of the shape; only the ring
     * diameters and colours vary per state.
     */
    rippleRing: {
      borderWidth: 1.5,
    },
    coreRing: {
      borderWidth: 1,
    },
    dropShadow: {
      height: 16,
      borderRadius: 9999,
      alignSelf: 'center',
    },
  });
