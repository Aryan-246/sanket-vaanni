/**
 * What a failed administration call means, in terms of what to do about it.
 *
 * ## The failure this exists to prevent
 *
 * `apps/mobile/src/screens/AdminScreen.tsx` showed every failure the same way: a
 * red card with the server's sentence and a Retry button. The sentences are
 * good — `apps/backend/src/middleware/requireAdmin.ts` produces distinct ones for
 * a missing token, an expired token, a non-administrator and an unconfigured
 * deployment — but the *app* did nothing different for any of them, and it
 * offered a Retry button for all of them, including the ones retrying cannot fix.
 *
 * The cost is worst in the two cases the status code alone identifies:
 *
 *  - **401.** The session has expired. Pressing Retry re-sends the same dead
 *    token and fails identically, so the one action the screen offers is the one
 *    action that cannot work. What is needed is to sign in again.
 *  - **403.** The account is signed in but is not an administrator, or is
 *    suspended. Retrying is pointless and looks like the app is stalling rather
 *    than refusing. What is needed is to see which account is signed in.
 *
 * ## Why the taxonomy is by action rather than by status code
 *
 * A status code is a fact about the response; a reader needs a fact about what to
 * do next. Three codes can all mean "try again" (5xx, a dropped connection, a
 * timeout) and two can both mean "this is not your session". Grouping them by the
 * action keeps the screen from having to re-derive that, and keeps two call sites
 * from deriving it differently.
 *
 * ## What this module will not do
 *
 * It will not read the server's message text to work out which flavour of 403
 * arrived. Those sentences are written to be read by a person, and a client that
 * pattern-matched them would break silently the first time one was reworded —
 * turning a precise explanation into a generic one with no test failing. The
 * server's sentence is shown as it is; this only decides what the app offers
 * beside it.
 */

/** The kinds of failure, grouped by the action that answers them. */
export type AdminFailureKind =
  | 'sign-in'
  | 'refused'
  | 'unconfigured'
  | 'server'
  | 'unreachable'
  | 'request';

export interface AdminFailureDescription {
  readonly kind: AdminFailureKind;
  /** One line naming what went wrong, without contradicting the server. */
  readonly headline: string;
  /** What the reader can do, or that there is nothing they can do here. */
  readonly advice: string;
  /** Whether repeating the same request could plausibly succeed. */
  readonly canRetry: boolean;
  /** Whether offering "sign in again" would help. */
  readonly canSignIn: boolean;
}

const DESCRIPTIONS: Record<AdminFailureKind, Omit<AdminFailureDescription, 'kind'>> = {
  'sign-in': {
    headline: 'This session is no longer valid.',
    advice:
      'Your sign-in has expired, so the console cannot act as you. Signing in again is the way forward — asking the same request again will be refused in exactly the same way.',
    canRetry: false,
    canSignIn: true,
  },
  refused: {
    headline: 'This account was refused.',
    advice:
      'The service declined the request for the account that is signed in, which usually means it is not an administrator or is suspended. Check which account is signed in before trying again.',
    canRetry: false,
    canSignIn: true,
  },
  unconfigured: {
    headline: 'The administration service is not set up yet.',
    advice:
      'The service reported that it is missing configuration rather than failing. Retrying will not change that; whoever deploys it has to set the values it named. Nothing here can fix it from the app.',
    canRetry: false,
    canSignIn: false,
  },
  server: {
    headline: 'The service failed while answering.',
    advice:
      'The request reached the service and the service did not complete it. This is usually transient, so trying again is reasonable.',
    canRetry: true,
    canSignIn: false,
  },
  unreachable: {
    headline: 'The service could not be reached.',
    advice:
      'Nothing was sent, so nothing was changed. Check the connection and try again — the console will not guess at what the answer might have been.',
    canRetry: true,
    canSignIn: false,
  },
  request: {
    headline: 'The service refused the request as written.',
    advice:
      'The service read the request and rejected it, and it said why above. Changing the input is what will change the answer.',
    canRetry: false,
    canSignIn: false,
  },
};

/** A failed call, as the screens hold it: the server's words and its status. */
export interface AdminFailure {
  /** The sentence to show, unchanged. `client.ts` prefers the server's own. */
  readonly message: string;
  /**
   * The HTTP status, when the request got one.
   *
   * Absent for a request that never produced a response — no API URL, no token,
   * an abort, or a network failure. That absence is itself information: it is
   * the difference between "the service said no" and "the service was never
   * asked", and only the first of those means the answer was considered.
   */
  readonly status?: number;
}

/**
 * Lifts the failure out of a result the client returned.
 *
 * Written as a function over the shape rather than called at each site, so a
 * screen cannot accidentally keep the message and drop the status — dropping it
 * is exactly what produced a Retry button in front of a 401.
 */
export function asFailure(result: { readonly error: string; readonly status?: number }): AdminFailure {
  return result.status === undefined
    ? { message: result.error }
    : { message: result.error, status: result.status };
}

/**
 * Reads a failure from the status of the response, when there was one.
 *
 * `undefined` is not "unknown" — it is the specific case of a request that never
 * got a status, which `apps/mobile/src/admin/client.ts` produces for a missing
 * API URL, a missing token, an abort and a network failure. Those are grouped
 * here under "unreachable" except where the client already said something more
 * precise in its message, which the screen shows unchanged.
 */
export function describeAdminFailure(
  status: number | undefined,
): AdminFailureDescription {
  const kind = kindOf(status);
  return { kind, ...DESCRIPTIONS[kind] };
}

function kindOf(status: number | undefined): AdminFailureKind {
  if (status === undefined) return 'unreachable';
  if (status === 401) return 'sign-in';
  if (status === 403) return 'refused';
  /*
   * 503 is its own case rather than a server fault. `requireAdmin` uses it for a
   * deployment that is missing configuration, and tells the reader which
   * variables are absent — so grouping it with 500 would turn a specific
   * instruction into "the server is broken", and offer a Retry that cannot work.
   */
  if (status === 503) return 'unconfigured';
  if (status >= 500) return 'server';
  if (status >= 400) return 'request';
  /*
   * A 2xx or 3xx reaching this function would be a bug in the caller rather than
   * a failure to explain. Treated as unreachable so the screen still says
   * something true — that no usable answer arrived.
   */
  return 'unreachable';
}
