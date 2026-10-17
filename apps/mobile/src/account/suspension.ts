/**
 * What a suspended account is told.
 *
 * ## Why this exists at all
 *
 * `profiles.status` has been readable by this client since the admin migration
 * — `AccountProvider` maps it, and its own comment says the column decides
 * "whether the account is suspended" — but nothing read it. The result was the
 * worst of both arrangements: the server does refuse a suspended account's reads
 * and writes, so sync fails, and the person seeing those failures was told
 * nothing about why. A suspension that presents itself as a mysterious sync
 * fault invites the user to keep retrying, to reinstall, to report a bug — and
 * all three waste their time and the administrator's.
 *
 * The migration is explicit that this is not the intent: it keeps `profiles`
 * readable to its own owner precisely so the app can say what happened, on the
 * grounds that "an account locked out with no explanation is worse than one that
 * is told".
 *
 * ## What the client knows, and what it does not
 *
 * This module can see one fact: the profile row said `status = 'suspended'` when
 * it was last read. Everything else in the notice is either a direct consequence
 * of that fact or a refusal to speculate.
 *
 *   * **Who acted.** Stated as an administrator, because `status` cannot be
 *     written by this client at all — `AccountProvider.updateProfile` does not
 *     attempt it, and the migration keeps the column behind a trigger that
 *     raises regardless of what any policy allows. The only paths that set it
 *     are the admin API and the bootstrap tool. So the inference is sound.
 *
 *   * **Why.** Deliberately absent. The reason is recorded in the audit log for
 *     administrators; it is not part of this client's read, and inventing a
 *     plausible cause would be the single most damaging thing this text could
 *     do.
 *
 *   * **Whether enforcement is actually in force.** The notice can only appear
 *     when `status` was readable, and `status` exists on `profiles` in the same
 *     migration that introduces `is_active()` and rewrites the user-data
 *     policies around it. The two travel together, so the sentence "the service
 *     refuses to read or write this account's synced records" is a description
 *     of the schema this row came from rather than a promise about a policy that
 *     might not be applied.
 *
 * ## The claims that must stay impossible
 *
 * Nothing here may read as a deletion. Suspension is reversible by design — the
 * admin API audits the opposite action as `restore_account` — and an account
 * whose owner believes it was destroyed will not ask for it back. So the text
 * names what is retained, names who can undo it, and never uses the words for
 * an ending.
 */

/** The subset of the profile this notice depends on. */
export interface SuspensionSubject {
  readonly status: 'active' | 'suspended';
}

export interface SuspensionNotice {
  /** The heading. Short enough to read at a glance. */
  readonly title: string;
  /** The one thing the reader most needs before anything else. */
  readonly summary: string;
  /** What happened, what still works, and what is kept. */
  readonly points: readonly string[];
}

const TITLE = 'Account suspended';

const SUMMARY = 'An administrator has suspended this account.';

const POINTS: readonly string[] = [
  'You can still sign in, and you can still read this page.',
  "The service will not read or write this account's synced records, so cloud sync cannot run until the account is restored.",
  'Nothing has been deleted. Records already on this phone stay on it, and the records synced to the account are kept.',
  'Only an administrator can restore the account. They can see the reason that was recorded for the suspension; it is not shown here.',
];

/**
 * The notice for a suspended profile, or `null` for anything else.
 *
 * `null` is the answer for an active account *and* for an absent profile: a
 * guest has no status to read and has not been suspended, and a screen that
 * announced a suspension it could not evidence would be worse than one that
 * stayed quiet.
 */
export function suspensionNotice(subject: SuspensionSubject | null | undefined): SuspensionNotice | null {
  if (!subject || subject.status !== 'suspended') return null;
  return { title: TITLE, summary: SUMMARY, points: POINTS };
}
