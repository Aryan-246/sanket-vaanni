import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { FINGERS, type Finger } from '../sensors/types';
import type { HandPose } from '../hands/pose';
import { viewerCaption, type ViewerFrame } from '../hands/viewer';
import { radii, spacing } from '../theme';

/**
 * A two-dimensional hand whose joints are driven by the pose.
 *
 * ## What this is, stated plainly
 *
 * It is **not** the 3D model viewer. It is an articulated figure: fifteen
 * independent finger segments plus a palm and a wrist, each positioned by
 * forward kinematics from the measured bend of its finger. Bend a finger and the
 * figure's finger bends, by the amount the sensor reported.
 *
 * The distinction matters and is labelled on screen, because the brief is
 * explicit that a stand-in must not be passed off as the real thing.
 *
 * ## The kinematics are real
 *
 * Each digit is a three-segment chain. For segment `k` with cumulative angle
 * `Θk` and length `Lk`:
 *
 * ```
 *   Pk = P(k-1) + (Lk·sin Θk, −Lk·cos Θk)
 * ```
 *
 * and the segment is drawn as a box whose *centre* is the midpoint of
 * `P(k-1) → Pk`, rotated about that centre by `Θk`. Rotating about the centre
 * rather than about a pivot endpoint is what avoids needing a transform origin:
 * the box's own endpoints land exactly on the two joint positions either way.
 *
 * ## What is a rendering choice, not a measurement
 *
 * The glove's flex sensors measure *how much* a finger is bent. They do not
 * measure the plane the finger bends in, and no joint angle has been observed on
 * real hardware. Three consequences, recorded rather than hidden:
 *
 *  - The curl direction is chosen so the fingers converge on the palm — it reads
 *    as a closing hand. It is a drawing convention.
 *  - The 45/35/30 split of the total curl across the three joints is a guess at
 *    how a human finger distributes flexion. Real values need a measurement.
 *  - `roll` is applied as a rotation of the whole figure and `pitch` as a
 *    vertical scale of `cos(pitch)`, which is what an orthographic projection of
 *    those two rotations would do. `yaw` is absent because the glove's MPU6050
 *    has no magnetometer and cannot observe it.
 *
 * None of that makes the figure wrong — it is driven by real bend values — but
 * it does mean the figure is a *depiction* rather than a measurement, and the
 * numbers beside it are the measurement.
 */

/** Design-space dimensions in abstract units; only their ratio matters. */
const DESIGN_WIDTH = 120;
const DESIGN_HEIGHT = 170;

/** How much of the total curl each joint of a finger takes. */
const JOINT_WEIGHTS = [0.45, 0.35, 0.3] as const;

/** Maximum total curl of a finger, and of the thumb, in radians. */
const MAX_FINGER_CURL = (120 * Math.PI) / 180;
const MAX_THUMB_CURL = (85 * Math.PI) / 180;

/** Palm geometry. */
const PALM = { x: 18, y: 62, width: 84, height: 64, radius: 16 } as const;

/** Wrist stub, so the hand is not floating. */
const WRIST = { x: 36, y: 118, width: 48, height: 52, radius: 12 } as const;

interface DigitSpec {
  readonly finger: Finger;
  /** Base joint position, in design units. */
  readonly x: number;
  readonly y: number;
  /** Segment lengths, proximal to distal. */
  readonly lengths: readonly [number, number, number];
  /** Width of each segment. */
  readonly width: number;
  /** Direction the extended digit points, in radians from straight up. */
  readonly restAngle: number;
  readonly maxCurl: number;
  /**
   * Which way the digit curls. `+1` rotates toward +x. Chosen so the fingers
   * converge on the palm's centre line; see the note above.
   */
  readonly curlSign: number;
}

/**
 * A **right** hand, palm toward the viewer.
 *
 * That is why the thumb is drawn on the left of the figure: your own right hand,
 * palm facing you, has its thumb on your left. The left hand is this figure
 * mirrored, which mirrors the curl directions with it and is therefore also
 * anatomically consistent.
 *
 * Which physical glove is "left" has not been confirmed against the firmware —
 * see `docs/ble-protocol.md`. Until it is, the side label on this figure is a
 * statement about the app's own state, not about a piece of hardware.
 */
const DIGITS: readonly DigitSpec[] = [
  {
    finger: 'thumb',
    x: 20,
    y: 104,
    lengths: [20, 16, 13],
    width: 15,
    // Extended, the thumb points up and outward.
    restAngle: (-58 * Math.PI) / 180,
    maxCurl: MAX_THUMB_CURL,
    curlSign: 1,
  },
  {
    finger: 'index',
    x: 30,
    y: 62,
    lengths: [23, 17, 14],
    width: 15,
    restAngle: 0,
    maxCurl: MAX_FINGER_CURL,
    curlSign: 1,
  },
  {
    finger: 'middle',
    x: 53,
    y: 60,
    lengths: [26, 19, 15],
    width: 15,
    restAngle: 0,
    maxCurl: MAX_FINGER_CURL,
    curlSign: 1 / 3,
  },
  {
    finger: 'ring',
    x: 76,
    y: 62,
    lengths: [23, 17, 14],
    width: 15,
    restAngle: 0,
    maxCurl: MAX_FINGER_CURL,
    curlSign: -1 / 3,
  },
  {
    finger: 'pinky',
    x: 95,
    y: 70,
    lengths: [17, 13, 11],
    width: 13,
    restAngle: 0,
    maxCurl: MAX_FINGER_CURL,
    curlSign: -2 / 3,
  },
];

export interface HandFigureProps {
  frame: ViewerFrame;
  /** Rendered width in dp. The figure keeps its aspect ratio. */
  width: number;
  /** Draws the fully-extended hand behind the live one, for comparison. */
  showRestReference?: boolean;
  testID?: string;
}

export function HandFigure({
  frame,
  width,
  showRestReference = true,
  testID,
}: HandFigureProps): React.JSX.Element {
  const { palette } = useTheme();

  const scale = width / DESIGN_WIDTH;
  const height = DESIGN_HEIGHT * scale;
  const { pose } = frame;
  const mirrored = pose.side === 'left';

  const wrist = pose.wrist;
  const rollDeg = wrist.roll === null ? 0 : (wrist.roll * 180) / Math.PI;
  // An orthographic projection of a pitch rotation is a vertical scale. Clamped
  // so a 90° pitch does not collapse the figure to a line that reads as a bug.
  const pitchScale = wrist.pitch === null ? 1 : Math.max(0.45, Math.cos(wrist.pitch));

  /**
   * The rest reference never changes, so it is built once per palette and size
   * rather than being recomputed on all twelve frames a second the pose updates.
   */
  const restReference = useMemo(
    () =>
      showRestReference ? (
        <DigitLayer
          bends={[0, 0, 0, 0, 0]}
          scale={scale}
          palette={palette}
          ghost
        />
      ) : null,
    [showRestReference, scale, palette],
  );

  const figure = (
    <View style={[styles.figure, { width, height }]}>
      {/* Palm and wrist are drawn first so the digits sit over them. */}
      <View
        style={[
          styles.solid,
          {
            left: WRIST.x * scale,
            top: WRIST.y * scale,
            width: WRIST.width * scale,
            height: WRIST.height * scale,
            borderRadius: WRIST.radius * scale,
            backgroundColor: palette.surfaceRaised,
            borderColor: palette.borderStrong,
          },
        ]}
      />
      <View
        style={[
          styles.solid,
          {
            left: PALM.x * scale,
            top: PALM.y * scale,
            width: PALM.width * scale,
            height: PALM.height * scale,
            borderRadius: PALM.radius * scale,
            backgroundColor: palette.surfaceRaised,
            borderColor: palette.borderStrong,
          },
        ]}
      />

      {restReference}
      <DigitLayer bends={pose.fingers} scale={scale} palette={palette} />
    </View>
  );

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={describePose(frame)}
      style={styles.host}
    >
      <View
        style={{
          transform: [
            { rotate: `${round(rollDeg, 2)}deg` },
            { scaleY: round(pitchScale, 3) },
            ...(mirrored ? [{ scaleX: -1 }] : []),
          ],
        }}
      >
        {figure}
      </View>

      <AppText
        variant="caption"
        center
        color={pose.source === 'none' ? palette.textMuted : palette.textSecondary}
        style={styles.caption}
      >
        {viewerCaption(pose).text}
      </AppText>
    </View>
  );
}

/* ------------------------------------------------------------------ drawing */

interface DigitLayerProps {
  /** Bend per finger, 0..1, in `FINGERS` order. */
  bends: HandPose['fingers'];
  scale: number;
  palette: Palette;
  /** Draws the whole layer faintly, for the rest reference. */
  ghost?: boolean;
}

function DigitLayer({ bends, scale, palette, ghost = false }: DigitLayerProps): React.JSX.Element {
  return (
    <>
      {DIGITS.map((digit) => {
        const index = FINGERS.indexOf(digit.finger);
        const bend = clamp01(bends[index] ?? 0);
        return (
          <Digit
            key={digit.finger}
            digit={digit}
            bend={bend}
            scale={scale}
            palette={palette}
            ghost={ghost}
          />
        );
      })}
    </>
  );
}

/**
 * One finger's props.
 *
 * Separate from `DigitLayerProps` rather than intersected with it: this takes a
 * single finger's `bend`, and inheriting the layer's required `bends` array would
 * demand the whole hand to draw one digit.
 */
interface DigitProps {
  digit: DigitSpec;
  /** Bend for this finger alone, 0..1. */
  bend: number;
  scale: number;
  palette: Palette;
  /** Draws the segment faintly, for the rest reference. */
  ghost?: boolean;
}

function Digit({ digit, bend, scale, palette, ghost = false }: DigitProps): React.JSX.Element {
  // Shape is a property of the *measurement*, so a ghost shows the same shape at
  // the same bend — it is the rest reference that is drawn with `bend: 0`.
  const curl = bend * digit.maxCurl;

  let x = digit.x;
  let y = digit.y;

  const segments: React.JSX.Element[] = [];
  const joints: React.JSX.Element[] = [];

  for (let k = 0; k < 3; k += 1) {
    const cumulative =
      digit.restAngle + digit.curlSign * curl * (JOINT_WEIGHTS[k] as number);
    const length = digit.lengths[k] as number;

    const nextX = x + length * Math.sin(cumulative);
    const nextY = y - length * Math.cos(cumulative);

    // Rotating about the box's centre puts the endpoints exactly on the joints.
    const midX = (x + nextX) / 2;
    const midY = (y + nextY) / 2;

    const fill = ghost
      ? palette.surface
      : mix(palette.surfaceRaised, palette.accentSurface, bend);
    const stroke = ghost
      ? palette.border
      : mix(palette.borderStrong, palette.accent, bend);

    segments.push(
      <View
        key={`s${k}`}
        style={[
          styles.solid,
          {
            left: (midX - digit.width / 2) * scale,
            top: (midY - length / 2) * scale,
            width: digit.width * scale,
            height: length * scale,
            borderRadius: (digit.width / 2) * scale,
            backgroundColor: fill,
            borderColor: stroke,
            transform: [{ rotate: `${round((cumulative * 180) / Math.PI, 2)}deg` }],
          },
        ]}
      />,
    );

    joints.push(
      <View
        key={`j${k}`}
        style={[
          styles.joint,
          {
            left: (x - 1.6) * scale,
            top: (y - 1.6) * scale,
            width: 3.2 * scale,
            height: 3.2 * scale,
            borderRadius: 1.6 * scale,
            backgroundColor: ghost ? palette.border : stroke,
          },
        ]}
      />,
    );

    x = nextX;
    y = nextY;
  }

  return (
    <>
      {segments}
      {joints}
      {/* Fingertip, so the end of each chain is unambiguous. */}
      <View
        style={[
          styles.joint,
          {
            left: (x - 2.2) * scale,
            top: (y - 2.2) * scale,
            width: 4.4 * scale,
            height: 4.4 * scale,
            borderRadius: 2.2 * scale,
            backgroundColor: ghost
              ? palette.border
              : mix(palette.borderStrong, palette.accent, bend),
          },
        ]}
      />
    </>
  );
}

/* -------------------------------------------------------------------- utils */

/**
 * Linear blend of two hex colours.
 *
 * Only ever called with palette tokens, which are all six-digit hex. Anything
 * else (an `rgba()` scrim, say) returns the second colour unchanged rather than
 * producing a broken string.
 */
function mix(from: string, to: string, t: number): string {
  if (!isHex(from) || !isHex(to)) return to;
  const amount = clamp01(t);
  const channel = (offset: number): number => {
    const a = parseInt(from.slice(offset, offset + 2), 16);
    const b = parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * amount);
  };
  const hex = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${hex(channel(1))}${hex(channel(3))}${hex(channel(5))}`;
}

function isHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The pose, in words.
 *
 * This is what a screen reader gets instead of the figure. It reports the
 * calibrated bend per finger as a percentage, which is a measured value — and it
 * says nothing about confidence, because a pose has none.
 */
export function describePose(frame: ViewerFrame): string {
  const { pose } = frame;
  const hand = pose.side === 'left' ? 'Left' : 'Right';
  const bends = FINGERS.map(
    (finger, index) => `${finger} ${Math.round((pose.fingers[index] ?? 0) * 100)} percent`,
  ).join(', ');

  const tilt =
    pose.wrist.roll === null
      ? 'wrist tilt unavailable'
      : `wrist tilt ${Math.round((pose.wrist.roll * 180) / Math.PI)} degrees`;

  return `${hand} hand, ${viewerCaption(pose).kind}. Flexion: ${bends}. ${tilt}.`;
}

/**
 * Styles are palette-independent here: every colour is applied inline from the
 * active palette, because the two segment colours are *blended* per finger. A
 * `StyleSheet` cannot express a blend, and splitting the difference — a static
 * sheet plus a few inline colours — would make the two hard to tell apart when
 * reading the component.
 */
const styles = StyleSheet.create({
  solid: {
    position: 'absolute',
    borderWidth: 1,
  },
  joint: {
    position: 'absolute',
  },
  figure: {
    position: 'relative',
  },
  host: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  caption: {
    maxWidth: 280,
    borderRadius: radii.sm,
  },
});
