/**
 * The bulk action's answer, turned into a sentence.
 *
 * ## Why this is what gets tested
 *
 * The rest of a bulk action is a screen and an HTTP call, and neither can be
 * tested honestly in this suite: the screen's data comes from a backend that is
 * not running, and the call's URL comes from a gitignored `.env`, so a test that
 * went through it would assert an environment fact. What is left is the part
 * that decides something — and this decision has a wrong answer that matters.
 *
 * ## The wrong answer
 *
 * A batch can half succeed. The database can refuse one account (its own CHECK
 * constraint) while the accounts beside it are changed. Describing that as
 * "Suspended 3 accounts" is the failure this file exists to prevent: the
 * administrator would stop looking, and two accounts would still be signed in.
 * So the tests below cover the partial case first and in both of its shapes.
 *
 * The other wrong answer is the opposite one, and it is tested too: an answer
 * that cannot be read must not become "nothing changed", which is a claim about
 * the database made from a response that failed to describe it.
 */
import {
  MAX_BULK_TARGETS,
  bulkOutcome,
  describeSelection,
  parseBulkReport,
  selectionProblem,
  UNREADABLE_BULK_ANSWER,
  type BulkReport,
} from '../src/admin/bulkEntry';

/*
 * Read for one assertion below: that the cap this app enforces is the cap the
 * service enforces. Declared the way `guest-migration-readback.test.ts` does it,
 * because this project's tsconfig has no Node types.
 */
const fs: any = require('fs');
const path: any = require('path');
declare const __dirname: string;

/** A report body as the service sends it. */
function payload(
  rows: readonly { id: string; ok: boolean; status?: string; error?: string }[],
  tally?: { succeeded?: number; failed?: number },
): Record<string, unknown> {
  return {
    results: rows,
    succeeded: tally?.succeeded ?? rows.filter((row) => row.ok).length,
    failed: tally?.failed ?? rows.filter((row) => !row.ok).length,
    suspended: true,
  };
}

describe('reading a bulk action answer', () => {
  it('reads the per-account results', () => {
    const report = parseBulkReport(
      payload([
        { id: 'u1', ok: true, status: 'suspended' },
        { id: 'u2', ok: false, error: 'The account status could not be changed.' },
      ]),
    );

    expect(report).not.toBeNull();
    expect(report?.rows).toHaveLength(2);
    expect(report?.rows[0]).toEqual({ id: 'u1', ok: true, status: 'suspended' });
    expect(report?.rows[1]).toEqual({
      id: 'u2',
      ok: false,
      error: 'The account status could not be changed.',
    });
  });

  it('counts the rows rather than trusting the service tally', () => {
    /*
     * The two numbers answer the same question, so a disagreement between them
     * would leave the screen choosing which to believe. The rows are what was
     * actually reported per account, so they are what the sentence is built from
     * — a tally that says 2 while one row says `ok: true` is the case that
     * decides it.
     */
    const report = parseBulkReport(
      payload([{ id: 'u1', ok: true }, { id: 'u2', ok: false }], { succeeded: 2, failed: 0 }),
    );

    expect(report?.succeeded).toBe(1);
    expect(report?.failed).toBe(1);
  });

  it('refuses to read an answer that is not a report', () => {
    // Each of these would otherwise be counted, and a count taken from a
    // partly-readable list is a number nobody can check.
    expect(parseBulkReport(null)).toBeNull();
    expect(parseBulkReport('suspended')).toBeNull();
    expect(parseBulkReport([])).toBeNull();
    expect(parseBulkReport({})).toBeNull();
    expect(parseBulkReport({ results: 'u1, u2' })).toBeNull();
    expect(parseBulkReport({ results: [{ id: 'u1', ok: true }, 'u2'] })).toBeNull();
    expect(parseBulkReport({ results: [{ ok: true }] })).toBeNull();
    expect(parseBulkReport({ results: [{ id: '', ok: true }] })).toBeNull();
    expect(parseBulkReport({ results: [{ id: 'u1' }] })).toBeNull();
  });

  it('refuses an entry whose ok is present but not a boolean', () => {
    /*
     * A truthy `yes` is not "this account was changed". The sentence counts the
     * entries with `ok: true`, so anything else counted as a success would inflate
     * the number by exactly the entries whose meaning is unknown — a batch of five
     * reported as five when one of the five was never described. Being strict is
     * the point: an entry has to say `true` to be counted.
     */
    expect(parseBulkReport({ results: [{ id: 'u1', ok: 1 }] })).toBeNull();
    expect(parseBulkReport({ results: [{ id: 'u1', ok: 'true' }] })).toBeNull();
    expect(parseBulkReport({ results: [{ id: 'u1', ok: null }] })).toBeNull();
    expect(parseBulkReport({ results: [{ id: 'u1', ok: true }] })).not.toBeNull();
  });
});

describe('saying what a bulk action did', () => {
  const allChanged: BulkReport = {
    rows: [
      { id: 'u1', ok: true, status: 'suspended' },
      { id: 'u2', ok: true, status: 'suspended' },
      { id: 'u3', ok: true, status: 'suspended' },
    ],
    succeeded: 3,
    failed: 0,
  };

  it('reports a complete action as complete, and nothing else', () => {
    const outcome = bulkOutcome(allChanged, 'suspend');

    expect(outcome.headline).toBe('Suspended 3 of 3.');
    expect(outcome.complete).toBe(true);
    expect(outcome.failures).toHaveLength(0);
  });

  it('names the account that was not changed, and says the batch was partial', () => {
    const outcome = bulkOutcome(
      {
        rows: [
          { id: 'u1', ok: true, status: 'suspended' },
          { id: 'u2', ok: true, status: 'suspended' },
          { id: 'u3', ok: false, error: 'No account has that id.' },
        ],
        succeeded: 2,
        failed: 1,
      },
      'suspend',
    );

    // The two numbers are both present, and the sentence does not read as done.
    expect(outcome.headline).toMatch(/2 of 3/);
    expect(outcome.headline).toMatch(/left as/);
    expect(outcome.complete).toBe(false);
    expect(outcome.failures).toEqual([{ id: 'u3', error: 'No account has that id.' }]);
  });

  it('says how many were left alone, in the plural, when more than one was', () => {
    const outcome = bulkOutcome(
      {
        rows: [
          { id: 'u1', ok: true, status: 'suspended' },
          { id: 'u2', ok: false, error: 'Refused.' },
          { id: 'u3', ok: false, error: 'Refused.' },
        ],
        succeeded: 1,
        failed: 2,
      },
      'suspend',
    );

    expect(outcome.headline).toMatch(/1 of 3/);
    expect(outcome.headline).toMatch(/others were left as they were/);
    expect(outcome.complete).toBe(false);
    expect(outcome.failures).toHaveLength(2);
  });

  it('does not describe a batch in which nothing changed as a suspension', () => {
    const outcome = bulkOutcome(
      {
        rows: [
          { id: 'u1', ok: false, error: 'Refused.' },
          { id: 'u2', ok: false, error: 'Refused.' },
        ],
        succeeded: 0,
        failed: 2,
      },
      'suspend',
    );

    expect(outcome.headline).toBe('Nothing was suspended. The service refused all 2 accounts.');
    expect(outcome.complete).toBe(false);
    expect(outcome.failures).toHaveLength(2);
  });

  it('does not invent a reason the service did not give', () => {
    const outcome = bulkOutcome(
      { rows: [{ id: 'u1', ok: false }], succeeded: 0, failed: 1 },
      'suspend',
    );

    expect(outcome.failures[0]?.error).toMatch(/did not say why/i);
  });

  it('uses the restoring words when the action was a restore', () => {
    const outcome = bulkOutcome(
      {
        rows: [
          { id: 'u1', ok: true, status: 'active' },
          { id: 'u2', ok: true, status: 'active' },
        ],
        succeeded: 2,
        failed: 0,
      },
      'restore',
    );

    expect(outcome.headline).toBe('Restored 2 of 2.');
  });

  it('has its own sentence for an answer that named no accounts', () => {
    // Zero rows is not "nothing changed": the service did not describe any
    // account, so no claim about any of them can be made from this answer.
    const outcome = bulkOutcome({ rows: [], succeeded: 0, failed: 0 }, 'suspend');

    expect(outcome.headline).toMatch(/nothing was changed/i);
    expect(outcome.complete).toBe(false);
  });

  it('never reports a partial batch as complete, in any mix of results', () => {
    /*
     * The invariant, over every arrangement of a three-account batch. Stated as
     * a loop rather than one example because the failure this guards against is
     * a branch that happens to be reached — and the branch that is reached
     * depends on how many accounts failed.
     */
    const arrangements = [
      [true, true, true],
      [true, true, false],
      [true, false, true],
      [false, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [false, false, false],
    ];

    for (const arrangement of arrangements) {
      const rows = arrangement.map((ok, index) => ({
        id: `u${index}`,
        ok,
        ...(ok ? { status: 'suspended' } : { error: 'Refused.' }),
      }));
      const succeeded = rows.filter((row) => row.ok).length;
      const outcome = bulkOutcome({ rows, succeeded, failed: rows.length - succeeded }, 'suspend');

      if (succeeded === rows.length) {
        expect(outcome.complete).toBe(true);
        expect(outcome.failures).toHaveLength(0);
      } else {
        expect(outcome.complete).toBe(false);
        expect(outcome.failures).toHaveLength(rows.length - succeeded);
      }
    }
  });
});

describe('the sentence for an answer that could not be read', () => {
  it('tells the reader to reload rather than claiming nothing changed', () => {
    expect(UNREADABLE_BULK_ANSWER).toMatch(/reload/i);
    expect(UNREADABLE_BULK_ANSWER).toMatch(/did not say/i);
    expect(UNREADABLE_BULK_ANSWER).not.toMatch(/nothing was changed/i);
  });
});

/* ------------------------------------------------------ before the action */

/**
 * The safeguards that run before a bulk action, not after it.
 *
 * The tests above describe what the screen says when an action has already
 * happened. These describe what has to be true before it is allowed to: an
 * administrator confirming a named set of accounts, and a selection that cannot
 * grow past what one request may carry.
 */
describe('the cap on one bulk action', () => {
  it('agrees with the limit the backend enforces', () => {
    /*
     * The two constants live in packages that are built separately, so neither
     * can import the other. Duplication without a guard is how the client comes
     * to allow a selection the server will always refuse — a 400 the
     * administrator only meets after writing a reason and pressing the button.
     * This reads the backend source and compares the numbers, which is the only
     * thing that actually keeps them in step.
     */
    const backend = fs.readFileSync(
      path.join(__dirname, '..', '..', 'backend', 'src', 'routes', 'admin.ts'),
      'utf8',
    );
    const declared = /const MAX_BULK_TARGETS = (\d+);/.exec(backend);

    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(MAX_BULK_TARGETS);
  });

  it('allows a selection up to the limit and refuses the one past it', () => {
    expect(selectionProblem(0)).toBeNull();
    expect(selectionProblem(1)).toBeNull();
    expect(selectionProblem(MAX_BULK_TARGETS)).toBeNull();
    expect(selectionProblem(MAX_BULK_TARGETS + 1)).not.toBeNull();
  });

  it('says by how much the selection is over, not merely that it is', () => {
    const message = selectionProblem(MAX_BULK_TARGETS + 3)!;

    expect(message).toContain(String(MAX_BULK_TARGETS));
    expect(message).toContain('3');
  });
});

describe('naming the accounts a confirmation is about', () => {
  const accounts = new Map([
    ['a', 'ada@example.test'],
    ['b', 'grace@example.test'],
    ['c', 'alan@example.test'],
    ['d', 'edsger@example.test'],
    ['e', 'barbara@example.test'],
  ]);

  it('says nothing is selected when nothing is', () => {
    expect(describeSelection([], accounts)).toMatch(/no accounts/i);
  });

  it('names a single account rather than counting it', () => {
    // "1 account selected" is a number the reader has to take on trust. The
    // address is something they can check against the row they ticked.
    const sentence = describeSelection(['a'], accounts);

    expect(sentence).toContain('ada@example.test');
    expect(sentence).toContain('1 account');
    expect(sentence).not.toContain('accounts:');
  });

  it('names a short selection in full', () => {
    const sentence = describeSelection(['a', 'b', 'c'], accounts);

    expect(sentence).toContain('ada@example.test');
    expect(sentence).toContain('grace@example.test');
    expect(sentence).toContain('alan@example.test');
    expect(sentence).toContain('3 accounts');
  });

  it('shortens a long selection without losing the count', () => {
    const sentence = describeSelection(['a', 'b', 'c', 'd', 'e'], accounts, 2);

    expect(sentence).toContain('5 accounts');
    expect(sentence).toContain('ada@example.test');
    expect(sentence).toContain('3 more');
  });

  it('counts a selected account it cannot name instead of dropping it', () => {
    /*
     * A selection can outlive the rows that produced it: the list is searched
     * and re-read, and `selected` is not cleared by a search. A dialog that
     * showed one name while carrying two ids would understate its own scope at
     * exactly the moment the reader is checking it.
     */
    const sentence = describeSelection(['a', 'gone'], accounts);

    expect(sentence).toContain('2 accounts');
    expect(sentence).toContain('ada@example.test');
    expect(sentence).toMatch(/1 no longer in the list/);
  });

  it('reads as a list a person would say out loud', () => {
    expect(describeSelection(['a', 'b'], accounts)).toContain('ada@example.test and grace@example.test');
    expect(describeSelection(['a', 'b', 'c'], accounts)).toContain(
      'ada@example.test, grace@example.test and alan@example.test',
    );
  });
});
