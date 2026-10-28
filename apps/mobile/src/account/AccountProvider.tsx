/**
 * Account and session state.
 *
 * ## Why this exists
 *
 * Before this, the app had authentication *operations* (`supabase/auth.ts`) and
 * an account *sheet*, but no shared answer to "who is signed in". The header
 * avatar, the guest banner, history ownership and the admin section all need
 * that answer, and each reading it independently would have meant three
 * subscriptions to the same session and three chances to disagree.
 *
 * ## Guest is the default, not a failure
 *
 * A user who has never signed in is a **guest**, not an error state. `isGuest`
 * is therefore true whenever there is no session — including when Supabase is
 * not configured at all, which is the genuine offline case rather than a
 * degraded one.
 *
 * ## `isAdmin` is a UI hint and nothing more
 *
 * It decides whether the Admin entry is *drawn*. It is not authorization and
 * must never be treated as such: every privileged operation is authorized on
 * the server against the caller's own token, and the client-visible flag is a
 * copy of the server's answer that a user could in principle forge. The
 * consequence of forging it is seeing a screen whose every request fails — not
 * gaining any authority.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Session, Subscription, User } from '@supabase/supabase-js';

import { getSupabaseClient, isSupabaseAvailable } from '../supabase/client';
import {
  requestPasswordReset,
  signInWithEmail,
  signUpWithEmail,
  signOut as signOutRequest,
  updatePassword,
  type AuthResult,
} from '../supabase/auth';

/** The `public.profiles` row, as far as the client is concerned. */
export interface AccountProfile {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly role: 'user' | 'admin';
  readonly status: 'active' | 'suspended';
}

export interface AccountValue {
  /** False until the persisted session has been read once. */
  readonly isReady: boolean;
  readonly session: Session | null;
  readonly user: User | null;
  readonly profile: AccountProfile | null;
  /**
   * True when there is no signed-in user. Includes the case where Supabase is
   * not configured, so an offline-only install is a guest rather than an error.
   */
  readonly isGuest: boolean;
  /** Supabase is configured, so account features can be attempted at all. */
  readonly cloudAvailable: boolean;
  /**
   * Whether the account is a Supabase *anonymous* user — a guest that the
   * server can see. Distinct from a purely local guest, which the server
   * cannot enumerate; the admin user list depends on that distinction being
   * real rather than assumed.
   */
  readonly isAnonymous: boolean;
  /** UI hint only. See the note at the top of this file. */
  readonly isAdmin: boolean;
  /** Best display name available, falling back through profile → metadata → email. */
  readonly displayName: string | null;
  readonly avatarUrl: string | null;

  signIn(email: string, password: string): Promise<AuthResult<unknown>>;
  signUp(email: string, password: string, displayName?: string): Promise<AuthResult<unknown>>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<AuthResult>;
  updatePassword(newPassword: string): Promise<AuthResult>;
  /**
   * Clears the local session after the backend has confirmed deletion.
   *
   * Separate from the confirmation request on purpose: the request belongs to
   * the dialog that collects the code, while clearing local state belongs
   * here. Calling this without a real deletion would only sign the device out;
   * it cannot delete anything.
   */
  completeAccountDeletion(): void;
  /** Re-reads the profile row, e.g. after the user edits their name. */
  refreshProfile(): Promise<void>;
  /**
   * Writes fields the user may change about themselves. Cannot set `role` or
   * `status` — see the implementation for why that restriction is structural.
   * `avatarUrl` is constrained to this account's own folder in the `avatars`
   * bucket, so the column cannot be used to point the app at another host.
   */
  updateProfile(patch: { displayName?: string; avatarUrl?: string | null }): Promise<AuthResult>;
}

const AccountContext = createContext<AccountValue | null>(null);

export interface AccountProviderProps {
  children: React.ReactNode;
  /**
   * Runs immediately before the session is ended, whether by sign-out or by
   * account deletion.
   *
   * ## Why this hook has to exist
   *
   * Some work can only be done *as* the signed-in user. Releasing this install's
   * push registration is the case that prompted it: the row belongs to the
   * account, and once the session is dropped the delete policy matches nothing,
   * so the cleanup silently does nothing and the registration is left pointing
   * at a phone nobody is signed in to.
   *
   * Doing it here rather than reacting to the session change is the difference
   * between the cleanup happening and appearing to happen. It is deliberately
   * allowed to fail without stopping the sign-out: a user who asked to be signed
   * out must be signed out, even if a token could not be released on the way.
   */
  onBeforeSignOut?: () => Promise<void>;
}

/**
 * Reads the profile row for a user.
 *
 * Returns null rather than throwing when the table has no row for this user or
 * the request fails. A missing profile is a real state — a user created before
 * the trigger existed, or a migration not yet applied — and the app should show
 * the account without a name rather than refuse to render.
 */
async function loadProfile(userId: string): Promise<AccountProfile | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  const { data, error } = await client
    .from('profiles')
    .select('id, email, display_name, avatar_url, role, status')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as unknown as {
    id: string;
    email: string | null;
    display_name: string | null;
    avatar_url: string | null;
    role: string | null;
    status: string | null;
  };

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    // Anything unexpected reads as the least privileged value. A role column
    // that has been corrupted must not be able to grant the admin UI.
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'suspended' ? 'suspended' : 'active',
  };
}

export function AccountProvider({
  children,
  onBeforeSignOut,
}: AccountProviderProps): React.JSX.Element {
  const [isReady, setIsReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);

  /**
   * Guards against a profile fetch that resolves after the user has already
   * signed out or switched accounts, which would otherwise leave the previous
   * account's name and role on screen under the new session.
   */
  const profileUserIdRef = useRef<string | null>(null);

  const cloudAvailable = isSupabaseAvailable();

  const applySession = useCallback(async (next: Session | null) => {
    setSession(next);
    const userId = next?.user?.id ?? null;

    if (userId === null) {
      profileUserIdRef.current = null;
      setProfile(null);
      return;
    }

    profileUserIdRef.current = userId;
    const loaded = await loadProfile(userId);
    // Only commit if this is still the session we fetched for.
    if (profileUserIdRef.current === userId) {
      setProfile(loaded);
    }
  }, []);

  useEffect(() => {
    const client = getSupabaseClient();

    if (!client) {
      // No Supabase: this is a local-only guest. Ready immediately, because
      // there is nothing to await and making the UI wait would be a blank frame
      // for no reason.
      setIsReady(true);
      return;
    }

    let cancelled = false;

    // Local session first — it is already on disk, so this is the fast path and
    // the one that works with no network.
    client.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        void applySession(data.session ?? null).finally(() => {
          if (!cancelled) setIsReady(true);
        });
      })
      .catch(() => {
        if (!cancelled) setIsReady(true);
      });

    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled) return;
      void applySession(nextSession ?? null);
    });

    return () => {
      cancelled = true;
      (data as { subscription?: Subscription })?.subscription?.unsubscribe();
    };
  }, [applySession]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await signInWithEmail(email, password);
      // `onAuthStateChange` is the single writer of session state; it fires for
      // a successful sign-in, so nothing is committed here. A failure needs no
      // state change at all.
      return result as AuthResult<unknown>;
    },
    [],
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const result = await signUpWithEmail(email, password, displayName);
      return result as AuthResult<unknown>;
    },
    [],
  );

  /**
   * Runs the pre-sign-out hook, tolerating failure.
   *
   * Swallowing the error is the deliberate part. Whatever this work is, it is
   * secondary to the user's request to be signed out, and a failure in it is
   * reported by whichever feature owns it rather than by refusing here.
   */
  const releaseBeforeSessionEnds = useCallback(async (): Promise<void> => {
    if (onBeforeSignOut === undefined) return;
    try {
      await onBeforeSignOut();
    } catch {
      // Owned by the caller. The session still ends.
    }
  }, [onBeforeSignOut]);

  const signOut = useCallback(async () => {
    await releaseBeforeSessionEnds();
    await signOutRequest();
    // Clear locally as well as remotely: if the network call failed the user
    // still asked to be signed out, and leaving a live session on the device
    // after an explicit sign-out would be the wrong failure direction.
    profileUserIdRef.current = null;
    setProfile(null);
    setSession(null);
  }, [releaseBeforeSessionEnds]);

  const completeAccountDeletion = useCallback(() => {
    /*
     * The provider's before-session hook has nothing left to release for most
     * installs: the backend deletes push registrations and the Auth identity in
     * the same action. It is still invoked for any other per-session cleanup a
     * host app registered, and its failure must not leave a deleted account
     * looking signed in on this device.
     */
    void releaseBeforeSessionEnds();
    profileUserIdRef.current = null;
    setProfile(null);
    setSession(null);
  }, [releaseBeforeSessionEnds]);

  const refreshProfile = useCallback(async () => {
    const userId = session?.user?.id ?? null;
    if (userId === null) return;
    const loaded = await loadProfile(userId);
    if (profileUserIdRef.current === userId) setProfile(loaded);
  }, [session]);

  /**
   * Writes the fields the user is allowed to change about themselves.
   *
   * ## What this deliberately cannot write
   *
   * No `role` and no `status`. Those two columns decide whether the app offers
   * the admin section and whether the account is suspended, and a client that
   * could set them would be able to promote itself. The policy on the server
   * rejects such an update, and this function does not attempt one — so a bug
   * here cannot even ask.
   *
   * The row is re-read afterwards rather than being written into local state
   * from the response. A successful update call means the server accepted the
   * request; only a read-back shows what the stored row actually contains.
   */
  const updateProfile = useCallback(
    async (patch: { displayName?: string; avatarUrl?: string | null }): Promise<AuthResult> => {
      const client = getSupabaseClient();
      const userId = session?.user?.id ?? null;

      if (!client) {
        return { success: false, error: 'No account service is configured in this build.' };
      }
      if (userId === null) {
        return { success: false, error: 'There is no signed-in account to update.' };
      }

      /*
       * Typed as the table's own Update shape, not `Record<string, string>`.
       *
       * A generic string map is not assignable to that type, and it should not
       * be: `role` and `status` are columns on this table, and a map that could
       * name any key would let a future edit here try to write one. Naming only
       * the column this function is allowed to touch makes that a compile error
       * rather than a request the trigger has to refuse at runtime.
       */
      const update: { display_name?: string; avatar_url?: string | null } = {};
      if (patch.displayName !== undefined) {
        const trimmed = patch.displayName.trim();
        if (trimmed.length === 0) {
          return { success: false, error: 'A display name cannot be empty.' };
        }
        if (trimmed.length > 60) {
          return {
            success: false,
            error: 'A display name cannot be longer than 60 characters.',
          };
        }
        update.display_name = trimmed;
      }

      if (patch.avatarUrl !== undefined) {
        /*
         * Only a URL inside this account's own folder in this project's
         * `avatars` bucket is accepted. The database policy stops a client
         * writing another user's *file*, but nothing would stop a row pointing
         * at an arbitrary external image — which the app would then fetch and
         * display, leaking a request to a third party on every profile view.
         */
        if (patch.avatarUrl !== null) {
          const ownFolder = `/storage/v1/object/public/avatars/${userId}/`;
          if (!patch.avatarUrl.includes(ownFolder)) {
            return {
              success: false,
              error: 'A profile photo must come from this account’s own storage folder.',
            };
          }
        }
        update.avatar_url = patch.avatarUrl;
      }

      if (Object.keys(update).length === 0) {
        return { success: true };
      }

      const { error } = await client.from('profiles').update(update).eq('id', userId);

      if (error) {
        return {
          success: false,
          error:
            'The name could not be saved. It may have been rejected by the account service, or the connection may have dropped.',
        };
      }

      await refreshProfile();
      return { success: true };
    },
    [session, refreshProfile],
  );

  const user = session?.user ?? null;

  const displayName = useMemo(() => {
    if (profile?.displayName && profile.displayName.trim().length > 0) {
      return profile.displayName.trim();
    }
    const meta = user?.user_metadata as { display_name?: unknown } | undefined;
    if (typeof meta?.display_name === 'string' && meta.display_name.trim().length > 0) {
      return meta.display_name.trim();
    }
    // The local part of the address, which is what a new account is named after
    // anyway (see the signup trigger). Never invented — it comes from the real
    // address the account was created with.
    const email = profile?.email ?? user?.email ?? null;
    if (email && email.includes('@')) return email.split('@')[0];
    return null;
  }, [profile, user]);

  const value = useMemo<AccountValue>(
    () => ({
      isReady,
      session,
      user,
      profile,
      isGuest: user === null,
      cloudAvailable,
      isAnonymous: user?.is_anonymous === true,
      isAdmin: profile?.role === 'admin',
      displayName,
      avatarUrl: profile?.avatarUrl ?? null,
      signIn,
      signUp,
      signOut,
      requestPasswordReset,
      updatePassword,
      completeAccountDeletion,
      refreshProfile,
      updateProfile,
    }),
    [
      isReady,
      session,
      user,
      profile,
      cloudAvailable,
      displayName,
      signIn,
      signUp,
      signOut,
      completeAccountDeletion,
      refreshProfile,
      updateProfile,
    ],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (value === null) {
    throw new Error('useAccount must be used inside an <AccountProvider>');
  }
  return value;
}

/**
 * Safe version of useAccount that returns null if rendered outside <AccountProvider>.
 * Useful for components tested in isolation or rendered in preview/sub-trees.
 */
export function useAccountSafe(): AccountValue | null {
  return useContext(AccountContext);
}
