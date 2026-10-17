/**
 * What a bulk action's answer means.
 *
 * ## Why this is a separate, pure module
 *
 * The same reason `auditEntry.ts` is one. The rest of a bulk action is a screen
 * and an HTTP call, and neither can be tested honestly here: the screen's data
 * comes from a backend that is not running, and the call's URL comes from a
 * gitignored `.env`. What is left is the part that decides something — and this
 * is the decision that can be wrong in a way that matters.
 *
 * ## The decision
 *
 * A bulk action that changed *some* of the selected accounts is the case this
 * exists for. Rounding it to "done" is the failure that matters, because the
 * administrator's next act depends on which accounts are still in the state they
 * were in before: a sentence that says "Suspended 5 accounts" when three were
 * suspended and two were refused is worse than no sentence at all. So the answer
 * is only ever described as complete when the service says every account
 * changed, and otherwise it names how many did and which did not, with a reason
 * for each.
 *
 * ## Why an unreadable answer is its own outcome
 *
 * A response that does not carry a recognisable list of per-account results
 * cannot support any claim, including a partial one. Reported as exactly that
 * rather than as zero successes — "nothing changed" would be a claim about the
 * database made from a response that failed to describe it.
 */

/** The backend's shape for one account in a bulk action. */
export interface BulkRowResult {
  readonly id: string;
  readonly ok: boolean;
  readonly status?: string;
  readonly error?: string;
}

/** The backend's shape for the whole answer. */
export interface BulkReport {
  readonly rows: readonly BulkRowResult[];
  readonly succeeded: number;
  readonly failed: number;
}

/** One account that was not changed, with the service's reason. */
export interface BulkFailure {
  readonly id: string;
  readonly error: string;
}

export interface BulkOutcome {
  /** The sentence to show. Says how many changed out of how many. */
  readonly headline: string;
  /** The accounts that were not changed, each with its reason. */
  readonly failures: readonly BulkFailure[];
  /** True only when every selected account was changed. */
  readonly complete: boolean;
}

/** What the action was trying to do, in the words the screen uses. */
export type BulkAction = 'suspend' | 'restore';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the service's answer, or null when it is not one.
 *
 * Deliberately strict about the parts the sentence depends on: an entry that is
 * not an object, or an `id` that is not a string, means the list cannot be
 * counted or named, and a count taken from a partly-readable list would be a
 * number nobody could check.
 */
export function parseBulkReport(raw: unknown): BulkReport | null {
  if (!isObject(raw)) return null;

  const list = raw.results;
  if (!Array.isArray(list)) return null;

  const rows: BulkRowResult[] = [];
  for (const entry of list) {
    if (!isObject(entry)) return null;
    if (typeof entry.id !== 'string' || entry.id.length === 0) return null;
    if (typeof entry.ok !== 'boolean') return null;

    rows.push({
      id: entry.id,
      ok: entry.ok,
      ...(typeof entry.status === 'string' ? { status: entry.status } : {}),
      ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
    });
  }

  const succeeded = rows.filter((row) => row.ok).length;

  /*
   * The service's own counts are not used. The list is what was actually
   * reported, and a count that disagreed with it would be a second answer to the
   * same question — the screen would then have to choose which to believe.
   */
  return { rows, succeeded, failed: rows.length - succeeded };
}

/**
 * The sentence for a bulk action's answer.
 *
 * `total` is the number of accounts the *service* reported on, which is the only
 * number either side can agree about. A request for five accounts that comes
 * back with three results is described as three, not as five.
 */
export function bulkOutcome(report: BulkReport, action: BulkAction): BulkOutcome {
  const verb = action === 'suspend' ? 'Suspended' : 'Restored';
  const total = report.rows.length;

  const failures: BulkFailure[] = report.rows
    .filter((row) => !row.ok)
    .map((row) => ({ id: row.id, error: row.error ?? 'The service did not say why.' }));

  if (total === 0) {
    return {
      headline: 'The service reported no accounts for this action, so nothing was changed.',
      failures: [],
      complete: false,
    };
  }

  if (report.succeeded === total) {
    return {
      headline: `${verb} ${total} of ${total}.`,
      failures: [],
      complete: true,
    };
  }

  if (report.succeeded === 0) {
    return {
      headline: `Nothing was ${verb.toLowerCase()}. The service refused all ${total} account${total === 1 ? '' : 's'}.`,
      failures,
      complete: false,
    };
  }

  return {
    headline: `${verb} ${report.succeeded} of ${total}. The other${report.failed === 1 ? '' : 's'} ${report.failed === 1 ? 'was' : 'were'} left as ${report.failed === 1 ? 'it was' : 'they were'}.`,
    failures,
    complete: false,
  };
}

/** The sentence for an answer that could not be read at all. */
export const UNREADABLE_BULK_ANSWER =
  'The service did not say which accounts were changed. Reload the list to see the current state.';

/* --------------------------------------------------------- before the action */

/**
 * How many accounts one bulk action may carry.
 *
 * Deliberately a copy of `MAX_BULK_TARGETS` in
 * `apps/backend/src/routes/admin.ts`, and deliberately not imported from it: the
 * app and the service are built and shipped separately, so a shared constant
 * would be a shared build step. The copy is checked by a test that asserts the
 * two numbers agree, which is the part that actually keeps them in step.
 *
 * ## Why the client keeps its own cap at all
 *
 * The service already refuses an oversize selection with a 400 that names the
 * limit, so no wrong change is possible without this. What it prevents is a
 * worse *experience* of a correct refusal: an administrator who selects
 * sixty accounts, writes a reason, presses Suspend, and only then learns that
 * the number was never allowed. The cap belongs where the selection is made.
 */
export const MAX_BULK_TARGETS = 50;

/**
 * What is wrong with a selection, or null when nothing is.
 *
 * Empty is not a problem — the controls are hidden at zero. It is over the cap
 * that needs a sentence, because the reason is not visible from the screen: the
 * list can be hundreds of rows long and nothing about it says where the line is.
 */
export function selectionProblem(count: number): string | null {
  if (count <= MAX_BULK_TARGETS) return null;
  return `One action can change at most ${MAX_BULK_TARGETS} accounts at a time. ${count} are selected — remove ${count - MAX_BULK_TARGETS} before continuing.`;
}

/**
 * The selected accounts, named — what a confirmation should say.
 *
 * ## Why this exists at all
 *
 * The consequence of a bulk action is not "some accounts will be suspended". It
 * is *these* accounts, and an administrator who has scrolled a list and tapped
 * a column of boxes has been looking at rows, not at a set. A dialog that only
 * repeats the count asks them to confirm a number; this asks them to confirm the
 * people the number stands for, which is the thing they can actually check.
 *
 * `labelFor` maps an id to the row's name. A selected id with no label is
 * counted rather than dropped: the list can be searched or filtered after a
 * selection is made, and a selection that quietly showed four names while
 * carrying five ids would be a dialog that lies about its own scope.
 */
export function describeSelection(
  selected: readonly string[],
  labelFor: ReadonlyMap<string, string>,
  limit = 4,
): string {
  if (selected.length === 0) return 'No accounts are selected.';

  const named: string[] = [];
  let unlisted = 0;

  for (const id of selected) {
    const label = labelFor.get(id);
    if (label === undefined) unlisted += 1;
    else named.push(label);
  }

  const shown = named.slice(0, limit);
  const hidden = named.length - shown.length;

  const parts = [...shown];
  if (hidden > 0) parts.push(`${hidden} more`);
  if (unlisted > 0) parts.push(`${unlisted} no longer in the list`);

  const head = `${selected.length} ${selected.length === 1 ? 'account' : 'accounts'}`;
  return `${head}: ${joinWithAnd(parts)}.`;
}

/** `a`, `a and b`, `a, b and c` — a list a person would say out loud. */
function joinWithAnd(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
