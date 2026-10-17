/**
 * Delivering a published announcement to the devices that asked for it.
 *
 * ## What a dispatch proves, and what it does not
 *
 * Firebase answers with a message id when it *accepts* a message. That id is not
 * a receipt. It means the request was well formed, the credentials were accepted
 * and the message was queued for the transport — and nothing more. The device
 * may be switched off, the app may have been uninstalled since the token was
 * issued, the user may have turned notifications off in the system settings, and
 * none of that is visible from here.
 *
 * So nothing in this file says a message was *delivered*. `accepted` counts
 * Firebase's acknowledgements, `failed` counts the attempts that came back an
 * error, and `deliveryConfirmed` is typed as the literal `false` rather than as
 * a `boolean`: there is no code path in this project that could set it
 * truthfully, so a caller that wants to claim a delivery has to come here and
 * change the type to do it.
 *
 * ## Why the size of the target list is part of the report
 *
 * "Sent to 12 devices" is read as "everyone got it". Two ways that reading can
 * be wrong are named in the report rather than rounded away:
 *
 * - `moreTargets` — there were more tokens stored than this dispatch was
 *   permitted to attempt, so some devices were never tried.
 * - `partial` — the time budget ran out with tokens still unvisited.
 *
 * An administrator deciding whether to send again needs to know whether the
 * first attempt covered everybody it meant to, so the count and the coverage
 * travel together and neither is inferred from the other.
 *
 * ## Why an unconfigured project sends nothing at all
 *
 * When no service account is configured there is no degraded mode: the dispatch
 * reports `unavailable`, says why in words an administrator can act on, and
 * returns without contacting anything. Attempting the sends anyway would produce
 * a report full of failures that reads like a delivery problem when the actual
 * state of the system is that push has never been set up.
 *
 * The reason is *classified* from the initialisation error rather than copied
 * from it. The error names the service account path, and a service account path
 * is a fact about this server's filesystem layout that no client needs — the
 * health screen already withholds `credentialsPath` for exactly that reason, and
 * forwarding the same path inside a different string would undo it.
 *
 * ## Duplicate safety
 *
 * This module does not decide *when* to dispatch; that decision belongs to the
 * route, which dispatches only on the transition into `published` and treats
 * re-publishing a live announcement as a no-op. What this module guarantees is
 * that one call is one attempt against each token it visits, that a token is
 * only ever removed for a failure Firebase calls permanent, and that a retry
 * re-sends only where a retry is the honest thing to do.
 */
import type { AppConfig } from '../config.js';
import { initFirebaseAdmin, type NotificationPayload } from '../services/firebase.js';

/**
 * How many devices one dispatch will attempt.
 *
 * A ceiling exists because this is one HTTP request that performs N outbound
 * sends, and without it the amount of work a single click can cause is decided
 * by how many rows are in a table. Five hundred is far above the number of
 * devices a project of this size has and far below anything that would look like
 * an outage to Firebase.
 */
const MAX_TARGETS = 500;

/** How many token rows are read per query, so one read cannot return the table. */
const TARGET_PAGE = 200;

/** How many times a send is attempted before it counts as failed. */
const MAX_ATTEMPTS = 3;

/** The first backoff, doubled between attempts. */
const RETRY_BASE_MS = 250;

/**
 * How long a whole dispatch may take.
 *
 * The response is what carries the report, so a dispatch that runs for minutes
 * is a request that has already been abandoned by its client while still
 * spending money. When the budget is reached the remaining tokens are not
 * attempted and the report says so.
 */
const DISPATCH_BUDGET_MS = 20_000;

/**
 * The failures that mean the token itself is dead.
 *
 * Only these two are unambiguous. `messaging/invalid-argument` is deliberately
 * absent even though a malformed token raises it: it is also what an oversized
 * payload raises, and deleting a working device's token because an announcement
 * body was too long would be a silent, permanent loss.
 */
const PERMANENT_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** The failures worth trying again: the other side was temporarily unable. */
const TRANSIENT_CODES = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/unavailable',
  'messaging/unknown-error',
  'messaging/quota-exceeded',
  'messaging/too-many-requests',
]);

/** One device row, as the token table stores it. */
export interface PushTarget {
  readonly token: string;
  readonly userId: string | null;
}

/** What the messaging client says about itself, before anything is sent. */
export interface PushAvailability {
  readonly initialized: boolean;
  readonly error?: string;
}

/**
 * Whether a dispatch happened, and whether it covered everything it meant to.
 *
 * `unavailable` is a statement about configuration, `partial` about coverage,
 * and `complete` about coverage only — never about delivery.
 */
export type DispatchState = 'unavailable' | 'complete' | 'partial';

export interface PushDispatchReport {
  readonly state: DispatchState;
  /** Why the dispatch was unavailable or partial. Null when it was neither. */
  readonly reason: string | null;
  /** Tokens this dispatch visited. */
  readonly targets: number;
  /** Messages Firebase accepted for transport. Not deliveries. */
  readonly accepted: number;
  /** Attempts that still failed after every retry. */
  readonly failed: number;
  /** Dead tokens deleted from the table. */
  readonly removed: number;
  /** Extra attempts beyond the first, across all tokens. */
  readonly retries: number;
  /** More tokens were stored than this dispatch was allowed to attempt. */
  readonly moreTargets: boolean;
  /**
   * Always false. Typed as the literal so a caller cannot set it, and so the
   * compiler refuses a future edit that tries to claim otherwise.
   */
  readonly deliveryConfirmed: false;
  /** The report as one sentence, for the response and the audit detail. */
  readonly summary: string;
}

export interface DispatchDeps {
  /** Whether push can run. Injected so a test need not own a service account. */
  readonly pushStatus?: (config: AppConfig) => PushAvailability;
  /** One page of device tokens. Injected so a test need not own a token table. */
  readonly listTargets?: (
    limit: number,
    offset: number,
  ) => Promise<{ targets: readonly PushTarget[]; error: string | null }>;
  /** Sends one message. Injected so a test never contacts Firebase. */
  readonly send?: (token: string, payload: NotificationPayload) => Promise<{ messageId: string }>;
  /** Deletes a token Firebase has declared dead. */
  readonly forgetToken?: (token: string) => Promise<void>;
  /** Waits between attempts. Injected so a test does not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The clock, in milliseconds. */
  readonly now?: () => number;
}

/**
 * What to tell an administrator when push cannot run.
 *
 * The initialisation error is *classified*, never echoed. It contains the path
 * to the service account, and the point of the health screen's own rule — that
 * `credentialsPath` is deliberately not returned — is that a client has no use
 * for the layout of this server. A path smuggled inside an error message is the
 * same disclosure by another route.
 */
export function pushUnavailableReason(status: PushAvailability): string {
  if (status.initialized) {
    return 'Push is configured. No message has been sent from here yet, so delivery to a device remains unproven.';
  }

  const text = (status.error ?? '').toLowerCase();
  if (text.includes('not set') || text.includes('not configured')) {
    return 'No Firebase service account is configured, so no push can be sent. Set GOOGLE_APPLICATION_CREDENTIALS to enable it.';
  }
  if (text.includes('not found')) {
    return 'The Firebase service account file named in the configuration is not present on this server, so no push can be sent.';
  }
  if (text.includes('failed to initialize')) {
    return 'The Firebase credentials could not be loaded, so no push can be sent.';
  }
  return 'Push is not configured, so no push can be sent.';
}

/** The FCM error code on a thrown error, or the empty string. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/** A short, bounded description of a failure, for the log and the audit detail. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * Whether another attempt is the honest thing to do.
 *
 * A failure Firebase names as transient is retried. A failure with no code at
 * all is taken to be a network fault, which is transient by nature — with one
 * exception: a client that was never initialised throws without a code, and
 * retrying a configuration error three times per token turns one mistake into
 * hundreds of pointless calls. That case is recognised by its message, which is
 * written in `services/firebase.ts`.
 */
function isRetryable(error: unknown): boolean {
  const code = errorCode(error);
  if (PERMANENT_TOKEN_CODES.has(code)) return false;
  if (TRANSIENT_CODES.has(code)) return true;
  if (code.length > 0) return false;
  return !/not initialized|no credential/i.test(errorMessage(error));
}

/** Whether the token should be deleted, rather than kept and retried later. */
function isDeadToken(error: unknown): boolean {
  return PERMANENT_TOKEN_CODES.has(errorCode(error));
}

function describe(report: Omit<PushDispatchReport, 'summary'>): string {
  if (report.state === 'unavailable') {
    return report.reason ?? 'Push is not configured, so no push can be sent.';
  }

  const parts: string[] = [];

  /*
   * A partial dispatch leads with why.
   *
   * Without this the sentence would begin "Attempted 7 devices" and a reader
   * would take it for the whole list; the count is only meaningful next to the
   * statement that it is not all of it.
   */
  if (report.state === 'partial' && report.reason !== null) parts.push(report.reason);

  parts.push(
    report.targets > 0
      ? `Attempted ${report.targets} device${report.targets === 1 ? '' : 's'}.`
      : /*
         * Zero attempted means two different things, and only one of them is a
         * fact about the table. A completed dispatch over an empty list has
         * really established that no device is registered; a dispatch that
         * stopped before it read anything has established nothing, and saying
         * "no device is registered" there would be a claim about the database
         * made from a read that never happened.
         */
        report.state === 'complete'
        ? 'No device is registered for push, so this announcement was published without reaching a phone.'
        : 'No device was attempted before the dispatch stopped.',
  );

  if (report.targets > 0) {
    parts.push(
      `Firebase accepted ${report.accepted} and refused ${report.failed}` +
        (report.retries > 0 ? `, after ${report.retries} retr${report.retries === 1 ? 'y' : 'ies'}` : '') +
        '.',
    );
  }

  if (report.removed > 0) {
    parts.push(
      `${report.removed} token${report.removed === 1 ? '' : 's'} no longer belonged to a device and ${
        report.removed === 1 ? 'was' : 'were'
      } removed.`,
    );
  }

  if (report.moreTargets) {
    parts.push(
      `More devices are registered than one dispatch may attempt, so some were not tried.`,
    );
  }

  /*
   * The sentence that has to be here.
   *
   * An acceptance count on its own is read as a delivery count, and the whole
   * reason this report is not just a boolean is that those are different facts.
   */
  parts.push('Acceptance is not delivery: no message is confirmed to have reached a screen.');

  return parts.join(' ');
}

/**
 * Sends one announcement to every registered device.
 *
 * Returns a report in every case, including every failure. A dispatch that could
 * not run is not an exception the caller has to interpret — it is a state with a
 * reason, because the announcement itself has already been published by the time
 * this is called and failing the request would misreport a notice that is live.
 */
export async function dispatchAnnouncement(
  config: AppConfig,
  notice: { id: string; title: string; body: string; severity: string },
  deps: DispatchDeps = {},
): Promise<PushDispatchReport> {
  const pushStatus = deps.pushStatus ?? initFirebaseAdmin;
  const status = pushStatus(config);

  const unavailable = (reason: string): PushDispatchReport => ({
    state: 'unavailable',
    reason,
    targets: 0,
    accepted: 0,
    failed: 0,
    removed: 0,
    retries: 0,
    moreTargets: false,
    deliveryConfirmed: false,
    summary: '',
  });

  if (!status.initialized) {
    const reason = pushUnavailableReason(status);
    const report = unavailable(reason);
    return { ...report, summary: describe(report) };
  }

  const listTargets = deps.listTargets;
  const send = deps.send;
  if (!listTargets || !send) {
    /*
     * Reachable only from a misconfigured injection. Reported as unavailable
     * rather than thrown: the notice is already published, and a 500 here would
     * tell the administrator the publication failed when it did not.
     */
    const report = unavailable('The push dispatcher is not wired up on this server, so no push can be sent.');
    return { ...report, summary: describe(report) };
  }

  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();

  const payload: NotificationPayload = {
    title: notice.title,
    body: notice.body,
    // The id travels with the message so a client can point at the notice it
    // came from rather than showing a copy of it that no longer exists.
    data: { announcementId: notice.id, severity: notice.severity },
  };

  let targets = 0;
  let accepted = 0;
  let failed = 0;
  let removed = 0;
  let retries = 0;
  let moreTargets = false;
  let stopped = false;

  for (let offset = 0; offset < MAX_TARGETS && !stopped; offset += TARGET_PAGE) {
    const page = await listTargets(Math.min(TARGET_PAGE, MAX_TARGETS - offset), offset);

    if (page.error !== null) {
      /*
       * A read that fails ends the dispatch. The count so far is still true, and
       * the coverage question is answered by the state: an administrator must be
       * able to tell that the list was not finished rather than read a partial
       * count as the whole of it.
       */
      const report = {
        state: 'partial' as const,
        reason: `The list of registered devices could not be finished: ${page.error}`,
        targets,
        accepted,
        failed,
        removed,
        retries,
        /*
         * Deliberately not `moreTargets`. That flag says "there are more devices
         * than this dispatch may attempt", which is a fact about the ceiling.
         * This is a fact about a failed read, and conflating them would put a
         * sentence about the wrong cause above the count.
         */
        moreTargets: false,
        deliveryConfirmed: false as const,
      };
      return { ...report, summary: describe(report) };
    }

    if (page.targets.length === 0) break;

    for (const target of page.targets) {
      if (now() - startedAt > DISPATCH_BUDGET_MS) {
        stopped = true;
        break;
      }

      targets += 1;
      let attempt = 0;

      for (;;) {
        attempt += 1;
        try {
          await send(target.token, payload);
          accepted += 1;
          break;
        } catch (error) {
          if (isDeadToken(error)) {
            /*
             * The token belongs to a device that will never receive anything
             * again. It is deleted rather than kept, because keeping it means
             * every future dispatch spends an attempt learning the same thing.
             * A failed deletion is not worth failing the send for; the token is
             * then simply retried another day.
             */
            failed += 1;
            if (deps.forgetToken) {
              try {
                await deps.forgetToken(target.token);
                removed += 1;
              } catch {
                // Left in place. The next dispatch will try it again and fail
                // the same way, which is a cost, not a correctness problem.
              }
            }
            break;
          }

          if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
            failed += 1;
            break;
          }

          retries += 1;
          await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        }
      }
    }

    if (page.targets.length < Math.min(TARGET_PAGE, MAX_TARGETS - offset)) break;
    if (offset + TARGET_PAGE >= MAX_TARGETS) {
      // There may be more rows behind the ceiling. Ask whether there are, so the
      // report can say so rather than implying the list was complete.
      const beyond = await listTargets(1, MAX_TARGETS);
      moreTargets = beyond.error === null && beyond.targets.length > 0;
      if (beyond.error !== null) moreTargets = true;
    }
  }

  const partial = stopped || moreTargets;

  const report = {
    state: (partial ? 'partial' : 'complete') as DispatchState,
    reason: stopped
      ? `The dispatch ran past its ${Math.round(DISPATCH_BUDGET_MS / 1000)}-second budget with devices still unattempted.`
      : moreTargets
        ? 'More devices are registered than one dispatch may attempt, so some were not tried.'
        : null,
    targets,
    accepted,
    failed,
    removed,
    retries,
    moreTargets,
    deliveryConfirmed: false as const,
  };

  return { ...report, summary: describe(report) };
}
