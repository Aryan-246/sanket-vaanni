/**
 * Typed HTTP client for the Sanket Vaanni backend.
 *
 * ## The app must work without this
 *
 * Sensor processing, calibration, history and (eventually) recognition all run
 * on-device. Nothing in the core loop may depend on this client. It exists for
 * things that are genuinely better centralised — vocabulary distribution,
 * model updates, optional sync — none of which exist yet.
 *
 * Every method therefore returns a discriminated result instead of throwing,
 * so a caller can degrade quietly rather than crash when offline.
 */
import { config } from '../config/env';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export type ApiErrorKind =
  | 'not-configured'
  | 'network'
  | 'timeout'
  | 'http'
  | 'parse';

export interface ApiError {
  kind: ApiErrorKind;
  message: string;
  /** Present for `kind: 'http'`. */
  statusCode?: number;
}

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

function fail(kind: ApiErrorKind, message: string, statusCode?: number): ApiResult<never> {
  return {
    ok: false,
    error: statusCode === undefined ? { kind, message } : { kind, message, statusCode },
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const base = config.apiBaseUrl;
  if (base === null) {
    return fail(
      'not-configured',
      'No backend URL is configured. Set API_BASE_URL in apps/mobile/.env ' +
      '(see .env.example). The app works offline without it.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);

  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...init?.headers },
    });

    if (!response.ok) {
      return fail('http', `Backend returned ${response.status} for ${path}`, response.status);
    }

    try {
      return { ok: true, data: (await response.json()) as T };
    } catch {
      return fail('parse', `Backend response for ${path} was not valid JSON`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return fail('timeout', `Request to ${path} timed out after ${config.apiTimeoutMs}ms`);
    }
    return fail(
      'network',
      `Could not reach the backend at ${base}. It may not be running, or a ` +
      'physical device may need the host LAN address rather than localhost.',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export interface PublishedModelResponse {
  readonly ok: boolean;
  readonly published: boolean;
  readonly languageProfile: string;
  readonly version?: string;
  readonly publishedAt?: string;
  readonly publishedBy?: string | null;
  readonly modelPackage?: any;
  readonly message?: string;
}

export interface ModelVersionResponse {
  readonly ok: boolean;
  readonly published: boolean;
  readonly languageProfile: string;
  readonly version: string | null;
  readonly publishedAt: string | null;
  readonly vocabularySize: number;
  readonly publishedBy?: string | null;
  readonly publishReason?: string | null;
}

export const apiClient = {
  /** Liveness check. */
  health(): Promise<ApiResult<HealthResponse>> {
    return request<HealthResponse>('/health');
  },
  /** Retrieves the active published sign language model for the given profile. */
  getPublishedModel(languageProfile: string): Promise<ApiResult<PublishedModelResponse>> {
    return request<PublishedModelResponse>(`/models/published/${encodeURIComponent(languageProfile)}`);
  },
  /** Queries current published version and vocabulary count. */
  getModelVersion(languageProfile: string): Promise<ApiResult<ModelVersionResponse>> {
    return request<ModelVersionResponse>(`/models/version/${encodeURIComponent(languageProfile)}`);
  },
  baseUrl: config.apiBaseUrl,
  isConfigured: config.isApiConfigured,
} as const;
