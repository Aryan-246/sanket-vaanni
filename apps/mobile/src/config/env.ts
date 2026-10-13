import { Platform } from 'react-native';
import {
  API_BASE_URL as ENV_API_BASE_URL,
  SUPABASE_PUBLISHABLE_KEY as ENV_SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL as ENV_SUPABASE_URL,
} from '@env';

/**
 * Runtime configuration, resolved once at module load.
 *
 * The app never hardcodes the backend URL in a screen or an API call. Changing
 * where the backend lives is a `.env` edit — see `apps/mobile/.env.example`.
 */

/**
 * Android emulators cannot reach the host machine on `127.0.0.1` — that is the
 * emulator itself. `10.0.2.2` is the host loopback alias. This default exists
 * so a fresh clone works against a locally running backend with no setup.
 *
 * A physical device on Wi-Fi needs the host's LAN address, which must be set
 * explicitly via `API_BASE_URL` — there is no safe way to guess it.
 */
const DEV_FALLBACK_BASE_URL =
  Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://127.0.0.1:4000';

function normaliseBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed;
}

function resolveApiBaseUrl(): string | null {
  const fromEnv = ENV_API_BASE_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return normaliseBaseUrl(fromEnv);
  }
  return __DEV__ ? DEV_FALLBACK_BASE_URL : null;
}

function resolveSupabaseUrl(): string | null {
  const fromEnv = ENV_SUPABASE_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return normaliseBaseUrl(fromEnv);
  }
  return null;
}

function resolveSupabasePublishableKey(): string | null {
  const fromEnv = ENV_SUPABASE_PUBLISHABLE_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return null;
}

export const config = {
  apiBaseUrl: resolveApiBaseUrl(),
  /** True when no backend URL is configured (production without `.env`). */
  get isApiConfigured(): boolean {
    return config.apiBaseUrl !== null;
  },
  /** How long a backend request may take before it is abandoned. */
  apiTimeoutMs: 8000,

  /** Supabase client-side configuration. */
  supabaseUrl: resolveSupabaseUrl(),
  supabasePublishableKey: resolveSupabasePublishableKey(),
  get isSupabaseConfigured(): boolean {
    return config.supabaseUrl !== null && config.supabasePublishableKey !== null;
  },
} as const;

export type AppConfig = typeof config;
