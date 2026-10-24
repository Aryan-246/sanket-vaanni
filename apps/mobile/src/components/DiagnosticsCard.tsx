import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { Icon } from './Icon';
import { ACTIVE_HAND_ASSET } from '../hands/viewer';
import type { GloveSnapshot } from '../ble/controller';
import type { GloveSide } from '../ble/types';
import type { RecognitionOutcome } from '../recognition/outcome';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { spacing } from '../theme';

export interface DiagnosticsCardProps {
  readonly gloves: Readonly<Record<GloveSide, GloveSnapshot>>;
  readonly outcome: RecognitionOutcome;
  readonly live: Readonly<Record<GloveSide, boolean>>;
  readonly testID?: string;
}

/**
 * Diagnostics & 3D Rig Status Card.
 *
 * Provides a clean, collapsible technical overview of the active 3D hand asset,
 * kinematics pipeline, WebGL renderer, and sensor stream for engineers and evaluators.
 */
export function DiagnosticsCard({
  gloves,
  outcome,
  live,
  testID,
}: DiagnosticsCardProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const [expanded, setExpanded] = useState(false);

  const leftLive = live.left;
  const rightLive = live.right;

  return (
    <Card testID={testID} style={styles.card}>
      <Pressable
        onPress={() => setExpanded((prev) => !prev)}
        style={styles.headerPressable}
        accessibilityRole="button"
        accessibilityLabel="Toggle diagnostics and 3D rig details"
        accessibilityState={{ expanded }}
      >
        <View style={styles.headerText}>
          <View style={styles.titleRow}>
            <AppText
              variant="overline"
              overline
              color={palette.textMuted}
              style={styles.titleLabel}
              numberOfLines={1}
            >
              Diagnostics & 3D Rig Status
            </AppText>
            <Badge label="3D rig" tone="accent" />
          </View>
          <AppText variant="caption" color={palette.textMuted}>
            {expanded
              ? 'Tap to collapse technical metrics'
              : 'Tap to view 3D asset, kinematics, and sensor metrics'}
          </AppText>
        </View>
        <Icon
          name={expanded ? 'chevronDown' : 'chevronRight'}
          size={16}
          color={palette.textMuted}
        />
      </Pressable>

      {expanded && (
        <View style={styles.body}>
          <View style={styles.metricRow}>
            <AppText variant="caption" color={palette.textMuted} style={styles.metricLabel}>
              3D Asset
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.metricValue}>
              {ACTIVE_HAND_ASSET.fileNames}
            </AppText>
          </View>

          <View style={styles.metricRow}>
            <AppText variant="caption" color={palette.textMuted} style={styles.metricLabel}>
              Geometry
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.metricValue}>
              {ACTIVE_HAND_ASSET.triangles.toLocaleString()} tris ·{' '}
              {ACTIVE_HAND_ASSET.vertices.toLocaleString()} verts
            </AppText>
          </View>

          <View style={styles.metricRow}>
            <AppText variant="caption" color={palette.textMuted} style={styles.metricLabel}>
              Texture
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.metricValue}>
              {ACTIVE_HAND_ASSET.texture}
            </AppText>
          </View>

          <View style={styles.metricRow}>
            <AppText variant="caption" color={palette.textMuted} style={styles.metricLabel}>
              Rig & Bones
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.metricValue}>
              {ACTIVE_HAND_ASSET.joints} bones · {ACTIVE_HAND_ASSET.chains} FK
            </AppText>
          </View>

          <View style={styles.metricRow}>
            <AppText variant="caption" color={palette.textMuted} style={styles.metricLabel}>
              Renderer
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.metricValue}>
              three.js r{ACTIVE_HAND_ASSET.threeRevision} WebGL in an Android WebView
            </AppText>
          </View>

          <View style={styles.metricRow}>
            <AppText variant="caption" color={palette.textMuted} style={styles.metricLabel}>
              Sensor Stream
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.metricValue}>
              Left: {gloves.left.link.kind} ({leftLive ? 'active' : 'idle'}) · Right:{' '}
              {gloves.right.link.kind} ({rightLive ? 'active' : 'idle'})
            </AppText>
          </View>

          <View style={styles.metricRow}>
            <AppText variant="caption" color={palette.textMuted} style={styles.metricLabel}>
              Battery (Cell / Pin)
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.metricValue}>
              L: {gloves.left.calibrated?.battery_v !== undefined ? `${gloves.left.calibrated.battery_v.toFixed(2)}V (~${gloves.left.calibrated.battery_pct}%) [pin ${gloves.left.calibrated.battery_pin_v?.toFixed(3)}V]` : '--'} · R: {gloves.right.calibrated?.battery_v !== undefined ? `${gloves.right.calibrated.battery_v.toFixed(2)}V (~${gloves.right.calibrated.battery_pct}%) [pin ${gloves.right.calibrated.battery_pin_v?.toFixed(3)}V]` : '--'}
            </AppText>
          </View>

          <View style={styles.metricRow}>
            <AppText variant="caption" color={palette.textMuted} style={styles.metricLabel}>
              IMU Temp (Silicon)
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.metricValue}>
              L: {gloves.left.calibrated?.imu_temp_c !== undefined ? `${gloves.left.calibrated.imu_temp_c.toFixed(1)}°C (MPU6050)` : '--'} · R: {gloves.right.calibrated?.imu_temp_c !== undefined ? `${gloves.right.calibrated.imu_temp_c.toFixed(1)}°C (MPU6050)` : '--'}
            </AppText>
          </View>

          <View style={styles.metricRow}>
            <AppText variant="caption" color={palette.textMuted} style={styles.metricLabel}>
              Recognition
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.metricValue}>
              {outcome.kind === 'result'
                ? `Active candidate: ${outcome.candidate.label}`
                : `Pipeline state: ${outcome.kind}`}
            </AppText>
          </View>
        </View>
      )}
    </Card>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.sm,
    },
    headerPressable: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerText: {
      flex: 1,
      gap: 2,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    /*
     * The eyebrow is tracked 11 pt uppercase and reads ~320 dp at 1x — wider than
     * the card it sits in once the badge shares the row, and wider still at the
     * capped 1.4x font scale. Without a shrink floor the badge was pushed off the
     * right edge instead of the label wrapping.
     */
    titleLabel: {
      flexShrink: 1,
    },
    body: {
      gap: spacing.xs,
      paddingTop: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    metricRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: spacing.sm,
      paddingVertical: 2,
    },
    metricLabel: {
      // A floor rather than a fixed width: it keeps the values in one column at
      // 1×, and lets "Rig & Bones" take the extra room 1.4× font scaling asks
      // for instead of being squeezed into 100 points.
      minWidth: 100,
    },
    metricValue: {
      flex: 1,
      textAlign: 'right',
    },
  });
