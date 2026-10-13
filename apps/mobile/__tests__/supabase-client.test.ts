import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getSupabaseClient,
  initSupabaseClient,
  isSupabaseAvailable,
  resetSupabaseClient,
  setCustomSupabaseClient,
  setSupabaseDisabledForTesting,
} from '../src/supabase/client';

describe('Supabase Client Module', () => {
  beforeEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetSupabaseClient();
  });

  it('checks if Supabase is configured via environment', () => {
    const available = isSupabaseAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('returns a configured Supabase client instance or null', () => {
    const client = getSupabaseClient();
    if (isSupabaseAvailable()) {
      expect(client).not.toBeNull();
      expect(client?.auth).toBeDefined();
    } else {
      expect(client).toBeNull();
    }
  });

  it('allows disabling Supabase client explicitly for testing', () => {
    setSupabaseDisabledForTesting(true);
    expect(isSupabaseAvailable()).toBe(false);
    expect(getSupabaseClient()).toBeNull();

    setSupabaseDisabledForTesting(false);
  });

  it('allows injecting a custom / mocked Supabase client for tests', () => {
    const mockClient = {
      auth: {
        getUser: jest.fn(),
      },
    } as any;

    setCustomSupabaseClient(mockClient);
    expect(getSupabaseClient()).toBe(mockClient);
    expect(isSupabaseAvailable()).toBe(true);

    setCustomSupabaseClient(null);
  });

  it('initializes a fresh client with specific URL and Key', () => {
    const freshClient = initSupabaseClient('https://test-project.supabase.co', 'test-anon-key');
    expect(freshClient).not.toBeNull();
    expect(freshClient.auth).toBeDefined();
  });

  it('storage adapter correctly interacts with AsyncStorage', async () => {
    await AsyncStorage.setItem('sb-test-token', JSON.stringify({ token: '123' }));
    const val = await AsyncStorage.getItem('sb-test-token');
    expect(val).toBe(JSON.stringify({ token: '123' }));

    await AsyncStorage.removeItem('sb-test-token');
    const removed = await AsyncStorage.getItem('sb-test-token');
    expect(removed).toBeNull();
  });
});
