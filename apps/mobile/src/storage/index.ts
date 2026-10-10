/**
 * Local persistence.
 *
 * Everything the app remembers between launches goes through this module, so
 * that there is exactly one place to audit for privacy — nothing here leaves
 * the device, and there is no network access in this file.
 *
 * An in-memory implementation is provided alongside the device implementation
 * so tests and storybook-style previews never touch real storage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AppPreferences, ThemeMode } from '../app/preferences';
import { parsePreferences } from '../app/preferences';
import type { CalibrationProfile } from '../sensors/calibration';

/**
 * Versioned key namespace. Bump the version to invalidate old payloads.
 *
 * Note what is deliberately absent: there is no "intro seen" key. Whether the
 * intro plays is decided by process lifetime, not by persisted state — see
 * `../app/launchSession.ts` for why a stored flag cannot express "this launch"
 * and permanently suppresses the intro once set.
 */
const KEYS = {
  selectedProfile: 'sv/v1/selected-profile',
  calibration: (side: string) => `sv/v1/calibration/${side}`,
  history: 'sv/v1/history',
  themeMode: 'sv/v1/theme-mode',
  preferences: 'sv/v1/preferences',
  /**
   * OLED Studio state. Kept as opaque JSON here rather than typed in this
   * module so that `storage` does not have to depend on the editor's shape;
   * the editor owns the schema and the migration, this module owns the bytes.
   */
  oledLayout: 'sv/v1/oled-layout',
  oledPresets: 'sv/v1/oled-presets',
} as const;

/**
 * One entry of local history.
 *
 * `source` records whether the text came from a real glove or from simulated
 * data, because history that silently mixes the two is worse than no history.
 * Today every entry would be `demo`; there are none in practice, because
 * nothing produces recognised text yet.
 */
export interface HistoryEntry {
  readonly id: string;
  readonly text: string;
  readonly profileId: string;
  readonly source: 'glove' | 'demo';
  readonly createdAtMs: number;
}

/** Keeps local history bounded; unbounded growth is a battery and disk risk. */
export const HISTORY_LIMIT = 200;

export interface Storage {
  getSelectedProfileId(): Promise<string | null>;
  setSelectedProfileId(profileId: string): Promise<void>;
  getCalibration(side: string): Promise<CalibrationProfile | null>;
  setCalibration(calibration: CalibrationProfile): Promise<void>;
  getHistory(): Promise<HistoryEntry[]>;
  addHistoryEntry(entry: HistoryEntry): Promise<HistoryEntry[]>;
  clearHistory(): Promise<void>;

  /** Theme preference. `null` means the user has never chosen; use the default. */
  getThemeMode(): Promise<ThemeMode | null>;
  setThemeMode(mode: ThemeMode): Promise<void>;

  getPreferences(): Promise<AppPreferences | null>;
  setPreferences(preferences: AppPreferences): Promise<void>;

  /** Untyped JSON reader for feature-owned payloads (OLED layout, presets). */
  getJson<T>(key: string): Promise<T | null>;
  setJson<T>(key: string, value: T): Promise<void>;
  removeKey(key: string): Promise<void>;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt value must not crash the launch path. Treat it as absent; the
    // next write repairs it.
    return null;
  }
}

export function createAsyncStorage(): Storage {
  return {
    async getSelectedProfileId() {
      return AsyncStorage.getItem(KEYS.selectedProfile);
    },
    async setSelectedProfileId(profileId) {
      await AsyncStorage.setItem(KEYS.selectedProfile, profileId);
    },

    async getCalibration(side) {
      const raw = await AsyncStorage.getItem(KEYS.calibration(side));
      return parseJson<CalibrationProfile>(raw);
    },
    async setCalibration(calibration) {
      await AsyncStorage.setItem(
        KEYS.calibration(calibration.side),
        JSON.stringify(calibration),
      );
    },

    async getHistory() {
      const raw = await AsyncStorage.getItem(KEYS.history);
      const parsed = parseJson<HistoryEntry[]>(raw);
      return Array.isArray(parsed) ? parsed : [];
    },
    async addHistoryEntry(entry) {
      const existing = await this.getHistory();
      // Newest first, trimmed to the limit.
      const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
      await AsyncStorage.setItem(KEYS.history, JSON.stringify(next));
      return next;
    },
    async clearHistory() {
      await AsyncStorage.removeItem(KEYS.history);
    },

    async getThemeMode() {
      const raw = await AsyncStorage.getItem(KEYS.themeMode);
      return raw === 'system' || raw === 'dark' || raw === 'light' ? raw : null;
    },
    async setThemeMode(mode) {
      await AsyncStorage.setItem(KEYS.themeMode, mode);
    },

    async getPreferences() {
      const raw = await AsyncStorage.getItem(KEYS.preferences);
      if (raw === null) return null;
      return parsePreferences(parseJson<unknown>(raw));
    },
    async setPreferences(preferences) {
      await AsyncStorage.setItem(KEYS.preferences, JSON.stringify(preferences));
    },

    async getJson<T>(key: string) {
      return parseJson<T>(await AsyncStorage.getItem(key));
    },
    async setJson<T>(key: string, value: T) {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    },
    async removeKey(key: string) {
      await AsyncStorage.removeItem(key);
    },
  };
}

/** In-memory storage for tests. Never used by the running app. */
export function createInMemoryStorage(): Storage {
  const map = new Map<string, string>();

  const read = (key: string): string | null => map.get(key) ?? null;

  return {
    async getSelectedProfileId() {
      return read(KEYS.selectedProfile);
    },
    async setSelectedProfileId(profileId) {
      map.set(KEYS.selectedProfile, profileId);
    },
    async getCalibration(side) {
      return parseJson<CalibrationProfile>(read(KEYS.calibration(side)));
    },
    async setCalibration(calibration) {
      map.set(KEYS.calibration(calibration.side), JSON.stringify(calibration));
    },
    async getHistory() {
      const parsed = parseJson<HistoryEntry[]>(read(KEYS.history));
      return Array.isArray(parsed) ? parsed : [];
    },
    async addHistoryEntry(entry) {
      const existing = await this.getHistory();
      const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
      map.set(KEYS.history, JSON.stringify(next));
      return next;
    },
    async clearHistory() {
      map.delete(KEYS.history);
    },

    async getThemeMode() {
      const raw = read(KEYS.themeMode);
      return raw === 'system' || raw === 'dark' || raw === 'light' ? raw : null;
    },
    async setThemeMode(mode) {
      map.set(KEYS.themeMode, mode);
    },

    async getPreferences() {
      const raw = read(KEYS.preferences);
      if (raw === null) return null;
      return parsePreferences(parseJson<unknown>(raw));
    },
    async setPreferences(preferences) {
      map.set(KEYS.preferences, JSON.stringify(preferences));
    },

    async getJson<T>(key: string) {
      return parseJson<T>(read(key));
    },
    async setJson<T>(key: string, value: T) {
      map.set(key, JSON.stringify(value));
    },
    async removeKey(key: string) {
      map.delete(key);
    },
  };
}

export const storageKeys = KEYS;

/** Feature-owned payload keys, so callers never hardcode a string. */
export const featureKeys = {
  oledLayout: KEYS.oledLayout,
  oledPresets: KEYS.oledPresets,
} as const;
