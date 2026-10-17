/**
 * What the overview and the health screen are allowed to say.
 *
 * ## Why the numbers are parsed rather than read
 *
 * An overview is the easiest place in an interface to lie by accident. A count
 * that arrives as `null` renders as "0", and "0 suspended accounts" is a claim
 * about the database — one that a failed query did not make. So nothing here is
 * defaulted: a payload that does not carry every figure it claims to carry is
 * refused as a whole, and the screen says the overview could not be read rather
 * than drawing a grid of zeroes.
 *
 * The same rule applies to the health screen, where it matters more. There are
 * exactly five things an administrator can be told about a component, and the
 * gap between "configured" and "delivered" is the one people get wrong:
 *
 * - `unconfigured` — the settings it needs are absent.
 * - `untested` — the settings are present, and nothing has been sent. This is
 *   not a success, and it is not a failure. It is the state the email and push
 *   paths are actually in.
 * - `verified` — the component performed its real job, against the real
 *   dependency. Only the database and the API can say this today.
 * - `failed` — an attempt was made and refused, or the component is unreachable.
 *
 * `deliveryTested` is the field that keeps `verified` from being read as "a
 * message arrived". A probe that opens an SMTP connection proves the server
 * answers; it does not prove an inbox received anything. Until a real
 * authorised delivery is confirmed, this stays false for every component — and
 * the wording below says so in the places a reader would otherwise assume
 * otherwise.
 */

import type { BadgeTone } from '../components/Badge';

/** A figure, as the backend reports it. */
export interface OverviewFigures {
  readonly users: {
    readonly total: number;
    readonly active: number;
    readonly suspended: number;
    readonly admins: number;
    readonly activeAdmins: number;
  };
  readonly announcements: {
    readonly live: number;
    readonly drafts: number;
    readonly expired: number;
  };
  readonly audit: {
    readonly succeeded24h: number;
    readonly failed24h: number;
    readonly recent: readonly OverviewActivity[];
  };
  /** When the backend read these figures. */
  readonly generatedAt: string;
}

/** One row of the recent-activity list. */
export interface OverviewActivity {
  readonly id: string;
  readonly action: string;
  readonly actorEmail: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly outcome: string | null;
  readonly createdAt: string;
}

/** The four states a component can be in, in the words the backend uses. */
export type HealthState = 'unconfigured' | 'untested' | 'verified' | 'failed';

export interface HealthCheck {
  readonly key: string;
  readonly label: string;
  readonly state: HealthState;
  /** What was found, in the probe's own words. Never a credential value. */
  readonly detail: string;
  /** Whether this component sends anything to a person. */
  readonly delivers: boolean;
  /**
   * Whether a real message is known to have arrived.
   *
   * Read from the payload rather than derived, because the only honest answer
   * is "the backend has proof", and the backend is the only thing that can have
   * it.
   */
  readonly deliveryTested: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A count, or `null` when the payload did not carry one. */
function count(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseActivity(value: unknown): OverviewActivity | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const action = text(value.action);
  const createdAt = text(value.created_at);
  if (id === null || action === null || createdAt === null) return null;

  return {
    id,
    action,
    actorEmail: text(value.actor_email),
    targetType: text(value.target_type),
    targetId: text(value.target_id),
    outcome: text((value.metadata as Record<string, unknown> | undefined)?.outcome),
    createdAt,
  };
}

/**
 * Reads the overview payload, or refuses it.
 *
 * Refusal is all-or-nothing on purpose. A grid in which ten tiles are real and
 * one is a zero nobody measured is worse than no grid: the reader has no way to
 * tell which one to distrust.
 */
export function parseOverview(payload: unknown): OverviewFigures | null {
  if (!isRecord(payload)) return null;

  const users = payload.users;
  const announcements = payload.announcements;
  const audit = payload.audit;
  if (!isRecord(users) || !isRecord(announcements) || !isRecord(audit)) return null;

  const total = count(users.total);
  const active = count(users.active);
  const suspended = count(users.suspended);
  const admins = count(users.admins);
  const activeAdmins = count(users.activeAdmins);
  const live = count(announcements.live);
  const drafts = count(announcements.drafts);
  const expired = count(announcements.expired);
  const succeeded24h = count(audit.succeeded24h);
  const failed24h = count(audit.failed24h);
  const generatedAt = text(payload.generatedAt);

  if (
    total === null ||
    active === null ||
    suspended === null ||
    admins === null ||
    activeAdmins === null ||
    live === null ||
    drafts === null ||
    expired === null ||
    succeeded24h === null ||
    failed24h === null ||
    generatedAt === null
  ) {
    return null;
  }

  /*
   * The recent list may be empty — it is a list, not a figure — but it must be
   * a list of rows the screen can render. A row that cannot be read is dropped
   * rather than drawn with blank fields, because a blank row in an audit trail
   * reads as a record of nothing happening.
   */
  const rawRecent = audit.recent;
  if (!Array.isArray(rawRecent)) return null;
  const recent: OverviewActivity[] = [];
  for (const entry of rawRecent) {
    const row = parseActivity(entry);
    if (row === null) return null;
    recent.push(row);
  }

  return {
    users: { total, active, suspended, admins, activeAdmins },
    announcements: { live, drafts, expired },
    audit: { succeeded24h, failed24h, recent },
    generatedAt,
  };
}

/** The four states, and nothing else. An unknown word is not a state. */
function healthState(value: unknown): HealthState | null {
  return value === 'unconfigured' || value === 'untested' || value === 'verified' || value === 'failed'
    ? value
    : null;
}

export function parseHealth(payload: unknown): readonly HealthCheck[] | null {
  if (!isRecord(payload)) return null;
  if (!Array.isArray(payload.checks)) return null;

  const checks: HealthCheck[] = [];
  for (const entry of payload.checks) {
    if (!isRecord(entry)) return null;
    const key = text(entry.key);
    const label = text(entry.label);
    const state = healthState(entry.state);
    if (key === null || label === null || state === null) return null;

    checks.push({
      key,
      label,
      state,
      detail: typeof entry.detail === 'string' ? entry.detail : '',
      delivers: entry.delivers === true,
      // Anything other than a literal `true` is not proof of delivery.
      deliveryTested: entry.deliveryTested === true,
    });
  }

  return checks;
}

/**
 * The state, in words an administrator will not misread.
 *
 * `untested` is the one that has to be worded most carefully. "Configured" on
 * its own reads as "working"; on a screen that also says "verified" beside the
 * database, it reads as "the same". It is neither, so the words say what is
 * missing: a message that has actually been sent and confirmed.
 */
export function healthStateLabel(check: HealthCheck): string {
  switch (check.state) {
    case 'unconfigured':
      return 'Not configured';
    case 'untested':
      return 'Configured — delivery not tested';
    case 'verified':
      return 'Working';
    case 'failed':
      return 'Not working';
  }
}

/** The one-line reason beside the label. */
export function healthDetail(check: HealthCheck): string {
  if (check.state === 'untested') {
    return check.delivers
      ? 'Settings are present, but nothing has been sent, so this is not yet evidence that a message would arrive.'
      : 'Settings are present, but the connection has not been tried.';
  }
  if (check.state === 'verified' && check.delivers) {
    // Unreachable today — no delivering component is verified — and written so
    // that it could not be read as a statement about a person's inbox if it
    // ever were.
    return 'The component performed its own job. No message delivery has been confirmed.';
  }
  return check.detail;
}

/**
 * The colour, which never carries the meaning on its own.
 *
 * Paired with `healthStateLabel` everywhere it is used: "amber" is not a state
 * an administrator can act on, and a reader who cannot separate amber from red
 * still has the words.
 */
export function healthTone(check: HealthCheck): BadgeTone {
  switch (check.state) {
    case 'verified':
      return 'success';
    case 'untested':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'unconfigured':
      return 'neutral';
  }
}

/**
 * The sentence above the checks, which must not outrun the checks themselves.
 *
 * Written from the states rather than from an assumption about them: a screen
 * whose summary says "everything is fine" above a row saying "Not configured"
 * has taught the reader to skip the summary.
 */
export function healthSummary(checks: readonly HealthCheck[]): string {
  if (checks.length === 0) {
    return 'The backend reported no components to check.';
  }
  const failing = checks.filter((check) => check.state === 'failed');
  const untestedDeliverers = checks.filter(
    (check) => check.delivers && check.state !== 'verified' && check.state !== 'failed',
  );

  const parts: string[] = [];
  if (failing.length > 0) {
    parts.push(`${failing.length} of ${checks.length} components is not working.`);
  } else {
    parts.push(`None of the ${checks.length} components reported a failure.`);
  }
  if (untestedDeliverers.length > 0) {
    const names = untestedDeliverers.map((check) => check.label).join(' and ');
    parts.push(
      `${names} cannot deliver a message until a real send is confirmed, and none has been.`,
    );
  }
  return parts.join(' ');
}
