/**
 * Launch session — decides whether the intro plays on this launch.
 *
 * ## Why this is not persisted
 *
 * The requirement is "play the intro on a fresh launch, but do not replay it
 * when the user simply leaves and comes back". A persisted flag such as
 * `hasSeenIntro` cannot express that: it only knows *ever*, never *this launch*.
 * Storing one is what previously made the intro vanish permanently after the
 * first run, which is the bug this module exists to fix.
 *
 * ## The signal: the JavaScript context
 *
 * Android destroys the app's process when the task is removed from Recents or
 * the app is force-stopped. That destroys the JS context, so this module is
 * evaluated from scratch and `played` is `false` again — the intro plays.
 *
 * Pressing Home or switching apps keeps the process (and therefore the JS
 * context) alive. `played` stays `true`, so returning does not restart the
 * intro. This is exactly the behaviour required, with no native lifecycle code
 * and no unreliable "replay on every AppState active" hack.
 *
 * ## Known platform limitation
 *
 * The signal is process death, not task removal — Android does not give
 * JavaScript a usable "my task was swiped away" callback without a foreground
 * service. The two therefore differ in one direction only:
 *
 *  - If Android kills the process in the background for memory pressure, the
 *    next resume is indistinguishable from a cold start, and the intro plays
 *    again. This is a *conservative* failure: it shows the intro once too
 *    often rather than never showing it.
 *  - The reverse (task dismissed, process somehow still alive) would skip the
 *    intro. In practice Recents-dismissal and force-stop both kill the process,
 *    so this does not arise — and it is the failure the old flag produced
 *    permanently, which is why it is worth avoiding.
 *
 * The device behaviour this reasoning predicts is asserted by
 * `__tests__/launch-session.test.ts` in the abstract, and checked against the
 * real phone in `docs/runtime-smoke-test.md`.
 */
export interface IntroSession {
  /** True when this launch has not yet shown the intro. */
  shouldPlayIntro(): boolean;
  /** Records that the intro has been shown (or deliberately skipped). */
  markIntroPlayed(): void;
}

/**
 * Creates an independent session.
 *
 * Exported so tests can create a fresh, isolated session per case rather than
 * sharing — and resetting — global state.
 */
export function createIntroSession(): IntroSession {
  let played = false;

  return {
    shouldPlayIntro: () => !played,
    markIntroPlayed: () => {
      played = true;
    },
  };
}

/**
 * The process-lifetime session.
 *
 * Created once per JS context. Nothing should reassign or reset this.
 */
export const sessionIntro: IntroSession = createIntroSession();
