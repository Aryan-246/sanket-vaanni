/**
 * The audit log's two pure pieces.
 *
 * ## Why these are the pieces that got tested
 *
 * The rest of the audit surface is a screen and an HTTP call, and neither can be
 * tested here honestly: the screen's data comes from a backend that is not
 * running, and the call's URL comes from a gitignored `.env` — so a test that
 * went through it would pass on one machine and fail on a fresh clone while
 * appearing to assert something about the code. (That exact trap already cost
 * this suite one environment-dependent failure; see `more-screen.test.tsx`.)
 *
 * What is left is the part that decides things: which query parameters a filter
 * becomes, and what a row's stored JSON means. Both are decisions with a wrong
 * answer, and both are tested here directly.
 */
import { auditQueryString } from '../src/admin/client';
import {
  actorLine,
  detailOf,
  outcomeOf,
  recordedActorOf,
  requestIdOf,
} from '../src/admin/auditEntry';

/** The query string as a lookup, so assertions do not depend on key order. */
function params(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of query.split('&')) {
    const [key, value = ''] = pair.split('=');
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

describe('turning filters into a query', () => {
  it('sends only the filters that were set', () => {
    /*
     * An absent filter must not be sent as an empty one. The server ignores an
     * empty value, so this is not about behaviour — it is about the request
     * saying what it asked for, which is what anyone reading a log will assume
     * it does.
     */
    const query = params(auditQueryString(1, {}));

    expect(query.page).toBe('1');
    expect(Object.keys(query).sort()).toEqual(['page', 'perPage']);
  });

  it('maps each filter to the parameter name the API expects', () => {
    const query = params(
      auditQueryString(3, {
        action: 'suspend_account',
        outcome: 'failed',
        actor: 'admin@example.test',
        targetType: 'profile',
        targetId: 'user-9',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      }),
    );

    expect(query.page).toBe('3');
    expect(query.action).toBe('suspend_account');
    expect(query.outcome).toBe('failed');
    expect(query.actor).toBe('admin@example.test');
    expect(query.targetType).toBe('profile');
    expect(query.targetId).toBe('user-9');
    expect(query.from).toBe('2026-01-01T00:00:00.000Z');
    expect(query.to).toBe('2026-02-01T00:00:00.000Z');
  });

  it('escapes an address, so a filter cannot change the query it is part of', () => {
    // The address is a value. A `&` in it must not become a new parameter — the
    // same class of mistake as the search-term interpolation fixed on the server.
    const query = params(auditQueryString(1, { actor: 'a&outcome=succeeded@example.test' }));

    expect(query.actor).toBe('a&outcome=succeeded@example.test');
    expect(query.outcome).toBeUndefined();
  });

  it('drops an address that is only whitespace', () => {
    // A field someone tabbed through and left spaces in is not a filter, and
    // sending `actor=%20%20` would read as one that matched everything.
    const query = params(auditQueryString(1, { actor: '   ' }));

    expect(query.actor).toBeUndefined();
  });

  it('trims an address rather than searching for the padding', () => {
    // A pasted address very often carries a trailing space, and `ilike` against
    // `%x %` matches nothing at all.
    const query = params(auditQueryString(1, { actor: '  admin@example.test  ' }));

    expect(query.actor).toBe('admin@example.test');
  });
});

describe('reading what a row says about itself', () => {
  const row = (metadata: unknown) => ({ metadata: metadata as never });

  it('reads the three outcomes this service records', () => {
    expect(outcomeOf(row({ outcome: 'requested' }))).toBe('requested');
    expect(outcomeOf(row({ outcome: 'succeeded' }))).toBe('succeeded');
    expect(outcomeOf(row({ outcome: 'failed' }))).toBe('failed');
  });

  it('does not read an outcome out of a row that has none', () => {
    /*
     * Rows written before outcomes were recorded have no such key. Reporting
     * them as failed would be the worst of the available mistakes — a suspension
     * that worked perfectly, displayed as a failure.
     */
    expect(outcomeOf(row({}))).toBe('unrecorded');
    expect(outcomeOf(row(null))).toBe('unrecorded');
    expect(outcomeOf(row('succeeded'))).toBe('unrecorded');
    expect(outcomeOf(row({ outcome: 'SUCCEEDED' }))).toBe('unrecorded');
    expect(outcomeOf(row({ outcome: 1 }))).toBe('unrecorded');
    expect(outcomeOf(row({ outcome: null }))).toBe('unrecorded');
  });

  it('does not read an outcome out of an array, which is also an object', () => {
    // `typeof [] === 'object'`. Without the array check, `[].outcome` is
    // `undefined` and this happens to work — but the guard is what makes that a
    // property rather than a coincidence.
    expect(outcomeOf(row([]))).toBe('unrecorded');
    expect(outcomeOf(row(['outcome']))).toBe('unrecorded');
  });

  it('reads the id that pairs an action’s two rows', () => {
    expect(requestIdOf(row({ requestId: 'req-1' }))).toBe('req-1');
    expect(requestIdOf(row({ requestId: '' }))).toBeNull();
    expect(requestIdOf(row({ requestId: 7 }))).toBeNull();
    expect(requestIdOf(row({}))).toBeNull();
    expect(requestIdOf(row(null))).toBeNull();
  });

  it('reads the failure detail when there is one', () => {
    expect(detailOf(row({ detail: 'permission denied for table profiles' }))).toBe(
      'permission denied for table profiles',
    );
    expect(detailOf(row({ detail: '' }))).toBeNull();
    expect(detailOf(row({}))).toBeNull();
  });

  it('reads the actor a row records when it names no account', () => {
    // What the bootstrap tool writes: no `actor_id`, no `actor_email`, and
    // `actor: 'operator-cli'` in the metadata instead.
    expect(recordedActorOf(row({ actor: 'operator-cli' }))).toBe('operator-cli');
    expect(recordedActorOf(row({ actor: '' }))).toBeNull();
    expect(recordedActorOf(row({ actor: 3 }))).toBeNull();
    expect(recordedActorOf(row({}))).toBeNull();
    expect(recordedActorOf(row(null))).toBeNull();
  });
});

describe('saying who acted when no account is named', () => {
  /*
   * A real device showed "by an account that no longer exists" on two bootstrap
   * rows whose own metadata said `operator-cli` — a deletion asserted about an
   * action that was taken from a terminal and had no account at all.
   */
  it('names the recorded actor instead of asserting a deletion', () => {
    expect(actorLine('operator-cli')).toBe('operator-cli (no account recorded)');
  });

  it('does not claim an account existed and was removed when none is recorded', () => {
    const line = actorLine(null);

    // `actor_id` is `ON DELETE SET NULL`, so a deleted actor and one that never
    // had an account are the same null here. A wording that picks one of the two
    // invents the distinction.
    expect(line).not.toMatch(/no longer exists|deleted|removed|terminated/i);
    expect(line).toBe('an actor with no account recorded');
  });

  it('reads as a continuation of "by", which is how the screen renders it', () => {
    // The card draws `by {…}`, so a line that starts with a capital or repeats
    // the preposition would render as "by By ...".
    for (const recorded of [null, 'operator-cli']) {
      expect(actorLine(recorded)).toMatch(/^[a-z]/);
      expect(actorLine(recorded)).not.toMatch(/^by\b/i);
    }
  });
});
