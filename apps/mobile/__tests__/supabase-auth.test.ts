import { Linking } from 'react-native';

import {
  getCurrentSession,
  requestPasswordReset,
  resendConfirmationEmail,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  signUpWithEmail,
  subscribeToAuthState,
  updatePassword,
  verifyEmailCode,
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
        resend: jest.fn(),
        verifyOtp: jest.fn(),
        signInWithOAuth: jest.fn(),
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
          emailRedirectTo: 'sanketvaani://auth-callback',
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

  describe('resending a confirmation email', () => {
    it('asks the provider to resend, pointing at the app callback', async () => {
      mockSupabase.auth.resend.mockResolvedValue({ error: null });

      const res = await resendConfirmationEmail('  Pending@Example.com ');

      expect(res.success).toBe(true);
      expect(mockSupabase.auth.resend).toHaveBeenCalledWith({
        type: 'signup',
        email: 'pending@example.com',
        options: { emailRedirectTo: 'sanketvaani://auth-callback' },
      });
    });

    it('recognises the provider rate-limit code even without the usual sentence', async () => {
      mockSupabase.auth.resend.mockResolvedValue({
        error: { message: 'Request refused', code: 'over_email_send_rate_limit' },
      });

      const res = await resendConfirmationEmail('pending@example.com');

      expect(res.success).toBe(false);
      expect(res.error).toContain('Too many attempts');
    });

    it('shows the provider rate limit rather than pretending it sent', async () => {
      mockSupabase.auth.resend.mockResolvedValue({
        error: { message: 'For security purposes, you can only request this after 43 seconds.' },
      });

      const res = await resendConfirmationEmail('pending@example.com');

      expect(res.success).toBe(false);
      expect(res.error).toContain('too recently');
    });
  });

  describe('confirming with an emailed code', () => {
    it('verifies the same signup token and returns the session', async () => {
      const session = { access_token: 'tok', user: { id: 'u-1' } };
      mockSupabase.auth.verifyOtp.mockResolvedValue({
        data: { user: { id: 'u-1' }, session },
        error: null,
      });

      const res = await verifyEmailCode('Pending@Example.com', ' 123456 ');

      expect(res.success).toBe(true);
      expect(res.data?.session).toEqual(session);
      expect(mockSupabase.auth.verifyOtp).toHaveBeenCalledWith({
        email: 'pending@example.com',
        token: '123456',
        type: 'signup',
      });
    });

    it('does not spend a request on something that is not a six-digit code', async () => {
      const res = await verifyEmailCode('pending@example.com', '12345');

      expect(res.success).toBe(false);
      expect(res.error).toContain('six-digit');
      expect(mockSupabase.auth.verifyOtp).not.toHaveBeenCalled();
    });

    it('maps an expired token to an instruction, not a raw provider string', async () => {
      mockSupabase.auth.verifyOtp.mockResolvedValue({
        data: { user: null, session: null },
        error: { message: 'Token has expired or is invalid' },
      });

      const res = await verifyEmailCode('pending@example.com', '123456');

      expect(res.success).toBe(false);
      expect(res.error).toContain('no longer valid');
    });
  });

  describe('Google sign-in', () => {
    it('opens the provider URL in the browser and passes no secret', async () => {
      const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
      mockSupabase.auth.signInWithOAuth.mockResolvedValue({
        data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google' },
        error: null,
      });

      const res = await signInWithGoogle();

      expect(res.success).toBe(true);
      expect(mockSupabase.auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: {
          redirectTo: 'sanketvaani://auth-callback',
          skipBrowserRedirect: true,
        },
      });
      // The whole options object is the assertion: no client secret, no second
      // credential, and nothing that would put a provider key in this bundle.
      expect(open).toHaveBeenCalledWith(
        'https://project.supabase.co/auth/v1/authorize?provider=google',
      );
      open.mockRestore();
    });

    it('explains a provider that is not enabled on the project', async () => {
      mockSupabase.auth.signInWithOAuth.mockResolvedValue({
        data: { url: null },
        error: { message: 'Unsupported provider: provider is not enabled' },
      });

      const res = await signInWithGoogle();

      expect(res.success).toBe(false);
      expect(res.error).toContain('not enabled');
    });

    it('reports a browser that would not open instead of leaving a dead button', async () => {
      const open = jest
        .spyOn(Linking, 'openURL')
        .mockRejectedValue(new Error('No activity found to handle Intent'));
      mockSupabase.auth.signInWithOAuth.mockResolvedValue({
        data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google' },
        error: null,
      });

      const res = await signInWithGoogle();

      expect(res.success).toBe(false);
      expect(res.error).toContain('browser could not be opened');
      open.mockRestore();
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
