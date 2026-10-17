/**
 * Reading an audit row's outcome.
 *
 * ## Why this is a module of its own
 *
 * An administrative action writes **two** rows: one before it is attempted, and
 * one when it resolves. Both carry the same `requestId` in `metadata`. A screen
 * that lists rows without reading `metadata.outcome` therefore shows one action
 * as two entries that look identical — the most confusing possible rendering of
 * the most trustworthy record in the system.
 *
 * `metadata` is stored as JSON and is not typed by the database, so every read of
 * it has to be narrowed by hand. Doing that narrowing in the screen would put a
 * `typeof` chain in the middle of layout code and leave it untested. Here it is
 * two small functions with a test each.
 *
 * ## `unrecorded` is not `failed`
 *
 * Rows written before outcomes were recorded have no `outcome` key at all.
 * Reporting those as anything other than "not recorded" would be inventing a
 * fact about the past, and reporting them as failures would be worse — a
 * suspension that worked perfectly, shown as failed.
 */
import type { Json } from '../supabase/types';

/** What is known about an action's result. */
export type AuditOutcome =
  /** The action was asked for, and has not resolved yet in what we have read. */
  | 'requested'
  /** It ran. */
  | 'succeeded'
  /** It did not run. */
  | 'failed'
  /** Written before outcomes were recorded, so nothing is claimed about it. */
  | 'unrecorded';

/**
 * The outcome recorded on a row.
 *
 * Anything that is not one of the three known values — including a row with no
 * `metadata` at all, which is what an older entry looks like — is `unrecorded`.
 */
export function outcomeOf(row: { readonly metadata: Json }): AuditOutcome {
  const metadata = row.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 'unrecorded';
  }

  const value = (metadata as Record<string, unknown>).outcome;
  if (value === 'requested' || value === 'succeeded' || value === 'failed') return value;
  return 'unrecorded';
}

/**
 * The id that pairs an action's two rows, or null.
 *
 * Empty strings are treated as absent: a blank id cannot pair anything, and
 * returning one would make two unrelated rows look like a pair.
 */
export function requestIdOf(row: { readonly metadata: Json }): string | null {
  const metadata = row.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>).requestId;
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}

/**
 * The error detail an unresolved or failed row carries, or null.
 *
 * Present only on terminal rows that resolved unsuccessfully. Shown because "it
 * failed" without the reason sends the reader to the logs, which is where they
 * would have gone anyway — but the reason is already here.
 */
export function detailOf(row: { readonly metadata: Json }): string | null {
  const metadata = row.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>).detail;
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}

/**
 * Who the record says acted, when it names no account.
 *
 * `actor_id` and `actor_email` are the columns that attribute an action to a
 * person, and there is one case where both are null that is *not* a deletion: an
 * action taken from the command line has no authenticated actor at all. The
 * bootstrap tool writes `actor: 'operator-cli'` into `metadata` rather than
 * naming somebody who did not act — see the long note at the top of
 * `apps/backend/src/admin/bootstrap.ts` — so the recorded actor is the one
 * identity that survives when the columns are empty.
 */
export function recordedActorOf(row: { readonly metadata: Json }): string | null {
  const metadata = row.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>).actor;
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}

/**
 * How the screen says that no account was named, which reads after "by ".
 *
 * The wording is deliberately about what the record holds rather than about what
 * happened to an account, because the columns cannot tell the two cases apart:
 * `admin_audit_log.actor_id` is `ON DELETE SET NULL`, so an actor whose profile
 * was deleted is set to exactly the same null as an actor that never had one.
 *
 * This replaced "an account that no longer exists", which was shown on a real
 * device for two bootstrap rows whose own `metadata` said `operator-cli`. It
 * asserted a deletion those rows contradict, and the audit log is the one screen
 * where a reader has no other source to check it against.
 */
export function actorLine(recordedActor: string | null): string {
  if (recordedActor === null) return 'an actor with no account recorded';
  return `${recordedActor} (no account recorded)`;
}
