/**
 * A small in-memory stand-in for the Supabase client.
 *
 * Not a suite — `jest.config.js` matches `*.test.*` only.
 *
 * ## Why this exists rather than `jest.fn()`
 *
 * The sync suite used to assert that `upsert` *had been called*. That passes
 * whether or not the row is correct, whether or not a second run duplicates it,
 * and whether or not the write could ever have succeeded. It cannot tell "the
 * data was uploaded" from "a function was invoked".
 *
 * This double actually stores rows, keyed the way the real tables are keyed, so
 * a test can ask the two questions that matter:
 *
 *   - what is on the server now?          → `fake.rows.oled_profiles`
 *   - what is still on the device?        → the real `Storage` instance
 *
 * Conflict targets come from the caller's `onConflict` when given, and otherwise
 * from the real primary key, so an upsert that misses its conflict target really
 * does produce a second row here — the duplicate case is reproducible instead of
 * assumed away.
 *
 * ## Why it is a real builder now
 *
 * The sync engine bounds every request with an `AbortController` and applies it
 * with `.abortSignal(signal)` *before* the terminal call, because that is the
 * only order the real `postgrest-js` accepts without the signal being dropped.
 * A fake whose `upsert` returned a bare promise could not be chained that way, so
 * the engine would have had to be written to suit the fake. Instead the fake
 * behaves like the builder: every method returns the same object, and the
 * request runs when that object is awaited. `select()`, `eq()`, `abortSignal()`
 * and `upsert()` are all chainable, and `.then` settles whichever operation was
 * staged.
 *
 * ## Why `hang` and `onAbort` exist
 *
 * A timeout can only be observed if something is slow, and cancellation can only
 * be proved if the request was actually still open. Without a way to make a
 * request hang, a test for "the deadline fired" would pass against an
 * implementation that merely gave up waiting while the request ran on — the exact
 * failure the deadline is written to avoid. `hang` supplies the slow request and
 * `onAbort` records that the transport was cancelled rather than abandoned.
 */

/** Table → the columns that make a row unique, mirroring the migrations. */
const PRIMARY_KEYS: Record<string, readonly string[]> = {
  profiles: ['id'],
  user_preferences: ['user_id'],
  calibration_profiles: ['user_id', 'side'],
  oled_profiles: ['user_id', 'profile_id'],
  user_history: ['user_id', 'entry_id'],
};

export interface FakeError {
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
}

/**
 * Builds a real `Error` carrying the PostgREST fields.
 *
 * `postgrest-js` throws a `PostgrestError` that *extends* `Error`, and the sync
 * engine reads `err.message`. Returning a bare object here would exercise a
 * shape the app never actually sees, and would let a broken error path look
 * correct.
 */
function makeError(spec: FakeError): Error & FakeError {
  const error = new Error(spec.message) as Error & FakeError;
  if (spec.code !== undefined) (error as { code?: string }).code = spec.code;
  if (spec.status !== undefined) (error as { status?: number }).status = spec.status;
  return error;
}

/**
 * The error an aborted request produces, matching what `fetch` rejects with.
 *
 * Named `AbortError` on purpose: that is the one thing the transport tells the
 * caller, and the sync engine has to work out *why* the abort happened rather
 * than pattern-matching on this name.
 */
function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Which kind of request is being made, for the hooks below. */
export type FakeOperation = 'read' | 'write';

export interface FakeSupabaseOptions {
  /**
   * Called before a write. Return an error to make that one write fail — the
   * hook used to reproduce a drop mid-migration, or an expired session.
   *
   * May be async: a test that wants to hold a write open returns a promise, and
   * the write does not complete until it settles.
   */
  readonly onWrite?: (
    table: string,
    row: Record<string, unknown>,
    operation: 'upsert' | 'insert',
  ) => FakeError | null | Promise<FakeError | null>;
  /** Called before a read. Return an error to make that read fail. */
  readonly onRead?: (table: string, operation: 'list' | 'single') => FakeError | null;
  /**
   * Makes a request stay open until it is aborted.
   *
   * The hold is on the *settle*, not on the response, so the request is genuinely
   * outstanding when the deadline fires — which is what makes a timeout test
   * mean something.
   */
  readonly hang?: (table: string, operation: FakeOperation) => boolean;
  /**
   * Records that an abort was observed on the transport.
   *
   * Called only when a hanging request is actually aborted. A test asserts this
   * fired, which distinguishes "the transport was cancelled" from "we stopped
   * waiting and let it run on".
   */
  readonly onAbort?: (table: string, operation: FakeOperation) => void;
}

export interface FakeSupabase {
  /** The stored rows, for assertions. Mutated in place, like a real database. */
  readonly rows: Record<string, Record<string, unknown>[]>;
  /** Registered credentials for `auth.signInWithPassword`. */
  readonly accounts: Record<string, string>;
  readonly from: (table: string) => any;
  readonly auth: any;
}

function keyFor(
  table: string,
  row: Record<string, unknown>,
  onConflict: string | undefined,
): string {
  const columns = onConflict
    ? onConflict.split(',').map((c) => c.trim())
    : (PRIMARY_KEYS[table] ?? []);

  if (columns.length === 0) return JSON.stringify(row);
  /*
   * A tuple of the key columns, not their concatenation. Joining the values
   * with a separator would let two different rows produce the same key —
   * ('a b', 'c') and ('a', 'b c') — so the duplicate case this fake exists
   * to reproduce could be hidden by a collision in the fake itself.
   */
  return JSON.stringify(columns.map((column) => row[column]));
}

export function createFakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  const rows: Record<string, Record<string, unknown>[]> = {};
  const table = (name: string): Record<string, unknown>[] => (rows[name] ??= []);

  const accounts: Record<string, string> = {};

  const from = (name: string) => {
    const filters: [string, unknown][] = [];
    let signal: AbortSignal | undefined;
    /** The operation staged by `upsert` / `delete`, run when the builder is awaited. */
    let staged: { kind: 'upsert'; row: Record<string, unknown>; onConflict?: string } | null = null;

    const matching = (): Record<string, unknown>[] =>
      table(name).filter((row) => filters.every(([column, value]) => row[column] === value));

    /**
     * Produces the operation's result, or stays open until aborted.
     *
     * An already-aborted signal is refused immediately, which is what the real
     * transport does: `fetch` rejects without sending anything.
     */
    const settle = <T>(
      operation: FakeOperation,
      produce: () => T | Promise<T>,
    ): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          options.onAbort?.(name, operation);
          reject(abortError());
          return;
        }
        if (options.hang?.(name, operation)) {
          if (signal === undefined) return; // Nothing can end it; the test must abort.
          signal.addEventListener(
            'abort',
            () => {
              options.onAbort?.(name, operation);
              reject(abortError());
            },
            { once: true },
          );
          return;
        }
        Promise.resolve(produce()).then(resolve, reject);
      });

    const readRows = (): { data: Record<string, unknown>[]; error: null } | { data: null; error: Error } => {
      const spec = options.onRead?.(name, 'list') ?? null;
      if (spec) return { data: null, error: makeError(spec) };
      return { data: matching(), error: null };
    };

    const readOne = (): { data: Record<string, unknown> | null; error: Error | null } => {
      const spec = options.onRead?.(name, 'single') ?? null;
      if (spec) return { data: null, error: makeError(spec) };

      const found = matching();
      /*
       * More than one row for a "single" read is an error, exactly as PostgREST
       * reports it. Returning the first would hide the duplicate this fake is
       * here to make visible.
       */
      if (found.length > 1) {
        return {
          data: null,
          error: makeError({
            message: 'JSON object requested, multiple (or no) rows returned',
            code: 'PGRST116',
          }),
        };
      }
      return { data: found[0] ?? null, error: null };
    };

    const doUpsert = async (
      row: Record<string, unknown>,
      onConflict?: string,
    ): Promise<{ data: null; error: Error | null }> => {
      const spec = (await options.onWrite?.(name, row, 'upsert')) ?? null;
      if (spec) return { data: null, error: makeError(spec) };

      const list = table(name);
      const key = keyFor(name, row, onConflict);
      const index = list.findIndex((r) => keyFor(name, r, onConflict) === key);
      if (index >= 0) {
        list[index] = { ...list[index], ...row };
      } else {
        list.push({ ...row });
      }
      return { data: null, error: null };
    };

    const api: any = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return api;
      },
      order: () => api,
      limit: () => api,
      abortSignal: (next: AbortSignal) => {
        signal = next;
        return api;
      },

      maybeSingle: () => settle('read', readOne),
      single: () => settle('read', readOne),

      upsert: (row: Record<string, unknown>, opts?: { onConflict?: string }) => {
        staged = { kind: 'upsert', row, onConflict: opts?.onConflict };
        return api;
      },
      delete: () => {
        staged = null;
        return api;
      },

      /* The builder is awaited directly for list reads: `.select('*').eq(...)`. */
      then: (resolve: any, reject: any) => {
        const operation: FakeOperation = staged === null ? 'read' : 'write';
        const settleOnce =
          staged === null ? settle(operation, readRows) : settle(operation, () => doUpsert(staged!.row, staged!.onConflict));
        // The staged write runs once; a second await of the same builder would
        // otherwise replay it, which no real builder does either.
        staged = null;
        return settleOnce.then(resolve, reject);
      },
    };

    return api;
  };

  const auth = {
    /*
     * `signInWithPassword` succeeds for any password when the address has been
     * registered, which is enough for the flows these tests drive. The one
     * special case is the password `'expired'`, which stands in for a session
     * the server has already invalidated.
     */
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      const id = accounts[email];
      if (id === undefined) {
        return {
          data: { user: null, session: null },
          error: { message: 'Invalid login credentials', status: 400 },
        };
      }
      if (password === 'expired') {
        return {
          data: { user: null, session: null },
          error: { message: 'JWT expired', status: 401 },
        };
      }
      return {
        data: { user: { id, email }, session: { access_token: 'test-token' } },
        error: null,
      };
    },
    signUp: async ({ email }: { email: string }) => ({
      data: { user: { id: 'signed-up', email }, session: null },
      error: null,
    }),
    signOut: async () => ({ error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({
      data: { subscription: { unsubscribe: () => undefined } },
    }),
    setSession: async () => ({ data: {}, error: null }),
  };

  return { rows, accounts, from, auth };
}
