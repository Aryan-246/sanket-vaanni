/**
 * Supabase client initialization for React Native 0.87.1.
 *
 * Configured with:
 * - Persistent sessions in AsyncStorage
 * - Automatic token refresh
 * - URL session detection disabled (native deep linking handles redirect URLs)
 * - Type-safe Database schema definitions
 */

// react-native-url-polyfill provides the missing URL protocol setter in React Native Hermes.
// Node.js test environment already provides native WHATWG URL with protocol setter.
if (typeof jest === 'undefined') {
  try {
    require('react-native-url-polyfill/auto');
  } catch {
    // Ignore in non-bundled or stubbed environments
  }
}
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { config } from '../config/env';
import type { Database } from './types';

let cachedClient: SupabaseClient<Database> | null = null;
let customClient: SupabaseClient<Database> | null = null;
let isDisabledForTesting = false;

export interface SupabaseClientOptions {
  storage?: typeof AsyncStorage;
}

/**
 * Initializes a new client instance directly (useful for tests or custom environments).
 */
export function initSupabaseClient(
  url: string,
  key: string,
  options?: SupabaseClientOptions,
): SupabaseClient<Database> {
  const storage = options?.storage ?? AsyncStorage;
  return createClient<Database>(url, key, {
    auth: {
      storage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Creates or retrieves the singleton Supabase client.
 * Returns null if Supabase URL or publishable key is not configured.
 */
export function getSupabaseClient(options?: SupabaseClientOptions): SupabaseClient<Database> | null {
  if (isDisabledForTesting) {
    return null;
  }

  if (customClient) {
    return customClient;
  }

  if (!config.isSupabaseConfigured) {
    return null;
  }

  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = initSupabaseClient(
    config.supabaseUrl!,
    config.supabasePublishableKey!,
    options,
  );

  return cachedClient;
}

/**
 * Checks whether Supabase has valid client credentials configured.
 */
export function isSupabaseAvailable(): boolean {
  if (isDisabledForTesting) return false;
  return customClient !== null || config.isSupabaseConfigured;
}

/**
 * Injects a mock or test client for isolated testing.
 */
export function setCustomSupabaseClient(client: SupabaseClient<Database> | null): void {
  customClient = client;
}

/**
 * Allows disabling Supabase client explicitly during test runs.
 */
export function setSupabaseDisabledForTesting(disabled: boolean): void {
  isDisabledForTesting = disabled;
}

/**
 * Resets the cached singleton client (e.g. on test teardown or logout).
 */
export function resetSupabaseClient(): void {
  cachedClient = null;
  customClient = null;
  isDisabledForTesting = false;
}
