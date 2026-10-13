import {
  deleteCurrentAccount,
  getCurrentSession,
  requestPasswordReset,
  signInWithEmail,
  signOut,
  signUpWithEmail,
  subscribeToAuthState,
  updatePassword,
} from '../src/supabase/auth';
import { resetSupabaseClient, setCustomSupabaseClient, setSupabaseDisabledForTesting } from '../src/supabase/client';

describe('Supabase Auth Module', () => {
  let mockSupabase: any;

  beforeEach(() => {
    mockSupabase = {
      auth: {
        signUp: jest.fn(),
        signInWithPassword: jest.fn(),
        signOut: jest.fn(),
        resetPasswordForEmail: jest.fn(),
        updateUser: jest.fn(),
        getSession: jest.fn(),
        onAuthStateChange: jest.fn().mockReturnValue({
          data: {
            subscription: {
              unsubscribe: jest.fn(),
            },
          },
        }),
      },
      rpc: jest.fn(),
    };
    setCustomSupabaseClient(mockSupabase);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  describe('signUpWithEmail', () => {
    it('creates account and signs in when confirmation is not required', async () => {
      mockSupabase.auth.signUp.mockResolvedValue({
        data: {
          user: { id: 'user-1', email: 'test@example.com' },
          session: { access_token: 'tok-123', user: { id: 'user-1' } },
        },
        error: null,
      });

      const res = await signUpWithEmail('test@example.com', 'secret123', 'Signer Aryan');
      expect(res.success).toBe(true);
      expect(res.needsEmailConfirmation).toBe(false);
      expect(res.data?.user?.id).toBe('user-1');
      expect(mockSupabase.auth.signUp).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'secret123',
        options: {
          data: { display_name: 'Signer Aryan' },
        },
      });
    });

    it('handles email confirmation required', async () => {
      mockSupabase.auth.signUp.mockResolvedValue({
        data: {
          user: { id: 'user-2', email: 'pending@example.com' },
          session: null,
        },
        error: null,
      });

      const res = await signUpWithEmail('pending@example.com', 'secret123');
      expect(res.success).toBe(true);
      expect(res.needsEmailConfirmation).toBe(true);
      expect(res.data?.session).toBeNull();
    });

    it('validates email format before sending request', async () => {
      const res = await signUpWithEmail('invalid-email', 'secret123');
      expect(res.success).toBe(false);
      expect(res.error).toContain('valid email');
      expect(mockSupabase.auth.signUp).not.toHaveBeenCalled();
    });

    it('validates password minimum length', async () => {
      const res = await signUpWithEmail('test@example.com', '123');
      expect(res.success).toBe(false);
      expect(res.error).toContain('6 characters');
      expect(mockSupabase.auth.signUp).not.toHaveBeenCalled();
    });

    it('aborts safely when Supabase is not available', async () => {
      setSupabaseDisabledForTesting(true);
      const res = await signUpWithEmail('test@example.com', 'secret123');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Local guest mode is active');
    });
  });

  describe('signInWithEmail', () => {
    it('signs in user successfully', async () => {
      mockSupabase.auth.signInWithPassword.mockResolvedValue({
        data: {
          user: { id: 'user-1', email: 'test@example.com' },
          session: { access_token: 'tok-123', user: { id: 'user-1' } },
        },
        error: null,
      });

      const res = await signInWithEmail('test@example.com', 'secret123');
      expect(res.success).toBe(true);
      expect(res.data?.user?.id).toBe('user-1');
      expect(res.data?.session?.access_token).toBe('tok-123');
    });

    it('translates invalid credentials error into user-friendly message', async () => {
      mockSupabase.auth.signInWithPassword.mockResolvedValue({
        data: { user: null, session: null },
        error: { message: 'Invalid login credentials' },
      });

      const res = await signInWithEmail('test@example.com', 'wrong-pass');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid email or password');
    });

    it('translates unconfirmed email error into user-friendly guidance', async () => {
      mockSupabase.auth.signInWithPassword.mockResolvedValue({
        data: { user: null, session: null },
        error: { message: 'Email not confirmed' },
      });

      const res = await signInWithEmail('unconfirmed@example.com', 'secret123');
      expect(res.success).toBe(false);
      expect(res.error).toContain('confirm your email address');
    });
  });

  describe('signOut', () => {
    it('signs out user successfully', async () => {
      mockSupabase.auth.signOut.mockResolvedValue({ error: null });

      const res = await signOut();
      expect(res.success).toBe(true);
      expect(mockSupabase.auth.signOut).toHaveBeenCalled();
    });

    it('succeeds safely if client is not configured', async () => {
      setSupabaseDisabledForTesting(true);
      const res = await signOut();
      expect(res.success).toBe(true);
    });
  });

  describe('requestPasswordReset', () => {
    it('requests reset with deep link callback url', async () => {
      mockSupabase.auth.resetPasswordForEmail.mockResolvedValue({ error: null });

      const res = await requestPasswordReset('test@example.com');
      expect(res.success).toBe(true);
      expect(mockSupabase.auth.resetPasswordForEmail).toHaveBeenCalledWith(
        'test@example.com',
        { redirectTo: 'sanketvaani://auth-callback' },
      );
    });

    it('validates email format', async () => {
      const res = await requestPasswordReset('no-at-sign');
      expect(res.success).toBe(false);
      expect(mockSupabase.auth.resetPasswordForEmail).not.toHaveBeenCalled();
    });
  });

  describe('updatePassword', () => {
    it('updates password when user has recovery session', async () => {
      mockSupabase.auth.updateUser.mockResolvedValue({ error: null });

      const res = await updatePassword('new-secure-pass-123');
      expect(res.success).toBe(true);
      expect(mockSupabase.auth.updateUser).toHaveBeenCalledWith({
        password: 'new-secure-pass-123',
      });
    });

    it('rejects short passwords', async () => {
      const res = await updatePassword('123');
      expect(res.success).toBe(false);
      expect(res.error).toContain('6 characters');
      expect(mockSupabase.auth.updateUser).not.toHaveBeenCalled();
    });
  });

  describe('deleteCurrentAccount', () => {
    it('calls delete_user_account RPC and signs out', async () => {
      mockSupabase.rpc.mockResolvedValue({ error: null });
      mockSupabase.auth.signOut.mockResolvedValue({ error: null });

      const res = await deleteCurrentAccount();
      expect(res.success).toBe(true);
      expect(mockSupabase.rpc).toHaveBeenCalledWith('delete_user_account');
      expect(mockSupabase.auth.signOut).toHaveBeenCalled();
    });

    it('handles RPC errors gracefully', async () => {
      mockSupabase.rpc.mockResolvedValue({
        error: { message: 'Database error deleting user' },
      });

      const res = await deleteCurrentAccount();
      expect(res.success).toBe(false);
      expect(res.error).toContain('Database error deleting user');
    });
  });

  describe('getCurrentSession and getCurrentUser', () => {
    it('returns null when no session is active', async () => {
      mockSupabase.auth.getSession.mockResolvedValue({
        data: { session: null },
      });

      const session = await getCurrentSession();
      expect(session).toBeNull();
    });

    it('returns active session', async () => {
      const dummySession = { access_token: '123', user: { id: 'u-1' } };
      mockSupabase.auth.getSession.mockResolvedValue({
        data: { session: dummySession },
      });

      const session = await getCurrentSession();
      expect(session).toEqual(dummySession);
    });
  });

  describe('subscribeToAuthState', () => {
    it('listens for auth state changes and unsubscribes cleanly', () => {
      const callback = jest.fn();
      const unsub = subscribeToAuthState(callback);

      expect(mockSupabase.auth.onAuthStateChange).toHaveBeenCalled();
      unsub.unsubscribe();
    });
  });
});
