/**
 * Guest-data migration: what there is, and whether the user agreed to move it.
 *
 * Two responsibilities, deliberately kept apart from the sync engine:
 *
 * 1. **Describing the offer.** `summariseGuestData` answers "which of this
 *    person's local records would an account actually take?" by reading local
 *    storage directly. The consent screen is built from this rather than from a
 *    hardcoded list, so the screen cannot promise to move something the sync
 *    engine would ignore, or omit something it would take.
 *
 * 2. **Remembering the answer.** `readMigrationDecision` / `recordMigrationDecision`
 *    persist a per-user yes-or-no so that a decision is asked for once and then
 *    respected — including a *no*, which must not be quietly reversed on the
 *    next sign-in.
 *
 * Nothing here performs I/O against a network. Every function reads or writes
 * local storage only, which is what lets the whole consent path be tested
 * without a server.
 */
import type { OledProfile } from '../oled/profiles';
import type { Storage } from '../storage';
import { featureKeys } from '../storage';
import { isMigratableScope, type MigratableScope } from './sync';

/** One local record kind, counted as a person would describe it. */
export interface GuestDataSummary {
  /** Saved preferences and theme choice. */
  readonly hasPreferences: boolean;
  /** Which calibration captures exist locally. */
  readonly calibrationSides: readonly ('left' | 'right')[];
  /** How many OLED studio profiles exist locally. */
  readonly oledProfileCount: number;
  /** History entries from a real glove — the only ones eligible to migrate. */
  readonly gloveHistoryCount: number;
  /**
   * History entries recorded from simulated data.
   *
   * Reported because it is the part of history that is *not* eligible, and a
   * consent screen that listed "your history" without this distinction would be
   * overstating what it is about to do.
   */
  readonly demoHistoryCount: number;
}

export interface MigrationDecision {
  readonly accepted: boolean;
  /** What was agreed to. Empty when declined. */
  readonly scopes: readonly MigratableScope[];
  readonly decidedAtMs: number;
}

/**
 * Consent is remembered per account.
 *
 * Per account, not per device: declining for one account says nothing about
 * whether a different person signing in on the same phone wants their own data
 * uploaded, and a shared device must not let the first answer speak for the
 * second user.
 */
export function migrationConsentKey(userId: string): string {
  return `sv/v1/guest-migration-consent/${userId}`;
}

/** Reads exactly what is on the device, without sending any of it anywhere. */
export async function summariseGuestData(local: Storage): Promise<GuestDataSummary> {
  const [preferences, theme, left, right, history, oledState] = await Promise.all([
    local.getPreferences(),
    local.getThemeMode(),
    local.getCalibration('left'),
    local.getCalibration('right'),
    local.getHistory(),
    local.getJson<{ profiles?: OledProfile[] }>(featureKeys.oledProfiles),
  ]);

  const calibrationSides: ('left' | 'right')[] = [];
  if (left) calibrationSides.push('left');
  if (right) calibrationSides.push('right');

  const entries = history ?? [];
  const gloveHistoryCount = entries.filter((h) => h.source === 'glove').length;
  const demoHistoryCount = entries.length - gloveHistoryCount;

  return {
    hasPreferences: preferences !== null || theme !== null,
    calibrationSides,
    oledProfileCount: oledState?.profiles?.length ?? 0,
    gloveHistoryCount,
    demoHistoryCount,
  };
}

/**
 * Whether there is anything worth asking about.
 *
 * Deliberately excludes `demoHistoryCount`: simulated entries are never
 * uploaded, so their presence must not trigger a consent prompt about data that
 * would not move.
 */
export function hasMigratableData(summary: GuestDataSummary): boolean {
  return (
    summary.hasPreferences ||
    summary.calibrationSides.length > 0 ||
    summary.oledProfileCount > 0 ||
    summary.gloveHistoryCount > 0
  );
}

/** The scopes that actually have data behind them, for an honest scope list. */
export function migratableScopesFor(summary: GuestDataSummary): MigratableScope[] {
  const scopes: MigratableScope[] = [];
  if (summary.hasPreferences) scopes.push('preferences');
  if (summary.calibrationSides.length > 0) scopes.push('calibration');
  if (summary.oledProfileCount > 0) scopes.push('oled_profiles');
  if (summary.gloveHistoryCount > 0) scopes.push('glove_history');
  return scopes;
}

/**
 * The recorded answer, or `null` if this account has never been asked.
 *
 * A malformed or partial record is treated as absent rather than guessed at:
 * re-asking is a small cost, and treating unreadable bytes as consent is not.
 *
 * The scope list is validated against the names this build implements, not
 * merely against "is a string". An acceptance that names a scope this build does
 * not know — a record written by a different version, or a corrupted value — is
 * discarded entirely rather than partially honoured, for two reasons:
 *
 *   - Honouring the recognised subset would let a later "synced" status stand in
 *     for a migration the user agreed to and which did not fully happen.
 *   - Falling back to "all scopes" here would be worse still: it would turn an
 *     unreadable record into a decision to upload *more* than was ever agreed to.
 *
 * Discarding the record sends the user back to the consent step, where the
 * question is asked again from what is actually on the device. That is the only
 * outcome in which nothing is uploaded that was not explicitly agreed to.
 *
 * A refusal needs no scopes and is returned as recorded.
 */
export async function readMigrationDecision(
  local: Storage,
  userId: string,
): Promise<MigrationDecision | null> {
  const raw = await local.getJson<unknown>(migrationConsentKey(userId));
  if (raw === null || typeof raw !== 'object') return null;

  const candidate = raw as Partial<MigrationDecision>;
  if (typeof candidate.accepted !== 'boolean') return null;

  const decidedAtMs =
    typeof candidate.decidedAtMs === 'number' ? candidate.decidedAtMs : Date.now();

  // A refusal carries no permissions, whatever else the record happens to say.
  if (candidate.accepted === false) {
    return { accepted: false, scopes: [], decidedAtMs };
  }

  if (!Array.isArray(candidate.scopes)) return null;

  const scopes: MigratableScope[] = [];
  for (const entry of candidate.scopes) {
    if (!isMigratableScope(entry)) return null;
    if (!scopes.includes(entry)) scopes.push(entry);
  }

  // An acceptance naming nothing is not an acceptance of nothing to upload: it
  // is a record that cannot be read as a decision, so it is not one.
  if (scopes.length === 0) return null;

  return { accepted: true, scopes, decidedAtMs };
}

/** Records the answer before any upload is attempted, so a failure cannot lose it. */
export async function recordMigrationDecision(
  local: Storage,
  userId: string,
  accepted: boolean,
  scopes: readonly MigratableScope[],
): Promise<void> {
  const decision: MigrationDecision = {
    accepted,
    scopes: accepted ? [...scopes] : [],
    decidedAtMs: Date.now(),
  };
  await local.setJson(migrationConsentKey(userId), decision);
}

/** Un-asks, so the offer is made again. Used by tests and by any future reset. */
export async function clearMigrationDecision(
  local: Storage,
  userId: string,
): Promise<void> {
  await local.removeKey(migrationConsentKey(userId));
}
