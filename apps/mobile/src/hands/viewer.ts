/**
 * Hand viewer boundary.
 *
 * ## What is here, and what is not
 *
 * This file defines the *contract* between pose data and anything that draws a
 * hand. It does not contain a 3D renderer, because the intended 3D asset could
 * not be obtained and would not have been suitable if it had been. That finding
 * is recorded below rather than worked around, and the renderer slot is left
 * explicitly empty rather than filled with something that looks like it works.
 *
 * ## The rule this file exists to enforce
 *
 * A viewer is only ever driven by a `HandPose` whose `source` says where the
 * numbers came from. There is no code path here that lets a renderer invent a
 * finger bend, and `usePoseStream` never produces a `real` pose from simulated
 * data. Demo Mode therefore cannot be mistaken for a working glove.
 */
import type { HandPose, NeutralPose, PoseSmoothing } from './pose';

/**
 * Findings on the supplied reference model.
 *
 * Recorded from Sketchfab's own v3 API (the authoritative source for these
 * fields — read on 2026-10-10), not from a search result or a description.
 *
 * The summary: the model cannot be downloaded, and even if it could, it could
 * not articulate a hand. Both are recorded because either one alone would be
 * enough to stop.
 */
export const HAND_ASSET_FINDINGS = {
  url: 'https://sketchfab.com/3d-models/female-hands-7304150ee9084c58b354ea173ca82f39',
  author: 'Lassi Kaukonen',
  /** `GET /v3/models/<uid>` → `license.label`, `license.slug`. */
  licenceLabel: 'Standard',
  licenceSlug: 'st',
  /**
   * Whether Sketchfab permits downloading the asset at all.
   *
   * `GET /v3/models/<uid>/download` responds **HTTP 401 Unauthorized**. There is
   * no downloadable archive for this model, on any plan — a downloadable model
   * returns a signed URL here.
   */
  downloadable: false,
  /** `GET /v3/models/<uid>` → `animationCount`. No animations exist. */
  animationCount: 0,
  faceCount: 64656,
  vertexCount: 32390,
  /** Author-supplied tags, which identify the production route. */
  tags: ['3dscan', 'female', 'hand', 'hands', 'photogrammetry', 'scan'],
  /**
   * The author's description names Agisoft Metashape, Blender and R3DS Wrap.
   *
   * That is a photogrammetry-to-retopology pipeline: a scan of real hands,
   * retopologised into a clean quad mesh. Wrap is a *retopology* tool — it
   * produces clean topology, not a skeleton. There is no rig, and therefore no
   * finger bones, and therefore nothing for a pose to drive.
   */
  pipeline: 'Photogrammetry (Metashape) → retopology (Wrap3) → Blender',
} as const;

/**
 * Why the 3D viewer is not complete.
 *
 * Written as a value rather than a comment so it can be rendered in the app
 * (see `HandViewer` on the Dashboard) and read by a test, which is what stops
 * this from quietly becoming a TODO nobody sees.
 */
export const HAND_ASSET_BLOCKER =
  'The supplied reference model cannot be downloaded — its download endpoint ' +
  'returns 401 Unauthorized — and it carries no rig or animation, so it has no ' +
  'finger bones to articulate. A photogrammetry scan retopologised in Wrap3 is ' +
  'a clean static mesh, not a rigged hand.';

/** A renderer that can draw a `HandPose`. */
export interface HandRenderer {
  /** Stable id, used as a key and in diagnostics. */
  readonly id: string;
  readonly label: string;
  /**
   * `mesh3d` is a real three-dimensional render of a rigged model; `articulated`
   * draws a two-dimensional figure whose joints are driven by the pose. The
   * distinction is recorded because the brief is explicit that they are not
   * interchangeable, and pretending otherwise is how a 2D placeholder becomes
   * "the 3D viewer".
   */
  readonly kind: 'mesh3d' | 'articulated';
}

/** The renderer the milestone was meant to deliver. No implementation exists. */
export const MESH_RENDERER: HandRenderer = {
  id: 'mesh3d',
  label: '3D model',
  kind: 'mesh3d',
};

/** The renderer that is implemented, and honestly labelled as a stand-in. */
export const ARTICULATED_RENDERER: HandRenderer = {
  id: 'articulated',
  label: 'Articulated preview',
  kind: 'articulated',
};

/**
 * The route to a real 3D viewer, as a proposal — not as work that has begun.
 *
 * Deliberately does not name a version or assert that any of these work on this
 * project's stack. Native renderer compatibility with RN 0.87.1 on the New
 * Architecture has not been established, and the brief is explicit that a
 * heavyweight dependency must not be added before it is.
 */
export const HAND_ASSET_ROUTE = [
  'License or author a low-poly hand with an explicit skeleton: 15 finger joints plus a wrist pivot, and a documented handedness convention.',
  'Confirm redistribution and commercial-use rights in writing, and record the licence text alongside the asset.',
  'Evaluate a native glTF renderer for RN 0.87.1 on the New Architecture in a throwaway branch, and record measured frame timing on the target device before adopting it.',
  'Drive its bones from the existing `HandPose` contract. The bone names map to `FINGERS` plus the wrist; nothing else about the interface changes.',
] as const;

/**
 * Everything a renderer needs for one frame.
 *
 * `neutral` and `smoothing` are part of the frame rather than renderer settings
 * because they are properties of the pose stream: a renderer that applied its
 * own smoothing would produce a pose that no longer matches the numbers the rest
 * of the app is showing.
 */
export interface ViewerFrame {
  readonly pose: HandPose;
  /** Captured neutral reference, or null when none exists. */
  readonly neutral: NeutralPose | null;
  readonly smoothing: PoseSmoothing;
}

/**
 * Whether a renderer can be used right now.
 *
 * `mesh3d` returns `false` with the blocker above. Nothing sets this to `true`
 * by default, and nothing infers it from the presence of an asset.
 */
export function rendererAvailability(
  renderer: HandRenderer,
): { readonly available: true } | { readonly available: false; readonly reason: string } {
  return renderer.kind === 'mesh3d'
    ? { available: false, reason: HAND_ASSET_BLOCKER }
    : { available: true };
}

/**
 * What the viewer should tell the user about the current pose.
 *
 * A single string, because the viewer must say exactly one thing: a hand driven
 * by the simulator, a hand with no data, or a hand with real data. Saying
 * "Demo" and "Live" at once is the failure mode this prevents.
 */
export type ViewerCaption =
  | { readonly kind: 'simulated'; readonly text: string }
  | { readonly kind: 'real'; readonly text: string }
  | { readonly kind: 'none'; readonly text: string };

export function viewerCaption(pose: HandPose): ViewerCaption {
  switch (pose.source) {
    case 'simulated':
      return {
        kind: 'simulated',
        text: 'SIMULATED · driven by the demo sensor stream, not a glove',
      };
    case 'real':
      return { kind: 'real', text: 'LIVE · driven by a connected glove' };
    case 'none':
      return {
        kind: 'none',
        text: 'NO DATA · resting pose shown, no glove is reporting',
      };
  }
}
