/**
 * Pose hooks.
 *
 * The `PoseStream` for each glove lives in `AppStateProvider`, not in the
 * component that happens to read it. That matters: two components asking for the
 * right hand's pose — the Dashboard figure and, say, a future diagnostic readout
 * — would otherwise each hold their own copy of the smoothing filter and
 * disagree about what the hand is doing.
 */
import { useAppState, useGlove } from '../app/AppState';
import type { PoseStream } from './stream';
import type { ViewerFrame } from './viewer';
import type { GloveSide } from '../ble/types';
import type { HandPose } from './pose';

export function usePoseStream(side: GloveSide): PoseStream {
  const { poseStreams } = useAppState();
  return poseStreams[side];
}

/**
 * The pose for one glove.
 *
 * Reads during render, and is safe to: `PoseStream.from` is idempotent per
 * sample, so a repeated render returns the identical object rather than
 * advancing the filter.
 */
export function useHandPose(side: GloveSide): HandPose {
  const stream = usePoseStream(side);
  const glove = useGlove(side);
  return stream.from(glove);
}

/** The same value as `useHandPose`, wrapped with the renderer's inputs. */
export function useViewerFrame(side: GloveSide): ViewerFrame {
  const stream = usePoseStream(side);
  const glove = useGlove(side);
  return stream.frame(glove);
}
