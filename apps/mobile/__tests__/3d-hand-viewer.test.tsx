import React from 'react';
import { act } from 'react-test-renderer';

import { HandViewer } from '../src/components/HandViewer';
import {
  handPoseToRigRotations,
  smoothHandPose,
  sanitizeBend,
  createPresetPose,
  PRESET_POSES,
} from '../src/hands/poseController';
import { emptyPose, DEFAULT_SMOOTHING, type HandPose } from '../src/hands/pose';
import type { ViewerFrame } from '../src/hands/viewer';
import type { GloveSide } from '../src/ble/types';
import { renderThemed, teardown } from './support';

function makeFrame(pose: HandPose): ViewerFrame {
  return { pose, neutral: null, smoothing: DEFAULT_SMOOTHING };
}

describe('3D Hand Rig Kinematics and Pose Controller', () => {
  it('correctly maps 5 normalized finger bend values to FPS Female Arms bones', () => {
    const leftPose: HandPose = {
      side: 'left',
      fingers: [0.5, 0.8, 0.6, 0.4, 0.2],
      wrist: { pitch: 0.25, roll: -0.15, yaw: null },
      source: 'simulated',
      timestampMs: 1000,
      confidence: 1.0,
    };

    const rig = handPoseToRigRotations(leftPose);
    expect(rig.side).toBe('left');
    expect(rig.wrist.x).toBeCloseTo(0.25);
    expect(rig.wrist.z).toBeCloseTo(-0.15);

    // Verify bone naming suffix for left hand
    const boneNames = rig.bones.map((b) => b.bone);
    expect(boneNames).toContain('Finger_5.1.L'); // Thumb metacarpal
    expect(boneNames).toContain('Finger_5.2.L'); // Thumb proximal
    expect(boneNames).toContain('Finger_5.3.L'); // Thumb distal
    expect(boneNames).toContain('Finger_4.1.L'); // Index MCP
    expect(boneNames).toContain('Finger_3.1.L'); // Middle MCP
    expect(boneNames).toContain('Finger_2.1.L'); // Ring MCP
    expect(boneNames).toContain('Finger_1.1.L'); // Pinky MCP

    // Check Thumb flexion & opposition angles
    const thumbMeta = rig.bones.find((b) => b.bone === 'Finger_5.1.L');
    expect(thumbMeta).toBeDefined();
    expect(thumbMeta!.x).toBeCloseTo(0.5 * 40 * (Math.PI / 180));
    expect(thumbMeta!.y).toBeCloseTo(0.5 * 35 * (Math.PI / 180));

    // Check Index MCP angle (0.8 * 70 deg)
    const indexMcp = rig.bones.find((b) => b.bone === 'Finger_4.1.L');
    expect(indexMcp).toBeDefined();
    expect(indexMcp!.x).toBeCloseTo(0.8 * 70 * (Math.PI / 180));
  });

  it('correctly maps right hand with .R bone naming convention', () => {
    const rightPose: HandPose = {
      side: 'right',
      fingers: [1.0, 1.0, 1.0, 1.0, 1.0], // Full fist
      wrist: { pitch: 0, roll: 0, yaw: null },
      source: 'simulated',
      timestampMs: 1000,
      confidence: 1.0,
    };

    const rig = handPoseToRigRotations(rightPose);
    expect(rig.side).toBe('right');
    const boneNames = rig.bones.map((b) => b.bone);
    expect(boneNames).toContain('Finger_5.1.R');
    expect(boneNames).toContain('Finger_4.1.R');
    expect(boneNames).toContain('Finger_1.3.R');
    expect(boneNames.some((b) => b.endsWith('.L'))).toBe(false);
  });

  it('sanitizes and clamps input values (handles NaN, null, and over-flex)', () => {
    expect(sanitizeBend(NaN)).toBe(0);
    expect(sanitizeBend(null)).toBe(0);
    expect(sanitizeBend(undefined)).toBe(0);
    expect(sanitizeBend(-0.5)).toBe(-0.2); // clamped at -0.2
    expect(sanitizeBend(1.5)).toBe(1.2); // clamped at 1.2
    expect(sanitizeBend(0.75)).toBe(0.75);
  });

  it('provides verified preset poses for testing without physical gloves', () => {
    expect(PRESET_POSES.rest).toEqual([0.0, 0.0, 0.0, 0.0, 0.0]);
    expect(PRESET_POSES.fist).toEqual([0.95, 0.95, 0.95, 0.95, 0.95]);
    expect(PRESET_POSES.point).toEqual([0.85, 0.0, 0.95, 0.95, 0.95]);
    expect(PRESET_POSES.peace).toEqual([0.85, 0.0, 0.0, 0.95, 0.95]);

    const fistPose = createPresetPose('right', 'fist');
    expect(fistPose.side).toBe('right');
    expect(fistPose.source).toBe('simulated');
    expect(fistPose.fingers).toEqual([0.95, 0.95, 0.95, 0.95, 0.95]);
  });

  it('smooths noisy pose frames with Exponential Moving Average (EMA)', () => {
    const prevPose: HandPose = {
      side: 'left',
      fingers: [0.0, 0.0, 0.0, 0.0, 0.0],
      wrist: { pitch: 0, roll: 0, yaw: null },
      source: 'real',
      timestampMs: 100,
      confidence: 1.0,
    };

    const noisyNext: HandPose = {
      side: 'left',
      fingers: [1.0, 1.0, 1.0, 1.0, 1.0],
      wrist: { pitch: 0.5, roll: 0.5, yaw: null },
      source: 'real',
      timestampMs: 150,
      confidence: 1.0,
    };

    const smoothed = smoothHandPose(prevPose, noisyNext, 0.3);
    // Val = prev + 0.3 * (next - prev) = 0 + 0.3 * 1 = 0.3
    expect(smoothed.fingers[0]).toBeCloseTo(0.3);
    expect(smoothed.fingers[1]).toBeCloseTo(0.3);
    expect(smoothed.wrist.pitch).toBeCloseTo(0.15);
  });

  it('resets smoothing if sides do not match', () => {
    const leftPose = emptyPose('left');
    const rightPose = emptyPose('right');
    const smoothed = smoothHandPose(leftPose, rightPose);
    expect(smoothed).toBe(rightPose);
  });
});

describe('HandViewer 3D and 2D Component Integration', () => {
  const frames: Record<GloveSide, ViewerFrame> = {
    left: makeFrame(emptyPose('left')),
    right: makeFrame(emptyPose('right')),
  };
  const live: Record<GloveSide, boolean> = { left: false, right: false };

  it('renders 3D hand models by default with both hands independently present', async () => {
    const renderer = await renderThemed(
      <HandViewer frames={frames} live={live} onExplain={() => undefined} />,
    );

    // Both hands columns exist
    const leftCol = renderer.root.findAllByProps({ testID: 'hand-column-left' })[0];
    const rightCol = renderer.root.findAllByProps({ testID: 'hand-column-right' })[0];
    expect(leftCol).toBeDefined();
    expect(rightCol).toBeDefined();

    // In 3D mode by default: 3D components exist
    const left3d = renderer.root.findAllByProps({ testID: 'hand-3d-left' })[0];
    const right3d = renderer.root.findAllByProps({ testID: 'hand-3d-right' })[0];
    expect(left3d).toBeDefined();
    expect(right3d).toBeDefined();

    await teardown(renderer);
  });

  it('allows toggling to 2D Articulated figure preview', async () => {
    const renderer = await renderThemed(
      <HandViewer
        frames={frames}
        live={live}
        onExplain={() => undefined}
        initialRenderer="articulated"
      />,
    );

    const leftFig = renderer.root.findAllByProps({ testID: 'hand-figure-left' })[0];
    const rightFig = renderer.root.findAllByProps({ testID: 'hand-figure-right' })[0];
    expect(leftFig).toBeDefined();
    expect(rightFig).toBeDefined();

    await teardown(renderer);
  });

  it('renders test pose chips for demonstration and testing without physical gloves', async () => {
    const renderer = await renderThemed(
      <HandViewer frames={frames} live={live} onExplain={() => undefined} />,
    );

    const fistChip = renderer.root.findAllByProps({ accessibilityLabel: 'Test pose Fist' })[0];
    expect(fistChip).toBeDefined();

    // Tap Fist preset
    act(() => {
      fistChip?.props.onPress();
    });

    // Subtitle indicates demo state
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Resume stream' })[0]).toBeDefined();

    await teardown(renderer);
  });
});
