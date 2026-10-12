import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { HandFigure } from './HandFigure';
import { HandModel3D } from './HandModel3D';
import { IconButton } from './IconButton';
import { SegmentedControl } from './SegmentedControl';
import type { ViewerFrame } from '../hands/viewer';
import { createPresetPose, type PresetPoseName } from '../hands/poseController';
import type { GloveSide } from '../ble/types';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, radii, spacing } from '../theme';

export interface HandViewerProps {
  frames: Readonly<Record<GloveSide, ViewerFrame>>;
  /** True per glove when that glove is actually delivering frames. */
  live: Readonly<Record<GloveSide, boolean>>;
  /** Opens the explanation of what this viewer is. */
  onExplain: () => void;
  testID?: string;
  initialRenderer?: 'mesh3d' | 'articulated';
}

const SIDES: readonly GloveSide[] = ['left', 'right'];

/** Space between the two hand columns. Mirrored by the `hands` row's `gap`. */
const HAND_GAP = spacing.md;

/** Widest a single hand column is allowed to grow in two-column mode. */
const MAX_HAND_COLUMN = 168;

/**
 * How wide one hand's column is in two-column mode.
 *
 * Exported and pure so the arithmetic can be asserted directly.
 */
export function handColumnWidth(windowWidth: number): number {
  const available = windowWidth - 2 * layout.screenPadding - 2 * spacing.lg - HAND_GAP;
  return Math.max(0, Math.min(MAX_HAND_COLUMN, available / 2));
}

const DEMO_PRESETS: readonly { readonly id: PresetPoseName; readonly label: string }[] = [
  { id: 'rest', label: 'Rest' },
  { id: 'relaxed', label: 'Relaxed' },
  { id: 'fist', label: 'Fist' },
  { id: 'thumbs_up', label: 'Thumbs Up' },
  { id: 'point', label: 'Point' },
  { id: 'peace', label: 'Peace' },
  { id: 'asl_a', label: 'ASL A' },
  { id: 'asl_b', label: 'ASL B' },
  { id: 'asl_l', label: 'ASL L' },
  { id: 'open', label: 'Open' },
];

/** Human-readable name for a preset id, so badges never show `thumbs_up`. */
const PRESET_LABELS: Readonly<Record<string, string>> = DEMO_PRESETS.reduce(
  (acc, preset) => ({ ...acc, [preset.id]: preset.label }),
  {},
);

/** Height of the single-hand focus viewport. Portrait, like the hand itself. */
const FOCUS_VIEWPORT_MAX_HEIGHT = 360;

export type HandViewMode = 'both' | 'left' | 'right';

/**
 * Centerpiece Hand Viewer Component.
 *
 * Supports hardware-accelerated 3D rigged VR hands rendering (Three.js WebGL via WebView)
 * and the 2D kinematic articulated figure.
 *
 * Supports Both Hands, Left Hand focus, and Right Hand focus views.
 */
export function HandViewer({
  frames,
  live,
  onExplain,
  testID,
  initialRenderer = 'mesh3d',
}: HandViewerProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { width } = useWindowDimensions();
  const columnWidth = handColumnWidth(width);
  const singleFocusWidth = Math.min(360, width - 2 * layout.screenPadding - 2 * spacing.lg);

  const [rendererKind, setRendererKind] = useState<'mesh3d' | 'articulated'>(initialRenderer);
  const [viewMode, setViewMode] = useState<HandViewMode>('both');
  const [activePreset, setActivePreset] = useState<PresetPoseName | null>(null);

  const displayFrames = useMemo(() => {
    const result: Record<GloveSide, ViewerFrame> = { ...frames };
    for (const side of SIDES) {
      if (activePreset && (!live[side] || frames[side].pose.source === 'simulated')) {
        result[side] = {
          ...frames[side],
          pose: createPresetPose(side, activePreset, 'simulated'),
        };
      }
    }
    return result;
  }, [frames, live, activePreset]);

  const wristSides = SIDES.filter((side) => live[side]);

  return (
    <Card testID={testID} style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <AppText variant="overline" overline color={palette.textMuted}>
            Hand viewer
          </AppText>
          <AppText variant="caption" color={palette.textMuted}>
            {rendererKind === 'mesh3d'
              ? '3D rig · bones driven by the pose'
              : '2D figure · joints driven by the pose'}
          </AppText>
        </View>
        <IconButton
          icon="info"
          onPress={onExplain}
          accessibilityLabel="About the hand viewer and 3D rig"
        />
      </View>

      {/* View Switcher: Both Hands | Left Hand | Right Hand */}
      <View style={styles.controlRow}>
        <SegmentedControl
          options={[
            { value: 'both', label: 'Both' },
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
          ]}
          value={viewMode}
          onChange={setViewMode}
          accessibilityLabel="Switch hand view mode"
        />
      </View>

      {/* Renderer Switcher: 3D Model | 2D Figure */}
      <View style={styles.controlRow}>
        <SegmentedControl
          options={[
            { value: 'mesh3d', label: '3D Model' },
            { value: 'articulated', label: '2D Figure' },
          ]}
          value={rendererKind}
          onChange={setRendererKind}
          accessibilityLabel="Switch between 3D model and 2D figure"
        />
      </View>

      {/* Hands Viewport Area */}
      {viewMode === 'both' ? (
        <View style={styles.hands}>
          {SIDES.map((side) => (
            <View
              key={side}
              style={[styles.hand, { width: columnWidth }]}
              testID={`hand-column-${side}`}
            >
              <View style={styles.handHead}>
                <AppText variant="label">{side === 'left' ? 'Left' : 'Right'}</AppText>
                <HandState
                  live={live[side]}
                  frame={displayFrames[side]}
                  isPreset={
                    activePreset !== null &&
                    (!live[side] || frames[side].pose.source === 'simulated')
                  }
                  presetName={activePreset}
                />
              </View>
              {rendererKind === 'mesh3d' ? (
                <HandModel3D
                  side={side}
                  frame={displayFrames[side]}
                  width={columnWidth}
                  height={Math.round(columnWidth * 1.35)}
                  testID={`hand-3d-${side}`}
                />
              ) : (
                <HandFigure
                  frame={displayFrames[side]}
                  width={columnWidth}
                  showRestReference={false}
                  testID={`hand-figure-${side}`}
                />
              )}
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.singleHandContainer}>
          <View
            style={[styles.hand, { width: singleFocusWidth }]}
            testID={`hand-column-${viewMode}`}
          >
            <View style={styles.handHead}>
              <AppText variant="label">
                {viewMode === 'left' ? 'Left hand' : 'Right hand'}
              </AppText>
              <HandState
                live={live[viewMode]}
                frame={displayFrames[viewMode]}
                isPreset={
                  activePreset !== null &&
                  (!live[viewMode] || frames[viewMode].pose.source === 'simulated')
                }
                presetName={activePreset}
              />
            </View>
            {rendererKind === 'mesh3d' ? (
              <HandModel3D
                side={viewMode}
                frame={displayFrames[viewMode]}
                width={singleFocusWidth}
                height={Math.min(
                  Math.round(singleFocusWidth * 1.1),
                  FOCUS_VIEWPORT_MAX_HEIGHT,
                )}
                testID={`hand-3d-${viewMode}`}
              />
            ) : (
              <HandFigure
                frame={displayFrames[viewMode]}
                width={singleFocusWidth}
                showRestReference={false}
                testID={`hand-figure-${viewMode}`}
              />
            )}
          </View>
        </View>
      )}

      {/* Test / Demo Poses */}
      <View style={styles.presetSection}>
        <View style={styles.presetHeader}>
          <AppText variant="overline" overline color={palette.textMuted}>
            Test poses · demo
          </AppText>
          {activePreset !== null && (
            <Pressable
              onPress={() => setActivePreset(null)}
              accessibilityRole="button"
              accessibilityLabel="Resume stream"
            >
              <AppText variant="caption" color={palette.accent}>
                Resume stream
              </AppText>
            </Pressable>
          )}
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.presetList}
        >
          {DEMO_PRESETS.map((preset) => {
            const selected = activePreset === preset.id;
            return (
              <Pressable
                key={preset.id}
                onPress={() => setActivePreset(selected ? null : preset.id)}
                style={[
                  styles.presetChip,
                  selected && {
                    backgroundColor: palette.surfaceRaised,
                    borderColor: palette.accent,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`Test pose ${preset.label}`}
                accessibilityState={{ selected }}
                hitSlop={8}
              >
                <AppText
                  variant="caption"
                  color={selected ? palette.accent : palette.textSecondary}
                >
                  {preset.label}
                </AppText>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Wrist rows appear only for hands that are sending data */}
      {wristSides.length > 0 ? (
        <View style={styles.wrist}>
          {wristSides.map((side) => (
            <WristRow key={side} side={side} frame={displayFrames[side]} />
          ))}
        </View>
      ) : (
        <View style={styles.wrist}>
          <AppText variant="caption" color={palette.textMuted}>
            No wrist orientation — no glove is sending data.
          </AppText>
        </View>
      )}
    </Card>
  );
}

function HandState({
  live,
  frame,
  isPreset,
  presetName,
}: {
  live: boolean;
  frame: ViewerFrame;
  isPreset?: boolean;
  presetName?: PresetPoseName | null;
}): React.JSX.Element {
  if (frame.pose.source === 'real') {
    return <Badge label="Live" tone="success" dot />;
  }

  if (isPreset && presetName) {
    // The preset's own name, not its id: `thumbs_up` is not a label.
    return <Badge label={PRESET_LABELS[presetName] ?? 'Demo'} tone="demo" dot />;
  }

  if (!live) return <Badge label="Resting" tone="neutral" />;

  switch (frame.pose.source) {
    case 'simulated':
      return <Badge label="Demo" tone="demo" dot />;
    default:
      return <Badge label="No data" tone="warning" />;
  }
}

function WristRow({ side, frame }: { side: GloveSide; frame: ViewerFrame }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { wrist } = frame.pose;

  const pitch = degrees(wrist.pitch);
  const roll = degrees(wrist.roll);

  return (
    <View
      style={styles.wristRow}
      accessible
      accessibilityLabel={`${side} wrist. Pitch ${pitch}. Roll ${roll}. Yaw not measurable.`}
    >
      <AppText variant="caption" color={palette.textMuted} style={styles.wristLabel}>
        {side === 'left' ? 'Left' : 'Right'}
      </AppText>
      <AppText variant="caption" color={palette.textSecondary} style={styles.wristValue}>
        pitch {pitch} · roll {roll} · yaw not measurable
      </AppText>
    </View>
  );
}

function degrees(radians: number | null): string {
  if (radians === null) return 'not available';
  return `${Math.round((radians * 180) / Math.PI)}°`;
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.md,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    headerText: {
      flex: 1,
      gap: spacing.xs,
    },
    controlRow: {
      paddingBottom: 2,
    },
    hands: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'center',
      gap: spacing.md,
    },
    singleHandContainer: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    hand: {
      alignItems: 'center',
      gap: spacing.sm,
    },
    handHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    presetSection: {
      gap: spacing.xs,
      paddingTop: spacing.xs,
    },
    presetHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    presetList: {
      gap: spacing.xs,
      paddingVertical: spacing.xs,
      // The row scrolls sideways, so the last chip is cut by the viewport edge
      // for as long as the user has not scrolled. This keeps a chip clear of
      // that edge once they have, and stops the final label from sitting flush
      // against the card's gutter and reading as truncated.
      paddingRight: spacing.sm,
    },
    presetChip: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      /*
       * 40, not 36. A pill chip is a control the user taps mid-conversation, and
       * 36 dp is under the 44 dp a fingertip needs; the `hitSlop` below widens
       * the target without changing how the row looks.
       */
      minHeight: 40,
      justifyContent: 'center',
      borderRadius: radii.pill,
      backgroundColor: palette.surfaceSunken,
      borderWidth: 1,
      borderColor: palette.border,
    },
    wrist: {
      gap: spacing.xs,
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    wristRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    wristLabel: {
      // "Right" needs about 48 points at the 1.4× scaling cap, so a fixed 38
      // clipped the hand's own name. `minWidth` keeps the two hands' rows
      // aligned at 1× and lets the label take the room it needs above it.
      minWidth: 38,
    },
    wristValue: {
      flex: 1,
    },
  });
