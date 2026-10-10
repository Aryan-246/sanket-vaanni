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

import type { CalibrationProfile } from '../sensors/calibration';

/** Versioned key namespace. Bump the version to invalidate old payloads. */
const KEYS = {
  introSeen: 'sv/v1/intro-seen',
  selectedProfile: 'sv/v1/selected-profile',
  calibration: (side: string) => `sv/v1/calibration/${side}`,
  history: 'sv/v1/history',
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
  isIntroSeen(): Promise<boolean>;
  setIntroSeen(seen: boolean): Promise<void>;
  getSelectedProfileId(): Promise<string | null>;
  setSelectedProfileId(profileId: string): Promise<void>;
  getCalibration(side: string): Promise<CalibrationProfile | null>;
  setCalibration(calibration: CalibrationProfile): Promise<void>;
  getHistory(): Promise<HistoryEntry[]>;
  addHistoryEntry(entry: HistoryEntry): Promise<HistoryEntry[]>;
  clearHistory(): Promise<void>;
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
    async isIntroSeen() {
      return (await AsyncStorage.getItem(KEYS.introSeen)) === 'true';
    },
    async setIntroSeen(seen) {
      await AsyncStorage.setItem(KEYS.introSeen, seen ? 'true' : 'false');
    },

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
  };
}

/** In-memory storage for tests. Never used by the running app. */
export function createInMemoryStorage(): Storage {
  const map = new Map<string, string>();

  const read = (key: string): string | null => map.get(key) ?? null;

  return {
    async isIntroSeen() {
      return read(KEYS.introSeen) === 'true';
    },
    async setIntroSeen(seen) {
      map.set(KEYS.introSeen, seen ? 'true' : 'false');
    },
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
  };
}

export const storageKeys = KEYS;
