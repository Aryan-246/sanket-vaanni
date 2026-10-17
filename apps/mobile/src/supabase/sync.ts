/**
 * Sanket Vaanni — Local-First Supabase Data Synchronizer.
 *
 * Implements:
 * - Local-first offline persistence (AsyncStorage is primary source of truth)
 * - Bi-directional synchronization for Preferences, Calibrations, and OLED profiles
 * - Conflict resolution: latest timestamp wins
 * - Multi-user isolation: keys isolated by authenticated userId
 * - Honest error reporting and offline fallbacks
 *
 * ## Uploads are opt-in
 *
 * Downloading an account's own data to the device is unconditional: it is the
 * point of having an account, and it cannot expose anything the signed-in user
 * cannot already read.
 *
 * Uploading is not. Everything this app holds locally was collected while the
 * user had no account, so sending it to a server is a decision only they can
 * make. `syncAll` therefore performs **download-only** work unless the caller
 * explicitly passes `uploadLocalData: true`, and it never deletes local records
 * in any case — a failed or declined upload leaves the device exactly as it was.
 *
 * ## A published status means the attempt has finished
 *
 * `syncAll` awaits *every* step before it reports anything. A caller that reads
 * `synced` knows all consented steps completed; a caller that reads `error`
 * knows how many did not, and can safely retry without racing writes that were
 * still in flight. Nothing is reported mid-attempt.
 *
 * ## An upload is confirmed by reading it back
 *
 * A step that reports success has not merely been accepted by the server: after
 * every upload this module asks the database again, in a separate `SELECT`
 * through the user's own authenticated access, and compares what is stored with
 * what was sent. An upsert that reported no error while storing nothing — a
 * policy that silently matched no row, a conflict target that matched no
 * constraint — is therefore a failure, not a success. The comparison rules live
 * in `readBack.ts`, which also explains why server-owned timestamps are excluded.
 *
 * ## Every request is bounded and cancellable
 *
 * Each request runs under a deadline and under an optional caller-supplied
 * `AbortSignal`, and the deadline aborts the HTTP request through the transport
 * rather than merely abandoning the promise. A cancelled attempt publishes no
 * status at all, so a dismissed migration cannot reappear as a failure banner.
 * `SyncManager.request` documents what aborting cannot promise.
 */

import type { ThemeMode } from '../app/preferences';
import { DEFAULT_PREFERENCES, parsePreferences } from '../app/preferences';
import { defaultHandConfig, type OledProfile } from '../oled/profiles';
import type { CalibrationProfile } from '../sensors/calibration';
import type { Storage } from '../storage';
import { featureKeys } from '../storage';
import { getSupabaseClient } from './client';
import {
  describeReadBackFailure,
  verifyCalibration,
  verifyHistory,
  verifyOledProfiles,
  verifyPreferences,
  type ReadBackOutcome,
  type StoredRow,
} from './readBack';
import type { Json, SyncState, SyncStatus } from './types';

/**
 * How long one database request may take before it is abandoned.
 *
 * Applied per request rather than per migration: a migration is a sequence of
 * requests, and a single stalled one should not consume the whole budget for the
 * ones behind it. Twenty seconds is long enough for a slow mobile connection to
 * deliver a calibration payload and short enough that a user is not left looking
 * at a spinner wondering whether the app has died.
 */
export const SYNC_REQUEST_TIMEOUT_MS = 20_000;

/**
 * A request that exceeded its deadline.
 *
 * A distinct type because "too slow" and "refused" need different sentences and
 * different advice: one is worth retrying where the connection is better, the
 * other is not worth retrying at all.
 */
export class SyncTimeoutError extends Error {
  constructor(what: string, ms: number) {
    /*
     * Sub-second deadlines are reported in milliseconds. The production deadline
     * is twenty seconds, but tests use a few milliseconds to observe the
     * behaviour at all, and "did not finish within 0 seconds" is a sentence that
     * tells nobody anything.
     */
    const limit = ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} milliseconds`;
    super(`${what} did not finish within ${limit}, so it was stopped.`);
    this.name = 'SyncTimeoutError';
  }
}

/**
 * The whole attempt was cancelled by whoever started it.
 *
 * Thrown rather than returned so that it unwinds through the same path as any
 * other failure, but recognised separately at the top so a cancelled attempt
 * publishes no status at all — the caller has already moved on, and an error
 * banner arriving afterwards is exactly the resurrection this is meant to stop.
 */
export class SyncCancelledError extends Error {
  constructor() {
    super('The sync was cancelled.');
    this.name = 'SyncCancelledError';
  }
}

/**
 * A kind of local record that can be migrated to an account.
 *
 * Named from the user's point of view, not the schema's, because these names
 * reach the consent screen: the user is agreeing to "your saved settings", not
 * to a row in `user_preferences`.
 */
export type MigratableScope =
  | 'preferences'
  | 'calibration'
  | 'oled_profiles'
  | 'glove_history';

export const ALL_MIGRATABLE_SCOPES: readonly MigratableScope[] = [
  'preferences',
  'calibration',
  'oled_profiles',
  'glove_history',
];

/**
 * Whether a value is one of the scopes this build actually implements.
 *
 * The canonical check, kept next to the list it validates so the two cannot
 * drift apart. It exists for the one input that is genuinely untrusted: a scope
 * list read back from storage. A name that this build does not know is not
 * "extra consent", it is a record from some other version of the app — and the
 * only safe reading of it is no reading at all.
 */
export function isMigratableScope(value: unknown): value is MigratableScope {
  return (
    typeof value === 'string' && (ALL_MIGRATABLE_SCOPES as readonly string[]).includes(value)
  );
}

export interface SyncOptions {
  /**
   * Whether local records may be written to the server.
   *
   * Defaults to `false`, which is the safe answer rather than the convenient
   * one. Uploading happens only when a caller passes `true` after the user has
   * agreed to it.
   */
  readonly uploadLocalData?: boolean;
  /**
   * Which record kinds may be uploaded. Ignored entirely when
   * `uploadLocalData` is false. Defaults to every scope, so a caller that has
   * consent for "the migration" need not enumerate them.
   */
  readonly scopes?: readonly MigratableScope[];
  /**
   * Cancels the attempt, including any request currently in flight.
   *
   * A caller that has navigated away or started a newer attempt passes a signal
   * it can abort, so that work nobody is waiting for stops — rather than running
   * to completion and delivering its result to a screen that has moved on.
   *
   * The transport is genuinely aborted: `postgrest-js` carries this signal into
   * `fetch`, so the HTTP request is cancelled rather than merely ignored. What a
   * client-side abort cannot do is un-execute a statement the server has already
   * run — see the note on `SyncManager.request`.
   */
  readonly signal?: AbortSignal;
  /**
   * Overrides the per-request deadline. Present for tests, which cannot wait
   * twenty seconds to observe a timeout.
   */
  readonly requestTimeoutMs?: number;
}

/**
 * A message worth showing a person.
 *
 * `postgrest-js` throws a `PostgrestError`, which extends `Error`, so the first
 * branch is the one that normally runs. The second exists because a transport or
 * proxy failure can surface as a bare object, and `String({ message })` renders
 * as `"[object Object]"` — which would tell the user nothing about their data at
 * exactly the moment they most need to know whether it is safe.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** One part of a migration that did not arrive, and why. */
interface StepFailure {
  /** Named in the user's terms, because this string reaches the screen. */
  readonly label: string;
  readonly reason: unknown;
  /**
   * Whether this step was one the user agreed to upload.
   *
   * A step that was not consented to still runs — it downloads — so it can still
   * fail. Those failures are reported, but they are not counted against the
   * number of parts the user agreed to send, because "2 of 1 agreed parts failed"
   * is not a sentence that means anything.
   */
  readonly consented: boolean;
}

/**
 * Reports what did not upload, and why, without overstating it.
 *
 * The difference between two parts failing and all five failing is the
 * difference between a retry worth attempting and a connection that is simply
 * down, so the count is stated rather than collapsed into "sync failed". The
 * reasons are de-duplicated because five steps failing for one dropped
 * connection is one fact, not five.
 *
 * The denominator is the number of steps the user *agreed to*, not the number
 * of steps that exist. Someone who agreed to move one kind of record and watched
 * it fail should read "1 of 1 part", not "1 of 5 parts" — the latter would imply
 * four other failures or four other permissions that were never in play. When
 * only non-consented (download) steps failed there is no meaningful ratio at
 * all, so none is given.
 */
function describeStepFailures(
  failures: readonly StepFailure[],
  consentedStepCount: number,
): string {
  const agreed = failures.filter((failure) => failure.consented);
  const reported = agreed.length > 0 ? agreed : failures;
  const labels = reported.map((failure) => failure.label);
  const reasons = [...new Set(reported.map((failure) => errorMessage(failure.reason)))];
  const detail = `(${labels.join(', ')}): ${reasons.join('; ')}`;

  if (agreed.length === 0 || consentedStepCount === 0) {
    return `The sync did not finish ${detail}`;
  }

  const noun = consentedStepCount === 1 ? 'part' : 'parts';
  return `${agreed.length} of ${consentedStepCount} ${noun} did not upload ${detail}`;
}

export class SyncManager {
  private status: SyncStatus = 'idle';
  private lastSyncedAtMs: number | null = null;
  private lastError: string | null = null;
  private syncListeners: ((state: SyncState) => void)[] = [];

  /**
   * Which attempt is allowed to publish, counted up by one per `syncAll`.
   *
   * ## Why the manager has to keep this, and the screen cannot
   *
   * The account sheet already ignores a stale *handler* (`attemptRef`), which
   * stops an old callback from writing screen state. It does not stop this
   * object: `syncAll` publishes to `this.status` and to every subscriber, and a
   * superseded attempt that was slow — a hung request waiting out its deadline,
   * for instance — would finish afterwards and publish its own conclusion over
   * the newer attempt's, putting an error banner on a screen whose latest sync
   * succeeded, or "Last synced" on one that just failed.
   *
   * The guard is deliberately the *smallest* one that removes the wrong answer:
   * a superseded attempt is silent, not cancelled. Aborting it would be stronger
   * still, but every caller here is the same screen, and one of those calls is a
   * consented upload. A background double-tap aborting a migration the user just
   * agreed to — and reporting it as a failure — would trade a wrong status for a
   * lost upload. Its writes are idempotent upserts against real conflict keys,
   * so an attempt that finishes silently after losing the race leaves the stored
   * rows correct; what it must not do is speak.
   */
  private publishSeq = 0;

  public getState(): SyncState {
    return {
      status: this.status,
      lastSyncedAtMs: this.lastSyncedAtMs,
      pendingChangesCount: 0,
      lastError: this.lastError,
    };
  }

  public subscribe(listener: (state: SyncState) => void): () => void {
    this.syncListeners.push(listener);
    listener(this.getState());
    return () => {
      this.syncListeners = this.syncListeners.filter((l) => l !== listener);
    };
  }

  private setStatus(status: SyncStatus, error: string | null = null) {
    this.status = status;
    this.lastError = error;
    if (status === 'synced') {
      this.lastSyncedAtMs = Date.now();
    }
    const state = this.getState();
    for (const listener of this.syncListeners) {
      listener(state);
    }
  }

  /**
   * Puts back a state captured before an attempt, without the side effects of
   * `setStatus`.
   *
   * Used only when an attempt is cancelled. Calling `setStatus('synced')` to
   * restore a previous success would stamp `lastSyncedAtMs` with the current
   * time, claiming a sync happened that did not — so the fields are assigned
   * directly instead.
   */
  private restore(state: SyncState): void {
    this.status = state.status;
    this.lastSyncedAtMs = state.lastSyncedAtMs;
    this.lastError = state.lastError;
    const next = this.getState();
    for (const listener of this.syncListeners) {
      listener(next);
    }
  }

  /**
   * User-isolated storage keys to prevent data leakage across account switches.
   */
  public getUserKey(userId: string, subKey: string): string {
    return `sv/v1/u/${userId}/${subKey}`;
  }

  /**
   * Runs one database request under a deadline, and under the attempt's signal.
   *
   * ## Why the deadline aborts rather than races
   *
   * The tempting implementation is `Promise.race([request, sleep(ms)])`: the
   * caller stops waiting, reports a timeout, and the write it was waiting for
   * carries on invisibly. That is worse than no timeout at all — the user is told
   * the upload failed while it is still happening, so a retry races the first
   * attempt and the reported outcome describes neither.
   *
   * Here the deadline fires an `AbortController` that `postgrest-js` carries into
   * `fetch`, so the request is genuinely cancelled. The `finally` clears the timer
   * and removes the outer listener on every path, including the throwing ones, so
   * an abandoned attempt leaves nothing scheduled behind it.
   *
   * ## What cancelling cannot promise
   *
   * Aborting the client's request does not reach back into the database. If the
   * statement had already been executed when the abort arrived, the row is
   * written and this call will never know. That is a real limitation of the
   * transport and not something this code can fix. It is survivable because every
   * write here is an idempotent upsert against a real conflict key, so a repeated
   * attempt converges on the same row instead of accumulating duplicates — and
   * because the read-back that follows an upload is what establishes whether the
   * data is actually there, rather than the absence of an error.
   */
  private async request<T>(
    what: string,
    timeoutMs: number,
    outer: AbortSignal | undefined,
    build: (signal: AbortSignal) => PromiseLike<{ data: T; error: unknown }>,
  ): Promise<T> {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();

    if (outer) {
      if (outer.aborted) throw new SyncCancelledError();
      outer.addEventListener('abort', onOuterAbort);
    }

    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, timeoutMs);

    try {
      const { data, error } = await build(controller.signal);
      if (error) throw error;
      return data;
    } catch (error) {
      /*
       * Ordered by cause rather than by error type. An abort surfaces as an
       * `AbortError`, which says nothing about *why* it was aborted; whether the
       * deadline expired or the caller walked away is known only here.
       */
      if (expired) throw new SyncTimeoutError(what, timeoutMs);
      if (outer?.aborted) throw new SyncCancelledError();
      throw error;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * Confirms an upload landed, by asking the database a second time.
   *
   * A separate request, never the rows an upsert returned. Those describe what
   * the write *intended* and are produced by the same statement whose success is
   * in question; a fresh `SELECT` is the only thing that answers "is this
   * actually stored", and it answers it through the same authenticated access
   * the user has, so a row it cannot see is reported rather than assumed.
   *
   * A read failure is re-raised as a message that names the cause — a permission
   * refusal is not a network problem and must not read like one.
   */
  private async verifyUpload(
    what: string,
    timeoutMs: number,
    outer: AbortSignal | undefined,
    readRows: (signal: AbortSignal) => PromiseLike<{ data: StoredRow[] | null; error: unknown }>,
    verify: (rows: StoredRow[]) => ReadBackOutcome,
  ): Promise<void> {
    let rows: StoredRow[] | null;
    try {
      rows = await this.request<StoredRow[] | null>(what, timeoutMs, outer, readRows);
    } catch (error) {
      if (error instanceof SyncTimeoutError || error instanceof SyncCancelledError) throw error;
      throw new Error(describeReadBackFailure(error));
    }

    const outcome = verify(rows ?? []);
    if (!outcome.ok) throw new Error(outcome.problem);
  }

  /**
   * Performs a full synchronization cycle for the currently signed-in user.
   *
   * Download-only unless `options.uploadLocalData` is true. Nothing is ever
   * deleted locally, so a failed or refused upload costs the user nothing.
   */
  public async syncAll(
    userId: string,
    local: Storage,
    options: SyncOptions = {},
  ): Promise<SyncState> {
    const client = getSupabaseClient();
    if (!client) {
      this.setStatus('offline', 'Supabase is not configured.');
      return this.getState();
    }

    /*
     * Resolved once, here, so that no individual step can decide for itself
     * that an upload is convenient. `scopes` can only narrow this.
     *
     * A name this build does not implement is dropped before anything is
     * decided. This is the one input that can be wrong — it may have been
     * persisted by a different version of the app — and the failure mode to
     * avoid is reading an unrecognised name as permission for whatever the
     * caller meant by it. Dropping it means an unknown scope can only ever
     * narrow what is uploaded, never widen it.
     */
    const scopes = (options.scopes ?? ALL_MIGRATABLE_SCOPES).filter(isMigratableScope);
    const mayUpload = (scope: MigratableScope): boolean =>
      options.uploadLocalData === true && scopes.includes(scope);

    const signal = options.signal;
    const timeoutMs = options.requestTimeoutMs ?? SYNC_REQUEST_TIMEOUT_MS;

    // This attempt's claim on the status. Taken before anything is published, so
    // a later `syncAll` supersedes it from the moment it starts rather than from
    // the moment it finishes.
    const attempt = ++this.publishSeq;

    // Captured before the attempt replaces it, so a cancelled attempt can put
    // the previous answer back rather than leaving the screen reporting a sync
    // that is not happening.
    const before = this.getState();

    this.setStatus('syncing');

    /*
     * Labelled so a partial failure can name the parts that did not arrive.
     * The labels reach the user, so they are written in their terms rather than
     * as the names of the steps below. Each step also carries the scope that
     * governs it, so a failure can be attributed to something the user actually
     * agreed to — which is what the reported count is measured against.
     */
    const steps: {
      readonly label: string;
      readonly scope: MigratableScope;
      readonly run: Promise<void>;
    }[] = [
      {
        label: 'your saved settings',
        scope: 'preferences',
        run: this.syncPreferences(userId, local, mayUpload('preferences'), signal, timeoutMs),
      },
      {
        label: 'the left glove calibration',
        scope: 'calibration',
        run: this.syncCalibration(userId, local, 'left', mayUpload('calibration'), signal, timeoutMs),
      },
      {
        label: 'the right glove calibration',
        scope: 'calibration',
        run: this.syncCalibration(userId, local, 'right', mayUpload('calibration'), signal, timeoutMs),
      },
      {
        label: 'your OLED profiles',
        scope: 'oled_profiles',
        run: this.syncOledProfiles(userId, local, mayUpload('oled_profiles'), signal, timeoutMs),
      },
      {
        label: 'your glove history',
        scope: 'glove_history',
        run: this.syncHistory(userId, local, mayUpload('glove_history'), signal, timeoutMs),
      },
    ];

    /*
     * What the user agreed to, as a number to report against.
     *
     * Counted from the steps rather than from `scopes.length`, because one scope
     * can be several steps: calibration is a left step and a right step, so a
     * user who agreed to "my calibrations" and lost one would otherwise be told
     * "1 of 1" while one of their two calibrations was missing.
     */
    const consentedStepCount = steps.filter((step) => mayUpload(step.scope)).length;

    /*
     * `allSettled`, deliberately not `all`.
     *
     * `Promise.all` rejects on the first failure, which published an error — and
     * with it a retry button — while four other writes from the same attempt
     * were still in the air. Pressing retry then raced the attempt being
     * retried. Awaiting every step to a conclusion means that by the time any
     * status is published, nothing from this attempt is still running, so the
     * count of what failed is a fact rather than a guess.
     *
     * This is also what makes the later status trustworthy: a caller that sees
     * `synced` from this method knows every consented step has finished, not
     * merely that none has failed *yet*.
     */
    const settled = await Promise.allSettled(steps.map((step) => step.run));

    /*
     * A superseded attempt says nothing at all.
     *
     * Everything below this line is a conclusion about the world as it was when
     * this attempt started. If a newer `syncAll` has begun since, that
     * conclusion is about a state of affairs that has already been replaced, and
     * publishing it — a failure, a success, or "Last synced: now" — would answer
     * a question the user is no longer asking. Both publish points below are
     * behind this return, including the cancellation restore: the newer attempt
     * owns the status now.
     *
     * The state returned is the current one rather than this attempt's, for the
     * same reason `restore` exists: a caller reading it must see what is true,
     * not what this attempt would have liked to report.
     */
    if (attempt !== this.publishSeq) {
      return this.getState();
    }

    /*
     * A cancelled attempt publishes nothing at all.
     *
     * This is the second half of the cancellation contract, and the half that is
     * easy to miss. Aborting the transport stops the work, but the steps that
     * were already in flight still settle — into rejections — and reporting them
     * would put an error banner on a screen the user has left, or overwrite the
     * result of the newer attempt that replaced this one. The caller signals
     * cancellation precisely because it no longer wants this attempt's outcome,
     * so the outcome is discarded rather than published.
     *
     * `syncAll` returning the *unchanged* state is deliberate: a caller that
     * reads it sees the previous attempt's answer, not a fabricated success.
     */
    const cancelled =
      signal?.aborted === true ||
      settled.some(
        (result) => result.status === 'rejected' && result.reason instanceof SyncCancelledError,
      );

    if (cancelled) {
      /*
       * The status the attempt replaced is put back, rather than left as
       * `syncing`. Aborting the transport stops the work but does not itself
       * resolve the status, so without this a cancelled attempt would leave a
       * spinner running forever — trading one stuck screen for another.
       */
      this.restore(before);
      return this.getState();
    }

    const failures: StepFailure[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.push({
          label: steps[index].label,
          reason: result.reason,
          consented: mayUpload(steps[index].scope),
        });
      }
    });

    if (failures.length === 0) {
      this.setStatus('synced');
    } else {
      this.setStatus('error', describeStepFailures(failures, consentedStepCount));
    }

    return this.getState();
  }

  /**
   * Syncs user preferences and theme.
   *
   * `allowUpload` gates the local→remote write only. The remote→local merge is
   * not gated: it reveals nothing to the server and is what makes an account's
   * settings appear on a second device.
   *
   * The upload ends with a read-back, so the step succeeds only when the row is
   * demonstrably stored — see `verifyUpload`.
   */
  public async syncPreferences(
    userId: string,
    local: Storage,
    allowUpload: boolean,
    signal?: AbortSignal,
    timeoutMs: number = SYNC_REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;

    // 1. Fetch remote preferences
    const remote = await this.request<Record<string, unknown> | null>(
      'Reading your saved settings',
      timeoutMs,
      signal,
      (s) =>
        client
          .from('user_preferences')
          .select('*')
          .eq('user_id', userId)
          .abortSignal(s)
          .maybeSingle(),
    );

    const localPrefs = (await local.getPreferences()) || DEFAULT_PREFERENCES;
    const localTheme = (await local.getThemeMode()) || 'system';

    if (!remote) {
      if (!allowUpload) return;

      /*
       * The conflict target is the primary key, stated rather than inferred.
       *
       * Leaving it out works today because `user_id` is the whole key, but it
       * would stop working the moment a second column joined it — and the failure
       * would be a silent second row rather than an error.
       */
      const row = {
        user_id: userId,
        sign_profile_id: localPrefs.signProfileId,
        target_language_code: localPrefs.targetLanguageCode,
        voice_enabled: localPrefs.voiceEnabled,
        theme_mode: localTheme,
      };

      await this.request('Saving your settings', timeoutMs, signal, (s) =>
        client.from('user_preferences').upsert(row, { onConflict: 'user_id' }).abortSignal(s),
      );

      /*
       * Ask again, in a request of its own.
       *
       * `updated_at` is neither sent nor compared. It is a server-owned
       * `TIMESTAMPTZ` with a default, and the previous revision filled it with a
       * value taken from the *device* clock — so a phone set to the wrong date
       * wrote that date into the column that describes when the row last changed,
       * and the read-back would then have been comparing the client's invention
       * to itself. Nothing here resolves a conflict by that column, so leaving it
       * to the server costs nothing and stops a wrong clock becoming a wrong
       * record.
       */
      await this.verifyUpload(
        'Reading your saved settings back',
        timeoutMs,
        signal,
        (s) => client.from('user_preferences').select('*').eq('user_id', userId).abortSignal(s),
        (rows) => verifyPreferences(userId, row, rows),
      );
    } else {
      // Merge preferences: update local with remote
      const mergedPrefs = parsePreferences({
        signProfileId: remote.sign_profile_id,
        targetLanguageCode: remote.target_language_code,
        voiceEnabled: remote.voice_enabled,
      });
      await local.setPreferences(mergedPrefs);
      if (typeof remote.theme_mode === 'string') {
        await local.setThemeMode(remote.theme_mode as ThemeMode);
      }
    }
  }

  /**
   * Syncs calibration profile for one side.
   *
   * Conflict resolution is unchanged — the newer `captured_at_ms` wins — and the
   * upload is confirmed by reading the row back, so a calibration is only
   * reported as moved when it can be read from the server afterwards.
   */
  public async syncCalibration(
    userId: string,
    local: Storage,
    side: 'left' | 'right',
    allowUpload: boolean,
    signal?: AbortSignal,
    timeoutMs: number = SYNC_REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;

    const localCal = await local.getCalibration(side);

    /*
     * `maybeSingle` rather than a list, because this is the conflict-resolution
     * read: it wants *the* row for this side, and a second one would mean the
     * unique constraint `(user_id, side)` is not doing its job. That case
     * surfaces as an error here instead of quietly picking the first.
     */
    const remote = await this.request<Record<string, unknown> | null>(
      `Reading the ${side} glove calibration`,
      timeoutMs,
      signal,
      (s) =>
        client
          .from('calibration_profiles')
          .select('*')
          .eq('user_id', userId)
          .eq('side', side)
          .abortSignal(s)
          .maybeSingle(),
    );

    if (localCal && (!remote || localCal.capturedAtMs > Number(remote.captured_at_ms))) {
      if (!allowUpload) return;

      // Local is newer: upload to remote
      const row = {
        user_id: userId,
        side,
        captured_at_ms: localCal.capturedAtMs,
        sign_language_id: localCal.signLanguageId,
        channels: localCal.channels as unknown as Json,
      };

      await this.request(`Saving the ${side} glove calibration`, timeoutMs, signal, (s) =>
        client
          .from('calibration_profiles')
          .upsert(row, { onConflict: 'user_id, side' })
          .abortSignal(s),
      );

      await this.verifyUpload(
        `Reading the ${side} glove calibration back`,
        timeoutMs,
        signal,
        (s) =>
          client
            .from('calibration_profiles')
            .select('*')
            .eq('user_id', userId)
            .eq('side', side)
            .abortSignal(s),
        (rows) => verifyCalibration(userId, row, rows),
      );
    } else if (remote && (!localCal || Number(remote.captured_at_ms) > localCal.capturedAtMs)) {
      // Remote is newer: save to local
      const downloaded: CalibrationProfile = {
        version: 1,
        side,
        capturedAtMs: Number(remote.captured_at_ms),
        signLanguageId: String(remote.sign_language_id ?? ''),
        channels: remote.channels as unknown as CalibrationProfile['channels'],
      };
      await local.setCalibration(downloaded);
    }
  }

  /**
   * Syncs OLED profiles between local storage and cloud.
   */
  public async syncOledProfiles(
    userId: string,
    local: Storage,
    allowUpload: boolean,
    signal?: AbortSignal,
    timeoutMs: number = SYNC_REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;

    // Local OLED state lives under `featureKeys.oledProfiles` — read and written
    // by that name, never by a repeated literal, so the two cannot disagree.
    const localState = await local.getJson<{
      profiles: OledProfile[];
      activeProfileId: string;
    }>(featureKeys.oledProfiles);

    const remotes = await this.request<Record<string, unknown>[] | null>(
      'Reading your OLED profiles',
      timeoutMs,
      signal,
      (s) => client.from('oled_profiles').select('*').eq('user_id', userId).abortSignal(s),
    );

    if (allowUpload && localState?.profiles && localState.profiles.length > 0) {
      /*
       * Upsert each local profile.
       *
       * The column names, the conflict target and the value types all have to
       * match the table exactly, and previously none of the three did — this
       * wrote `id`, `left_preset` and `right_preset` into a table keyed on
       * `(user_id, profile_id)` with `left_config`/`right_config`, and passed
       * a JSON string where the column is JSONB, so every save was a
       * double-encoded string inside an object.
       *
       * The conflict target is `user_id, profile_id`, matching the primary key.
       * It is deliberately *not* the profile's name: renaming a profile must
       * update the existing row, not create a second one beside it.
       *
       * One profile per call rather than a single bulk upsert, so that a row
       * rejected by a policy aborts with a message naming that row instead of
       * failing the whole batch opaquely.
       */
      const sent = localState.profiles.map((p) => ({
        user_id: userId,
        profile_id: p.id,
        name: p.name,
        created_at_ms: p.createdAtMs,
        updated_at_ms: p.updatedAtMs,
        // Objects, not `JSON.stringify` of them: these columns are JSONB.
        left_config: p.left as unknown as Json,
        right_config: p.right as unknown as Json,
      }));

      for (const row of sent) {
        await this.request(`Saving the OLED profile "${row.name}"`, timeoutMs, signal, (s) =>
          client
            .from('oled_profiles')
            .upsert(row, { onConflict: 'user_id, profile_id' })
            .abortSignal(s),
        );
      }

      /*
       * One read-back for the whole set.
       *
       * Every uploaded profile is checked in a single extra request rather than
       * one request each, and the check is all-or-nothing: "most of your
       * profiles are backed up" is not a state the user agreed to and not one
       * they can act on, so a single missing or altered profile fails the step
       * and the message names it.
       */
      await this.verifyUpload(
        'Reading your OLED profiles back',
        timeoutMs,
        signal,
        (s) => client.from('oled_profiles').select('*').eq('user_id', userId).abortSignal(s),
        (rows) => verifyOledProfiles(userId, sent, rows),
      );
    }

    // If remote has profiles not present locally, incorporate them.
    if (remotes && remotes.length > 0 && localState) {
      const localIds = new Set(localState.profiles.map((p) => p.id));
      const missing = remotes
        .filter((r) => typeof r.profile_id === 'string' && !localIds.has(r.profile_id))
        .map(
          (r): OledProfile => ({
            id: String(r.profile_id),
            name: String(r.name),
            /*
             * The real timestamps, read from the row.
             *
             * This used to substitute `Date.now()` for both, which quietly
             * rewrote the age of every profile pulled from another device — and
             * since conflict resolution is "latest timestamp wins", it made
             * every downloaded profile look newer than the local one it had
             * just been merged with.
             */
            createdAtMs: Number(r.created_at_ms),
            updatedAtMs: Number(r.updated_at_ms),
            left: (r.left_config ?? defaultHandConfig()) as OledProfile['left'],
            right: (r.right_config ?? defaultHandConfig()) as OledProfile['right'],
          }),
        );

      if (missing.length > 0) {
        /*
         * Written under the same key this method reads, by name rather than by
         * repeating the string.
         *
         * The literal used to be spelled out here while the read above used
         * `featureKeys.oledProfiles`. They happened to be equal, so nothing
         * failed — and that is the whole problem: the day the key is renamed, the
         * read follows it and the write does not, so a profile merged in from
         * another device would be written to a key the app never reads. It would
         * not error. It would just not be there.
         */
        await local.setJson(featureKeys.oledProfiles, {
          ...localState,
          profiles: [...localState.profiles, ...missing],
        });
      }
    }
  }

  /**
   * Syncs user recognition history.
   *
   * Upload-only, so `allowUpload` is the whole decision. Note that history is
   * filtered twice: only entries whose `source` is `'glove'` are candidates at
   * all, because history that silently mixes measured and simulated text is
   * worse than no history.
   */
  public async syncHistory(
    userId: string,
    local: Storage,
    allowUpload: boolean,
    signal?: AbortSignal,
    timeoutMs: number = SYNC_REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    if (!allowUpload) return;

    const client = getSupabaseClient();
    if (!client) return;

    const history = await local.getHistory();
    if (!history || history.length === 0) return;

    // Only upload entries from real glove reading
    const gloveEntries = history.filter((h) => h.source === 'glove');
    if (gloveEntries.length === 0) return;

    const sent = gloveEntries.map((entry) => ({
      user_id: userId,
      entry_id: entry.id,
      text: entry.text,
      profile_id: entry.profileId,
      // The column has a CHECK constraint of its own, so the value is sent as
      // read rather than narrowed here — a source this build does not recognise
      // should be refused loudly, not silently rewritten to `'glove'`.
      source: entry.source,
      created_at_ms: entry.createdAtMs,
    }));

    for (const row of sent) {
      await this.request('Saving a history entry', timeoutMs, signal, (s) =>
        client
          .from('user_history')
          .upsert(row, { onConflict: 'user_id, entry_id' })
          .abortSignal(s),
      );
    }

    /*
     * Read the whole history back in one request and check every uploaded entry.
     *
     * The conflict key is `(user_id, entry_id)`, so a resumed migration re-sends
     * entries that already exist and updates them in place. The read-back is what
     * distinguishes that from the failure it resembles: if the key were wrong,
     * this same loop would have created duplicates instead, and the count would
     * still have matched.
     */
    await this.verifyUpload(
      'Reading your history back',
      timeoutMs,
      signal,
      (s) => client.from('user_history').select('*').eq('user_id', userId).abortSignal(s),
      (rows) => verifyHistory(userId, sent, rows),
    );
  }
}

export const syncManager = new SyncManager();
