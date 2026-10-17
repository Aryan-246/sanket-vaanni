import {
  resetSupabaseClient,
  setCustomSupabaseClient,
  setSupabaseDisabledForTesting,
} from '../src/supabase/client';
import { handleAuthUrl, parseAuthUrl } from '../src/supabase/linking';
import { SyncManager } from '../src/supabase/sync';
import { createInMemoryStorage, type Storage } from '../src/storage';
import { createFakeSupabase } from './fakeSupabase';

function createMockQueryBuilder(data: any = null, error: any = null) {
  const result = { data, error };
  const builder: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    /*
     * The sync engine applies its deadline through `.abortSignal()`, exactly as
     * it must against the real `postgrest-js` builder. This double has to offer
     * the same method or it is describing a client that does not exist — and
     * every request would fail with a `TypeError` that looks like a sync bug.
     */
    abortSignal: jest.fn().mockReturnThis(),
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
        setSession: jest.fn().mockResolvedValue({
          data: { session: { access_token: 'session-token' } },
          error: null,
        }),
        verifyOtp: jest.fn(),
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

      /*
       * A fake that stores rows, so the assertion is about the record that
       * reached the table rather than about `upsert` having been invoked. The
       * upload is requested explicitly because it is opt-in: an unqualified
       * `syncAll` must not send anything, which
       * `guest-migration.test.ts` covers directly.
       */
      const server = createFakeSupabase();
      setCustomSupabaseClient(server as any);

      const state = await syncManager.syncAll('user-1', inMemoryStorage, {
        uploadLocalData: true,
      });

      expect(state.status).toBe('synced');
      expect(server.rows['user_preferences']).toHaveLength(1);
      expect(server.rows['user_preferences'][0]).toMatchObject({
        user_id: 'user-1',
        target_language_code: 'mr',
        theme_mode: 'light',
      });
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

    it('ignores another host on the app scheme', () => {
      // Any installed app can launch a `sanketvaani://` URL. Only the configured
      // callback is allowed to hand tokens to this app.
      expect(
        parseAuthUrl('sanketvaani://something-else#access_token=a&refresh_token=b'),
      ).toBeNull();
    });

    it('reports an expired or refused link instead of doing nothing', async () => {
      const outcome = await handleAuthUrl(
        'sanketvaani://auth-callback#error=access_denied&error_description=Email+link+is+invalid+or+has+expired',
      );

      expect(outcome).toEqual({
        status: 'error',
        message:
          'That link has expired or was already used. Request a new one and open the newest email.',
      });
      expect(mockSupabase.auth.setSession).not.toHaveBeenCalled();
    });

    it('reports a callback with no tokens rather than claiming success', async () => {
      const outcome = await handleAuthUrl('sanketvaani://auth-callback?type=signup');

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.message).toContain('no sign-in information');
      }
      expect(mockSupabase.auth.setSession).not.toHaveBeenCalled();
    });

    it('exchanges a one-time token_hash link instead of reading tokens from the URL', async () => {
      mockSupabase.auth.verifyOtp.mockResolvedValue({
        data: { session: { access_token: 'session-token' } },
        error: null,
      });

      const outcome = await handleAuthUrl(
        'sanketvaani://auth-callback?token_hash=one-time-hash&type=signup',
      );

      expect(outcome).toEqual({ status: 'signed-in', type: 'signup' });
      expect(mockSupabase.auth.verifyOtp).toHaveBeenCalledWith({
        token_hash: 'one-time-hash',
        type: 'signup',
      });
      // No reusable token was taken from the address.
      expect(mockSupabase.auth.setSession).not.toHaveBeenCalled();
    });

    it('reports a spent one-time link rather than retrying it', async () => {
      mockSupabase.auth.verifyOtp.mockResolvedValue({
        data: { session: null },
        error: { message: 'Token has expired or is invalid' },
      });

      const outcome = await handleAuthUrl(
        'sanketvaani://auth-callback?token_hash=spent&type=recovery',
      );

      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.message).toContain('no longer valid');
      }
    });

    it('handles recovery callback and notifies handler', async () => {
      const onRecovery = jest.fn();
      const url =
        'sanketvaani://auth-callback#access_token=rec_token&refresh_token=rec_refresh&type=recovery';

      const outcome = await handleAuthUrl(url, onRecovery);
      expect(outcome).toEqual({ status: 'signed-in', type: 'recovery' });
      expect(mockSupabase.auth.setSession).toHaveBeenCalledWith({
        access_token: 'rec_token',
        refresh_token: 'rec_refresh',
      });
      expect(onRecovery).toHaveBeenCalled();
    });
  });
});
