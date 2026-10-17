/**
 * What the console offers after a call fails.
 *
 * ## The defect these defend against
 *
 * Every failure in `AdminScreen.tsx` used to be drawn identically: the server's
 * sentence and a Retry button. The sentences were good — the middleware
 * produces separate ones for a missing token, an expired token, a
 * non-administrator and an unconfigured deployment — but the app behaved the
 * same for all of them.
 *
 * The worst case is the 401. Its whole meaning is "this session is finished",
 * and the one control the screen offered was "try again", which re-sends the
 * same dead token. An administrator presses it, watches it fail the same way,
 * and concludes the console is broken. The action that works — signing in — was
 * not on screen at all.
 *
 * The second is subtler and is the one a naive implementation gets wrong: **503
 * is not a 5xx to retry**. `requireAdmin` returns it for a deployment that is
 * missing configuration, and names the variables. Treating it as a server fault
 * puts a Retry in front of a condition no amount of retrying can change.
 *
 * So the assertions are about what is *offered*, not about the words: which
 * kinds get a retry, which get a sign-in, and that no kind claims the app can
 * fix something it cannot.
 */
import {
  asFailure,
  describeAdminFailure,
  type AdminFailureKind,
} from '../src/admin/failureState';

const KINDS: readonly AdminFailureKind[] = [
  'sign-in',
  'refused',
  'unconfigured',
  'server',
  'unreachable',
  'request',
];

describe('reading a status', () => {
  it('maps each status to the kind it means', () => {
    expect(describeAdminFailure(401).kind).toBe('sign-in');
    expect(describeAdminFailure(403).kind).toBe('refused');
    expect(describeAdminFailure(503).kind).toBe('unconfigured');
    expect(describeAdminFailure(500).kind).toBe('server');
    expect(describeAdminFailure(502).kind).toBe('server');
    expect(describeAdminFailure(400).kind).toBe('request');
    expect(describeAdminFailure(422).kind).toBe('request');
  });

  it('reads an absent status as "the service was never asked"', () => {
    // No status means no response: no API URL, no token, an abort or a dropped
    // connection. That is a different fact from "the service said no", and only
    // the second one means the request was ever considered.
    expect(describeAdminFailure(undefined).kind).toBe('unreachable');
  });

  /*
   * The trap. 503 is greater than 500, so any implementation that buckets by
   * "5xx means retry" gets this exactly backwards — and the mistake is invisible
   * in review, because the code looks like a reasonable range check.
   */
  it('does not treat 503 as an ordinary server fault', () => {
    expect(describeAdminFailure(503).kind).not.toBe('server');
    expect(describeAdminFailure(503).canRetry).toBe(false);
  });
});

describe('what each kind offers', () => {
  it('offers a way back in for an expired session, and no retry', () => {
    const described = describeAdminFailure(401);

    expect(described.canSignIn).toBe(true);
    expect(described.canRetry).toBe(false);
  });

  it('offers a way to check the account when the account was refused', () => {
    const described = describeAdminFailure(403);

    expect(described.canSignIn).toBe(true);
    expect(described.canRetry).toBe(false);
  });

  it('offers a retry only where repeating the request could work', () => {
    // Stated as the full set rather than by example: a kind added later that
    // quietly offered a retry would otherwise pass every test here.
    const retryable = KINDS.filter((kind) => kindCanRetry(kind));

    expect(retryable).toEqual(['server', 'unreachable']);
  });

  it('offers nothing a 503 cannot act on', () => {
    const described = describeAdminFailure(503);

    expect(described.canRetry).toBe(false);
    expect(described.canSignIn).toBe(false);
  });

  it('offers neither for a request the service rejected as written', () => {
    const described = describeAdminFailure(400);

    expect(described.canRetry).toBe(false);
    expect(described.canSignIn).toBe(false);
  });
});

describe('what each kind says', () => {
  it('says something for every kind, and never the same thing twice', () => {
    const headlines = KINDS.map((kind) => kindDescription(kind).headline);
    const advice = KINDS.map((kind) => kindDescription(kind).advice);

    for (const text of [...headlines, ...advice]) expect(text.trim().length).toBeGreaterThan(0);
    expect(new Set(headlines).size).toBe(KINDS.length);
  });

  it('never says the app can fix an unconfigured deployment', () => {
    // This is the one kind where the reader is genuinely stuck, and a sentence
    // that implied otherwise would send them looking for a control that is not
    // there. The service names the missing variables; only its deployment can
    // set them.
    const described = describeAdminFailure(503);

    expect(described.advice).toMatch(/retrying will not change that/i);
    expect(described.advice).toMatch(/deploys it/i);
  });

  it('does not tell the reader to try again for a session failure', () => {
    const described = describeAdminFailure(401);

    expect(described.advice).not.toMatch(/try again is reasonable/i);
    expect(described.advice).toMatch(/signing in again/i);
  });

  it('distinguishes a refusal from a session that ended', () => {
    // Both are "the console will not act as you", and they are fixed by
    // different things. Telling a signed-in non-administrator to sign in again
    // sends them round a loop that ends in the same refusal.
    const ended = describeAdminFailure(401);
    const refused = describeAdminFailure(403);

    expect(ended.headline).not.toBe(refused.headline);
    expect(refused.advice).toMatch(/which account is signed in/i);
  });
});

describe('carrying the status out of a result', () => {
  it('keeps the status when there was one', () => {
    expect(asFailure({ error: 'nope', status: 403 })).toEqual({ message: 'nope', status: 403 });
  });

  it('omits the status entirely when there was none', () => {
    // The bug this guards: keeping the message and dropping the status is what
    // made a 401 look like any other failure, and it fails silently — the card
    // still shows a sentence, it just stops knowing what to offer.
    const failure = asFailure({ error: 'The backend could not be reached.' });

    expect(failure.message).toBe('The backend could not be reached.');
    expect('status' in failure).toBe(false);
  });

  it('does not invent a status of zero for an absent one', () => {
    // 0 is falsy, so a truthiness check downstream would treat it as absent
    // while a `>= 400` check would classify it as a request failure. Neither is
    // what happened, so the key must not be present at all.
    expect(asFailure({ error: 'x' }).status).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ helpers */

function kindCanRetry(kind: AdminFailureKind): boolean {
  return kindDescription(kind).canRetry;
}

/** The description for a kind, reached through a status that maps to it. */
function kindDescription(kind: AdminFailureKind) {
  const STATUS_FOR: Record<AdminFailureKind, number | undefined> = {
    'sign-in': 401,
    refused: 403,
    unconfigured: 503,
    server: 500,
    unreachable: undefined,
    request: 400,
  };
  return describeAdminFailure(STATUS_FOR[kind]);
}
