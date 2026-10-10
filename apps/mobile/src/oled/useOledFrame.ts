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
 * It is stopped in three cases, because each is a real waste otherwise:
 *
 *  - the screen is showing a still preview (`animate` is false);
 *  - the layout has no loading indicator to animate;
 *  - the component unmounts — which, since only the active tab is mounted, is
 *    what happens when the user leaves the OLED tab.
 *
 * The interval period is the user's own animation duration, so a slow setting
 * costs four times fewer wake-ups than a fast one rather than the app choosing
 * a fixed rate and throttling the result.
 */
import { useEffect, useState } from 'react';

import { buildFrame, type OledFrame, type OledLayout, type OledValues } from './layout';

export function useOledFrame(
  layout: OledLayout,
  values: OledValues,
  animate: boolean,
): OledFrame {
  const [frame, setFrame] = useState(0);

  const wantsAnimation =
    animate &&
    layout.loadingStyle !== 'none' &&
    layout.items.some((item) => item.visible && item.kind === 'loading');

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

  return buildFrame(layout, values, frame);
}
