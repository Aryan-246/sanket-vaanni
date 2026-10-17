/**
 * Notices — announcements, as the app is allowed to see them.
 *
 * ## Why this reads the database directly
 *
 * `announcements` carries a policy that lets anyone read a row that is published
 * and inside its window: `"Published announcements are readable by everyone"`,
 * for `anon` and `authenticated`, with `GRANT SELECT` to both and every write
 * revoked. That policy exists so that a notice can be shown to a user who has
 * never signed in — which is the whole point of guest-first, and is why this
 * read does not go through `admin/client.ts`. That client attaches an
 * administrator's bearer token; using it here would mean a guest could not see a
 * notice, and would suggest to a reader that a notice is an administrative
 * thing.
 *
 * No service-role key is involved anywhere in this file, and it could not be:
 * the app has none, and a client with one would be able to read every row in the
 * database. This read succeeds or fails entirely on the policy above.
 *
 * ## Why the client filters what the policy already filtered
 *
 * The rows are checked again here — published, inside the window, well-formed —
 * rather than trusted. Two reasons, and neither is redundancy for its own sake:
 *
 *  * A **draft** must never be shown. If the policy were ever dropped, or the
 *    project were pointed at a different database, the thing that would leak is
 *    an unpublished announcement, which is the one row an operator expects to
 *    keep to themselves.
 *  * The query asks for `published = true` and the row still has to *say* so. The
 *    check that matters most is the one that survives someone else's mistake.
 *
 * ## What this deliberately does not do
 *
 *  * **No targeting.** The table has no audience, segment or user column. Every
 *    published notice applies to everybody, and nothing here invents a filter
 *    that would let one be addressed to a group.
 *  * **Nothing here sends anything.** This module reads the table and nothing
 *    else. Push is dispatched by the backend, from the admin console's
 *    re-send control, and its outcome is reported there as *acceptance*, never
 *    as delivery — see `src/admin/dispatchReport.ts`. The distinction matters
 *    because the two are easy to blur when describing this feature: a notice
 *    being published does not notify anybody by itself, and a notice that *was*
 *    dispatched is not proof that any phone showed it. What this card renders is
 *    only ever what the app read when it asked.
 *
 *    (An earlier version of this comment said flatly that nothing dispatched a
 *    notification for an announcement. That had become false once the dispatch
 *    route was built, and a comment that denies a real feature is as misleading
 *    as one that overstates it.)
 *  * **No server-side read state.** Dismissal is recorded on this device and
 *    nowhere else. It hides the notice here; it does not tell the server, and it
 *    does not follow the user to another phone.
 *
 * ## The failure this module exists to avoid
 *
 * "I could not read the notices" and "there are no notices" are different facts,
 * and only one of them is a reason to stay silent. So a failed read keeps the
 * last answer it successfully read and says it is the last one; and a failed
 * read with nothing cached says plainly that it could not check. It never
 * renders as an empty list.
 */
import { getSupabaseClient } from '../supabase/client';
import type { AnnouncementSeverity } from '../supabase/types';
import type { Storage } from '../storage';

/** Where the last successfully read list is kept, so an offline launch knows it. */
const CACHE_KEY = 'sv/v1/notices/lastKnown';
/** Which notices this device has dismissed. Local to this device, by design. */
const DISMISSED_KEY = 'sv/v1/notices/dismissed';

/**
 * The most notices a single read asks for.
 *
 * Bounded so a database that somehow accumulated thousands of live rows cannot
 * make one screen open slowly. Fifty simultaneous live notices is already far
 * past plausible for this product.
 */
export const NOTICE_LIMIT = 50;

/**
 * The longest a dismissed-id list is kept.
 *
 * Dismissals are pruned against the rows a successful read returns, so this is a
 * backstop rather than the mechanism: it bounds the one case pruning cannot,
 * which is a device that stops being able to reach the service while holding a
 * long list.
 */
export const MAX_DISMISSED = 200;

/** How long a read may take before it is abandoned. */
export const READ_TIMEOUT_MS = 8000;

/** The columns read. Named rather than `*`, so a column added later is not sent. */
const COLUMNS = 'id, title, body, severity, published, published_at, expires_at';

/** A notice, as the app will render it. */
export interface Notice {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: AnnouncementSeverity;
  /** Null when the notice is live as soon as it is published. */
  readonly publishedAt: string | null;
  /** Null when it does not expire. */
  readonly expiresAt: string | null;
}

const SEVERITIES: readonly AnnouncementSeverity[] = ['info', 'warning', 'critical'];

/** Critical first, then warning, then info. */
const SEVERITY_RANK: Record<AnnouncementSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function isSeverity(value: unknown): value is AnnouncementSeverity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

/**
 * A date the client can reason about, or null when there is nothing to parse.
 *
 * A non-null value that is not a date is **unreadable**, which is reported
 * separately from "absent" by `parseDate` returning `undefined` — because the
 * two lead to opposite decisions about a notice whose window cannot be checked.
 */
function parseDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

/**
 * Whether a notice's window contains this moment.
 *
 * Split out from `parseNotice` so a cached notice can be re-checked when it is
 * read back: a notice cached yesterday may have expired since, and showing it
 * because it was once valid would be how a stale notice outlives its own
 * expiry — the exact failure an operator sets an expiry to prevent.
 */
export function isLive(notice: Notice, nowMs: number): boolean {
  if (notice.expiresAt !== null && Date.parse(notice.expiresAt) <= nowMs) return false;
  if (notice.publishedAt !== null && Date.parse(notice.publishedAt) > nowMs) return false;
  return true;
}

/**
 * One row as a notice, or null when it must not be shown.
 *
 * Null covers both "this row is not a notice this build understands" and "this
 * notice is not for now". They are the same decision — do not render it — and
 * the caller has nothing different to do about either.
 */
export function parseNotice(row: unknown, nowMs: number): Notice | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const raw = row as Record<string, unknown>;

  /*
   * `published === true`, not truthy. A row carrying `published: "true"` is a row
   * whose shape this build does not recognise, and recognising it as published
   * would be a guess about a draft.
   */
  if (raw.published !== true) return null;

  const id = raw.id;
  const title = raw.title;
  const body = raw.body;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof title !== 'string' || title.trim().length === 0) return null;
  if (typeof body !== 'string' || body.trim().length === 0) return null;
  if (!isSeverity(raw.severity)) return null;

  const severity = raw.severity;
  if (!isSeverity(severity)) return null;

  const publishedAt = parseDate(raw.published_at);
  const expiresAt = parseDate(raw.expires_at);
  /*
   * A date that is present but unparseable makes the notice unshowable. The
   * alternative is rendering something whose validity window could not be
   * checked, which is precisely the claim an expiry date exists to make. This is
   * the same refusal to coerce that `../maintenance/controller.ts` applies to
   * `enabled`, and for the same reason.
   */
  if (publishedAt === undefined || expiresAt === undefined) return null;

  const notice: Notice = { id, title, body, severity, publishedAt, expiresAt };
  return isLive(notice, nowMs) ? notice : null;
}

/**
 * One notice per id, first occurrence kept.
 *
 * Ids are a primary key, so a database cannot return a duplicate — but this list
 * can also come from a cache written by an earlier build, and a duplicate notice
 * shown twice is the visible form of a bug that is much harder to find later.
 */
export function dedupeById(notices: readonly Notice[]): readonly Notice[] {
  const seen = new Set<string>();
  const out: Notice[] = [];
  for (const notice of notices) {
    if (seen.has(notice.id)) continue;
    seen.add(notice.id);
    out.push(notice);
  }
  return out;
}

/**
 * Most important first, then most recent.
 *
 * Severity before recency, because a critical notice published last week
 * outranks an informational one published this morning, and a list ordered by
 * date alone would bury it.
 */
export function sortNotices(notices: readonly Notice[]): readonly Notice[] {
  return [...notices].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const at = a.publishedAt === null ? 0 : Date.parse(a.publishedAt);
    const bt = b.publishedAt === null ? 0 : Date.parse(b.publishedAt);
    return bt - at;
  });
}

/** The notices to render: the live ones this device has not dismissed. */
export function selectVisible(
  notices: readonly Notice[],
  dismissedIds: readonly string[],
): readonly Notice[] {
  const dismissed = new Set(dismissedIds);
  return notices.filter((notice) => !dismissed.has(notice.id));
}

/**
 * Whether there is anything to draw.
 *
 * The rule that matters is the last one. A **successful** read with no notices is
 * the only state that means "there are none", and it is the only state that
 * renders nothing. A read that could not be completed always renders, even with
 * nothing cached, because on a settings screen a missing card and a card saying
 * "no notices" look identical — and the one thing a failed read must never do is
 * become indistinguishable from "you have no notices".
 */
export function shouldShowNotices(state: AnnouncementsState): boolean {
  if (state.status === 'ready') return state.notices.length > 0;
  return true;
}

/** What is known about the last read. */
export type AnnouncementsStatus =
  /** A read is in flight and no earlier answer is available. */
  | 'loading'
  /** Read successfully. An empty list here genuinely means there are none. */
  | 'ready'
  /** Could not be read. Falls back to the cached answer, or to saying so. */
  | 'unreadable';

export interface AnnouncementsState {
  readonly status: AnnouncementsStatus;
  /** Live, undismissed notices, most important first. */
  readonly notices: readonly Notice[];
  readonly checkedAtMs: number | null;
  /** Why the read could not complete. Present only for `unreadable`. */
  readonly reason: string | null;
  /** True when what is shown came from the cache rather than the network. */
  readonly fromCache: boolean;
  /** How many are hidden because this device dismissed them. */
  readonly dismissedCount: number;
}

export const INITIAL_ANNOUNCEMENTS_STATE: AnnouncementsState = {
  status: 'loading',
  notices: [],
  checkedAtMs: null,
  reason: null,
  fromCache: false,
  dismissedCount: 0,
};

/**
 * The result of one read, in the shape the callers of this module produce.
 *
 * A discriminated union rather than a throw, matching `../admin/client.ts`: a
 * failure here is an expected state of the world (offline, no project
 * configured, policy refused) and it has a sentence attached that the screen
 * shows.
 */
export type AnnouncementsRead =
  | { readonly ok: true; readonly rows: readonly unknown[] }
  | { readonly ok: false; readonly reason: string };

export interface AnnouncementsDeps {
  readonly storage: Storage;
  /**
   * Injected only by tests.
   *
   * The default reaches a live Supabase, so without this the whole read path —
   * what is cached, what survives a failure, whether a dismissed notice comes
   * back — would be unreachable from a test and would in practice go untested.
   * It is a constructor argument, not something a caller can supply at runtime.
   */
  readonly read?: (signal: AbortSignal) => Promise<AnnouncementsRead>;
}

/**
 * Reads the published notices.
 *
 * The `AbortSignal` is handed to the client's own transport rather than raced
 * against a timer: `postgrest-js` takes an `abortSignal` and aborts the request
 * itself, so a timeout here cancels the request instead of abandoning a promise
 * that is still in flight.
 */
async function supabaseRead(signal: AbortSignal): Promise<AnnouncementsRead> {
  const client = getSupabaseClient();
  if (client === null) {
    return {
      ok: false,
      reason: 'No announcement service is configured in this build, so notices cannot be read.',
    };
  }

  const { data, error } = await client
    .from('announcements')
    .select(COLUMNS)
    .eq('published', true)
    .limit(NOTICE_LIMIT)
    .abortSignal(signal);

  if (error) {
    /*
     * The message is surfaced rather than replaced. A refusal by the policy reads
     * as `permission denied for table announcements`, and the operator reading
     * that sentence knows immediately which grant is missing — where "could not
     * load notices" would send them looking at the network.
     */
    return {
      ok: false,
      reason: `The notice check could not be completed (${error.message}).`,
    };
  }

  return { ok: true, rows: Array.isArray(data) ? data : [] };
}

interface CachedNotices {
  readonly notices: readonly Notice[];
  readonly checkedAtMs: number | null;
}

export class AnnouncementsReader {
  private readonly storage: Storage;
  private readonly read: (signal: AbortSignal) => Promise<AnnouncementsRead>;
  private readonly listeners = new Set<() => void>();
  private state: AnnouncementsState = INITIAL_ANNOUNCEMENTS_STATE;
  /** Everything the last successful read returned, dismissed ones included. */
  private known: readonly Notice[] = [];
  private dismissed: readonly string[] = [];
  private loaded = false;
  /** Guards against two overlapping reads racing to write the state. */
  private inFlight = false;
  private disposed = false;

  constructor(deps: AnnouncementsDeps) {
    this.storage = deps.storage;
    this.read = deps.read ?? supabaseRead;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AnnouncementsState => this.state;

  /**
   * The one place the state is written.
   *
   * `notices` and `dismissedCount` are derived here rather than passed in, so a
   * caller cannot publish a list that disagrees with the dismissal set it was
   * filtered by — which is how a dismissed notice reappears.
   */
  private publish(patch: Omit<AnnouncementsState, 'notices' | 'dismissedCount'>): void {
    if (this.disposed) return;
    this.state = {
      ...patch,
      notices: selectVisible(this.known, this.dismissed),
      dismissedCount: this.dismissed.length,
    };
    for (const listener of this.listeners) listener();
  }

  /**
   * Reads the cached list and the dismissal set, once.
   *
   * Both are validated on the way in: the cache is JSON written by a previous
   * version of this app or by nobody, and a shape this build does not recognise
   * has to be treated as absent rather than coerced into something renderable.
   */
  private async loadLocal(): Promise<CachedNotices | null> {
    if (this.loaded) {
      /*
       * Already read once. What is in hand is fresher than the cache it came
       * from, so it is returned as-is; returning null here would make a later
       * failure look like a first launch with nothing cached.
       */
      return { notices: this.known, checkedAtMs: this.state.checkedAtMs };
    }
    this.loaded = true;

    const rawDismissed = await this.storage.getJson<unknown>(DISMISSED_KEY).catch(() => null);
    this.dismissed = Array.isArray(rawDismissed)
      ? rawDismissed
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .slice(0, MAX_DISMISSED)
      : [];

    const cached = await this.storage.getJson<CachedNotices>(CACHE_KEY).catch(() => null);
    if (cached === null || typeof cached !== 'object' || !Array.isArray(cached.notices)) {
      return null;
    }

    const nowMs = Date.now();
    /*
     * Re-validated rather than trusted: a notice cached while it was live may
     * have expired since, and rendering it from the cache would be how a stale
     * notice outlives the expiry an operator set to stop it.
     */
    const notices = dedupeById(
      cached.notices
        .map((notice) => parseNotice(asRow(notice), nowMs))
        .filter((notice): notice is Notice => notice !== null),
    );

    this.known = notices;
    return {
      notices,
      checkedAtMs: typeof cached.checkedAtMs === 'number' ? cached.checkedAtMs : null,
    };
  }

  /**
   * Falls back to the cached answer and says what happened.
   *
   * The distinction this preserves: a failed read with a cached answer renders
   * that answer and dates it; a failed read with nothing cached says it could not
   * check. Neither renders as an empty list, because "there are no notices" is
   * not something a failed read establishes.
   */
  private fallback(reason: string, cached: CachedNotices | null): void {
    this.publish({
      status: 'unreadable',
      checkedAtMs: cached?.checkedAtMs ?? null,
      reason,
      fromCache: cached !== null,
    });
  }

  /**
   * Asks the service.
   *
   * Safe to call often: overlapping calls are dropped rather than queued, and a
   * failed read never replaces a previously successful one — it is reported
   * alongside it.
   */
  async refresh(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    this.inFlight = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);

    try {
      const cached = await this.loadLocal();
      if (this.disposed) return;

      /*
       * A retry over an answer already on screen does not announce that it is
       * checking: replacing notices the user is reading with a spinner makes a
       * refresh look like the notices went away. Only a first read, with nothing
       * cached and nothing read, shows the loading state.
       */
      if (this.state.status !== 'ready' && this.known.length === 0) {
        this.publish({ status: 'loading', checkedAtMs: null, reason: null, fromCache: false });
      }

      const result = await this.read(controller.signal);
      if (this.disposed) return;

      if (!result.ok) {
        this.fallback(result.reason, cached);
        return;
      }

      const nowMs = Date.now();
      const notices = sortNotices(
        dedupeById(
          result.rows
            .map((row) => parseNotice(row, nowMs))
            .filter((notice): notice is Notice => notice !== null),
        ),
      );

      this.known = notices;
      /*
       * Dismissals are pruned against what the service still returns — and only
       * here, on a successful read. Doing it on a failure would use a stale list
       * to decide what the user had dismissed, and the first notice it dropped
       * would come back. An id belonging to an expired or deleted notice is
       * released, so the set cannot grow forever.
       */
      this.dismissed = this.dismissed.filter((id) => notices.some((notice) => notice.id === id));

      const checkedAtMs = nowMs;
      await Promise.all([
        this.storage
          .setJson<CachedNotices>(CACHE_KEY, { notices, checkedAtMs })
          .catch(() => undefined),
        this.storage.setJson<string[]>(DISMISSED_KEY, [...this.dismissed]).catch(() => undefined),
      ]);
      if (this.disposed) return;

      this.publish({ status: 'ready', checkedAtMs, reason: null, fromCache: false });
    } finally {
      clearTimeout(timeout);
      this.inFlight = false;
    }
  }

  /**
   * Hides a notice on this device.
   *
   * Nothing is sent to the service. The row stays published, every other device
   * still shows it, and this phone forgets the dismissal once the notice expires
   * or is deleted — which is exactly what the screen's own wording has to admit.
   */
  dismiss(id: string): void {
    if (this.disposed || id.length === 0) return;
    if (this.dismissed.includes(id)) return;

    this.dismissed = [id, ...this.dismissed].slice(0, MAX_DISMISSED);
    this.publish({
      status: this.state.status,
      checkedAtMs: this.state.checkedAtMs,
      reason: this.state.reason,
      fromCache: this.state.fromCache,
    });
    void this.storage.setJson<string[]>(DISMISSED_KEY, [...this.dismissed]).catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

/**
 * A cached notice read back as a row.
 *
 * The cache holds parsed notices, so the fields are re-presented under the
 * column names `parseNotice` expects rather than writing a second parser that
 * could drift from the first. Anything missing stays missing, which is how a
 * corrupted cache entry reaches the same rejection an unrecognised row would.
 *
 * `published: true` is asserted rather than carried, because a parsed notice does
 * not keep the column — every entry in this cache was read from a row that was
 * published at the time. The check still does its work: an entry with no `title`,
 * an unknown `severity`, or an unreadable date is rejected exactly as a row would
 * be.
 */
function asRow(notice: unknown): unknown {
  if (notice === null || typeof notice !== 'object') return notice;
  const raw = notice as Record<string, unknown>;
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    severity: raw.severity,
    published: true,
    published_at: raw.publishedAt ?? null,
    expires_at: raw.expiresAt ?? null,
  };
}
