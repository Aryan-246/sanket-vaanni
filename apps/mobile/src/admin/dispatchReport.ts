/**
 * What the announcements screen is allowed to say about a push.
 *
 * ## The claim that must be impossible
 *
 * A screen that publishes an announcement and then says "Sent to 12 devices" has
 * told the administrator that twelve people were notified. Nobody knows that.
 * Firebase accepting a message means the request was well formed and queued; the
 * phone may be off, the app uninstalled, notifications silenced in the system
 * settings, and none of it visible from this side.
 *
 * So this module does two things rather than one. It reads the service's report,
 * and it *refuses* any report that claims a confirmed delivery — because the
 * backend's `deliveryConfirmed` is a literal `false` and there is no code path
 * in this project that could make it true. A payload that says otherwise is not
 * a delivery that happened; it is a payload this screen does not understand, and
 * it is dropped rather than rendered.
 *
 * ## Why every field has to be there
 *
 * The counts are shown next to each other, and a missing one renders as nothing
 * — which reads as zero. "Attempted 12, accepted 0" and "attempted 12, accepted
 * —" are the same sentence to a reader, and only one of them is true. So a
 * report that does not carry every figure it claims to carry is refused whole,
 * the same rule the overview screen follows and for the same reason.
 */
import type { BadgeTone } from '../components/Badge';

/** The three states the service reports, and no others. */
export type DispatchState = 'unavailable' | 'complete' | 'partial';

export interface DispatchReport {
  readonly state: DispatchState;
  /** Why the send could not run, or why it did not cover everything. */
  readonly reason: string | null;
  readonly targets: number;
  readonly accepted: number;
  readonly failed: number;
  readonly removed: number;
  readonly retries: number;
  readonly moreTargets: boolean;
  readonly summary: string;
}

const STATES: readonly string[] = ['unavailable', 'complete', 'partial'];

/** A count, or `null` when the payload did not carry one. */
function count(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a dispatch report, or refuses it.
 *
 * Exported so the refusal itself can be tested: the interesting behaviour is
 * what this declines to accept, not what it accepts.
 */
export function parseDispatchReport(payload: unknown): DispatchReport | null {
  if (!isRecord(payload)) return null;

  const state = typeof payload.state === 'string' && STATES.includes(payload.state)
    ? (payload.state as DispatchState)
    : null;
  if (state === null) return null;

  /*
   * `deliveryConfirmed` must be present and must be false.
   *
   * Absent is refused as well as true: an older or altered service that simply
   * omitted the field would leave this screen with no statement either way, and
   * the safe reading of an unknown is not "it was delivered".
   */
  if (payload.deliveryConfirmed !== false) return null;

  const targets = count(payload.targets);
  const accepted = count(payload.accepted);
  const failed = count(payload.failed);
  const removed = count(payload.removed);
  const retries = count(payload.retries);
  const summary =
    typeof payload.summary === 'string' && payload.summary.length > 0 ? payload.summary : null;

  if (
    targets === null ||
    accepted === null ||
    failed === null ||
    removed === null ||
    retries === null ||
    summary === null
  ) {
    return null;
  }

  return {
    state,
    reason: typeof payload.reason === 'string' && payload.reason.length > 0 ? payload.reason : null,
    targets,
    accepted,
    failed,
    removed,
    retries,
    moreTargets: payload.moreTargets === true,
    summary,
  };
}

export const NOT_DELIVERED =
  'Acceptance is not delivery: it is not proof that any phone showed one.';

function devices(n: number): string {
  return `${n} device${n === 1 ? '' : 's'}`;
}

/** The label for a badge beside the announcement. */
export function dispatchBadgeLabel(report: DispatchReport): string {
  if (report.state === 'unavailable') return 'Not sent';
  if (report.state === 'partial') return 'Partly sent';
  return 'Sent, not confirmed';
}

/**
 * The colour, which never carries the meaning alone.
 *
 * There is deliberately no `success` here. Green beside "Sent" is read as
 * "delivered", and no push in this system can be reported as delivered. The best
 * a complete send earns is the neutral tone, next to words that say what was and
 * was not established.
 */
export function dispatchTone(report: DispatchReport): BadgeTone {
  if (report.state === 'complete' && report.failed === 0 && report.targets > 0) return 'neutral';
  return 'warning';
}

/** The sentence the screen shows after a publish or a deliberate re-send. */
export function dispatchMessage(report: DispatchReport): string {
  if (report.state === 'unavailable') {
    return `No notification was sent. ${report.reason ?? 'Push is not configured.'}`;
  }

  if (report.state === 'complete' && report.targets === 0) {
    return 'No notification was sent: no phone is registered for push yet. The announcement is still live in the app.';
  }

  const accepted = `Firebase accepted ${report.accepted} of ${devices(report.targets)}`;
  const refused = report.failed > 0 ? ` and refused ${report.failed}` : '';
  const tail = report.state === 'partial' ? ` ${report.reason ?? 'Not every device was attempted.'}` : '';

  return `A notification was attempted: ${accepted}${refused}.${tail} ${NOT_DELIVERED}`;
}

/**
 * The sentence to show for whatever the service returned, or `null` when it
 * returned no dispatch at all.
 *
 * `null` and an unreadable payload are kept apart. The first means a draft was
 * saved and nothing was ever going to be sent; the second means the service said
 * something this screen cannot interpret, which the administrator should be told
 * rather than shown as silence.
 */
export function dispatchLine(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  const report = parseDispatchReport(payload);
  if (report === null) {
    return 'The service reported something about the notification that this screen cannot read, so nothing is claimed about it.';
  }
  return dispatchMessage(report);
}
