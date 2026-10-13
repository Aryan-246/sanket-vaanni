/**
 * Copying to the clipboard, with feedback that reflects what happened.
 *
 * The clipboard is a native call and can fail — most importantly it is simply
 * absent on platforms where the app's native module is not built. So the state
 * this hook returns distinguishes three outcomes rather than assuming success:
 * nothing has happened yet, the text reached the clipboard, or it did not and
 * here is why.
 *
 * A button that says "Copied" when the copy failed is the specific failure this
 * exists to prevent. It reads as a working feature while the user pastes
 * whatever was on the clipboard before.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { copyToClipboard, isNativeModuleAvailable } from '../native/SanketVaanniNative';

export type CopyStatus = 'idle' | 'copied' | 'failed';

export interface CopyController {
  readonly status: CopyStatus;
  /** Why the last attempt failed. Null unless `status` is `failed`. */
  readonly error: string | null;
  /** True when the clipboard can be reached at all on this platform. */
  readonly available: boolean;
  /**
   * The word to show on the button right now: `Copy`, `Copied`, or `Copy failed`.
   */
  readonly label: string;
  copy(text: string): Promise<boolean>;
  reset(): void;
}

const UNAVAILABLE = 'The clipboard is not available in this build.';

export function useCopy(resetAfterMs = 2000): CopyController {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // A pending reset must not fire after unmount and set state on a dead
  // component.
  useEffect(() => clearTimer, [clearTimer]);

  const scheduleReset = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => {
      setStatus('idle');
      setError(null);
    }, resetAfterMs);
  }, [clearTimer, resetAfterMs]);

  const reset = useCallback(() => {
    clearTimer();
    setStatus('idle');
    setError(null);
  }, [clearTimer]);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      if (text.length === 0) {
        setStatus('failed');
        setError('There is nothing to copy.');
        scheduleReset();
        return false;
      }

      if (!isNativeModuleAvailable) {
        setStatus('failed');
        setError(UNAVAILABLE);
        scheduleReset();
        return false;
      }

      const ok = await copyToClipboard(text);
      setStatus(ok ? 'copied' : 'failed');
      setError(ok ? null : 'The system refused the clipboard write.');
      scheduleReset();
      return ok;
    },
    [scheduleReset],
  );

  const label = status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy';

  return { status, error, available: isNativeModuleAvailable, label, copy, reset };
}
