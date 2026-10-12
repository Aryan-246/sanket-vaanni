/**
 * 3D Hand Rig Pose Controller & Kinematics Driver.
 *
 * Implements the mathematical Forward Kinematics (FK) mapping between the
 * Sanket Vaanni `HandPose` sensor contract and the FPS Female Arms 3D rig bones.
 *
 * Validated in Blender 5.2.2 LTS (see `docs/hand-model-evaluation.md`).
 */
import type { GloveSide } from '../ble/types';
import type { HandPose, WristOrientation } from './pose';
import { DEFAULT_SMOOTHING } from './pose';

/**
 * Verified Preset Poses for testing and demonstration without physical gloves.
 * Each pose specifies [thumb, index, middle, ring, pinky] in 0..1 (0 = extended, 1 = fully flexed).
 */
export const PRESET_POSES = {
  /** Neutral resting hand: relaxed fingers slightly curved naturally. */
  rest: [0.0, 0.0, 0.0, 0.0, 0.0],
  /** Natural relaxed hand. */
  relaxed: [0.15, 0.2, 0.22, 0.24, 0.25],
  /** Full fist: all 5 fingers tightly curled into palm. */
  fist: [0.95, 0.95, 0.95, 0.95, 0.95],
  /** Thumbs up: fingers 1-4 curled, thumb extended and abducted. */
  thumbs_up: [0.0, 0.95, 0.95, 0.95, 0.95],
  /** Pointing: index extended straight, thumb and other fingers curled. */
  point: [0.85, 0.0, 0.95, 0.95, 0.95],
  /** Peace / Victory: index and middle extended in V, others curled. */
  peace: [0.85, 0.0, 0.0, 0.95, 0.95],
  /** Flat open hand: fingers extended flat. */
  open: [-0.1, -0.1, -0.1, -0.1, -0.1],
  /** ASL letter 'A': fist with thumb resting alongside index finger. */
  asl_a: [0.35, 0.95, 0.95, 0.95, 0.95],
  /** ASL letter 'B': four fingers extended vertically, thumb folded across palm. */
  asl_b: [0.95, 0.0, 0.0, 0.0, 0.0],
  /** ASL letter 'C': all fingers and thumb curved to form a C shape. */
  asl_c: [0.55, 0.55, 0.55, 0.55, 0.55],
  /** ASL letter 'L': index finger up, thumb out at 90 degrees. */
  asl_l: [0.0, 0.0, 0.95, 0.95, 0.95],
} as const;

export type PresetPoseName = keyof typeof PRESET_POSES;

export interface RigBoneRotation {
  readonly bone: string;
  readonly x: number; // pitch in radians
  readonly y: number; // yaw / roll in radians
  readonly z: number; // roll in radians
}

export interface HandRigRotations {
  readonly side: GloveSide;
  readonly wrist: { readonly x: number; readonly y: number; readonly z: number };
  readonly bones: readonly RigBoneRotation[];
}

const RAD = Math.PI / 180;

/**
 * Clamps and sanitizes a normalized finger flex value (0..1).
 */
export function sanitizeBend(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(-0.2, Math.min(1.2, value));
}

/**
 * Converts a `HandPose` into explicit 3D Euler bone rotations for the FPS Female Arms rig.
 *
 * Rig bone naming convention (from evaluation):
 * - Pinky: Finger_1.1..1.4
 * - Ring: Finger_2.1..2.4
 * - Middle: Finger_3.1..3.4
 * - Index: Finger_4.1..4.4
 * - Thumb: Finger_5.1..5.3
 * - Wrist: Hand.L / Hand.R
 */
export function handPoseToRigRotations(pose: HandPose): HandRigRotations {
  const s = pose.side === 'left' ? '.L' : '.R';
  const bones: RigBoneRotation[] = [];

  const [rawThumb, rawIndex, rawMiddle, rawRing, rawPinky] = pose.fingers;
  const t = sanitizeBend(rawThumb);
  const idx = sanitizeBend(rawIndex);
  const mid = sanitizeBend(rawMiddle);
  const rng = sanitizeBend(rawRing);
  const pnk = sanitizeBend(rawPinky);

  // 1. Thumb (Finger 5): 3 joints (Metacarpal, Proximal, Distal)
  // Opposition / Adduction + Flexion
  bones.push({
    bone: `Finger_5.1${s}`,
    x: t * 40 * RAD,
    y: t * 35 * RAD,
    z: 0,
  });
  bones.push({
    bone: `Finger_5.2${s}`,
    x: t * 50 * RAD,
    y: 0,
    z: 0,
  });
  bones.push({
    bone: `Finger_5.3${s}`,
    x: t * 45 * RAD,
    y: 0,
    z: 0,
  });

  // VR Hands Thumb
  const vrPrefix = pose.side === 'left' ? 'J_Left_Hand' : 'J_Right_Hand';
  const sign = pose.side === 'left' ? 1 : -1;
  bones.push({
    bone: `${vrPrefix}Thumb1`,
    x: t * 45 * RAD,
    y: sign * t * 30 * RAD,
    z: 0,
  });
  bones.push({
    bone: `${vrPrefix}Thumb2`,
    x: t * 55 * RAD,
    y: 0,
    z: 0,
  });
  bones.push({
    bone: `${vrPrefix}Thumb3`,
    x: t * 50 * RAD,
    y: 0,
    z: 0,
  });

  // 2. Index (Finger 4 / J_*_HandIndex): MCP 70-75°, PIP 80°, DIP 60°
  bones.push({ bone: `Finger_4.1${s}`, x: idx * 70 * RAD, y: 0, z: 0 });
  bones.push({ bone: `Finger_4.2${s}`, x: idx * 80 * RAD, y: 0, z: 0 });
  bones.push({ bone: `Finger_4.3${s}`, x: idx * 60 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Index1`, x: idx * 75 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Index2`, x: idx * 80 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Index3`, x: idx * 60 * RAD, y: 0, z: 0 });

  // 3. Middle (Finger 3 / J_*_HandMiddle)
  bones.push({ bone: `Finger_3.1${s}`, x: mid * 70 * RAD, y: 0, z: 0 });
  bones.push({ bone: `Finger_3.2${s}`, x: mid * 80 * RAD, y: 0, z: 0 });
  bones.push({ bone: `Finger_3.3${s}`, x: mid * 60 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Middle1`, x: mid * 75 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Middle2`, x: mid * 80 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Middle3`, x: mid * 60 * RAD, y: 0, z: 0 });

  // 4. Ring (Finger 2 / J_*_HandRing)
  bones.push({ bone: `Finger_2.1${s}`, x: rng * 70 * RAD, y: 0, z: 0 });
  bones.push({ bone: `Finger_2.2${s}`, x: rng * 80 * RAD, y: 0, z: 0 });
  bones.push({ bone: `Finger_2.3${s}`, x: rng * 60 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Ring1`, x: rng * 75 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Ring2`, x: rng * 80 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Ring3`, x: rng * 60 * RAD, y: 0, z: 0 });

  // 5. Pinky (Finger 1 / J_*_HandPinky)
  bones.push({ bone: `Finger_1.1${s}`, x: pnk * 70 * RAD, y: 0, z: 0 });
  bones.push({ bone: `Finger_1.2${s}`, x: pnk * 80 * RAD, y: 0, z: 0 });
  bones.push({ bone: `Finger_1.3${s}`, x: pnk * 60 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Pinky1`, x: pnk * 75 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Pinky2`, x: pnk * 80 * RAD, y: 0, z: 0 });
  bones.push({ bone: `${vrPrefix}Pinky3`, x: pnk * 60 * RAD, y: 0, z: 0 });

  // 6. Wrist (Hand.L / Hand.R)
  const pitch = typeof pose.wrist.pitch === 'number' && !Number.isNaN(pose.wrist.pitch)
    ? pose.wrist.pitch
    : 0;
  const roll = typeof pose.wrist.roll === 'number' && !Number.isNaN(pose.wrist.roll)
    ? pose.wrist.roll
    : 0;

  const wristRot = {
    x: pitch,
    y: 0,
    z: roll,
  };

  return {
    side: pose.side,
    wrist: wristRot,
    bones,
  };
}

/**
 * Exponential Moving Average (EMA) smoothing for HandPose stream.
 * Smooths sensor noise without adding perceptible latency.
 */
export function smoothHandPose(
  previous: HandPose | null,
  next: HandPose,
  alpha = DEFAULT_SMOOTHING.alpha,
): HandPose {
  if (!previous || previous.side !== next.side) {
    return next;
  }

  const smoothedFingers = next.fingers.map((val, i) => {
    const prevVal = previous.fingers[i] ?? 0;
    return prevVal + alpha * (val - prevVal);
  }) as unknown as HandPose['fingers'];

  const smoothAngle = (prev: number | null, nxt: number | null): number | null => {
    if (nxt === null) return null;
    if (prev === null) return nxt;
    return prev + alpha * (nxt - prev);
  };

  const smoothedWrist: WristOrientation = {
    pitch: smoothAngle(previous.wrist.pitch, next.wrist.pitch),
    roll: smoothAngle(previous.wrist.roll, next.wrist.roll),
    yaw: null, // Always null on this hardware
  };

  return {
    ...next,
    fingers: smoothedFingers,
    wrist: smoothedWrist,
  };
}

/**
 * Creates a HandPose from a verified preset pose for demo/testing.
 */
export function createPresetPose(
  side: GloveSide,
  name: PresetPoseName,
  source: 'simulated' = 'simulated',
): HandPose {
  const fingers = [...PRESET_POSES[name]] as unknown as HandPose['fingers'];
  return {
    side,
    fingers,
    wrist: { pitch: 0, roll: 0, yaw: null },
    source,
    timestampMs: Date.now(),
    confidence: 1.0,
  };
}
