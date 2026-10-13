/**
 * Sanket Vaanni — Local-First Supabase Data Synchronizer.
 *
 * Implements:
 * - Local-first offline persistence (AsyncStorage is primary source of truth)
 * - Bi-directional synchronization for Preferences, Calibrations, and OLED profiles
 * - Conflict resolution: latest timestamp wins
 * - Multi-user isolation: keys isolated by authenticated userId
 * - Honest error reporting and offline fallbacks
 */

import type { ThemeMode } from '../app/preferences';
import { DEFAULT_PREFERENCES, parsePreferences } from '../app/preferences';
import { defaultHandConfig, type OledProfile } from '../oled/profiles';
import type { CalibrationProfile } from '../sensors/calibration';
import type { Storage } from '../storage';
import { getSupabaseClient } from './client';
import type { Json, SyncState, SyncStatus } from './types';

export class SyncManager {
  private status: SyncStatus = 'idle';
  private lastSyncedAtMs: number | null = null;
  private lastError: string | null = null;
  private syncListeners: ((state: SyncState) => void)[] = [];

  public getState(): SyncState {
    return {
      status: this.status,
      lastSyncedAtMs: this.lastSyncedAtMs,
      pendingChangesCount: 0,
      lastError: this.lastError,
    };
  }

  public subscribe(listener: (state: SyncState) => void): () => void {
    this.syncListeners.push(listener);
    listener(this.getState());
    return () => {
      this.syncListeners = this.syncListeners.filter((l) => l !== listener);
    };
  }

  private setStatus(status: SyncStatus, error: string | null = null) {
    this.status = status;
    this.lastError = error;
    if (status === 'synced') {
      this.lastSyncedAtMs = Date.now();
    }
    const state = this.getState();
    for (const listener of this.syncListeners) {
      listener(state);
    }
  }

  /**
   * User-isolated storage keys to prevent data leakage across account switches.
   */
  public getUserKey(userId: string, subKey: string): string {
    return `sv/v1/u/${userId}/${subKey}`;
  }

  /**
   * Performs a full synchronization cycle for the currently signed-in user.
   */
  public async syncAll(userId: string, local: Storage): Promise<SyncState> {
    const client = getSupabaseClient();
    if (!client) {
      this.setStatus('offline', 'Supabase is not configured.');
      return this.getState();
    }

    this.setStatus('syncing');

    try {
      await Promise.all([
        this.syncPreferences(userId, local),
        this.syncCalibration(userId, local, 'left'),
        this.syncCalibration(userId, local, 'right'),
        this.syncOledProfiles(userId, local),
        this.syncHistory(userId, local),
      ]);

      this.setStatus('synced');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus('error', message);
    }

    return this.getState();
  }

  /**
   * Syncs user preferences and theme.
   */
  public async syncPreferences(userId: string, local: Storage): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;

    // 1. Fetch remote preferences
    const { data: remote, error } = await client
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    const localPrefs = (await local.getPreferences()) || DEFAULT_PREFERENCES;
    const localTheme = (await local.getThemeMode()) || 'system';

    if (!remote) {
      // Upload local preferences to remote
      const { error: upsertErr } = await client.from('user_preferences').upsert({
        user_id: userId,
        sign_profile_id: localPrefs.signProfileId,
        target_language_code: localPrefs.targetLanguageCode,
        voice_enabled: localPrefs.voiceEnabled,
        theme_mode: localTheme,
        updated_at: new Date().toISOString(),
      });
      if (upsertErr) throw upsertErr;
    } else {
      // Merge preferences: update local with remote
      const mergedPrefs = parsePreferences({
        signProfileId: remote.sign_profile_id,
        targetLanguageCode: remote.target_language_code,
        voiceEnabled: remote.voice_enabled,
      });
      await local.setPreferences(mergedPrefs);
      if (remote.theme_mode) {
        await local.setThemeMode(remote.theme_mode as ThemeMode);
      }
    }
  }

  /**
   * Syncs calibration profile for one side.
   */
  public async syncCalibration(
    userId: string,
    local: Storage,
    side: 'left' | 'right',
  ): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;

    const localCal = await local.getCalibration(side);

    const { data: remote, error } = await client
      .from('calibration_profiles')
      .select('*')
      .eq('user_id', userId)
      .eq('side', side)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;

    if (localCal && (!remote || localCal.capturedAtMs > remote.captured_at_ms)) {
      // Local is newer: upload to remote
      const { error: upsertErr } = await client.from('calibration_profiles').upsert(
        {
          user_id: userId,
          side,
          captured_at_ms: localCal.capturedAtMs,
          sign_language_id: localCal.signLanguageId,
          channels: localCal.channels as any,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id, side' },
      );
      if (upsertErr) throw upsertErr;
    } else if (remote && (!localCal || remote.captured_at_ms > localCal.capturedAtMs)) {
      // Remote is newer: save to local
      const downloaded: CalibrationProfile = {
        version: 1,
        side,
        capturedAtMs: remote.captured_at_ms,
        signLanguageId: remote.sign_language_id,
        channels: remote.channels as unknown as CalibrationProfile['channels'],
      };
      await local.setCalibration(downloaded);
    }
  }

  /**
   * Syncs OLED profiles between local storage and cloud.
   */
  public async syncOledProfiles(userId: string, local: Storage): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;

    // Local OLED state is stored under 'sv/v1/oled-profiles'
    const localState = await local.getJson<{
      profiles: OledProfile[];
      activeProfileId: string;
    }>('sv/v1/oled-profiles');

    const { data: remotes, error } = await client
      .from('oled_profiles')
      .select('*')
      .eq('user_id', userId);

    if (error) throw error;

    if (localState?.profiles && localState.profiles.length > 0) {
      /*
       * Upsert each local profile.
       *
       * The column names, the conflict target and the value types all have to
       * match the table exactly, and previously none of the three did — this
       * wrote `id`, `left_preset` and `right_preset` into a table keyed on
       * `(user_id, profile_id)` with `left_config`/`right_config`, and passed
       * a JSON string where the column is JSONB, so every save was a
       * double-encoded string inside an object.
       *
       * The conflict target is `user_id, profile_id`, matching the primary key.
       * It is deliberately *not* the profile's name: renaming a profile must
       * update the existing row, not create a second one beside it.
       *
       * One profile per call rather than a single bulk upsert, so that a row
       * rejected by a policy aborts with a message naming that row instead of
       * failing the whole batch opaquely.
       */
      for (const p of localState.profiles) {
        const { error: upsertErr } = await client.from('oled_profiles').upsert(
          {
            user_id: userId,
            profile_id: p.id,
            name: p.name,
            created_at_ms: p.createdAtMs,
            updated_at_ms: p.updatedAtMs,
            // Objects, not `JSON.stringify` of them: these columns are JSONB.
            left_config: p.left as unknown as Json,
            right_config: p.right as unknown as Json,
          },
          { onConflict: 'user_id, profile_id' },
        );
        if (upsertErr) throw upsertErr;
      }
    }

    // If remote has profiles not present locally, incorporate them.
    if (remotes && remotes.length > 0 && localState) {
      const localIds = new Set(localState.profiles.map((p) => p.id));
      const missing = remotes
        .filter((r) => !localIds.has(r.profile_id))
        .map(
          (r): OledProfile => ({
            id: r.profile_id,
            name: r.name,
            /*
             * The real timestamps, read from the row.
             *
             * This used to substitute `Date.now()` for both, which quietly
             * rewrote the age of every profile pulled from another device — and
             * since conflict resolution is "latest timestamp wins", it made
             * every downloaded profile look newer than the local one it had
             * just been merged with.
             */
            createdAtMs: r.created_at_ms,
            updatedAtMs: r.updated_at_ms,
            left: (r.left_config ?? defaultHandConfig()) as OledProfile['left'],
            right: (r.right_config ?? defaultHandConfig()) as OledProfile['right'],
          }),
        );

      if (missing.length > 0) {
        await local.setJson('sv/v1/oled-profiles', {
          ...localState,
          profiles: [...localState.profiles, ...missing],
        });
      }
    }
  }

  /**
   * Syncs user recognition history.
   */
  public async syncHistory(userId: string, local: Storage): Promise<void> {
    const client = getSupabaseClient();
    if (!client) return;

    const history = await local.getHistory();
    if (!history || history.length === 0) return;

    // Only upload entries from real glove reading
    const gloveEntries = history.filter((h) => h.source === 'glove');
    if (gloveEntries.length === 0) return;

    for (const entry of gloveEntries) {
      const { error } = await client.from('user_history').upsert(
        {
          user_id: userId,
          entry_id: entry.id,
          text: entry.text,
          profile_id: entry.profileId,
          source: entry.source,
          created_at_ms: entry.createdAtMs,
        },
        { onConflict: 'user_id, entry_id' },
      );
      if (error) throw error;
    }
  }
}

export const syncManager = new SyncManager();
