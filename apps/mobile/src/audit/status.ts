/**
 * The status vocabulary.
 *
 * ## Why this is its own module
 *
 * The brief is explicit that a single green "Connected" badge must not stand in
 * for "every component is working". That is not a styling problem, it is a
 * vocabulary problem: if the only words available are connected/disconnected,
 * every partially-working state has to be told as a lie.
 *
 * So there are six states, and `unknown` is a first-class one. A component
 * whose state the firmware has not reported is `unknown` — never `healthy`,
 * and never `disconnected` either, because we do not know that it is down.
 *
 * `simulated` is deliberately **not** a health state. Whether data is real or
 * simulated is an orthogonal property (`DataSource`), because simulated data
 * can be perfectly healthy and real data can be broken.
 */

export type HealthState =
  | 'healthy'
  | 'warning'
  | 'disconnected'
  | 'unavailable'
  | 'unknown';

/**
 * Where a value came from.
 *
 * `none` is distinct from `simulated`: "we have no reading" and "we have an
 * invented reading" are different claims and must never render the same.
 */
export type DataSource = 'real' | 'simulated' | 'none';

/** Wording for each state. Sentence case, no trailing punctuation. */
export const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  disconnected: 'Disconnected',
  unavailable: 'Unavailable',
  unknown: 'Unknown',
};

/**
 * Longer explanations, for the audit screen.
 *
 * These describe what the state *means* in this app, so a reader is not left
 * to infer whether "unavailable" is a fault or an absence.
 */
export const HEALTH_MEANING: Record<HealthState, string> = {
  healthy: 'Reported working by the hardware, within the last expected window.',
  warning: 'Reachable but not fully nominal — see the detail line.',
  disconnected: 'The link was established and is now closed.',
  unavailable: 'Not implemented, or not present on this build.',
  unknown: 'No evidence either way. Nothing has reported on this yet.',
};

export const DATA_SOURCE_LABEL: Record<DataSource, string> = {
  real: 'Hardware',
  simulated: 'Simulated',
  none: 'No data',
};

/**
 * Orders states by how much attention they deserve, so a summary can surface
 * the worst one. `unknown` sits above `healthy` deliberately: it is not a
 * problem, but it is not reassurance either.
 */
export const HEALTH_SEVERITY: Record<HealthState, number> = {
  disconnected: 4,
  warning: 3,
  unavailable: 2,
  unknown: 1,
  healthy: 0,
};

/** The single worst state in a list, or `unknown` for an empty list. */
export function worstState(states: readonly HealthState[]): HealthState {
  if (states.length === 0) return 'unknown';
  return states.reduce((worst, next) =>
    HEALTH_SEVERITY[next] > HEALTH_SEVERITY[worst] ? next : worst,
  );
}
