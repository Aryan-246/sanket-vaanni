import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { HandFigure } from './HandFigure';
import { IconButton } from './IconButton';
import type { ViewerFrame } from '../hands/viewer';
import type { GloveSide } from '../ble/types';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, spacing } from '../theme';

export interface HandViewerProps {
  frames: Readonly<Record<GloveSide, ViewerFrame>>;
  /** True per glove when that glove is actually delivering frames. */
  live: Readonly<Record<GloveSide, boolean>>;
  /** Opens the explanation of what this viewer is. */
  onExplain: () => void;
  testID?: string;
}

const SIDES: readonly GloveSide[] = ['left', 'right'];

/** Space between the two hand columns. Mirrored by the `hands` row's `gap`. */
const HAND_GAP = spacing.md;

/** Widest a single hand column is allowed to grow, so a tablet does not get a
 * pair of enormous hands. */
const MAX_HAND_COLUMN = 168;

/**
 * How wide one hand's column is.
 *
 * Exported and pure so the arithmetic can be asserted directly. It has been
 * wrong once already, and in a way no rendering test in this repo could see: a
 * caption inside the figure declared its own `maxWidth`, which silently made the
 * hand wider than the column the parent had measured for it, and the row
 * overflowed the card and was clipped by the screen edges. The figure is not the
 * only thing in the column — its caption is too — so the column has to be the
 * authority rather than whichever child happens to be widest.
 *
 * There is deliberately **no minimum**: a floor would be a width the available
 * space might not have, which is how the overflow happened. Half of whatever is
 * left always fits, at any window width, by construction.
 */
export function handColumnWidth(windowWidth: number): number {
  // Both sides of the page, both sides of the card, and the gap between hands.
  const available = windowWidth - 2 * layout.screenPadding - 2 * spacing.lg - HAND_GAP;
  return Math.max(0, Math.min(MAX_HAND_COLUMN, available / 2));
}

/**
 * Both hands in one viewer.
 *
 * ## Why one viewer and not one per glove
 *
 * A signing conversation is between hands. Two separate viewers would put the
 * left hand above the right in a scrolling column, at different times, with no
 * guarantee you were looking at the same instant of both — and a two-handed sign
 * is precisely the thing that arrangement cannot show.
 *
 * ## What a resting hand means
 *
 * A hand with no glove connected is drawn in its rest pose and labelled as such.
 * It is not omitted, and it is not drawn from the other hand's numbers. Leaving
 * it on screen is the honest option: it shows which hand is missing rather than
 * silently presenting a one-handed app as if that were all there is.
 *
 * ## What this is not
 *
 * Not the 3D model viewer. It is an articulated figure driven by measured bend,
 * and it says so on its own badge rather than only in a document — see
 * `docs/hand-viewer.md` for the asset finding behind that.
 */
export function HandViewer({
  frames,
  live,
  onExplain,
  testID,
}: HandViewerProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { width } = useWindowDimensions();
  const columnWidth = handColumnWidth(width);

  const wristSides = SIDES.filter((side) => live[side]);

  return (
    <Card testID={testID} style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <AppText variant="overline" overline color={palette.textMuted}>
            Hand viewer
          </AppText>
          <AppText variant="caption" color={palette.textMuted} numberOfLines={1}>
            Driven by measured flex, not a 3D model
          </AppText>
        </View>
        <IconButton
          icon="info"
          onPress={onExplain}
          accessibilityLabel="Why this is not the 3D hand model"
        />
      </View>

      <View style={styles.hands}>
        {SIDES.map((side) => (
          <View key={side} style={[styles.hand, { width: columnWidth }]} testID={`hand-column-${side}`}>
            <View style={styles.handHead}>
              <AppText variant="label">{side === 'left' ? 'Left' : 'Right'}</AppText>
              <HandState side={side} live={live[side]} frame={frames[side]} />
            </View>
            <HandFigure
              frame={frames[side]}
              width={columnWidth}
              showRestReference={false}
              testID={`hand-figure-${side}`}
            />
          </View>
        ))}
      </View>

      {/*
        Wrist rows appear only for hands that are actually sending data. Rendering
        a pitch of 0° for a disconnected glove would be a measurement nobody took.
      */}
      {wristSides.length > 0 ? (
        <View style={styles.wrist}>
          {wristSides.map((side) => (
            <WristRow key={side} side={side} frame={frames[side]} />
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

/**
 * A hand's data state, in a badge.
 *
 * `Resting` and `No data` are not the same claim as `Demo` or `Live`, and the
 * distinction is the whole point of the badge: a still figure must never be read
 * as a hand that happens to be still.
 */
function HandState({
  side,
  live,
  frame,
}: {
  side: GloveSide;
  live: boolean;
  frame: ViewerFrame;
}): React.JSX.Element {
  if (!live) return <Badge label="Resting" tone="neutral" />;

  switch (frame.pose.source) {
    case 'real':
      return <Badge label="Live" tone="success" dot />;
    case 'simulated':
      return <Badge label="Demo" tone="demo" dot />;
    default:
      // Unreachable while `live` is true — a live glove has a pose source — but
      // returning a labelled badge rather than nothing keeps the case honest if
      // that invariant ever breaks.
      return <Badge label={`${side} unknown`} tone="warning" />;
  }
}

/** Pitch and roll for one hand, on a single line. */
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

/**
 * An angle in degrees, or a stated absence.
 *
 * `Not available` and `Not measurable` are different failures and are kept
 * distinct: the first means no reading arrived, the second means this hardware
 * cannot produce one at all.
 */
function degrees(radians: number | null): string {
  if (radians === null) return 'not available';
  return `${Math.round((radians * 180) / Math.PI)}°`;
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.lg,
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
    hands: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'center',
      gap: spacing.md,
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
    wrist: {
      gap: spacing.xs,
      paddingTop: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    wristRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    wristLabel: {
      width: 38,
    },
    wristValue: {
      flex: 1,
    },
  });
