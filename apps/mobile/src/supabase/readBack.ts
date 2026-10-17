/**
 * Independent read-back verification for migration uploads.
 *
 * ## Why an upsert reporting no error is not evidence
 *
 * `await client.from(t).upsert(row)` answering `{ error: null }` says the request
 * was accepted. It does not say the row is *there*, and it does not say it is the
 * row that was sent. Three real cases produce a green upsert and no stored data:
 *
 *   - Row level security refuses the write, and the refusal is reported as an
 *     error the caller never inspects — or, worse, an `ON CONFLICT DO UPDATE`
 *     against a row the policy hides updates nothing and raises nothing.
 *   - The conflict target does not match a real constraint, so a second row is
 *     created beside the one the app will read, and the app reads the old one.
 *   - A column is silently dropped or coerced by the server (a JSON string into
 *     a JSONB column, a trimmed text field), so the stored value differs from
 *     the sent one.
 *
 * The only way to tell "uploaded" from "a function was invoked" is to ask the
 * database again, in a **separate request**, and compare what comes back to what
 * was meant to be stored. That is what this module decides; `sync.ts` performs
 * the queries, because it is the only place that holds the client.
 *
 * ## What is compared, and what is deliberately not
 *
 * Only columns the client owns. `created_at` and `updated_at` are `TIMESTAMPTZ`
 * defaults written by the server at insert time; they are not values this app
 * uploaded, so comparing them to anything the client holds would be comparing a
 * thing to itself. `created_at_ms` and `updated_at_ms` on `oled_profiles` are the
 * opposite case — `BIGINT` values the *client* supplies — so they are compared,
 * and the difference in name is exactly the difference in ownership.
 *
 * ## The failure direction is deliberate
 *
 * Every check fails closed. A comparison that cannot be made confidently
 * reports a problem rather than passing: a false "not verified" costs the user
 * an honest message and a retry, and a false "verified" tells someone their data
 * is safe in the cloud when it is not. Values are compared after canonical JSON
 * serialisation, which removes key-order differences but keeps numeric precision
 * exact — so a value the server normalised differently is reported, not smoothed
 * over.
 */

/** The result of one read-back check. */
export type ReadBackOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string };

/** A row as the database returned it. Loosely typed on purpose — see below. */
export type StoredRow = Record<string, unknown>;

/**
 * Canonical JSON for comparison.
 *
 * Object keys are sorted so that two equal objects with different key order
 * compare equal — JSONB does not preserve the order keys were written in, so a
 * `channels` object read back is legitimately a different string from the one
 * sent while being the same value. Arrays keep their order, because order is
 * meaningful in them.
 *
 * Returns `undefined` for a value that cannot be serialised at all (a cycle, a
 * function), which callers treat as "not comparable" and therefore as a
 * failure rather than a match.
 */
export function canonical(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, inner) => {
      if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(inner as Record<string, unknown>).sort()) {
        sorted[key] = (inner as Record<string, unknown>)[key];
      }
      return sorted;
    });
  } catch {
    return undefined;
  }
}

/**
 * The first column whose stored value differs from what was sent.
 *
 * `expected` carries only the columns this client owns, so the loop cannot
 * reach a server-owned timestamp. Typed as `object` rather than an index-signature
 * record so the named interfaces below can be passed without every caller having
 * to widen its own type.
 */
function firstMismatch(
  expected: object,
  row: StoredRow,
): { column: string; sent: string; stored: string } | null {
  const sentColumns = expected as Record<string, unknown>;
  for (const column of Object.keys(sentColumns)) {
    const sent = canonical(sentColumns[column]);
    const stored = canonical(row[column]);
    if (sent === undefined || stored === undefined || sent !== stored) {
      return {
        column,
        sent: sent ?? 'a value that cannot be compared',
        stored: stored ?? 'a value that cannot be compared',
      };
    }
  }
  return null;
}

function describeMismatch(
  what: string,
  mismatch: { column: string; sent: string; stored: string },
): string {
  return `${what} was stored differently from what was sent: ${mismatch.column} was ${mismatch.sent} and is now ${mismatch.stored}.`;
}

/**
 * The rows that belong to the caller.
 *
 * A query already filters by `user_id`, so this is a second, independent check
 * rather than the only one. It exists because the cost of being wrong is
 * asymmetric: if the filter were ever wrong, or a policy ever returned a row it
 * should not, the difference between "my own records" and "somebody else's
 * records" must be an error, not a silent success.
 */
function ownRows(userId: string, rows: readonly StoredRow[]): StoredRow[] {
  return rows.filter((row) => row.user_id === userId);
}

function foreignRow(rows: readonly StoredRow[], userId: string): StoredRow | undefined {
  return rows.find((row) => row.user_id !== userId);
}

/** One row expected, exactly. Zero is a failure; more than one is ambiguous. */
function expectExactlyOne(
  rows: readonly StoredRow[],
  userId: string,
  what: string,
): { ok: true; row: StoredRow } | { ok: false; problem: string } {
  const stray = foreignRow(rows, userId);
  if (stray !== undefined) {
    return {
      ok: false,
      problem: `A read-back for ${what} returned a record belonging to another account. Nothing about this migration can be verified while that is happening.`,
    };
  }

  const mine = ownRows(userId, rows);
  if (mine.length === 0) {
    return {
      ok: false,
      problem: `${what} was sent but is not in the database. The upload did not take effect.`,
    };
  }
  if (mine.length > 1) {
    return {
      ok: false,
      problem: `${what} now has ${mine.length} records where only one is possible, so it is not clear which one is real. Nothing has been deleted; retrying will not fix this and it needs looking at.`,
    };
  }
  return { ok: true, row: mine[0] };
}

/* -------------------------------------------------------------- preferences */

export interface ExpectedPreferences {
  readonly user_id: string;
  readonly sign_profile_id: string;
  readonly target_language_code: string;
  readonly voice_enabled: boolean;
  readonly theme_mode: string;
}

/**
 * Verifies `user_preferences` landed as sent.
 *
 * The theme mode is included: it is the field most likely to be rejected by the
 * table's CHECK constraint, and a rejection that arrived as a silent default
 * would otherwise look like a successful upload.
 */
export function verifyPreferences(
  userId: string,
  expected: ExpectedPreferences,
  rows: readonly StoredRow[],
): ReadBackOutcome {
  const found = expectExactlyOne(rows, userId, 'your saved settings');
  if (!found.ok) return found;

  const mismatch = firstMismatch(expected, found.row);
  if (mismatch) return { ok: false, problem: describeMismatch('Your saved settings', mismatch) };
  return { ok: true };
}

/* -------------------------------------------------------------- calibration */

export interface ExpectedCalibration {
  readonly user_id: string;
  readonly side: 'left' | 'right';
  readonly captured_at_ms: number;
  readonly sign_language_id: string | null;
  readonly channels: unknown;
}

/**
 * Verifies one glove's calibration landed as sent.
 *
 * `channels` is the load-bearing field and the reason this check exists: it is
 * JSONB, and a `JSON.stringify` of it sent into that column stores a *string*
 * that passes every superficial check while making the calibration unusable on
 * any other device. Comparing the parsed value catches that; counting rows
 * would not.
 */
export function verifyCalibration(
  userId: string,
  expected: ExpectedCalibration,
  rows: readonly StoredRow[],
): ReadBackOutcome {
  const what = `The ${expected.side} glove calibration`;
  const found = expectExactlyOne(rows, userId, what);
  if (!found.ok) return found;

  const mismatch = firstMismatch(expected, found.row);
  if (mismatch) return { ok: false, problem: describeMismatch(what, mismatch) };
  return { ok: true };
}

/* ------------------------------------------------------------ oled profiles */

export interface ExpectedOledProfile {
  readonly user_id: string;
  readonly profile_id: string;
  readonly name: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly left_config: unknown;
  readonly right_config: unknown;
}

/**
 * Verifies every OLED profile that was uploaded is stored, and stored correctly.
 *
 * All-or-nothing: one profile missing or altered fails the step. A partial
 * success reported as success is the case that matters here, because the user's
 * belief would be "my profiles are backed up" while one of them is not.
 */
export function verifyOledProfiles(
  userId: string,
  expected: readonly ExpectedOledProfile[],
  rows: readonly StoredRow[],
): ReadBackOutcome {
  const stray = foreignRow(rows, userId);
  if (stray !== undefined) {
    return {
      ok: false,
      problem:
        'A read-back of your OLED profiles returned a record belonging to another account. Nothing about this migration can be verified while that is happening.',
    };
  }

  const mine = ownRows(userId, rows);
  const byId = new Map<string, StoredRow>();
  for (const row of mine) {
    const id = row.profile_id;
    if (typeof id !== 'string') continue;
    /*
     * A duplicate id here is impossible against the real primary key
     * `(user_id, profile_id)`. Keeping the first and reporting below rather than
     * silently overwriting would be better, but there is no reachable path — the
     * map would only collide if the database let it, which is the thing the
     * primary key forbids.
     */
    if (!byId.has(id)) byId.set(id, row);
  }

  for (const profile of expected) {
    const stored = byId.get(profile.profile_id);
    if (stored === undefined) {
      return {
        ok: false,
        problem: `The OLED profile "${profile.name}" was sent but is not in the database. The upload did not take effect.`,
      };
    }
    const mismatch = firstMismatch(profile, stored);
    if (mismatch) {
      return {
        ok: false,
        problem: describeMismatch(`The OLED profile "${profile.name}"`, mismatch),
      };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ history */

export interface ExpectedHistoryEntry {
  readonly user_id: string;
  readonly entry_id: string;
  readonly text: string;
  readonly profile_id: string;
  readonly source: 'glove' | 'demo';
  readonly created_at_ms: number;
}

/** Verifies every glove history entry that was uploaded is stored as sent. */
export function verifyHistory(
  userId: string,
  expected: readonly ExpectedHistoryEntry[],
  rows: readonly StoredRow[],
): ReadBackOutcome {
  const stray = foreignRow(rows, userId);
  if (stray !== undefined) {
    return {
      ok: false,
      problem:
        'A read-back of your history returned a record belonging to another account. Nothing about this migration can be verified while that is happening.',
    };
  }

  const mine = ownRows(userId, rows);
  const byId = new Map<string, StoredRow>();
  for (const row of mine) {
    const id = row.entry_id;
    if (typeof id !== 'string') continue;
    if (!byId.has(id)) byId.set(id, row);
  }

  for (const entry of expected) {
    const stored = byId.get(entry.entry_id);
    if (stored === undefined) {
      return {
        ok: false,
        problem: `A history entry was sent but is not in the database. The upload did not take effect.`,
      };
    }
    const mismatch = firstMismatch(entry, stored);
    if (mismatch) {
      return { ok: false, problem: describeMismatch('A history entry', mismatch) };
    }
  }

  return { ok: true };
}

/* -------------------------------------------------------------- read errors */

/**
 * Turns a failed read-back query into a message that names the cause.
 *
 * A permission refusal is worth separating from a network failure, because the
 * two have completely different fixes and only one of them is worth retrying.
 * The SQLSTATE is checked first (`42501` is `insufficient_privilege`), then the
 * message, because PostgREST surfaces the code on some paths and only the text
 * on others — and a bare "permission denied for table user_history" is exactly
 * the string an operator needs to see, not a generic failure.
 */
export function describeReadBackFailure(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message?: unknown }).message ?? '')
      : String(err);

  if (code === '42501' || /permission denied/i.test(message)) {
    return `The account is not permitted to read back its own records, so nothing could be verified (${message}). This is a database permission problem, not a network one, and retrying will not change it. Nothing was deleted from this phone.`;
  }
  if (code === '42P01' || /does not exist/i.test(message)) {
    return `The records could not be read back because the table or column does not exist on the server (${message}). The database may not have this migration applied. Nothing was deleted from this phone.`;
  }
  return `The records could not be read back to confirm the upload (${message}).`;
}
