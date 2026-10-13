import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { TextField } from './TextField';
import { useAccount } from '../account/AccountProvider';
import { useAppState } from '../app/AppState';
import { syncManager } from '../supabase/sync';
import type { SyncState } from '../supabase/types';
import { spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';

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
}

type AuthMode = 'signin' | 'signup' | 'forgot' | 'update_password';

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
}: AccountSheetProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { storage } = useAppState();
  const account = useAccount();
  const { user } = account;

  const [authMode, setAuthMode] = useState<AuthMode>(isRecoveryMode ? 'update_password' : 'signin');
  const [syncState, setSyncState] = useState<SyncState>(syncManager.getState());

  // Form states
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // Status states
  const [isLoading, setIsLoading] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [infoBanner, setInfoBanner] = useState<string | null>(null);

  // Dialogs
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);

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

  const clearForm = useCallback(() => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setDisplayName('');
    setNewPassword('');
    setErrorBanner(null);
    setInfoBanner(null);
  }, []);

  const handleSignIn = async () => {
    setIsLoading(true);
    setErrorBanner(null);
    setInfoBanner(null);

    const res = await account.signIn(email, password);
    setIsLoading(false);

    if (res.success) {
      clearForm();
      onClose();
      /*
       * Sync after a successful sign-in, explicitly.
       *
       * This replaces an auth subscription that used to fire it. Doing it here
       * means it happens when this screen signs someone in, and not on every
       * session change anywhere in the app — and `syncAll` is safe to call when
       * there is nothing to send.
       */
      const signedInId = (res.data as { user?: { id?: string } } | undefined)?.user?.id;
      if (signedInId) {
        syncManager.syncAll(signedInId, storage).catch(() => undefined);
      }
    } else {
      setErrorBanner(res.error || 'Failed to sign in.');
    }
  };

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
        setInfoBanner(
          'Confirmation link sent! Please check your inbox before logging in.',
        );
        setAuthMode('signin');
      } else {
        clearForm();
        onClose();
      }
    } else {
      setErrorBanner(res.error || 'Failed to create account.');
    }
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

  const handleDeleteAccount = async () => {
    setIsLoading(true);
    const res = await account.deleteAccount();
    setIsLoading(false);
    setConfirmDeleteAccount(false);

    if (res.success) {
      clearForm();
      onClose();
    } else {
      setErrorBanner(res.error || 'Failed to delete account.');
    }
  };

  const handleSyncNow = async () => {
    if (!user) return;
    setIsLoading(true);
    await syncManager.syncAll(user.id, storage);
    setIsLoading(false);
  };

  // Dynamic titles and subtitles based on screen state
  let sheetTitle = 'Cloud Account';
  let sheetDescription = 'Synchronize preferences and glove configurations';

  if (!user) {
    if (authMode === 'signin') {
      sheetTitle = 'Sign In to Sanket Vaanni';
      sheetDescription = 'Access your synced preferences and calibration across devices';
    } else if (authMode === 'signup') {
      sheetTitle = 'Create Cloud Account';
      sheetDescription = 'Sync your glove settings and offline history to Supabase';
    } else if (authMode === 'forgot') {
      sheetTitle = 'Reset Password';
      sheetDescription = 'Receive a recovery link to restore account access';
    } else if (authMode === 'update_password') {
      sheetTitle = 'Set New Password';
      sheetDescription = 'Enter your new account password';
    }
  }

  return (
    <>
      <Sheet
        visible={visible}
        onClose={onClose}
        title={sheetTitle}
        description={sheetDescription}
        footer={
          <ActionButton
            label={user ? 'Done' : 'Close'}
            tone="ghost"
            onPress={onClose}
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

          {/* ------------------------------------------------ Signed In View */}
          {user ? (            <View style={styles.section}>
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

              {/* Informational guidance, and the guest route out of this sheet. */}
              <View style={styles.guestNotice}>
                <AppText variant="caption" color={palette.textMuted} style={styles.guestNoticeText}>
                  • Google Sign-In is not enabled on this Supabase project. Use Email/Password.
                </AppText>
                <AppText variant="caption" color={palette.textMuted} style={styles.guestNoticeText}>
                  • You can use Sanket Vaanni without an account. A guest keeps every local
                  feature — the gloves, the 3D hand, the OLED editor, the audit and this phone&apos;s
                  own speech engine.
                </AppText>
                <AppText variant="caption" color={palette.warning} style={styles.guestNoticeText}>
                  • What a guest does is temporary. It is stored on this phone only: uninstalling
                  the app, or losing the phone, loses it. A guest who has never signed in does not
                  exist on the server at all, so no administrator can see, restore or recover that
                  data — and signing in later does not upload it.
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

      <ConfirmDialog
        visible={confirmDeleteAccount}
        title="Delete Cloud Account"
        message="This will permanently delete your cloud account and all cloud-synced records. This cannot be undone."
        confirmLabel="Delete Forever"
        cancelLabel="Cancel"
        destructive
        onConfirm={handleDeleteAccount}
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
  noticeCard: {
    padding: spacing.sm,
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
