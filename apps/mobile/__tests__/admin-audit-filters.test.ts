/**
 * The audit screen's new filters: what each one sends, and what it says it did.
 *
 * ## The failure this file exists to catch
 *
 * Three of the seven audit filters are translated rather than passed through: a
 * period becomes two instants, a subject becomes a `target_type` token, and an
 * action is chosen from a list this file does not derive from the server. Each
 * translation has a specific way of going quietly wrong, and every one of them
 * ends in the same place — the log comes back **unfiltered or empty** while the
 * screen reports that a filter is in force.
 *
 *  - A period that sends only `from` is an open-ended window, so "24 hours"
 *    quietly means "everything since yesterday, including anything written with
 *    a clock ahead of this phone's".
 *  - A subject token the server's regex rejects is dropped by `readToken`, and
 *    the query runs unfiltered.
 *  - An action typed rather than picked fails the same way — which is why there
 *    is no text field for it, and why `AUDIT_ACTIONS` is checked against the
 *    server's own pattern below.
 *
 * These are pure functions and a query string, so all of it is testable without
 * a backend, a device or a running app. Fixtures are literal instants; no figure
 * here says anything about what is in a real log.
 */
import { auditQueryString } from '../src/admin/client';
import {
  AUDIT_ACTIONS,
  PERIOD_OPTIONS,
  SUBJECT_OPTIONS,
  countAuditFilters,
  describeAuditFilters,
  humanToken,
  periodWindow,
} from '../src/admin/auditFilters';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15T12:00:00Z
const HOUR = 60 * 60 * 1000;

describe('the window a period names', () => {
  it('sends nothing at all when no period is chosen', () => {
    // '' is the absence of a filter. Sending an empty window would read as
    // "since the beginning of time, until right now" and would silently exclude
    // any row dated a moment into the future.
    expect(periodWindow('', NOW)).toEqual({});
  });

  it('closes the window at both ends', () => {
    const window = periodWindow('day', NOW);

    // The `to` is the point. A `from`-only window matches rows written after it,
    // which is not what "the last 24 hours" says.
    expect(window.to).toBe('2026-10-15T12:00:00.000Z');
    expect(window.from).toBe('2026-10-14T12:00:00.000Z');
  });

  it('sends instants the server can parse', () => {
    for (const option of PERIOD_OPTIONS) {
      const window = periodWindow(option.value, NOW);
      if (option.value === '') continue;
      // The server normalises through `Date.parse` and rejects what it cannot
      // read, so an unparseable string would mean a dropped filter.
      expect(Number.isNaN(Date.parse(window.from!))).toBe(false);
      expect(Number.isNaN(Date.parse(window.to!))).toBe(false);
      expect(window.from!.endsWith('Z')).toBe(true);
    }
  });

  it('uses fixed spans, so the window does not change length with the calendar', () => {
    const spans = { day: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR } as const;

    for (const [period, expected] of Object.entries(spans)) {
      const window = periodWindow(period as keyof typeof spans, NOW);
      expect(Date.parse(window.to!) - Date.parse(window.from!)).toBe(expected);
    }
  });

  it('measures the same span in February as in March', () => {
    // A calendar-month reading would make "30 days" shorter across a 28-day
    // month, which is not what a log reader is asking for.
    const february = periodWindow('month', Date.UTC(2026, 1, 15, 12));
    const march = periodWindow('month', Date.UTC(2026, 2, 15, 12));

    /*
     * The NaN check is not decoration. Deleting `to` from `periodWindow` makes
     * both spans `NaN`, and `expect(NaN).toBe(NaN)` passes — `Object.is` treats
     * two NaNs as equal — so the subtraction below would go on passing while
     * the window it was comparing had no upper bound at all. Asserted first
     * because this is the assertion that fails.
     */
    expect(Number.isNaN(Date.parse(february.to!))).toBe(false);
    expect(Number.isNaN(Date.parse(march.to!))).toBe(false);
    expect(Date.parse(february.to!) - Date.parse(february.from!)).toBe(
      Date.parse(march.to!) - Date.parse(march.from!),
    );
  });
});

describe('the action vocabulary', () => {
  it('offers only tokens the server will accept', () => {
    /*
     * `readToken` in `apps/backend/src/routes/admin.ts` gates the `action`
     * parameter, and a value it refuses is dropped without an error — the query
     * runs unfiltered. So a token in this list that does not match would produce
     * a picker option that shows the *entire* log while the header claims a
     * filter is applied. This is the assertion that makes that impossible.
     */
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z][a-z0-9_]{0,40}$/);
    }
  });

  it('lists each action once', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('offers the actions the bootstrap script writes, not only the routes', () => {
    // These two are written by an operator-run script rather than a route, and
    // they are the entries most worth finding: who made the first administrator.
    expect(AUDIT_ACTIONS).toContain('bootstrap_admin');
    expect(AUDIT_ACTIONS).toContain('restore_admin');
  });

  it('offers a subject for each target type the server records', () => {
    const values = SUBJECT_OPTIONS.map((option) => option.value);

    expect(values).toEqual(['', 'profile', 'announcement', 'setting']);
  });

  it('turns a token into words without dropping it', () => {
    expect(humanToken('suspend_account')).toBe('suspend account');
    expect(humanToken('request_password_reset')).toBe('request password reset');
  });
});

describe('what the screen says is filtered', () => {
  it('says nothing when nothing is filtered', () => {
    expect(describeAuditFilters({})).toEqual([]);
    expect(countAuditFilters({})).toBe(0);
  });

  it('names a filter for each of the seven the server accepts', () => {
    const filters = {
      action: 'grant_admin',
      outcome: 'succeeded' as const,
      actor: 'admin@example.test',
      targetType: 'profile',
      targetId: '00000000-0000-0000-0000-000000000001',
      from: '2026-10-14T12:00:00.000Z',
      to: '2026-10-15T12:00:00.000Z',
    };

    /*
     * Seven parameters, six questions. `from` and `to` are the two ends of one
     * window the user set with one control, and a summary that listed them
     * separately would tell an administrator they had applied seven filters when
     * they had applied six — and would make "Clear filters" look like it only
     * undid part of what is in force.
     */
    const named = describeAuditFilters(filters);
    expect(named).toHaveLength(6);
    expect(named.filter((clause) => clause.includes('date range'))).toHaveLength(1);
    expect(countAuditFilters(filters)).toBe(named.length);
  });

  it('names a subject with the same word its control shows', () => {
    // A summary that disagreed with the control above it would be worse than no
    // summary: the reader would check the controls, see them empty, and believe
    // the list was broken.
    const [clause] = describeAuditFilters({ targetType: 'announcement' });

    expect(clause).toContain('notices');
    expect(SUBJECT_OPTIONS.find((option) => option.value === 'announcement')!.label).toBe('Notices');
  });

  it('describes an action it does not offer as a filter option', () => {
    // The picker list is a convenience, not a whitelist. An action added to the
    // backend after this build must still be describable, because the server
    // will still return it.
    expect(AUDIT_ACTIONS).not.toContain('some_future_action');
    expect(describeAuditFilters({ action: 'some_future_action' })).toEqual([
      'only some future action',
    ]);
  });

  it('counts a period as one filter, not two', () => {
    // `from` and `to` are one question to the user. Counting them separately
    // would make "Clear filters" appear to undo two things.
    expect(countAuditFilters(periodWindow('week', NOW))).toBe(1);
  });

  it('ignores an address that is only whitespace', () => {
    expect(countAuditFilters({ actor: '   ' })).toBe(0);
  });
});

describe('what actually reaches the wire', () => {
  it('sends every filter the screen can set', () => {
    const window = periodWindow('day', NOW);
    const query = auditQueryString(1, {
      action: 'suspend_account',
      outcome: 'failed',
      actor: 'admin@example.test',
      targetType: 'profile',
      targetId: '00000000-0000-0000-0000-000000000001',
      ...window,
    });

    const sent = new URLSearchParams(query);
    expect(sent.get('action')).toBe('suspend_account');
    expect(sent.get('outcome')).toBe('failed');
    expect(sent.get('actor')).toBe('admin@example.test');
    expect(sent.get('targetType')).toBe('profile');
    expect(sent.get('targetId')).toBe('00000000-0000-0000-0000-000000000001');
    expect(sent.get('from')).toBe('2026-10-14T12:00:00.000Z');
    expect(sent.get('to')).toBe('2026-10-15T12:00:00.000Z');
  });

  it('does not put an empty filter on the wire', () => {
    const query = auditQueryString(1, { outcome: undefined, actor: '  ', ...periodWindow('', NOW) });

    const sent = new URLSearchParams(query);
    for (const key of ['action', 'outcome', 'actor', 'targetType', 'targetId', 'from', 'to']) {
      expect(sent.get(key)).toBeNull();
    }
  });
});
