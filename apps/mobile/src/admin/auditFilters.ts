/**
 * What the audit screen may ask the server for, and what each question means.
 *
 * ## Why this is a module and not a handful of `useState`s
 *
 * The server accepts seven filters (`apps/backend/src/routes/admin.ts`, the
 * `/admin/audit` handler): `action`, `outcome`, `actor`, `targetType`,
 * `targetId`, `from`, `to`. The screen used to send two of them. Three of the
 * remaining five are a *range* or a *set* rather than a typed value, so they
 * need a small amount of translation — a period picker is not a date, and an
 * action picker is not a token — and translation that lives inside a component
 * is translation that cannot be tested without rendering the component.
 *
 * So the vocabulary and the arithmetic live here, as plain functions, and the
 * screen only renders the result.
 *
 * ## The two things this file refuses to do
 *
 * **It does not invent values.** Every action and target type below is one the
 * backend actually writes; they were read off the `beginAction` call sites, not
 * guessed. The lists are a convenience for the picker, not a whitelist — the
 * server matches the token it is given, and an action added to the backend but
 * not to this file still appears in the log. It would simply not be offered as
 * a one-tap filter, which is a smaller failure than a picker that offers
 * choices the server cannot produce.
 *
 * **It does not decide what "recent" means on the server's behalf.** A period
 * is resolved to two instants against the clock of the phone that asked, and
 * the comment on `periodWindow` says so. An audit log filtered "since
 * yesterday" is a statement about this device's idea of yesterday, and if the
 * device's clock is wrong the window is wrong with it.
 */
import type { AdminAuditFilters } from './client';

/* ------------------------------------------------------------------ subject */

/**
 * What an entry is about.
 *
 * `target_type` on the row. The three values are the complete set the backend
 * writes: `profile` for everything done to an account, `announcement` for
 * everything done to a notice, and `setting` for the maintenance switch.
 */
export type SubjectFilter = '' | 'profile' | 'announcement' | 'setting';

/** In shown order. `''` is "no filter", not a fourth kind of subject. */
export const SUBJECT_OPTIONS: readonly { value: SubjectFilter; label: string }[] = [
  { value: '', label: 'Anything' },
  { value: 'profile', label: 'Accounts' },
  { value: 'announcement', label: 'Notices' },
  { value: 'setting', label: 'Settings' },
];

/* ------------------------------------------------------------------- period */

/** A named span ending now, instead of two dates the user would have to type. */
export type PeriodFilter = '' | 'day' | 'week' | 'month';

/** In shown order, shortest first so the list reads as a widening window. */
export const PERIOD_OPTIONS: readonly { value: PeriodFilter; label: string }[] = [
  { value: '', label: 'Any time' },
  { value: 'day', label: '24 hours' },
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
];

/**
 * The lengths, in milliseconds.
 *
 * Fixed spans, not calendar units: "7 days" here means 168 hours, so the window
 * does not jump by an hour when it crosses a daylight-saving boundary. A log is
 * read as "what happened in the last stretch of time", and that stretch is
 * easier to reason about when it never changes length. The label says hours and
 * days rather than "this week" for the same reason.
 */
const PERIOD_MS: Record<Exclude<PeriodFilter, ''>, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/**
 * The span a period names, as the two instants the server understands.
 *
 * Both ends are sent, including `to`. Sending only `from` would leave the
 * window open at the top, so an entry written a second from now — or written
 * with a `created_at` the database set ahead of this phone's clock — would
 * match a filter the user read as "the last 24 hours". A closed window is what
 * the words promise.
 *
 * `nowMs` is the caller's clock and is a parameter rather than a call to
 * `Date.now()` so that a test can pin the window and assert the exact strings.
 */
export function periodWindow(
  period: PeriodFilter,
  nowMs: number,
): Pick<AdminAuditFilters, 'from' | 'to'> {
  if (period === '') return {};
  return {
    from: new Date(nowMs - PERIOD_MS[period]).toISOString(),
    to: new Date(nowMs).toISOString(),
  };
}

/* ------------------------------------------------------------------- action */

/**
 * Every action the backend writes into `admin_audit_log`, in a display order
 * that groups related entries.
 *
 * Read off the `beginAction` call sites in `apps/backend/src/routes/admin.ts`
 * and `apps/backend/src/admin/bootstrap.ts`. `bootstrap_admin` and
 * `restore_admin` are here too: they are written by the operator-run bootstrap
 * script rather than by a route, and they appear in the same log, so leaving
 * them out would make the one event most worth finding — who made the first
 * administrator — the one event the picker could not ask for.
 */
export const AUDIT_ACTIONS: readonly string[] = [
  'suspend_account',
  'restore_account',
  'grant_admin',
  'revoke_admin',
  'bootstrap_admin',
  'restore_admin',
  'request_password_reset',
  'draft_announcement',
  'update_announcement',
  'publish_announcement',
  'dispatch_announcement',
  'enable_maintenance',
  'disable_maintenance',
];

/* ------------------------------------------------------------------ summary */

/** One clause per active filter, in the order the controls are shown. */
export function describeAuditFilters(filters: AdminAuditFilters): readonly string[] {
  const parts: string[] = [];

  if (filters.action) parts.push(`only ${humanToken(filters.action)}`);
  if (filters.outcome) parts.push(`only ${filters.outcome} attempts`);
  if (filters.targetType) {
    const named = SUBJECT_OPTIONS.find((option) => option.value === filters.targetType);
    parts.push(`only ${(named?.label ?? filters.targetType).toLowerCase()}`);
  }
  if (filters.actor?.trim()) parts.push(`by ${filters.actor.trim()}`);
  if (filters.targetId) parts.push('one account');
  if (filters.from || filters.to) parts.push('within one date range');

  return parts;
}

/** How many of the server's seven filters are in use. Drives "Clear filters". */
export function countAuditFilters(filters: AdminAuditFilters): number {
  return describeAuditFilters(filters).length;
}

/** `suspend_account` → `suspend account`. Shared with the entry cards. */
export function humanToken(token: string): string {
  return token.replace(/_/g, ' ');
}
