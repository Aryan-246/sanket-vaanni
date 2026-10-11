/**
 * The animated frame for the panel preview.
 *
 * ## Why the timer is here and not in the canvas
 *
 * The canvas is a pure function of a frame. The clock is not: it is the one
 * thing in this feature that runs on its own, so it is isolated in a hook whose
 * whole job is to start it, stop it, and keep it from running when it would do
 * nothing.
 *
 * It is stopped in four cases, because each is a real waste otherwise:
 *
 *  - the screen is showing a still preview (`animate` is false);
 *  - the layout has no loading indicator to animate;
 *  - the layout has one, but it belongs to the other view — a startup-only
 *    indicator must not keep the timer awake while the running view is shown;
 *  - the component unmounts — which, since only the active tab is mounted, is
 *    what happens when the user leaves the OLED tab.
 *
 * The interval period is the user's own animation duration, so a slow setting
 * costs four times fewer wake-ups than a fast one rather than the app choosing
 * a fixed rate and throttling the result.
 *
 * ## Phase
 *
 * The panel has a startup view and a running view, and an item can belong to
 * only one of them. Both the animation decision and the frame itself therefore
 * take the phase, so the preview cannot animate an indicator that this view does
 * not draw.
 */
import { useEffect, useState } from 'react';

import {
  buildFrame,
  visibleItems,
  type OledFrame,
  type OledLayout,
  type OledPhase,
  type OledValues,
} from './layout';

export function useOledFrame(
  layout: OledLayout,
  values: OledValues,
  animate: boolean,
  phase: OledPhase = 'persistent',
): OledFrame {
  const [frame, setFrame] = useState(0);

  const wantsAnimation =
    animate &&
    layout.loadingStyle !== 'none' &&
    visibleItems(layout, phase).some((item) => item.kind === 'loading');

  const periodMs = layout.animationMs;

  useEffect(() => {
    if (!wantsAnimation) {
      // Reset so a still preview always shows the same phase, which keeps
      // screenshots and tests stable.
      setFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setFrame((current) => current + 1);
    }, periodMs);

    return () => clearInterval(timer);
  }, [wantsAnimation, periodMs]);

  return buildFrame(layout, values, frame, phase);
}
