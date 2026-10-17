/**
 * What the audit log recorded about the last attempt to notify devices.
 *
 * ## Why this is read from the log rather than from the announcement
 *
 * The announcement row has nowhere to keep it. `GET /admin/announcements`
 * returns the notice and nothing about delivery, so the only durable trace of a
 * dispatch is the audit entry the backend already writes —
 * `dispatch_announcement`, targeted at the announcement, with the outcome and
 * the dispatch summary in its metadata.
 *
 * That entry is reachable through the audit endpoint the console already calls,
 * so this needs no new route, no new table and no change to the service. The
 * console asks the same `/admin/audit` it asks for the log itself, filtered to
 * one action.
 *
 * ## Why the badge is weaker than the live one
 *
 * `dispatchBadgeLabel` in `./dispatchReport` can say "Sent, not confirmed"
 * because it holds the structured report: it knows `targets` and `accepted`. This
 * one holds an outcome and a sentence, and the outcome is coarser than it looks.
 *
 * The service audits a dispatch as **succeeded** whenever it was not
 * `unavailable` — a `complete` dispatch with **zero registered devices** is
 * recorded as succeeded, and in that case nothing was sent to anyone. So
 * "succeeded" here cannot mean "sent". Reading it as if it did would put a
 * reassuring badge on a notification that went nowhere.
 *
 * What the log actually supports is: an attempt was recorded, and here is what
 * the service said about it. The summary is shown verbatim, which is where the
 * detail lives — it already ends by saying acceptance is not delivery.
 */

import type { AdminAuditRow } from '../supabase/types';
import type { BadgeTone } from '../components/Badge';
import { detailOf, outcomeOf, type AuditOutcome } from './auditEntry';

/** The one action whose rows carry a notification attempt. */
export const DISPATCH_ACTION = 'dispatch_announcement';

/** What the log recorded for one announcement. */
export interface LoggedDispatch {
  readonly announcementId: string;
  readonly outcome: AuditOutcome;
  /** The service's own summary, shown as it was written. */
  readonly detail: string | null;
  readonly at: string;
}

/**
 * The most recent recorded attempt per announcement.
 *
 * ## Why the window is stated rather than hidden
 *
 * The rows are whatever came back from one page of the audit endpoint
 * (`AUDIT_PAGE_SIZE` entries, newest first). An announcement whose last dispatch
 * predates that window simply has no entry here, which is not the same fact as
 * "no attempt was ever made" — so the caller must be able to tell the two apart,
 * and a missing key is therefore reported as "not in the log" rather than as
 * nothing.
 *
 * The first row for an id wins, because the endpoint orders newest first. Ties
 * on `created_at` are resolved the same way — arbitrarily but consistently, and
 * only between two rows written in the same millisecond.
 */
export function latestDispatchPerAnnouncement(
  rows: readonly AdminAuditRow[],
): ReadonlyMap<string, LoggedDispatch> {
  const found = new Map<string, LoggedDispatch>();

  for (const row of rows) {
    if (row.action !== DISPATCH_ACTION) continue;
    if (row.target_id === null || row.target_id.length === 0) continue;
    if (found.has(row.target_id)) continue;

    found.set(row.target_id, {
      announcementId: row.target_id,
      outcome: outcomeOf(row),
      detail: detailOf(row),
      at: row.created_at,
    });
  }

  return found;
}

/**
 * The badge for a recorded attempt.
 *
 * Deliberately not "Sent", and deliberately not "Notified" either. See the note
 * at the top: the service records a dispatch that reached no devices as a
 * success, so "Sent" would be a claim the log does not support — and "Notified"
 * is the same claim with a softer word. A badge is scanned rather than read, so
 * the first word is the one that lands, and a reader who takes "Notified" and
 * stops has been told something untrue.
 *
 * What is left is the part that is certainly true: an attempt was recorded, and
 * confirmation is not something this system produces.
 */
export function loggedDispatchBadge(outcome: AuditOutcome): string {
  switch (outcome) {
    case 'succeeded':
      return 'Recorded: not confirmed';
    case 'failed':
      return 'Not sent';
    case 'requested':
      return 'Attempt unrecorded';
    default:
      return 'Unknown';
  }
}

/**
 * The colour, which never carries the meaning alone.
 *
 * There is no `success` tone, for the same reason the live badge has none: green
 * beside a dispatch is read as "delivered", and nothing in this system can
 * report a delivery.
 */
export function loggedDispatchTone(outcome: AuditOutcome): BadgeTone {
  return outcome === 'succeeded' ? 'neutral' : 'warning';
}

/** One sentence for the card, built from what the log holds. */
export function loggedDispatchLine(entry: LoggedDispatch): string {
  const when = stamp(entry.at);
  const said = entry.detail;

  if (entry.outcome === 'succeeded') {
    return said === null
      ? `A notification attempt was recorded on ${when}, and the service did not record what it said about it.`
      : `Last notification attempt, ${when}: ${said}`;
  }

  if (entry.outcome === 'failed') {
    return said === null
      ? `A notification attempt on ${when} was recorded as failed, without a reason.`
      : `Last notification attempt, ${when}, was recorded as failed: ${said}`;
  }

  if (entry.outcome === 'requested') {
    return `A notification attempt was started on ${when} and nothing was ever recorded about how it ended.`;
  }

  return `A notification entry was recorded on ${when} before outcomes were recorded, so nothing is claimed about it either way.`;
}

/** The badge for an announcement with no dispatch entry in the window read. */
export const NOT_IN_LOG_BADGE = 'No recent attempt';

/**
 * A timestamp, as a reader would say it.
 *
 * Falls back to the raw string rather than to a placeholder: an unparseable
 * `created_at` is a fact about the row, and replacing it with "unknown" would
 * hide which row it was. The screen has its own formatter for the same reason —
 * this one only has to keep a sentence readable.
 */
function stamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

export const NOT_IN_LOG_NOTE =
  'No notification attempt for this notice appears in the most recent page of the audit log. That is not the same as never having sent one: an older attempt would be further back.';
