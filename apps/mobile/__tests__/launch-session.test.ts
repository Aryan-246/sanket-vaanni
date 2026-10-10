/**
 * Launch session semantics.
 *
 * These are the rules behind "the intro plays on a fresh launch, but does not
 * replay when the user merely leaves and comes back".
 *
 * The mechanism is process lifetime: `sessionIntro` is created once per
 * JavaScript context, and Android destroys that context when the task is
 * removed from Recents or the app is force-stopped. A new JS context means a
 * new session, which means the intro plays again.
 *
 * What a unit test can prove is the session's own semantics — starts unplayed,
 * stays played once marked, and is independent per instance. That sessions
 * genuinely survive backgrounding and genuinely do not survive process death is
 * platform behaviour, and is asserted on hardware in
 * `docs/runtime-smoke-test.md` rather than claimed here. The distinction
 * matters: this file would still pass if Android behaved differently.
 */
import { createIntroSession } from '../src/app/launchSession';

describe('intro session', () => {
  it('is unplayed when the process starts', () => {
    expect(createIntroSession().shouldPlayIntro()).toBe(true);
  });

  it('stops asking for the intro once it has been played', () => {
    const session = createIntroSession();

    session.markIntroPlayed();

    expect(session.shouldPlayIntro()).toBe(false);
  });

  it('is unaffected by being marked more than once', () => {
    const session = createIntroSession();

    session.markIntroPlayed();
    session.markIntroPlayed();

    expect(session.shouldPlayIntro()).toBe(false);
  });

  it('gives each process its own session', () => {
    // This is what makes a fresh launch replay the intro. The previous
    // session having played says nothing about the new one — a distinction a
    // persisted `hasSeenIntro` flag cannot express, and the reason there is no
    // longer one.
    const previousLaunch = createIntroSession();
    previousLaunch.markIntroPlayed();

    const thisLaunch = createIntroSession();

    expect(thisLaunch.shouldPlayIntro()).toBe(true);
    expect(previousLaunch.shouldPlayIntro()).toBe(false);
  });

  it('exposes one shared session, so playback state is process-wide', () => {
    // Module caching is the whole reason this works: the navigator marks the
    // intro played, and any other importer sees that. If each `import`
    // produced a new session, the gate would reset on every re-render.
    const a = require('../src/app/launchSession');
    const b = require('../src/app/launchSession');

    expect(a.sessionIntro).toBe(b.sessionIntro);
  });
});
