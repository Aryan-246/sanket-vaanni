/**
 * Supabase Authentication operations for Sanket Vaanni.
 *
 * Provides type-safe wrappers around Supabase Auth with user-friendly error
 * mapping and offline resilience.
 */

import type { Session, Subscription, User } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';

export interface AuthResult<T = void> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
  readonly needsEmailConfirmation?: boolean;
}

export function formatAuthError(error: unknown): string {
  if (!error) return 'An unknown error occurred.';
  if (typeof error === 'string') return error;

  const err = error as { message?: string; status?: number; code?: string };
  const msg = err.message || '';

  if (msg.includes('Invalid login credentials') || msg.includes('invalid_grant')) {
    return 'Invalid email or password. Please try again.';
  }
  if (msg.includes('Email not confirmed')) {
    return 'Please confirm your email address before signing in.';
  }
  if (msg.includes('User already registered') || msg.includes('already_registered')) {
    return 'An account with this email already exists. Try signing in instead.';
  }
  if (msg.includes('Password should be at least')) {
    return 'Password must be at least 6 characters long.';
  }
  if (msg.includes('Network request failed') || msg.includes('Failed to fetch') || msg.includes('network')) {
    return 'Network connection failed. You can continue using Sanket Vaanni offline.';
  }
  if (msg.includes('rate limit') || msg.includes('over_email_send_rate_limit')) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }

  return msg || 'Authentication operation failed.';
}

/**
 * Creates a new user account with email and password.
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  displayName?: string,
): Promise<AuthResult<{ user: User | null; session: Session | null }>> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Cloud authentication is not configured. Local guest mode is active.',
    };
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { success: false, error: 'Please enter a valid email address.' };
  }
  if (password.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters.' };
  }

  try {
    const { data, error } = await client.auth.signUp({
      email: cleanEmail,
      password,
      options: {
        data: {
          display_name: displayName?.trim() || cleanEmail.split('@')[0],
        },
      },
    });

    if (error) {
      return { success: false, error: formatAuthError(error) };
    }

    // When Supabase requires email confirmation, session is null but user exists
    const needsEmailConfirmation = !data.session && !!data.user;

    return {
      success: true,
      data: { user: data.user, session: data.session },
      needsEmailConfirmation,
    };
  } catch (err) {
    return { success: false, error: formatAuthError(err) };
  }
}

/**
 * Signs in an existing user with email and password.
 */
export async function signInWithEmail(
  email: string,
  password: string,
): Promise<AuthResult<{ user: User; session: Session }>> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Cloud authentication is not configured. Local guest mode is active.',
    };
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) {
    return { success: false, error: 'Please enter your email address.' };
  }
  if (!password) {
    return { success: false, error: 'Please enter your password.' };
  }

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });

    if (error) {
      return { success: false, error: formatAuthError(error) };
    }

    if (!data.user || !data.session) {
      return { success: false, error: 'Failed to retrieve session from cloud.' };
    }

    return {
      success: true,
      data: { user: data.user, session: data.session },
    };
  } catch (err) {
    return { success: false, error: formatAuthError(err) };
  }
}

/**
 * Signs out the current user session and clears stored tokens.
 */
export async function signOut(): Promise<AuthResult> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: true };
  }

  try {
    const { error } = await client.auth.signOut();
    if (error) {
      return { success: false, error: formatAuthError(error) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: formatAuthError(err) };
  }
}

/**
 * Sends a password reset email for forgotten passwords.
 * The redirect URL uses the app's native deep linking scheme.
 */
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Cloud authentication is not configured. Local guest mode is active.',
    };
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { success: false, error: 'Please enter a valid email address.' };
  }

  try {
    const { error } = await client.auth.resetPasswordForEmail(cleanEmail, {
      redirectTo: 'sanketvaani://auth-callback',
    });

    if (error) {
      return { success: false, error: formatAuthError(error) };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: formatAuthError(err) };
  }
}

/**
 * Updates the user's password once an authenticated recovery session exists.
 */
export async function updatePassword(newPassword: string): Promise<AuthResult> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Cloud authentication is not configured.',
    };
  }

  if (newPassword.length < 6) {
    return { success: false, error: 'New password must be at least 6 characters.' };
  }

  try {
    const { error } = await client.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      return { success: false, error: formatAuthError(error) };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: formatAuthError(err) };
  }
}

/**
 * Deletes the authenticated user account and all associated cloud data via secure RPC.
 */
export async function deleteCurrentAccount(): Promise<AuthResult> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Cloud authentication is not configured.',
    };
  }

  try {
    const { error } = await client.rpc('delete_user_account');
    if (error) {
      return { success: false, error: formatAuthError(error) };
    }

    // Sign out locally
    await client.auth.signOut();
    return { success: true };
  } catch (err) {
    return { success: false, error: formatAuthError(err) };
  }
}

/**
 * Retrieves the currently active user session from local storage or remote.
 */
export async function getCurrentSession(): Promise<Session | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const { data } = await client.auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

/**
 * Retrieves the currently signed-in user.
 */
export async function getCurrentUser(): Promise<User | null> {
  const session = await getCurrentSession();
  return session?.user ?? null;
}

/**
 * Subscribes to auth state changes (sign in, sign out, token refresh).
 */
export function subscribeToAuthState(
  callback: (session: Session | null, user: User | null) => void,
): { unsubscribe: () => void } {
  const client = getSupabaseClient();
  if (!client) {
    callback(null, null);
    return { unsubscribe: () => undefined };
  }

  const { data } = client.auth.onAuthStateChange((_event, session) => {
    callback(session, session?.user ?? null);
  });

  return {
    unsubscribe: () => {
      (data as { subscription?: Subscription })?.subscription?.unsubscribe();
    },
  };
}
