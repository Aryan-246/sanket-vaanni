import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { ConfirmDialog } from './ConfirmDialog';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { TextField } from './TextField';
import { useAccount } from '../account/AccountProvider';
import { suspensionNotice } from '../account/suspension';
import { useAppState } from '../app/AppState';
import {
  clearMigrationDecision,
  hasMigratableData,
  migratableScopesFor,
  readMigrationDecision,
  recordMigrationDecision,
  summariseGuestData,
  type GuestDataSummary,
} from '../supabase/guestMigration';
import {
  resendConfirmationEmail,
  signInWithGoogle,
  verifyEmailCode,
} from '../supabase/auth';
import {
  syncManager,
  type MigratableScope,
} from '../supabase/sync';
import type { SyncState } from '../supabase/types';
import { spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';

/**
 * A message produced by an authentication link the app was opened with.
 *
 * The root navigator parses the link and passes the sentence here rather than
 * letting this sheet parse URLs too — one place decides what a callback means.
 * `id` exists so the same message can be re-delivered for a second link without
 * being mistaken for unchanged state.
 */
export interface AuthLinkNotice {
  readonly id: number;
  readonly tone: 'info' | 'error';
  readonly message: string;
}

export interface AccountSheetProps {
  visible: boolean;
  onClose: () => void;
  isRecoveryMode?: boolean;
  /**
   * True while the service is under maintenance.
   *
   * Passed in rather than read here so that the sheet has one reason to change:
   * whether it should print the maintenance notice. It does not decide what
   * maintenance means or who is exempt.
   */
  maintenanceOn?: boolean;
  /** The outcome of an auth deep link, if one has just been opened. */
  authLinkNotice?: AuthLinkNotice | null;
}

type AuthMode = 'signin' | 'signup' | 'forgot' | 'verify' | 'update_password';

/**
 * How long the resend control stays disabled after a send.
 *
 * This is courtesy pacing, not a security control: the provider enforces its own
 * per-address limit, and its refusal is shown rather than disguised.
 */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Turns a failed sync into something worth reading.
 *
 * A resumed migration that cannot reach the server is a different situation
 * from one the server refused, and the difference decides whether trying again
 * is worth the user's time — so the two are not flattened into one sentence.
 * Both say plainly that nothing was lost.
 */
function describeSyncFailure(state: SyncState): string {
  if (state.status === 'offline') {
    return 'The app cannot reach the server at the moment, so your agreed upload has not happened. Every record is still on this phone.';
  }
  return `${
    state.lastError ?? 'The upload did not finish.'
  } Every record is still on this phone.`;
}

/**
 * Sign in, create an account, recover a password, and manage cloud sync.
 *
 * ## One source of session truth
 *
 * This sheet used to keep its own `currentUser`, read with `getCurrentSession()`
 * and kept up to date by its own `subscribeToAuthState` subscription. That made
 * it a second answer to "is anybody signed in", which could disagree with
 * `AccountProvider`'s — and did, briefly, after a sign-out performed elsewhere.
 * It now reads `useAccount()`, which is the single answer, and its own `isLoading`
 * covers only the period its buttons are busy.
 *
 * The consequence worth noting: because there is no auth subscription here, the
 * post-sign-in sync is triggered explicitly by the sign-in handler rather than
 * by watching for a user to appear. That is a smaller and more predictable thing
 * — sync happens when this screen causes a sign-in, not whenever any part of the
 * app does.
 */
export function AccountSheet({
  visible,
  onClose,
  isRecoveryMode = false,
  maintenanceOn = false,
  authLinkNotice = null,
}: AccountSheetProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { storage } = useAppState();
  const account = useAccount();

  /*
   * Read once from the profile row, rather than derived from whatever the last
   * sync said. A suspension causes failures that look exactly like a network
   * fault, so the explanation cannot come from the failures.
   */
  const suspension = suspensionNotice(account.profile);
  const { user } = account;

  const [authMode, setAuthMode] = useState<AuthMode>(isRecoveryMode ? 'update_password' : 'signin');
  const [syncState, setSyncState] = useState<SyncState>(syncManager.getState());

  // Form states
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');

  /** The address a confirmation email was sent to, and the code typed back. */
  const [pendingEmail, setPendingEmail] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [resendRemaining, setResendRemaining] = useState(0);

  // Status states
  const [isLoading, setIsLoading] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [infoBanner, setInfoBanner] = useState<string | null>(null);

  /**
   * Set only between a successful sign-in and the user's answer about migrating
   * this phone's data. While it is non-null the sheet shows the consent step and
   * nothing has been uploaded.
   */
  const [pendingMigration, setPendingMigration] = useState<{
    readonly userId: string;
    readonly summary: GuestDataSummary;
  } | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  /**
   * True when this account has been asked and said no.
   *
   * A refusal has to stay visible after the sheet is reopened. Otherwise a
   * signed-in user sees "Never synced" beside a "Sync Now" button and can only
   * guess whether their records are on the server, which is the guess the whole
   * consent step exists to remove.
   */
  const [migrationDeclined, setMigrationDeclined] = useState(false);

  /**
   * Set when a migration the user already agreed to did not finish.
   *
   * Deliberately separate from `pendingMigration`: consent has been given, so
   * showing the consent step again would be asking a second time. This state
   * only reports that the agreement was not honoured yet, and offers the retry.
   */
  const [resumeFailure, setResumeFailure] = useState<{
    readonly userId: string;
    readonly scopes: readonly MigratableScope[];
    readonly message: string;
  } | null>(null);

  // Dialogs
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);

  /**
   * Which asynchronous action is allowed to write UI state.
   *
   * Every handler that awaits something takes a number here before it starts,
   * and checks it still holds the latest number before it sets state. Closing the
   * sheet, or starting another action, increments it — which quietly revokes the
   * right of anything already in flight to speak.
   *
   * Without this, dismissing a slow upload was not really a dismissal: the sheet
   * closed, the request landed a moment later, and its handler set a failure
   * banner that reopened the very panel the user had just closed. A dismissal
   * that can be undone by a request the user has already given up on is not a
   * dismissal.
   *
   * A ref rather than state, because the guard is read inside awaits that
   * captured their value at call time; a re-render must not hand them a new one.
   */
  const attemptRef = useRef(0);

  /** Claims the right to write state, superseding anything already running. */
  const beginAttempt = useCallback((): number => {
    attemptRef.current += 1;
    return attemptRef.current;
  }, []);

  /** Whether an action that started earlier is still the one in charge. */
  const isCurrent = useCallback(
    (attempt: number): boolean => attemptRef.current === attempt,
    [],
  );

  const supabaseConfigured = account.cloudAvailable;

  useEffect(() => {
    const syncSub = syncManager.subscribe((state) => {
      setSyncState(state);
    });

    return () => {
      syncSub();
    };
  }, []);

  // Update recovery mode if prop changes
  useEffect(() => {
    if (isRecoveryMode) {
      setAuthMode('update_password');
    }
  }, [isRecoveryMode]);

  /*
   * The resend button counts down visibly rather than merely being disabled, so
   * a person can see that waiting is the intended action instead of concluding
   * the control is broken. The provider still owns the real limit.
   */
  useEffect(() => {
    if (resendRemaining <= 0) return undefined;
    const timer = setTimeout(() => {
      setResendRemaining((remaining) => Math.max(0, remaining - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [resendRemaining]);

  /*
   * A link that has just been opened produces its message here. The id guard
   * matters because this sheet can re-render for unrelated reasons; without it,
   * dismissing the banner would bring it back on the next render.
   */
  const lastAuthLinkNoticeId = useRef<number | null>(null);
  useEffect(() => {
    if (authLinkNotice === null || authLinkNotice === undefined) return;
    if (lastAuthLinkNoticeId.current === authLinkNotice.id) return;
    lastAuthLinkNoticeId.current = authLinkNotice.id;

    if (authLinkNotice.tone === 'error') {
      setErrorBanner(authLinkNotice.message);
      return;
    }
    setErrorBanner(null);
    setInfoBanner(authLinkNotice.message);
  }, [authLinkNotice]);

  /*
   * Re-read the stored answer whenever the signed-in account changes, and after
   * the question is answered, so the account view can describe what is actually
   * on the server rather than guessing from the sync status alone.
   */
  useEffect(() => {
    let cancelled = false;

    if (!user) {
      setMigrationDeclined(false);
      return undefined;
    }

    readMigrationDecision(storage, user.id)
      .then((decision) => {
        if (!cancelled) setMigrationDeclined(decision?.accepted === false);
      })
      .catch(() => {
        if (!cancelled) setMigrationDeclined(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, storage, pendingMigration]);

  /**
   * Offers the move when a session arrives without passing through this form.
   *
   * Google sign-in and an email-confirmation link both create a session through
   * the auth provider, not through `handleSignIn`, so the consent step would
   * otherwise never be shown to them — and the phone's records could only ever
   * be pulled down, never offered up. Nothing is uploaded here: the effect only
   * decides whether to ask. Sync Now already refuses to upload without a
   * recorded yes, so the alternative state is safe, not leaky.
   *
   * The gate is per sheet opening. Without it, declining would clear
   * `pendingMigration` and the effect would immediately ask again, forever.
   */
  const migrationOfferChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) {
      migrationOfferChecked.current = null;
      return undefined;
    }
    if (!user || pendingMigration || resumeFailure) return undefined;
    if (migrationOfferChecked.current === user.id) return undefined;

    let cancelled = false;
    (async () => {
      try {
        const decision = await readMigrationDecision(storage, user.id);
        if (cancelled || decision !== null) return;

        const summary = await summariseGuestData(storage);
        if (cancelled || !hasMigratableData(summary)) return;

        migrationOfferChecked.current = user.id;
        setPendingMigration({ userId: user.id, summary });
      } catch {
        // The question is simply asked on the next opening; nothing moved.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, user, storage, pendingMigration, resumeFailure]);

  const clearForm = useCallback(() => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setDisplayName('');
    setNewPassword('');
    setPendingEmail('');
    setVerifyCode('');
    setResendRemaining(0);
    setErrorBanner(null);
    setInfoBanner(null);
  }, []);

  const handleSignIn = async () => {
    const attempt = beginAttempt();

    setIsLoading(true);
    setErrorBanner(null);
    setInfoBanner(null);
    setMigrationError(null);

    try {
      const res = await account.signIn(email, password);
      if (!isCurrent(attempt)) return;

      if (!res.success) {
        const message = res.error || 'Failed to sign in.';
        setErrorBanner(message);
        /*
         * "Please confirm your email" is a dead end on the sign-in form. The
         * same address can be confirmed from here, so the screen moves to the
         * step that can actually finish, with the address already filled in.
         */
        if (/confirm your email/i.test(message) && email.trim().includes('@')) {
          setPendingEmail(email.trim().toLowerCase());
          setResendRemaining(0);
          setAuthMode('verify');
        }
        return;
      }

      clearForm();

      const signedInId = (res.data as { user?: { id?: string } } | undefined)?.user?.id;
      if (!signedInId) {
        onClose();
        return;
      }

      /*
       * Decide whether to ask, before sending anything.
       *
       * Both reads are local, so this step cannot half-upload on failure. The ask
       * happens when there is something that would actually move AND this account
       * has never been asked; a previous answer is honoured rather than repeated.
       */
      const [summary, decision] = await Promise.all([
        summariseGuestData(storage),
        readMigrationDecision(storage, signedInId),
      ]);
      if (!isCurrent(attempt)) return;

      if (hasMigratableData(summary) && decision === null) {
        // Keep the sheet open and ask. Nothing is uploaded until they answer.
        setPendingMigration({ userId: signedInId, summary });
        return;
      }

      /*
       * A recorded "yes" is honoured here, on every later sign-in, not only the
       * one that produced it.
       *
       * The sheet stays open until the upload has settled. Closing first and
       * syncing in the background is what made a failed resume invisible: the
       * sheet was gone and the only trace was a line in the sync card that the
       * user had no reason to open. Nothing is asked again — the question was
       * already answered, and this only reports whether the answer was honoured.
       *
       * `decision.scopes` is used exactly as recorded. `readMigrationDecision`
       * only ever returns a non-empty list of names this build implements, so
       * there is nothing to default and deliberately no fallback here: a
       * fallback to every scope would turn an unreadable record into permission
       * for more than was ever agreed to.
       */
      if (decision?.accepted === true) {
        const scopes = decision.scopes;

        setResumeFailure(null);

        const state = await syncManager.syncAll(signedInId, storage, {
          uploadLocalData: true,
          scopes,
        });
        if (!isCurrent(attempt)) return;

        if (state.status === 'synced') {
          onClose();
        } else {
          setResumeFailure({ userId: signedInId, scopes, message: describeSyncFailure(state) });
        }
        return;
      }

      onClose();

      /*
       * A refusal, or no decision at all: pull the account's data down and send
       * nothing up.
       */
      syncManager
        .syncAll(signedInId, storage, { uploadLocalData: false })
        .catch(() => undefined);
    } catch (err) {
      /*
       * A local read or the sync itself threw. Sign-in is aborted rather than
       * left half-applied, and the spinner is cleared by the `finally` below so
       * the form is usable again immediately.
       */
      if (!isCurrent(attempt)) return;
      setErrorBanner(
        `Sign-in could not be completed on this phone (${
          err instanceof Error ? err.message : String(err)
        }). Nothing was uploaded, and nothing was removed from this phone.`,
      );
    } finally {
      // Only the action still in charge may clear the spinner; otherwise a
      // dismissal or a newer action has already taken responsibility for it.
      if (isCurrent(attempt)) setIsLoading(false);
    }
  };

  /**
   * Uploads the guest records the user just agreed to move.
   *
   * The decision is written *before* the upload begins: if the network drops
   * half way through, the agreement still stands, so retrying does not ask the
   * same question twice. Local storage is never deleted on any path — the sync
   * engine only reads from it — so a failure costs the user nothing.
   */
  const handleMigrationAccept = async () => {
    if (!pendingMigration) return;
    const attempt = beginAttempt();
    const { userId, summary } = pendingMigration;
    const scopes = migratableScopesFor(summary);

    setIsLoading(true);
    setMigrationError(null);

    try {
      try {
        await recordMigrationDecision(storage, userId, true, scopes);
      } catch (err) {
        /*
         * The agreement could not be stored, so there is no permission on record
         * — and an upload that outran its own record of consent is exactly what
         * this screen exists to prevent. Nothing is sent, and the question stays
         * on screen rather than the sheet closing on an answer that does not
         * exist.
         */
        if (!isCurrent(attempt)) return;
        setMigrationError(
          `Your choice could not be saved on this phone (${
            err instanceof Error ? err.message : String(err)
          }), so nothing was uploaded. Every record is still on this phone.`,
        );
        return;
      }

      if (!isCurrent(attempt)) return;

      const state = await syncManager.syncAll(userId, storage, {
        uploadLocalData: true,
        scopes,
      });
      if (!isCurrent(attempt)) return;

      if (state.status === 'synced') {
        setPendingMigration(null);
        onClose();
        return;
      }

      setMigrationError(
        state.status === 'offline'
          ? 'No connection to the server, so nothing was uploaded. Every record is still on this phone.'
          : `The upload did not finish: ${state.lastError ?? 'unknown error'}. Nothing was removed from this phone.`,
      );
    } catch (err) {
      // An unexpected throw must leave a usable screen, not a stuck spinner.
      if (!isCurrent(attempt)) return;
      setMigrationError(
        `The upload could not be completed (${
          err instanceof Error ? err.message : String(err)
        }). Every record is still on this phone.`,
      );
    } finally {
      if (isCurrent(attempt)) setIsLoading(false);
    }
  };

  /**
   * Leaves every local record where it is and records the refusal.
   *
   * No sync runs at all on this path, so the answer cannot be undone by a later
   * merge in the same breath as the question that produced it.
   */
  const handleMigrationDecline = async () => {
    if (!pendingMigration) return;
    const attempt = beginAttempt();
    const { userId } = pendingMigration;

    setIsLoading(true);

    try {
      try {
        await recordMigrationDecision(storage, userId, false, []);
      } catch (err) {
        /*
         * The refusal could not be stored, so it is not treated as recorded. The
         * sheet stays open with the question still on it: closing here would
         * discard an answer the user did give, and the next sign-in would ask
         * again as though they had said nothing.
         */
        if (!isCurrent(attempt)) return;
        setMigrationError(
          `Your choice could not be saved on this phone (${
            err instanceof Error ? err.message : String(err)
          }), so it has not been recorded. Nothing was uploaded.`,
        );
        return;
      }

      if (!isCurrent(attempt)) return;
      setPendingMigration(null);
      setMigrationError(null);
      onClose();
    } finally {
      if (isCurrent(attempt)) setIsLoading(false);
    }
  };

  /**
   * Retries a migration the user had already agreed to.
   *
   * Consent is untouched: this repeats work, it does not ask anything. The same
   * scope list is used as the one agreed to, so a retry cannot widen what was
   * permitted.
   */
  const handleResumeRetry = async () => {
    if (!resumeFailure) return;
    const attempt = beginAttempt();
    const { userId, scopes } = resumeFailure;

    setIsLoading(true);

    try {
      const state = await syncManager.syncAll(userId, storage, {
        uploadLocalData: true,
        scopes,
      });
      if (!isCurrent(attempt)) return;

      if (state.status === 'synced') {
        setResumeFailure(null);
        onClose();
        return;
      }

      setResumeFailure({ userId, scopes, message: describeSyncFailure(state) });
    } catch (err) {
      /*
       * An unexpected throw must not take the retry button with it. The failure
       * state is re-set explicitly so the user is left with the same screen plus
       * a reason, rather than a spinner that will never stop.
       */
      if (!isCurrent(attempt)) return;
      setResumeFailure({
        userId,
        scopes,
        message: `${err instanceof Error ? err.message : String(err)}. Every record is still on this phone.`,
      });
    } finally {
      if (isCurrent(attempt)) setIsLoading(false);
    }
  };

  /**
   * Closing the sheet mid-question is a cancel, not an answer.
   *
   * Nothing is recorded, so the offer is made again next time rather than the
   * user being silently counted as having declined. A resume failure is
   * likewise not recorded, so the next sign-in tries again — the error remains
   * visible in the sync card in the meantime.
   *
   * It also revokes the right of anything still in flight to write state. This
   * is what makes the dismissal stick: an upload already running when the sheet
   * closed resolves afterwards, finds it is no longer the current attempt, and
   * returns without setting the failure banner that would have reopened the
   * panel the user just dismissed.
   */
  const handleSheetClose = useCallback(() => {
    beginAttempt();
    setPendingMigration(null);
    setMigrationError(null);
    setResumeFailure(null);
    // A dismissed sheet is not busy. Leaving this set would show a spinner the
    // next time the sheet opened, for a request nobody is waiting on any more.
    setIsLoading(false);
    onClose();
  }, [onClose, beginAttempt]);

  const handleSignUp = async () => {
    if (password !== confirmPassword) {
      setErrorBanner('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    setErrorBanner(null);
    setInfoBanner(null);

    const res = await account.signUp(email, password, displayName);
    setIsLoading(false);

    if (res.success) {
      if (res.needsEmailConfirmation) {
        const cleanEmail = email.trim().toLowerCase();
        setPendingEmail(cleanEmail);
        // One message has just been sent, so pacing starts now rather than at
        // zero. The first resend is available a minute after this one.
        setResendRemaining(RESEND_COOLDOWN_SECONDS);
        setInfoBanner(
          `Account created, but it is not active yet. Open the confirmation link sent to ${cleanEmail}. Nothing on this phone has been uploaded. If the message does not arrive, check the spam folder or send a new link below.`,
        );
        setAuthMode('verify');
      } else {
        clearForm();
        onClose();
      }
    } else {
      setErrorBanner(res.error || 'Failed to create account.');
    }
  };

  /**
   * Sends another confirmation email for the address already waiting.
   *
   * The success sentence is conditional on purpose: the provider may accept a
   * request for an address that is in fact already confirmed, and saying "a new
   * link was sent" would then be a claim this screen cannot verify.
   */
  const handleResendConfirmation = async () => {
    const target = pendingEmail || email.trim().toLowerCase();
    if (resendRemaining > 0 || isLoading) return;
    if (!target) {
      setErrorBanner('Enter the email address the account was created with.');
      return;
    }

    setIsLoading(true);
    setErrorBanner(null);
    setInfoBanner(null);

    const res = await resendConfirmationEmail(target);
    setIsLoading(false);

    if (res.success) {
      setResendRemaining(RESEND_COOLDOWN_SECONDS);
      setInfoBanner(
        `If ${target} is still waiting for confirmation, a new link is on its way. Only the newest message will work.`,
      );
    } else {
      setErrorBanner(res.error || 'A new link could not be sent.');
    }
  };

  /**
   * Confirms with the six-digit code, for a person reading mail somewhere the
   * link cannot be opened. The code is the same single-use token the provider
   * issued; nothing here can activate an account without it.
   */
  const handleVerifyCode = async () => {
    const target = pendingEmail || email.trim().toLowerCase();
    if (isLoading) return;

    setIsLoading(true);
    setErrorBanner(null);
    setInfoBanner(null);

    const res = await verifyEmailCode(target, verifyCode);
    setIsLoading(false);

    if (!res.success) {
      setErrorBanner(res.error || 'The code could not be confirmed.');
      return;
    }

    if (res.data?.session) {
      clearForm();
      onClose();
      return;
    }

    /*
     * Confirmed but no session: the account is usable now, and the next step is
     * an ordinary sign-in. Saying "confirmed" is true; saying "signed in" would
     * not be.
     */
    setVerifyCode('');
    setInfoBanner('Email confirmed. Sign in with your password to continue.');
    setAuthMode('signin');
  };

  /**
   * Opens the provider's Google page in the phone's browser.
   *
   * This call cannot know whether the browser sign-in succeeded — the answer
   * arrives on the deep link. The sentence after it says exactly that, including
   * what happens if the browser is simply closed: nothing.
   */
  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setErrorBanner(null);
    setInfoBanner(null);

    const res = await signInWithGoogle();
    setIsLoading(false);

    if (!res.success) {
      setErrorBanner(res.error || 'Google sign-in could not be started.');
      return;
    }

    setInfoBanner(
      'Continue in the browser window. When you finish there, Sanket Vaanni opens again and signs you in. If you close the browser without finishing, nothing on this phone changes.',
    );
  };

  const handleForgotPassword = async () => {
    setIsLoading(true);
    setErrorBanner(null);
    setInfoBanner(null);

    const res = await account.requestPasswordReset(email);
    setIsLoading(false);

    if (res.success) {
      setInfoBanner(
        'Password reset link sent to your email. Click it from your phone to reset.',
      );
    } else {
      setErrorBanner(res.error || 'Failed to send reset link.');
    }
  };

  const handleUpdatePassword = async () => {
    setIsLoading(true);
    setErrorBanner(null);
    setInfoBanner(null);

    const res = await account.updatePassword(newPassword);
    setIsLoading(false);

    if (res.success) {
      setInfoBanner('Password updated successfully.');
      setAuthMode('signin');
      clearForm();
    } else {
      setErrorBanner(res.error || 'Failed to update password.');
    }
  };

  const handleSignOut = async () => {
    setIsLoading(true);
    await account.signOut();
    setIsLoading(false);
    setConfirmSignOut(false);
    clearForm();
  };

  /*
   * The deletion dialog confirms with a code from the user's email. Only after
   * the backend reports the account gone does local state get cleared; a
   * failure leaves the sheet exactly as it was, with the account still usable.
   */
  const handleAccountDeleted = () => {
    account.completeAccountDeletion();
    clearForm();
    onClose();
  };

  /**
   * Withdraws a recorded refusal so the question can be asked again.
   *
   * Without this the consent step would be a one-way door: a single tap of
   * "Keep it on this phone" would end the conversation permanently, which is not
   * what consent means. Clearing the answer and re-summarising puts the user back
   * at the question with nothing uploaded in the meantime.
   */
  const handleReconsider = async () => {
    if (!user) return;
    const attempt = beginAttempt();
    setIsLoading(true);

    try {
      try {
        await clearMigrationDecision(storage, user.id);
      } catch (err) {
        // The stored answer is untouched, so the notice stays and telling the
        // user it was withdrawn would be untrue.
        if (!isCurrent(attempt)) return;
        setErrorBanner(
          `The saved answer could not be cleared on this phone (${
            err instanceof Error ? err.message : String(err)
          }). Nothing changed.`,
        );
        return;
      }

      if (!isCurrent(attempt)) return;
      setMigrationDeclined(false);

      /*
       * The answer is already cleared by this point. If the re-read fails, the
       * prompt simply does not open; the question is asked again the next time
       * the sheet is opened, because nothing is recorded any more.
       */
      try {
        const summary = await summariseGuestData(storage);
        if (!isCurrent(attempt)) return;
        if (hasMigratableData(summary)) {
          setPendingMigration({ userId: user.id, summary });
        }
      } catch {
        // Deliberately silent: nothing was uploaded and nothing was lost.
      }
    } finally {
      if (isCurrent(attempt)) setIsLoading(false);
    }
  };

  /**
   * The explicit "Sync Now" action.
   *
   * Uploads only when this account has agreed to it. Someone who declined the
   * migration can still pull their account's data down, but pressing this
   * button must not quietly send up the very records they chose to keep local.
   */
  const handleSyncNow = async () => {
    if (!user) return;
    const attempt = beginAttempt();
    setIsLoading(true);

    try {
      const decision = await readMigrationDecision(storage, user.id);
      if (!isCurrent(attempt)) return;

      /*
       * `readMigrationDecision` returns either a refusal or a non-empty list of
       * scopes this build implements, so there is nothing to default here — and
       * deliberately no fallback: widening to every scope on an unreadable
       * record would send records the user chose to keep on this phone.
       */
      await syncManager.syncAll(user.id, storage, {
        uploadLocalData: decision?.accepted === true,
        scopes: decision?.scopes ?? [],
      });
    } catch (err) {
      if (!isCurrent(attempt)) return;
      setErrorBanner(
        `The sync could not be started (${
          err instanceof Error ? err.message : String(err)
        }). Nothing was removed from this phone.`,
      );
    } finally {
      if (isCurrent(attempt)) setIsLoading(false);
    }
  };

  // Dynamic titles and subtitles based on screen state
  let sheetTitle = 'Cloud Account';
  let sheetDescription = 'Synchronize preferences and glove configurations';

  if (pendingMigration) {
    sheetTitle = 'Move this phone’s data?';
    sheetDescription =
      'You are signed in. Nothing has been uploaded yet — this is your choice to make.';
  } else if (resumeFailure) {
    sheetTitle = 'Your upload did not finish';
    sheetDescription =
      'You already agreed to this, so nothing is being asked again. Your records are safe on this phone.';
  } else if (!user) {
    if (authMode === 'signin') {
      sheetTitle = 'Sign In to Sanket Vaanni';
      sheetDescription = 'Access your synced preferences and calibration across devices';
    } else if (authMode === 'signup') {
      sheetTitle = 'Create Cloud Account';
      sheetDescription = 'Sync your glove settings and offline history to Supabase';
    } else if (authMode === 'forgot') {
      sheetTitle = 'Reset Password';
      sheetDescription = 'Receive a recovery link to restore account access';
    } else if (authMode === 'verify') {
      sheetTitle = 'Confirm Your Email';
      sheetDescription = 'The account exists, but it cannot be used until the address is confirmed';
    } else if (authMode === 'update_password') {
      sheetTitle = 'Set New Password';
      sheetDescription = 'Enter your new account password';
    }
  }

  return (
    <>
      <Sheet
        visible={visible}
        onClose={handleSheetClose}
        title={sheetTitle}
        description={sheetDescription}
        footer={
          <ActionButton
            label={
              pendingMigration || resumeFailure ? 'Not now' : user ? 'Done' : 'Close'
            }
            tone="ghost"
            onPress={handleSheetClose}
          />
        }
      >
        <View style={styles.content}>
          {/* Informational Error / Success Banners */}
          {errorBanner && (
            <Card sunken style={[styles.banner, { borderColor: palette.danger }]}>
              <View style={styles.bannerRow}>
                <Icon name="warning" size={16} color={palette.danger} />
                <AppText variant="caption" color={palette.danger} style={styles.bannerText}>
                  {errorBanner}
                </AppText>
              </View>
            </Card>
          )}

          {infoBanner && (
            <Card sunken style={[styles.banner, { borderColor: palette.accent }]}>
              <View style={styles.bannerRow}>
                <Icon name="info" size={16} color={palette.accent} />
                <AppText variant="caption" color={palette.accent} style={styles.bannerText}>
                  {infoBanner}
                </AppText>
              </View>
            </Card>
          )}

          {/* Cloud Configuration Status */}
          {!supabaseConfigured && (
            <Card sunken style={styles.noticeCard}>
              <AppText variant="body" color={palette.warning}>
                Cloud sync is not configured. The app is running in Offline Guest Mode.
              </AppText>
              <AppText variant="caption" color={palette.textMuted}>
                All local preferences, 3D hand features, and OLED settings will remain safe on this phone.
              </AppText>
            </Card>
          )}

          {/* --------------------------------------- Resume Failure (agreed) */}
          {resumeFailure ? (
            <View style={styles.section} testID="guest-migration-resume">
              <Card style={styles.noticeCard}>
                <AppText variant="body" color={palette.textPrimary}>
                  Your agreed upload has not finished.
                </AppText>
                <AppText variant="caption" color={palette.textMuted} style={styles.migrationLine}>
                  You already agreed to move this phone’s records into your account, so you are
                  not being asked again. The records you agreed to are listed in your account
                  view; nothing has been sent twice, and nothing has been removed from this
                  phone.
                </AppText>
              </Card>

              <Card sunken style={[styles.banner, { borderColor: palette.danger }]}>
                <View style={styles.bannerRow}>
                  <Icon name="warning" size={16} color={palette.danger} />
                  <AppText
                    variant="caption"
                    color={palette.danger}
                    style={styles.bannerText}
                    testID="guest-migration-resume-error"
                  >
                    {resumeFailure.message}
                  </AppText>
                </View>
              </Card>

              {isLoading ? (
                <ActivityIndicator size="small" color={palette.accent} style={styles.loader} />
              ) : (
                <View style={styles.accountButtons}>
                  <ActionButton
                    label="Try Again"
                    tone="primary"
                    onPress={handleResumeRetry}
                    testID="guest-migration-resume-retry"
                    hint="Uploads only what has not already arrived"
                  />
                  <ActionButton
                    label="Not now"
                    tone="ghost"
                    onPress={handleSheetClose}
                    testID="guest-migration-resume-dismiss"
                    hint="Keeps every record here and tries again next time you sign in"
                  />
                </View>
              )}
            </View>
          ) : pendingMigration ? (
            <View style={styles.section} testID="guest-migration-step">
              <Card style={styles.noticeCard}>
                <AppText variant="body" color={palette.textPrimary}>
                  Nothing has been uploaded yet.
                </AppText>
                <AppText variant="caption" color={palette.textMuted} style={styles.migrationLine}>
                  Your records were made while you had no account, so they exist only on this
                  phone. You can move them to your account now or leave them here. Neither
                  choice deletes anything from this device.
                </AppText>
              </Card>

              <Card style={styles.noticeCard}>
                <View style={styles.migrationGroup}>
                  <AppText variant="body" color={palette.textPrimary}>
                    Would be uploaded
                  </AppText>
                  {pendingMigration.summary.hasPreferences ? (
                    <AppText variant="caption" color={palette.textSecondary} style={styles.migrationLine}>
                      • Your saved preferences and theme choice.
                    </AppText>
                  ) : null}
                  {pendingMigration.summary.calibrationSides.length > 0 ? (
                    <AppText variant="caption" color={palette.textSecondary} style={styles.migrationLine}>
                      • {pendingMigration.summary.calibrationSides.length === 2
                        ? 'Both glove calibrations'
                        : `The ${pendingMigration.summary.calibrationSides[0]} glove calibration`}
                      .
                    </AppText>
                  ) : null}
                  {pendingMigration.summary.oledProfileCount > 0 ? (
                    <AppText variant="caption" color={palette.textSecondary} style={styles.migrationLine}>
                      • {pendingMigration.summary.oledProfileCount} OLED studio{' '}
                      {pendingMigration.summary.oledProfileCount === 1 ? 'profile' : 'profiles'}.
                    </AppText>
                  ) : null}
                  {pendingMigration.summary.gloveHistoryCount > 0 ? (
                    <AppText variant="caption" color={palette.textSecondary} style={styles.migrationLine}>
                      • {pendingMigration.summary.gloveHistoryCount} history{' '}
                      {pendingMigration.summary.gloveHistoryCount === 1 ? 'entry' : 'entries'}{' '}
                      recorded from the glove.
                    </AppText>
                  ) : null}
                </View>
              </Card>

              <Card sunken style={styles.noticeCard}>
                <View style={styles.migrationGroup}>
                  <AppText variant="body" color={palette.textPrimary}>
                    Would stay on this phone
                  </AppText>
                  <AppText variant="caption" color={palette.textMuted} style={styles.migrationLine}>
                    • Every app setting, and any history recorded from simulated rather than real
                    glove data
                    {pendingMigration.summary.demoHistoryCount > 0
                      ? ` (${pendingMigration.summary.demoHistoryCount} such ${
                          pendingMigration.summary.demoHistoryCount === 1 ? 'entry' : 'entries'
                        })`
                      : ''}
                    . Simulated entries are never uploaded.
                  </AppText>
                  <AppText variant="caption" color={palette.textMuted} style={styles.migrationLine}>
                    • Nothing is removed from this phone, whichever you choose.
                  </AppText>
                </View>
              </Card>

              {migrationError && (
                <Card sunken style={[styles.banner, { borderColor: palette.danger }]}>
                  <View style={styles.bannerRow}>
                    <Icon name="warning" size={16} color={palette.danger} />
                    <AppText variant="caption" color={palette.danger} style={styles.bannerText}>
                      {migrationError}
                    </AppText>
                  </View>
                </Card>
              )}

              {isLoading ? (
                <ActivityIndicator size="small" color={palette.accent} style={styles.loader} />
              ) : (
                <View style={styles.accountButtons}>
                  <ActionButton
                    label={migrationError ? 'Try Again' : 'Upload to my account'}
                    tone="primary"
                    onPress={handleMigrationAccept}
                    testID="guest-migration-accept"
                    hint="Uploads only the records listed above"
                  />
                  <ActionButton
                    label="Keep it on this phone"
                    tone="ghost"
                    onPress={handleMigrationDecline}
                    testID="guest-migration-decline"
                    hint="Uploads nothing and keeps every record on this device"
                  />
                </View>
              )}
            </View>
          ) : user ? (            <View style={styles.section}>
              <Card style={styles.profileCard}>
                <View style={styles.profileHeader}>
                  <View style={styles.profileAvatar}>
                    <Icon name="link" size={24} color={palette.accent} />
                  </View>
                  <View style={styles.profileInfo}>
                    <AppText variant="heading" color={palette.textPrimary}>
                      {account.displayName ?? 'Signed In User'}
                    </AppText>
                    <AppText variant="caption" color={palette.textMuted}>
                      {user.email}
                    </AppText>
                  </View>
                  {syncState.status === 'synced' && <Badge label="Synced" tone="accent" />}
                  {syncState.status === 'syncing' && <Badge label="Syncing" tone="neutral" />}
                  {syncState.status === 'error' && <Badge label="Error" tone="danger" />}
                  {syncState.status === 'offline' && <Badge label="Offline" tone="neutral" />}
                </View>
              </Card>

              {/*
                Placed above the sync card, because it is the reason every
                control below it will fail. An account told "Sync Now" and then
                refused has been led into a fault it cannot diagnose.
              */}
              {suspension && (
                <Card sunken style={[styles.banner, { borderColor: palette.warning }]}>
                  <View style={styles.bannerRow}>
                    <Icon name="warning" size={16} color={palette.warning} />
                    <View style={styles.bannerText}>
                      <AppText variant="body" color={palette.textPrimary}>
                        {suspension.title}
                      </AppText>
                      <AppText variant="caption" color={palette.textSecondary}>
                        {suspension.summary}
                      </AppText>
                      {suspension.points.map((point) => (
                        <AppText
                          key={point}
                          variant="caption"
                          color={palette.textMuted}
                          style={styles.suspensionPoint}
                        >
                          • {point}
                        </AppText>
                      ))}
                    </View>
                  </View>
                </Card>
              )}

              {/* Sync Status Card */}
              <Card style={styles.syncCard}>
                <View style={styles.syncRow}>
                  <View style={styles.syncTextGroup}>
                    <AppText variant="body" color={palette.textPrimary}>
                      Cloud Synchronization
                    </AppText>
                    <AppText variant="caption" color={palette.textMuted}>
                      {syncState.lastSyncedAtMs
                        ? `Last synced: ${new Date(syncState.lastSyncedAtMs).toLocaleTimeString()}`
                        : 'Never synced'}
                    </AppText>
                  </View>
                  <ActionButton
                    label={syncState.status === 'syncing' ? 'Syncing...' : 'Sync Now'}
                    compact
                    tone="secondary"
                    onPress={handleSyncNow}
                    disabled={isLoading || syncState.status === 'syncing'}
                  />
                </View>
                {syncState.lastError && (
                  <AppText variant="caption" color={palette.danger} style={styles.syncError}>
                    {syncState.lastError}
                  </AppText>
                )}
                {/*
                  Shown only after a recorded refusal. Someone who has just said
                  no needs to be able to tell, without experimenting, that their
                  records are still only here — and that pressing Sync Now will
                  not quietly send them.
                */}
                {migrationDeclined && (
                  <>
                    <AppText
                      variant="caption"
                      color={palette.textMuted}
                      style={styles.syncError}
                      testID="migration-declined-notice"
                    >
                      Sync Now reads this account’s data onto the phone. The records you chose
                      to keep on this phone only — preferences, calibrations, OLED profiles and
                      glove history — are not uploaded by it, and would be lost with the phone.
                    </AppText>
                    <ActionButton
                      label="Ask me again"
                      tone="ghost"
                      compact
                      onPress={handleReconsider}
                      disabled={isLoading}
                      testID="migration-reconsider"
                    />
                  </>
                )}
              </Card>

              {/* Actions */}
              <View style={styles.accountButtons}>
                <ActionButton
                  label="Sign Out"
                  tone="ghost"
                  onPress={() => setConfirmSignOut(true)}
                  disabled={isLoading}
                />
                <ActionButton
                  label="Delete Cloud Account"
                  tone="ghost"
                  onPress={() => setConfirmDeleteAccount(true)}
                  disabled={isLoading}
                />
              </View>
            </View>
          ) : (
            /* ----------------------------------------------- Signed Out View */
            <View style={styles.section}>
              {/*
                Maintenance notice, before the form rather than after it.
                A sign-in attempted while the service is closed cannot get the
                user into the app, and saying so after they have typed a
                password would be a waste of their time and a bad surprise.
              */}
              {maintenanceOn ? (
                <Card sunken style={styles.noticeCard}>
                  <AppText variant="body" color={palette.warning}>
                    Sanket Vaanni is under maintenance. Signing in will not open the app.
                  </AppText>
                  <AppText variant="caption" color={palette.textMuted}>
                    Sign-in stays available so that an administrator can reach the console and
                    reopen the service. Creating a new account is paused until then.
                  </AppText>
                </Card>
              ) : null}

              {authMode === 'signin' && (
                <>
                  <TextField
                    label="Email address"
                    placeholder="signer@example.com"
                    autoCapitalize="none"
                    keyboardType="email-address"
                    value={email}
                    onChangeText={setEmail}
                  />

                  <TextField
                    label="Password"
                    placeholder="••••••••"
                    secureTextEntry
                    value={password}
                    onChangeText={setPassword}
                  />

                  {isLoading ? (
                    <ActivityIndicator size="small" color={palette.accent} style={styles.loader} />
                  ) : (
                    <ActionButton
                      label="Sign In"
                      tone="primary"
                      onPress={handleSignIn}
                      disabled={!email || !password}
                    />
                  )}

                  <View style={styles.secondaryLinks}>
                    <ActionButton
                      label="Create Account"
                      tone="ghost"
                      // Creating an account during maintenance would produce an
                      // account that immediately cannot be used, so the offer is
                      // withdrawn rather than made and then refused.
                      disabled={maintenanceOn}
                      hint={
                        maintenanceOn
                          ? 'Paused while Sanket Vaanni is under maintenance'
                          : undefined
                      }
                      onPress={() => {
                        setErrorBanner(null);
                        setAuthMode('signup');
                      }}
                    />
                    <ActionButton
                      label="Forgot Password?"
                      tone="ghost"
                      onPress={() => {
                        setErrorBanner(null);
                        setAuthMode('forgot');
                      }}
                    />
                  </View>
                </>
              )}

              {authMode === 'signup' && (
                <>
                  <TextField
                    label="Display name (optional)"
                    placeholder="Aryan"
                    value={displayName}
                    onChangeText={setDisplayName}
                  />

                  <TextField
                    label="Email address"
                    placeholder="signer@example.com"
                    autoCapitalize="none"
                    keyboardType="email-address"
                    value={email}
                    onChangeText={setEmail}
                  />

                  <TextField
                    label="Password"
                    placeholder="At least 6 characters"
                    secureTextEntry
                    value={password}
                    onChangeText={setPassword}
                  />

                  <TextField
                    label="Confirm password"
                    placeholder="Re-enter password"
                    secureTextEntry
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                  />

                  {isLoading ? (
                    <ActivityIndicator size="small" color={palette.accent} style={styles.loader} />
                  ) : (
                    <ActionButton
                      label="Create Account"
                      tone="primary"
                      onPress={handleSignUp}
                      disabled={!email || password.length < 6 || !confirmPassword}
                    />
                  )}

                  <ActionButton
                    label="Already have an account? Sign In"
                    tone="ghost"
                    onPress={() => {
                      setErrorBanner(null);
                      setAuthMode('signin');
                    }}
                  />
                </>
              )}

              {authMode === 'verify' && (
                <>
                  <AppText variant="caption" color={palette.textSecondary} style={styles.flowDescription}>
                    {pendingEmail || 'This address'} is registered, but the account is not active
                    yet. Open the confirmation link in the newest email — or, if that email shows
                    a six-digit code, enter the code here.
                  </AppText>

                  <ActionButton
                    label={
                      resendRemaining > 0
                        ? `Send a new link in ${resendRemaining}s`
                        : 'Send a new confirmation link'
                    }
                    tone="secondary"
                    onPress={handleResendConfirmation}
                    disabled={resendRemaining > 0 || isLoading}
                    busy={isLoading}
                    testID="auth-resend"
                  />

                  <TextField
                    label="Six-digit code"
                    placeholder="123456"
                    keyboardType="number-pad"
                    maxLength={6}
                    value={verifyCode}
                    onChangeText={setVerifyCode}
                    hint="Only if the confirmation email contains a code."
                    testID="auth-verify-code"
                  />

                  <ActionButton
                    label="Confirm with code"
                    tone="primary"
                    onPress={handleVerifyCode}
                    disabled={!/^\d{6}$/.test(verifyCode) || isLoading}
                    testID="auth-verify-submit"
                  />

                  <ActionButton
                    label="Back to Sign In"
                    tone="ghost"
                    onPress={() => {
                      setErrorBanner(null);
                      setInfoBanner(null);
                      setAuthMode('signin');
                    }}
                  />
                </>
              )}

              {authMode === 'forgot' && (
                <>
                  <AppText variant="caption" color={palette.textSecondary} style={styles.flowDescription}>
                    Enter your email to receive a password reset link for Sanket Vaanni.
                  </AppText>

                  <TextField
                    label="Email address"
                    placeholder="signer@example.com"
                    autoCapitalize="none"
                    keyboardType="email-address"
                    value={email}
                    onChangeText={setEmail}
                  />

                  {isLoading ? (
                    <ActivityIndicator size="small" color={palette.accent} style={styles.loader} />
                  ) : (
                    <ActionButton
                      label="Send Password Reset Link"
                      tone="primary"
                      onPress={handleForgotPassword}
                      disabled={!email}
                    />
                  )}

                  <ActionButton
                    label="Back to Sign In"
                    tone="ghost"
                    onPress={() => {
                      setErrorBanner(null);
                      setAuthMode('signin');
                    }}
                  />
                </>
              )}

              {authMode === 'update_password' && (
                <>
                  <AppText variant="caption" color={palette.textSecondary} style={styles.flowDescription}>
                    Enter a new password for your Sanket Vaanni account.
                  </AppText>

                  <TextField
                    label="New Password"
                    placeholder="At least 6 characters"
                    secureTextEntry
                    value={newPassword}
                    onChangeText={setNewPassword}
                  />

                  {isLoading ? (
                    <ActivityIndicator size="small" color={palette.accent} style={styles.loader} />
                  ) : (
                    <ActionButton
                      label="Update Password"
                      tone="primary"
                      onPress={handleUpdatePassword}
                      disabled={newPassword.length < 6}
                    />
                  )}
                </>
              )}

              {(authMode === 'signin' || authMode === 'signup') && (
                <>
                  <ActionButton
                    label="Continue with Google"
                    tone="secondary"
                    icon="link"
                    onPress={handleGoogleSignIn}
                    busy={isLoading}
                    // Creating an account during maintenance would produce the
                    // same unusable account the email form refuses to create.
                    disabled={maintenanceOn}
                    hint={
                      maintenanceOn
                        ? 'Paused while Sanket Vaanni is under maintenance'
                        : undefined
                    }
                    testID="auth-google"
                  />
                  <AppText variant="caption" color={palette.textMuted}>
                    Opens Google in your browser. Sanket Vaanni never sees your Google password,
                    and no second password is created for the account.
                  </AppText>
                </>
              )}

              {/* Informational guidance, and the guest route out of this sheet. */}
              <View style={styles.guestNotice}>
                <AppText variant="caption" color={palette.textMuted} style={styles.guestNoticeText}>
                  • You can use Sanket Vaanni without an account. A guest keeps every local
                  feature — the gloves, the 3D hand, the OLED editor, the audit and this phone&apos;s
                  own speech engine.
                </AppText>
                <AppText variant="caption" color={palette.warning} style={styles.guestNoticeText}>
                  • What a guest does is temporary. It is stored on this phone only: uninstalling
                  the app, or losing the phone, loses it. A guest who has never signed in does not
                  exist on the server at all, so no administrator can see, restore or recover that
                  data.
                </AppText>
                <AppText variant="caption" color={palette.textMuted} style={styles.guestNoticeText}>
                  • If you sign in, the app asks whether to move this phone&apos;s records —
                  preferences, calibrations, OLED profiles and glove-recorded history — into your
                  account. Nothing is uploaded unless you agree, and declining leaves all of it on
                  this device.
                </AppText>

                <ActionButton
                  label="Continue as guest"
                  tone="ghost"
                  onPress={onClose}
                  hint="Closes this sheet and keeps using the app without an account"
                />
              </View>
            </View>
          )}
        </View>
      </Sheet>

      {/* Confirmation Dialogs */}
      <ConfirmDialog
        visible={confirmSignOut}
        title="Sign Out"
        message="Signing out will pause cloud sync on this device. Your local calibration, OLED profiles, and settings will remain safe on this phone."
        confirmLabel="Sign Out"
        cancelLabel="Stay Signed In"
        onConfirm={handleSignOut}
        onCancel={() => setConfirmSignOut(false)}
      />

      <DeleteAccountDialog
        visible={confirmDeleteAccount}
        email={account.user?.email ?? account.profile?.email ?? null}
        onDeleted={handleAccountDeleted}
        onCancel={() => setConfirmDeleteAccount(false)}
      />
    </>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
  content: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  section: {
    gap: spacing.md,
  },
  banner: {
    borderWidth: 1,
    padding: spacing.sm,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  bannerText: {
    flex: 1,
  },
  suspensionPoint: {
    marginTop: spacing.xs,
  },
  noticeCard: {
    padding: spacing.sm,
  },
  /** Groups the enumerated lines of the migration offer under one heading. */
  migrationGroup: {
    gap: spacing.xs,
  },
  migrationLine: {
    lineHeight: 18,
  },
  flowDescription: {
    marginBottom: spacing.xs,
  },
  loader: {
    marginVertical: spacing.sm,
  },
  secondaryLinks: {
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  guestNotice: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    gap: spacing.xs,
  },
  guestNoticeText: {
    lineHeight: 18,
  },
  profileCard: {
    padding: spacing.md,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  profileAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: palette.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  syncCard: {
    padding: spacing.md,
    gap: spacing.md,
  },
  syncRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  syncTextGroup: {
    gap: spacing.xs,
  },
  syncError: {
    marginTop: spacing.xs,
  },
  accountButtons: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
});
