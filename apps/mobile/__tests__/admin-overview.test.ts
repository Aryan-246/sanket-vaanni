/**
 * What the overview and the health screen are allowed to say.
 *
 * Following the same line as `admin-audit.test.ts`: the screen and the HTTP call
 * are not tested here, because their data comes from a backend that is not
 * running and their URL comes from a gitignored `.env`. What is tested is the
 * part that decides — whether a payload is figures this screen can stand behind,
 * and whether a health state can be read as a delivery claim.
 *
 * The reason the refusals matter more than the successes: every failure mode
 * here produces a *plausible* number. A missing count defaulted to zero reads as
 * "none of those", a string count coerced reads as a real figure, and a state
 * word nobody defined reads as whatever the badge happens to render.
 */
import {
  healthDetail,
  healthStateLabel,
  healthSummary,
  healthTone,
  parseHealth,
  parseOverview,
} from '../src/admin/overviewFigures';

/** A payload as the backend sends it, so each test can spoil one field. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    users: { total: 40, active: 33, suspended: 7, admins: 3, activeAdmins: 2 },
    announcements: { live: 5, drafts: 2, expired: 1 },
    audit: { succeeded24h: 9, failed24h: 1, recent: [] },
    generatedAt: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

const RECENT = {
  id: 'a1',
  actor_email: 'admin@example.test',
  action: 'suspend_account',
  target_type: 'profile',
  target_id: 'u1',
  metadata: { outcome: 'succeeded', requestId: 'r1' },
  created_at: '2026-10-15T09:00:00.000Z',
};

describe('reading the overview', () => {
  it('reads every figure the backend counted', () => {
    const figures = parseOverview(payload());

    expect(figures?.users).toEqual({
      total: 40,
      active: 33,
      suspended: 7,
      admins: 3,
      activeAdmins: 2,
    });
    expect(figures?.announcements).toEqual({ live: 5, drafts: 2, expired: 1 });
    expect(figures?.audit.succeeded24h).toBe(9);
    expect(figures?.audit.failed24h).toBe(1);
    expect(figures?.generatedAt).toBe('2026-10-15T10:00:00.000Z');
  });

  it('reads a recent row, including the outcome it carries', () => {
    const figures = parseOverview(
      payload({ audit: { succeeded24h: 1, failed24h: 0, recent: [RECENT] } }),
    );

    expect(figures?.audit.recent).toEqual([
      {
        id: 'a1',
        action: 'suspend_account',
        actorEmail: 'admin@example.test',
        targetType: 'profile',
        targetId: 'u1',
        outcome: 'succeeded',
        createdAt: '2026-10-15T09:00:00.000Z',
      },
    ]);
  });

  it('accepts an empty recent list, which is a real answer', () => {
    // The list is not a figure. "Nobody has done anything yet" is a fact the
    // database can report, and it is the state of a fresh project.
    expect(parseOverview(payload())?.audit.recent).toEqual([]);
  });

  it('refuses a payload that is missing a count rather than reading it as zero', () => {
    /*
     * The whole point. `users: { active: ... }` cast to a type would give
     * `undefined`, which renders as nothing — and the tile beside it, showing a
     * real number, would make the blank look like "none".
     */
    const figures = parseOverview(
      payload({ users: { total: 40, suspended: 7, admins: 3, activeAdmins: 2 } }),
    );

    expect(figures).toBeNull();
  });

  it('refuses a count that is not a number', () => {
    // A string count is a shape the service has never sent, and coercing it with
    // `Number()` would accept `''` as 0 — the same lie by another route.
    for (const bad of ['33', null, true, {}, []]) {
      const figures = parseOverview(
        payload({ users: { total: 40, active: bad, suspended: 7, admins: 3, activeAdmins: 2 } }),
      );
      expect(figures).toBeNull();
    }
  });

  it('refuses a count that cannot be a count of rows', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const figures = parseOverview(
        payload({ announcements: { live: bad, drafts: 2, expired: 1 } }),
      );
      expect(figures).toBeNull();
    }
  });

  it('refuses a payload with no read time, because the screen prints one', () => {
    // "Read at <stamp>" with nothing after it is worse than no stamp: it states
    // that these numbers are current without saying when they were read.
    expect(parseOverview(payload({ generatedAt: undefined }))).toBeNull();
  });

  it('refuses a whole payload over one unreadable activity row', () => {
    /*
     * A row with no id or no action cannot be rendered, and a row rendered with
     * blank fields in an audit trail reads as a recorded event with no content.
     * Dropping the row would silently under-report the last five actions, so the
     * payload is refused instead.
     */
    for (const bad of [{ ...RECENT, id: undefined }, { ...RECENT, action: '' }, 'not a row']) {
      const figures = parseOverview(
        payload({ audit: { succeeded24h: 1, failed24h: 0, recent: [RECENT, bad] } }),
      );
      expect(figures).toBeNull();
    }
  });

  it('refuses a recent list that is not a list', () => {
    const figures = parseOverview(
      payload({ audit: { succeeded24h: 1, failed24h: 0, recent: { id: 'a1' } } }),
    );

    expect(figures).toBeNull();
  });

  it('refuses shapes that are not the payload at all', () => {
    for (const bad of [null, undefined, 'ok', 42, [], { users: {}, announcements: {}, audit: {} }]) {
      expect(parseOverview(bad)).toBeNull();
    }
  });
});

/** A health payload as the backend sends it. */
function health(checks: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { checks, checkedAt: '2026-10-15T10:00:00.000Z' };
}

const API = {
  key: 'api',
  label: 'Backend API',
  state: 'verified',
  detail: 'This endpoint answered.',
  delivers: false,
  deliveryTested: false,
};

const EMAIL_UNTESTED = {
  key: 'email',
  label: 'Email',
  state: 'untested',
  detail: 'Settings are present.',
  delivers: true,
  deliveryTested: false,
};

describe('reading the health screen', () => {
  it('reads each check, with the state the backend reported', () => {
    const checks = parseHealth(health([API, EMAIL_UNTESTED]));

    expect(checks).toHaveLength(2);
    expect(checks?.[0]?.key).toBe('api');
    expect(checks?.[0]?.state).toBe('verified');
    expect(checks?.[1]?.delivers).toBe(true);
  });

  it('refuses a state word it does not know', () => {
    /*
     * The five words are the whole vocabulary of this screen. 'ok' is the one
     * that would arrive if someone added a state to the backend and forgot this
     * side — and it would render through `healthStateLabel` as nothing at all,
     * leaving a badge with no words in it beside a component nobody checked.
     */
    for (const bad of ['ok', 'ready', 'VERIFIED', '', null, 1]) {
      const checks = parseHealth(health([{ ...API, state: bad }]));
      expect(checks).toBeNull();
    }
  });

  it('only believes a delivery that is literally true', () => {
    // `deliveryTested` is the field that separates "configured" from "delivered".
    // Anything short of the boolean would be a string comparison away from
    // claiming a message arrived.
    for (const bad of ['true', 1, null, undefined, {}]) {
      const checks = parseHealth(health([{ ...EMAIL_UNTESTED, deliveryTested: bad }]));
      expect(checks?.[0]?.deliveryTested).toBe(false);
    }
    expect(parseHealth(health([{ ...EMAIL_UNTESTED, deliveryTested: true }]))?.[0]?.deliveryTested)
      .toBe(true);
  });

  it('refuses a check with no key or no label', () => {
    expect(parseHealth(health([{ ...API, key: undefined }]))).toBeNull();
    expect(parseHealth(health([{ ...API, label: '' }]))).toBeNull();
  });

  it('refuses a response with no list of checks', () => {
    for (const bad of [null, {}, { checks: 'api' }, { checks: [API], error: 'x' }.error]) {
      expect(parseHealth(bad)).toBeNull();
    }
  });

  it('tolerates a check with no detail, which is not an error', () => {
    // The detail is prose from a probe. A probe that had nothing to add must not
    // take the whole screen down with it.
    const checks = parseHealth(health([{ ...API, detail: undefined }]));

    expect(checks).toHaveLength(1);
    expect(checks?.[0]?.detail).toBe('');
  });
});

describe('the words the health screen uses', () => {
  const check = (overrides: Record<string, unknown> = {}) => {
    const parsed = parseHealth(health([{ ...API, ...overrides }]));
    return parsed![0]!;
  };

  it('says "not configured" only when the settings are absent', () => {
    expect(healthStateLabel(check({ state: 'unconfigured' }))).toBe('Not configured');
  });

  it('never lets "configured" read as "working"', () => {
    /*
     * The sentence an administrator reads must contain the missing step. A badge
     * saying "Configured" beside a database badge saying "Working" is read as
     * two successes, which is exactly the misreading this label exists to stop.
     */
    const label = healthStateLabel(check({ state: 'untested', delivers: true }));

    expect(label).toContain('not tested');
    expect(label).not.toContain('Working');
  });

  it('separates a component that works from one that sends nothing', () => {
    // The database and the API do their real job when they answer, so they may
    // say Working. Email and push cannot, and are never worded as if they do.
    expect(healthStateLabel(check({ state: 'verified', delivers: false }))).toBe('Working');
  });

  it('does not claim delivery for a component that was only reached', () => {
    const untested = check({ state: 'untested', delivers: true });
    const label = healthStateLabel(untested);
    const detail = healthDetail(untested);

    for (const text of [label, detail]) {
      expect(text).not.toMatch(/delivered|sends|message arrives/i);
    }
    expect(detail).toMatch(/nothing has been sent/i);
  });

  it('keeps a probe’s own words when it refused the connection', () => {
    const failed = check({ state: 'failed', detail: 'Invalid login', delivers: true });

    expect(healthDetail(failed)).toBe('Invalid login');
  });

  it('marks a failure apart from the other states, and never by colour alone', () => {
    expect(healthTone(check({ state: 'failed' }))).toBe('danger');
    expect(healthTone(check({ state: 'verified' }))).toBe('success');
    expect(healthTone(check({ state: 'untested' }))).toBe('warning');
    expect(healthTone(check({ state: 'unconfigured' }))).toBe('neutral');

    // Every state has words, so the tone is never the only signal.
    for (const state of ['unconfigured', 'untested', 'verified', 'failed'] as const) {
      expect(healthStateLabel(check({ state })).length).toBeGreaterThan(0);
    }
  });
});

describe('the health summary sentence', () => {
  const all = (...states: readonly string[]) =>
    parseHealth(
      health(
        states.map((state, index) => ({
          ...API,
          key: `c${index}`,
          label: `Component ${index}`,
          state,
          delivers: state === 'untested' || state === 'failed',
        })),
      ),
    )!;

  it('does not say everything is fine when something failed', () => {
    const summary = healthSummary(all('verified', 'failed'));

    expect(summary).toContain('1 of 2');
    expect(summary).not.toMatch(/everything|all (fine|good|healthy)/i);
  });

  it('names the components that cannot deliver, rather than counting them', () => {
    const checks = parseHealth(
      health([
        { ...API, key: 'email', label: 'Email', state: 'untested', delivers: true },
        { ...API, key: 'push', label: 'Push', state: 'untested', delivers: true },
      ]),
    )!;

    const summary = healthSummary(checks);

    expect(summary).toContain('Email and Push');
    expect(summary).toMatch(/cannot deliver/i);
  });

  it('says nothing about delivery when nothing has to deliver', () => {
    const summary = healthSummary(all('verified', 'verified'));

    expect(summary).toContain('None of the 2 components reported a failure');
    expect(summary).not.toMatch(/deliver/i);
  });

  it('admits when there is nothing to summarise', () => {
    expect(healthSummary([])).toMatch(/no components/i);
  });
});
