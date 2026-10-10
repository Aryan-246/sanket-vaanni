/**
 * Pose stream — turns a glove snapshot into a pose, once per sample.
 *
 * ## Why this is a class and not a `useMemo`
 *
 * Pose smoothing is stateful: each pose depends on the one before it. That state
 * has to live somewhere that survives re-renders but is not React state, because
 * a new pose must not cause a render by itself — the sample that produced it
 * already did.
 *
 * The obvious implementation, calling the mapper inside a `useMemo`, has a real
 * defect: React 19 invokes render functions more than once in development, so
 * the exponential moving average would be advanced twice per sample and the
 * figure on screen would move at a different rate in development than in
 * production.
 *
 * ## The fix: memoise on sample identity
 *
 * The controller replaces `calibrated` only when a new frame arrives, so the
 * same object reference means the same sample. This class keys off that
 * reference, which makes `from()` idempotent: calling it twice with the same
 * snapshot returns the *same pose object*, so a repeated render cannot advance
 * the filter and cannot produce a different answer. It also gives the caller a
 * referentially stable value across unrelated re-renders.
 */
import { emptyPose, createPoseMapper, type HandPose, type NeutralPose, type PoseMapper, type PoseSmoothing } from './pose';
import type { GloveSnapshot } from '../ble/controller';
import type { GloveSide } from '../ble/types';

export interface PoseStreamOptions {
  readonly smoothing?: PoseSmoothing;
  readonly neutral?: NeutralPose;
}

export class PoseStream {
  readonly side: GloveSide;

  readonly #mapper: PoseMapper;
  readonly #smoothing: PoseSmoothing;
  #neutral: NeutralPose | null;
  #lastSample: unknown = null;
  #lastPose: HandPose;
  #lastFrame: {
    pose: HandPose;
    neutral: NeutralPose | null;
    smoothing: PoseSmoothing;
  } | null = null;
  #lastFramePose: HandPose | null = null;

  constructor(side: GloveSide, options: PoseStreamOptions = {}) {
    this.side = side;
    this.#mapper = createPoseMapper(side, options);
    this.#smoothing = options.smoothing ?? { alpha: 0.28 };
    this.#neutral = options.neutral ?? null;
    this.#lastPose = emptyPose(side);
  }

  /**
   * The pose for a snapshot.
   *
   * Idempotent per sample — see the note at the top. A snapshot with no
   * calibrated frame yields the resting pose with `source: 'none'`, and resets
   * the filter, so a new session cannot inherit the smoothing state of a
   * previous one.
   */
  from(snapshot: GloveSnapshot): HandPose {
    const sample = snapshot.calibrated;

    if (sample === null) {
      if (this.#lastSample !== null) {
        this.#mapper.reset();
        this.#lastSample = null;
        this.#lastPose = emptyPose(this.side);
      }
      return this.#lastPose;
    }

    if (sample === this.#lastSample) return this.#lastPose;

    this.#lastSample = sample;
    // `snapshot.source` is `'real' | 'simulated' | 'none'`, and `none` cannot
    // occur here because a calibrated frame exists. Passing it through rather
    // than deciding it locally is what stops a simulated frame from being drawn
    // as a live one.
    this.#lastPose = this.#mapper.map(sample, snapshot.source === 'real' ? 'real' : 'simulated');
    return this.#lastPose;
  }

  /**
   * The frame a renderer is given, including its smoothing parameters.
   *
   * Memoised on the pose's identity, so a re-render that produced no new sample
   * hands the renderer the *same* frame object. A viewer that diffed its props
   * would otherwise see a change on every render of its parent.
   */
  frame(snapshot: GloveSnapshot): {
    pose: HandPose;
    neutral: NeutralPose | null;
    smoothing: PoseSmoothing;
  } {
    const pose = this.from(snapshot);
    if (this.#lastFrame === null || this.#lastFramePose !== pose) {
      this.#lastFramePose = pose;
      this.#lastFrame = { pose, neutral: this.#neutral, smoothing: this.#smoothing };
    }
    return this.#lastFrame;
  }

  /**
   * Discards filter state.
   *
   * Called when a link closes. The neutral reference is kept: it belongs to the
   * glove and its wearer, not to the session, so clearing it would silently
   * un-calibrate the hand on a reconnect.
   */
  reset(): void {
    this.#mapper.reset();
    this.#lastSample = null;
    this.#lastPose = emptyPose(this.side);
    this.#lastFrame = null;
    this.#lastFramePose = null;
  }
}
