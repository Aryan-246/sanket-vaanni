import {
  resetSupabaseClient,
  setCustomSupabaseClient,
  setSupabaseDisabledForTesting,
} from '../src/supabase/client';
import { handleAuthUrl, parseAuthUrl } from '../src/supabase/linking';
import { SyncManager } from '../src/supabase/sync';
import { createInMemoryStorage, type Storage } from '../src/storage';

function createMockQueryBuilder(data: any = null, error: any = null) {
  const result = { data, error };
  const builder: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(result),
    single: jest.fn().mockResolvedValue(result),
    upsert: jest.fn().mockResolvedValue({ error: null }),
    then: (resolve: any, reject: any) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

describe('Supabase Sync & Data Integrity', () => {
  let mockSupabase: any;
  let inMemoryStorage: Storage;
  let syncManager: SyncManager;

  beforeEach(() => {
    syncManager = new SyncManager();
    inMemoryStorage = createInMemoryStorage();

    mockSupabase = {
      from: jest.fn().mockImplementation(() => createMockQueryBuilder(null)),
      auth: {
        setSession: jest.fn().mockResolvedValue({ data: {}, error: null }),
      },
    };
    setCustomSupabaseClient(mockSupabase);
    setSupabaseDisabledForTesting(false);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  describe('SyncManager states and subscriptions', () => {
    it('initializes with idle state', () => {
      const state = syncManager.getState();
      expect(state.status).toBe('idle');
      expect(state.lastSyncedAtMs).toBeNull();
      expect(state.lastError).toBeNull();
    });

    it('subscribes and receives state updates', async () => {
      const listener = jest.fn();
      const unsub = syncManager.subscribe(listener);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'idle',
        }),
      );

      // Trigger sync with disabled client to test state change
      setSupabaseDisabledForTesting(true);
      await syncManager.syncAll('user-1', inMemoryStorage);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'offline',
        }),
      );

      unsub();
    });
  });

  describe('Sync execution and conflict resolution', () => {
    it('aborts safely if Supabase client is not available', async () => {
      setSupabaseDisabledForTesting(true);
      const state = await syncManager.syncAll('user-1', inMemoryStorage);
      expect(state.status).toBe('offline');
      expect(state.lastError).toBe('Supabase is not configured.');
    });

    it('syncs user preferences with remote-wins when remote exists', async () => {
      await inMemoryStorage.setPreferences({
        signProfileId: 'isl',
        targetLanguageCode: 'hi',
        voiceEnabled: true,
      });
      await inMemoryStorage.setThemeMode('dark');

      const remotePrefs = {
        user_id: 'user-1',
        theme_mode: 'light',
        voice_enabled: false,
        sign_profile_id: 'isl_advanced',
        target_language_code: 'en',
        updated_at: new Date().toISOString(),
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'user_preferences') {
          return createMockQueryBuilder(remotePrefs);
        }
        return createMockQueryBuilder(null);
      });

      const state = await syncManager.syncAll('user-1', inMemoryStorage);
      expect(state.status).toBe('synced');
      expect(syncManager.getState().status).toBe('synced');

      // Check that local storage was updated with remote changes
      const updatedPrefs = await inMemoryStorage.getPreferences();
      const updatedTheme = await inMemoryStorage.getThemeMode();
      expect(updatedTheme).toBe('light');
      expect(updatedPrefs?.targetLanguageCode).toBe('en');
      expect(updatedPrefs?.signProfileId).toBe('isl_advanced');
    });

    it('syncs user preferences by uploading local when remote is empty', async () => {
      await inMemoryStorage.setPreferences({
        signProfileId: 'isl',
        targetLanguageCode: 'mr',
        voiceEnabled: true,
      });
      await inMemoryStorage.setThemeMode('light');

      const upsertMock = jest.fn().mockResolvedValue({ error: null });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'user_preferences') {
          const builder = createMockQueryBuilder(null);
          builder.upsert = upsertMock;
          return builder;
        }
        return createMockQueryBuilder(null);
      });

      const state = await syncManager.syncAll('user-1', inMemoryStorage);
      expect(state.status).toBe('synced');
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          target_language_code: 'mr',
          theme_mode: 'light',
        }),
      );
    });

    it('records sync error and preserves local storage when network fails', async () => {
      mockSupabase.from.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const state = await syncManager.syncAll('user-1', inMemoryStorage);
      expect(state.status).toBe('error');
      expect(state.lastError).toContain('Database connection failed');
      expect(syncManager.getState().status).toBe('error');
      expect(syncManager.getState().lastError).toContain('Database connection failed');
    });

    it('isolates cache keys when switching between different user accounts', () => {
      const u1Key = syncManager.getUserKey('user-1', 'profile');
      const u2Key = syncManager.getUserKey('user-2', 'profile');

      expect(u1Key).toBe('sv/v1/u/user-1/profile');
      expect(u2Key).toBe('sv/v1/u/user-2/profile');
      expect(u1Key).not.toBe(u2Key);
    });
  });

  describe('Deep Linking and Password Recovery', () => {
    it('parses auth callback URL with hash fragment', () => {
      const url =
        'sanketvaani://auth-callback#access_token=token123&refresh_token=refresh456&type=recovery';
      const event = parseAuthUrl(url);
      expect(event).not.toBeNull();
      expect(event?.type).toBe('recovery');
      expect(event?.accessToken).toBe('token123');
      expect(event?.refreshToken).toBe('refresh456');
    });

    it('parses auth callback URL with query parameters', () => {
      const url =
        'sanketvaani://auth-callback?access_token=tokenABC&refresh_token=refreshXYZ&type=signup';
      const event = parseAuthUrl(url);
      expect(event).not.toBeNull();
      expect(event?.type).toBe('signup');
      expect(event?.accessToken).toBe('tokenABC');
      expect(event?.refreshToken).toBe('refreshXYZ');
    });

    it('returns null for unrelated URLs', () => {
      expect(parseAuthUrl('https://example.com/other')).toBeNull();
      expect(parseAuthUrl('')).toBeNull();
    });

    it('handles recovery callback and notifies handler', async () => {
      const onRecovery = jest.fn();
      const url =
        'sanketvaani://auth-callback#access_token=rec_token&refresh_token=rec_refresh&type=recovery';

      const handled = await handleAuthUrl(url, onRecovery);
      expect(handled).toBe(true);
      expect(mockSupabase.auth.setSession).toHaveBeenCalledWith({
        access_token: 'rec_token',
        refresh_token: 'rec_refresh',
      });
      expect(onRecovery).toHaveBeenCalled();
    });
  });
});
