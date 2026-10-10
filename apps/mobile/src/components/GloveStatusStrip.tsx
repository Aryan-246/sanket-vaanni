import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Badge } from './Badge';
import type { GloveSnapshot } from '../ble/controller';
import { isSimulatedLink, linkHealth, linkLabel } from '../ble/link';
import type { HealthState } from '../audit/status';
import type { GloveSide } from '../ble/types';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { motion, radii, spacing } from '../theme';

/**
 * At-a-glance state for both gloves.
 *
 * Sits at the top of the Dashboard because the first question anyone asks this
 * app is "is it connected?", and answering that should not require scrolling to
 * a control panel. It is also the screen's hand selector: tapping a row makes
 * that glove the one the viewer, the sensors and the recognition panel are
 * showing, which turns a status readout into the spine of the screen rather than
 * a decoration above it.
 */
export interface GloveStatusStripProps {
  gloves: Readonly<Record<GloveSide, GloveSnapshot>>;
  active: GloveSide;
  onSelect: (side: GloveSide) => void;
}

const SIDES: readonly GloveSide[] = ['left', 'right'];

export function GloveStatusStrip({
  gloves,
  active,
  onSelect,
}: GloveStatusStripProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={styles.strip} accessibilityRole="tablist" accessibilityLabel="Glove status">
      {SIDES.map((side) => {
        const snapshot = gloves[side];
        const health = linkHealth(snapshot.link);
        const selected = side === active;

        return (
          <Pressable
            key={side}
            onPress={() => onSelect(side)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`${linkLabel(snapshot.link, side)}${selected ? ', selected' : ''}`}
            accessibilityHint="Shows this hand in the viewer, sensors and recognition panel"
            style={({ pressed }) => [
              styles.item,
              selected && styles.itemSelected,
              pressed && styles.pressed,
            ]}
          >
            <StateDot health={health} />

            <View style={styles.itemText}>
              <AppText variant="label" numberOfLines={1}>
                {side === 'left' ? 'Left glove' : 'Right glove'}
              </AppText>
              <AppText variant="caption" color={palette.textMuted} numberOfLines={1}>
                {stateWord(snapshot)}
              </AppText>
            </View>

            {isSimulatedLink(snapshot.link) && <Badge label="Demo" tone="demo" />}
          </Pressable>
        );
      })}
    </View>
  );
}

function stateWord(snapshot: GloveSnapshot): string {
  const kind = snapshot.link.kind;
  if (kind === 'connected') {
    return isSimulatedLink(snapshot.link) ? 'Simulated stream' : 'Live';
  }
  return linkLabel(snapshot.link, snapshot.side).replace(/^\w+ · /, '');
}

/**
 * Colour token per health state.
 *
 * Typed as a literal union rather than `keyof Palette` on purpose: `Palette`
 * also carries `scheme` and `shadowOpacity`, so a general key would widen the
 * result to `string | number` and `backgroundColor` would reject it.
 */
const DOT_COLOR: Record<HealthState, 'success' | 'warning' | 'danger' | 'unknown'> = {
  healthy: 'success',
  warning: 'warning',
  disconnected: 'danger',
  unavailable: 'unknown',
  unknown: 'unknown',
};

/**
 * The dot: colour plus motion.
 *
 * It pulses only when the link is genuinely healthy, and the pulse is the
 * *only* thing motion is used for here — a still dot means still, which is
 * information. The animation is driven on the native driver and stopped on
 * unmount, because a loop that outlives its view keeps a native animation
 * running on a screen nobody is looking at.
 */
function StateDot({ health }: { health: HealthState }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const pulse = useRef(new Animated.Value(1)).current;
  const live = health === 'healthy';

  useEffect(() => {
    if (!live) {
      pulse.setValue(1);
      return;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: motion.slow * 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: motion.slow * 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();
    return () => animation.stop();
  }, [live, pulse]);

  return (
    <Animated.View
      style={[
        styles.dot,
        { backgroundColor: palette[DOT_COLOR[health]], opacity: pulse },
      ]}
    />
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    strip: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    item: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      minHeight: 56,
    },
    itemSelected: {
      borderColor: palette.accent,
      backgroundColor: palette.accentSurface,
    },
    pressed: {
      opacity: 0.75,
    },
    itemText: {
      flex: 1,
      gap: 1,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
  });
