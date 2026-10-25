import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { ActionButton } from './ActionButton';
import { Badge } from './Badge';
import { Card } from './Card';
import { FlexBar } from './FlexBar';
import { Icon } from './Icon';
import type { GloveSnapshot } from '../ble/controller';
import { isSimulatedLink } from '../ble/link';
import type { CalibrationProfile } from '../sensors/calibration';
import { FINGERS } from '../sensors/types';
import type { GloveSide } from '../ble/types';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { MIN_TOUCH_TARGET, motion, radii, spacing } from '../theme';

export interface FingerReadingsProps {
  gloves: Readonly<Record<GloveSide, GloveSnapshot>>;
  calibration: Readonly<Record<GloveSide, CalibrationProfile>>;
  onOpenCalibration?: (side: GloveSide) => void;
  testID?: string;
}

const SIDES: readonly GloveSide[] = ['left', 'right'];

/**
 * Five fingers per hand, behind one disclosure.
 *
 * ## Why this is collapsed by default
 *
 * There are ten channels. Rendered open, they are about four hundred pixels of
 * scrolling — more than the result, the viewer and the voice controls combined —
 * and the numbers only change meaning when you are looking for them. Collapsed,
 * the header still reports enough to know whether there is anything worth
 * opening: which hands are sending, and in what mode.
 *
 * ## Null is not zero, and it is not hidden
 *
 * A hand with no glove shows no rows at all rather than five zeros. `0.00` would
 * be a claim that every finger is extended, which is a measurement nobody took.
 * The empty state says which hand is missing it.
 */
export function FingerReadings({
  gloves,
  calibration,
  onOpenCalibration,
  testID,
}: FingerReadingsProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const [open, setOpen] = useState(false);

  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: motion.fast,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [open, progress]);

  const reporting = useMemo(
    () => SIDES.filter((side) => gloves[side].calibrated !== null),
    [gloves],
  );

  const rotate = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  return (
    <Card testID={testID} style={styles.card}>
      <Pressable
        onPress={() => setOpen((next) => !next)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Finger readings"
        accessibilityHint={
          open ? 'Collapses the per-finger values' : 'Shows the calibrated and raw value of every finger'
        }
        style={styles.header}
      >
        <View style={styles.headerText}>
          <AppText variant="overline" overline color={palette.textMuted}>
            Finger readings
          </AppText>
          <AppText variant="caption" color={palette.textSecondary} numberOfLines={2}>
            {summary(gloves, reporting)}
          </AppText>
        </View>

        <Animated.View style={{ transform: [{ rotate }] }}>
          <Icon name="chevronRight" size={18} color={palette.textMuted} />
        </Animated.View>
      </Pressable>

      {open && (
        <View style={styles.body}>
          {reporting.length === 0 ? (
            <AppText variant="caption" color={palette.textMuted}>
              Nothing here is estimated for a hand that is not connected.
            </AppText>
          ) : (
            reporting.map((side) => (
              <HandReadings
                key={side}
                side={side}
                snapshot={gloves[side]}
                calibration={calibration[side]}
                onOpenCalibration={onOpenCalibration}
              />
            ))
          )}

          {reporting.length > 0 && (
            <AppText variant="caption" color={palette.textMuted} style={styles.legend}>
              Large figure: calibrated bend, 0.00–1.00. Small figure: the raw channel value in
              transport units. {calibrationNote(calibration, reporting)}
            </AppText>
          )}
        </View>
      )}
    </Card>
  );
}

function HandReadings({
  side,
  snapshot,
  calibration,
  onOpenCalibration,
}: {
  side: GloveSide;
  snapshot: GloveSnapshot;
  calibration: CalibrationProfile;
  onOpenCalibration?: (side: GloveSide) => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const simulated = isSimulatedLink(snapshot.link);
  // The demo calibration has no captured timestamp; a real one always does.
  const captured = calibration.capturedAtMs !== 0;

  return (
    <View style={styles.hand}>
      <View style={styles.handHead}>
        <AppText variant="label">{side === 'left' ? 'Left hand' : 'Right hand'}</AppText>
        {simulated && <Badge label="Simulated" tone="demo" dot />}
        {!simulated && <Badge label="Hardware" tone="accent" dot />}
        {!captured && <Badge label="Demo calibration" tone="neutral" />}
      </View>

      {FINGERS.map((finger, index) => (
        <FlexBar
          key={finger}
          label={capitalise(finger)}
          calibrated={snapshot.calibrated?.flex[index] ?? null}
          raw={snapshot.raw?.flex[index] ?? null}
          tone={simulated ? 'demo' : 'accent'}
        />
      ))}

      {onOpenCalibration && (
        <View style={{ marginTop: spacing.sm }}>
          <ActionButton
            label={`Calibrate ${side === 'left' ? 'Left' : 'Right'} Glove`}
            tone="secondary"
            compact
            onPress={() => onOpenCalibration(side)}
          />
        </View>
      )}
    </View>
  );
}

/** One line saying which hands are worth opening this for. */
function summary(
  gloves: Readonly<Record<GloveSide, GloveSnapshot>>,
  reporting: readonly GloveSide[],
): string {
  if (reporting.length === 0) {
    const connected = SIDES.filter((side) => gloves[side].link.kind === 'connected');
    return connected.length > 0
      ? 'Connected, but no frames have arrived yet.'
      : 'No glove connected.';
  }

  return reporting
    .map((side) => {
      const hand = side === 'left' ? 'Left' : 'Right';
      return `${hand}: ${isSimulatedLink(gloves[side].link) ? 'simulated' : 'hardware'}`;
    })
    .concat(reporting.length === 1 ? ['— one hand active'] : [])
    .join(' · ');
}

/**
 * The calibration behind the numbers, said once.
 *
 * Repeated per row it was noise; omitted entirely it would let a passthrough be
 * mistaken for a captured calibration, which is the layer that goes wrong
 * silently.
 */
function calibrationNote(
  calibration: Readonly<Record<GloveSide, CalibrationProfile>>,
  reporting: readonly GloveSide[],
): string {
  const allCaptured = reporting.every((side) => calibration[side].capturedAtMs !== 0);
  return allCaptured
    ? 'Calibration was captured on hardware.'
    : 'Calibration is the demo passthrough (0→1); no rest or full-flex pose has been captured on hardware.';
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      // The whole header is the disclosure control, so it meets the app's own
      // touch floor rather than stopping 4 dp short of it.
      minHeight: MIN_TOUCH_TARGET,
    },
    headerText: {
      flex: 1,
      gap: spacing.xs,
    },
    body: {
      gap: spacing.lg,
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    hand: {
      gap: spacing.xs,
    },
    handHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      flexWrap: 'wrap',
    },
    legend: {
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      borderRadius: radii.sm,
    },
  });
