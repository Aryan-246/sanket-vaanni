/**
 * Supabase Authentication operations for Sanket Vaanni.
 *
 * Provides type-safe wrappers around Supabase Auth with user-friendly error
 * mapping and offline resilience.
 */

import { Linking } from 'react-native';
import type { Session, Subscription, User } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';

/**
 * The one address Supabase Auth is allowed to send people back to.
 *
 * Kept here and imported by the deep-link parser, so the address the provider is
 * asked to redirect to and the address the app accepts cannot drift apart. The
 * Android intent filter declares this same scheme and host.
 */
export const AUTH_CALLBACK_URL = 'sanketvaani://auth-callback';

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
  const code = err.code ?? '';

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
  if (
    msg.includes('Email link is invalid or has expired') ||
    msg.includes('Token has expired or is invalid') ||
    msg.includes('invalid or has expired') ||
    code === 'otp_expired'
  ) {
    return 'That link or code is no longer valid. Request a new one and use the newest message.';
  }
  if (msg.includes('For security purposes, you can only request this after')) {
    return 'A new email was requested too recently. Wait a minute before asking again.';
  }
  if (msg.includes('provider is not enabled') || msg.includes('Unsupported provider')) {
    return 'Google sign-in is not enabled for this project yet. Use email and password.';
  }
  if (msg.includes('Signups not allowed') || msg.includes('signup_disabled')) {
    return 'This project is not accepting new accounts at the moment.';
  }
  if (msg.includes('Email not authorized') || msg.includes('email_not_authorized')) {
    return 'This project cannot send mail to that address yet. Contact sanketvaanni@gmail.com.';
  }
  if (msg.includes('Network request failed') || msg.includes('Failed to fetch') || msg.includes('network')) {
    return 'Network connection failed. You can continue using Sanket Vaanni offline.';
  }
  if (
    msg.includes('rate limit') ||
    msg.includes('over_email_send_rate_limit') ||
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    code === 'over_sms_send_rate_limit'
  ) {
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
        // Without this, the provider falls back to the project's Site URL — a
        // web address this app cannot open. The confirmation link then exists
        // but never reaches the phone it was requested from.
        emailRedirectTo: AUTH_CALLBACK_URL,
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
      redirectTo: AUTH_CALLBACK_URL,
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
 * Sends a fresh confirmation email for an account that is still pending.
 *
 * The provider, not this screen, owns the real rate limit. The UI's cooldown is
 * only there to stop a person hammering the button; the provider's refusal is
 * mapped by `formatAuthError` and shown unchanged in meaning rather than being
 * hidden behind a success message.
 */
export async function resendConfirmationEmail(email: string): Promise<AuthResult> {
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
    const { error } = await client.auth.resend({
      type: 'signup',
      email: cleanEmail,
      options: { emailRedirectTo: AUTH_CALLBACK_URL },
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
 * Confirms a pending account with the six-digit code from its email.
 *
 * This is the fallback for a person who cannot open the link (a desktop inbox,
 * for example). It confirms the same account; it does not create a second one,
 * and it cannot be used without the code the provider sent.
 */
export async function verifyEmailCode(
  email: string,
  code: string,
): Promise<AuthResult<{ session: Session | null }>> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Cloud authentication is not configured. Local guest mode is active.',
    };
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = code.trim();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { success: false, error: 'Please enter a valid email address.' };
  }
  if (!/^\d{6}$/.test(cleanCode)) {
    return { success: false, error: 'Enter the six-digit code from the email.' };
  }

  try {
    const { data, error } = await client.auth.verifyOtp({
      email: cleanEmail,
      token: cleanCode,
      type: 'signup',
    });

    if (error) {
      return { success: false, error: formatAuthError(error) };
    }

    return { success: true, data: { session: data.session ?? null } };
  } catch (err) {
    return { success: false, error: formatAuthError(err) };
  }
}

/**
 * Starts Google sign-in in the phone's browser.
 *
 * The provider is the one already configured on the Supabase project — this
 * function passes no client secret, because a mobile binary is not a safe place
 * to keep one and the provider's browser flow does not require one here. The
 * browser is opened
 * explicitly (`skipBrowserRedirect`) so the app can report a failure to launch
 * instead of silently doing nothing. The session arrives later, on the
 * `sanketvaani://auth-callback` deep link, not from this call.
 */
export async function signInWithGoogle(): Promise<AuthResult<{ url: string }>> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Cloud authentication is not configured. Local guest mode is active.',
    };
  }

  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: AUTH_CALLBACK_URL,
        skipBrowserRedirect: true,
      },
    });

    if (error) {
      return { success: false, error: formatAuthError(error) };
    }
    if (!data.url) {
      return {
        success: false,
        error: 'Google sign-in did not return a page to open. Try again.',
      };
    }

    await Linking.openURL(data.url);
    return { success: true, data: { url: data.url } };
  } catch (err) {
    return {
      success: false,
      error: `The browser could not be opened (${formatAuthError(err)}). Use email and password instead.`,
    };
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
