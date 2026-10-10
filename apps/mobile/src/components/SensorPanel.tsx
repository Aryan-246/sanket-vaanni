import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { FlexBar } from './FlexBar';
import type { GloveSnapshot } from '../ble/controller';
import { isSimulatedLink } from '../ble/link';
import type { CalibrationProfile } from '../sensors/calibration';
import { FINGERS } from '../sensors/types';
import { sideWord } from '../app/format';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface SensorPanelProps {
  side: 'left' | 'right';
  glove: GloveSnapshot;
  calibration: CalibrationProfile;
  testID?: string;
}

/**
 * The five flex channels of one glove.
 *
 * ## Raw and calibrated, side by side, labelled
 *
 * The two columns are different quantities and are never merged: `raw` is what
 * the transport reported, in whatever units it uses, and the large figure is that
 * value after this glove's calibration maps it to 0–1. Showing only one would
 * make the calibration invisible, which is exactly the layer that goes wrong
 * silently.
 *
 * ## Null is not zero
 *
 * With no glove connected there is no reading, so every channel shows `—`. A
 * `0.00` there would be a claim that the fingers are extended, which is a
 * measurement nobody took. `FlexBar` handles that distinction itself; this
 * component's job is to not defeat it by substituting a number.
 *
 * ## The calibration in use is named
 *
 * Today it is the demo calibration — anchors of `rest: 0, fullFlex: 1`, which is
 * a passthrough, because the simulator's raw values are already 0–1. Saying so
 * matters: the numbers look like real calibrated readings, and they are, but the
 * calibration behind them has not been captured from hardware.
 */
export function SensorPanel({
  side,
  glove,
  calibration,
  testID,
}: SensorPanelProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const simulated = isSimulatedLink(glove.link);
  const hasReadings = glove.calibrated !== null;
  const demoCalibration = calibration.capturedAtMs === 0;

  return (
    <Card testID={testID} style={styles.card}>
      <View style={styles.headerRow}>
        <AppText variant="heading">{sideWord(side)} hand · flex sensors</AppText>
        {simulated && <Badge label="Simulated" tone="demo" dot />}
        {!simulated && hasReadings && <Badge label="Hardware" tone="accent" dot />}
        {!hasReadings && <Badge label="No data" tone="neutral" />}
      </View>

      <View style={styles.bars}>
        {FINGERS.map((finger, index) => (
          <FlexBar
            key={finger}
            label={capitalise(finger)}
            calibrated={glove.calibrated?.flex[index] ?? null}
            raw={glove.raw?.flex[index] ?? null}
            // The note repeats the source per row so a single row copied out of
            // context still carries it.
            note={simulated ? 'simulated' : hasReadings ? 'hardware' : undefined}
            tone={simulated ? 'demo' : 'accent'}
          />
        ))}
      </View>

      <View style={styles.legend}>
        <AppText variant="caption" color={palette.textSecondary}>
          Bar and large figure: calibrated bend, 0.00–1.00. Small figure: the raw channel
          value, in transport units.
        </AppText>
        <AppText variant="caption" color={palette.textMuted}>
          Calibration in use:{' '}
          {demoCalibration
            ? 'demo anchors (0→1 passthrough). No rest or full-flex pose has been captured on hardware.'
            : `captured for the ${calibration.side} glove.`}
        </AppText>
      </View>
    </Card>
  );
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.sm,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      flexWrap: 'wrap',
    },
    bars: {
      marginTop: spacing.xs,
    },
    legend: {
      gap: spacing.xs,
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      borderRadius: radii.sm,
    },
  });
