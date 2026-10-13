/**
 * Whether the user has asked the system to reduce motion.
 *
 * ## Why this is a hook and not a one-off check
 *
 * The value can change while the app is running — the setting is in the
 * accessibility menu, which a user can open over the app — and anything that
 * animates needs to stop *when* it changes, not only at launch. So this
 * subscribes as well as reading once.
 *
 * ## Why it defaults to `false`
 *
 * It resolves asynchronously, and the first frame is rendered before the answer
 * arrives. Defaulting to `true` would mean every animation is suppressed for
 * the first frame of every launch for everyone, which is a visible stutter for
 * the majority to protect the minority. Defaulting to `false` means a
 * reduce-motion user may see one frame of motion at launch — the same trade the
 * rest of this app makes for the first paint.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (!cancelled) setReduceMotion(value);
      })
      .catch(() => undefined);

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setReduceMotion(value);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
