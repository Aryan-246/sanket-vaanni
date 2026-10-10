/**
 * API contracts shared across Sanket Vaanni applications.
 *
 * See ../README.md — this package is types-only and is NOT yet imported by any
 * application. It is the canonical written contract; the backend mirrors these
 * shapes locally.
 */

/** Liveness response from `GET /health`. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  /** ISO-8601 instant, e.g. `2026-10-10T09:15:00.000Z`. */
  timestamp: string;
}

/**
 * Service identity from `GET /`.
 *
 * `status` is `'foundation'` while the service has no recognition or glove
 * integration. Do not add a member such as `'operational'` until there is
 * something real behind it.
 */
export interface ServiceInfoResponse {
  service: string;
  version: string;
  status: 'foundation';
  message: string;
  endpoints: Record<string, string>;
}

/** Standard error body for non-2xx responses. */
export interface ApiErrorResponse {
  statusCode: number;
  error: string;
  message: string;
}
