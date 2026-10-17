/**
 * The account, and everything a person can do to it.
 *
 * ## What is shown, and why the completion figure is computed
 *
 * The profile's completeness is derived from the fields that actually have
 * values in them — the display name, the avatar, and whether an account exists
 * at all. It is not a number written into the screen. A percentage baked into
 * the source is a claim that stops being true the moment anyone edits the
 * profile, and it is invariably left behind.
 *
 * ## What is deliberately absent
 *
 * No password field, no password display, and no way to see one. Changing a
 * password goes through the provider's own reset flow, because an application
 * that can read a password is an application that can leak it — and the honest
 * answer to "show me my password" is that no part of this system holds a
 * readable copy.
 *
 * ## Guests
 *
 * A guest has no account row, so there is nothing to edit and nothing to sync.
 * The screen says that rather than showing disabled fields, which would imply
 * something is broken rather than absent.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Linking, StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { DeleteAccountDialog } from '../components/DeleteAccountDialog';
import { DetailHeader } from '../components/DetailHeader';
import { Icon } from '../components/Icon';
import { ListRow } from '../components/ListRow';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { TextField } from '../components/TextField';
import { useAccount } from '../account/AccountProvider';
import {
  pickAvatar,
  removeAvatarByUrl,
  uploadAvatar,
} from '../account/avatar';
import { spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';

export interface ProfileScreenProps {
  onClose: () => void;
  /** Opens the account sheet, for signing in or creating an account. */
  onOpenAccount?: () => void;
}

export function ProfileScreen({ onClose, onOpenAccount }: ProfileScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const account = useAccount();

  const [displayName, setDisplayName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoStatus, setPhotoStatus] = useState<string | null>(null);

  /** The name being edited, falling back to the account's own value. */
  const currentName = displayName ?? account.displayName ?? '';
  const dirty = displayName !== null && displayName !== (account.displayName ?? '');

  const completion = useMemo(() => {
    /*
     * Only fields that genuinely exist are counted. An avatar is one, a display
     * name is one, and having an account rather than being a guest is one. The
     * denominator is the length of that list, so adding a field to the profile
     * means adding it here — the figure cannot silently stop matching reality.
     */
    const parts = [
      { label: 'an account', met: !account.isGuest },
      { label: 'a display name', met: (account.displayName ?? '').trim().length > 0 },
      { label: 'a photo', met: account.avatarUrl !== null },
    ];
    const met = parts.filter((part) => part.met);
    return {
      percent: Math.round((met.length / parts.length) * 100),
      missing: parts.filter((part) => !part.met).map((part) => part.label),
      total: parts.length,
      met: met.length,
    };
  }, [account.isGuest, account.displayName, account.avatarUrl]);

  const saveName = useCallback(async () => {
    if (displayName === null) return;
    setSaving(true);
    setStatus(null);
    const result = await account.updateProfile({ displayName: displayName.trim() });
    setSaving(false);
    if (result.success) {
      setStatus('Saved.');
      return;
    }
    setStatus(result.error ?? 'The name could not be saved.');
  }, [account, displayName]);

  /*
   * The upload order is what makes a failure safe: the new object is written
   * first, the row is pointed at it second, and only then is the old object
   * removed. Every interruption leaves either the old photo or the new one
   * referenced — never neither.
   */
  const changePhoto = useCallback(async () => {
    const userId = account.user?.id ?? null;
    if (userId === null) return;

    setPhotoStatus(null);
    const picked = await pickAvatar();
    if (!picked.ok) {
      if (!picked.cancelled && picked.error !== null) setPhotoStatus(picked.error);
      return;
    }

    setPhotoBusy(true);
    const uploaded = await uploadAvatar(userId, picked.avatar);
    if (!uploaded.ok) {
      setPhotoBusy(false);
      setPhotoStatus(uploaded.error);
      return;
    }

    const previous = account.avatarUrl;
    const saved = await account.updateProfile({ avatarUrl: uploaded.url });
    if (!saved.success) {
      // The row still points at the old photo, so the new object is an orphan.
      await removeAvatarByUrl(uploaded.url);
      setPhotoBusy(false);
      setPhotoStatus(saved.error ?? 'The photo could not be saved.');
      return;
    }

    await removeAvatarByUrl(previous);
    setPhotoBusy(false);
    setPhotoStatus('Photo updated.');
  }, [account]);

  const removePhoto = useCallback(async () => {
    const previous = account.avatarUrl;
    if (previous === null) return;

    setPhotoBusy(true);
    setPhotoStatus(null);
    const saved = await account.updateProfile({ avatarUrl: null });
    if (!saved.success) {
      setPhotoBusy(false);
      setPhotoStatus(saved.error ?? 'The photo could not be removed.');
      return;
    }
    await removeAvatarByUrl(previous);
    setPhotoBusy(false);
    setPhotoStatus('Photo removed.');
  }, [account]);

  const confirmSignOut = useCallback(() => {
    Alert.alert(
      'Sign out?',
      'Your preferences stay on this phone. Anything that has not finished syncing will stop until you sign in again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => {
            void account.signOut();
          } },
      ],
    );
  }, [account]);

  /*
   * The old flow deleted on a single Alert confirmation. That is gone: deletion
   * now requires a code sent to the account's verified address, so the button
   * opens the same dialog the account sheet uses rather than a second, weaker
   * path.
   */
  const confirmDelete = useCallback(() => {
    setDeleting(true);
  }, []);

  return (
    <>
      <Screen scroll testID="profile-screen">
      <DetailHeader title="Profile" onClose={onClose} subtitle="Your account on this device" />

      {/* -------------------------------------------------------- identity */}

      <Card style={styles.identity}>
        <Avatar
          name={account.displayName}
          uri={account.avatarUrl}
          size={64}
          accessibilityLabel={
            account.displayName === null ? 'No photo set' : `${account.displayName}'s photo`
          }
        />
        <View style={styles.identityText}>
          <AppText variant="heading">
            {account.displayName ?? (account.isGuest ? 'Guest' : 'Signed in')}
          </AppText>
          <AppText variant="caption" color={palette.textMuted}>
            {account.user?.email ?? 'No email — this device has no account'}
          </AppText>
          <View style={styles.badges}>
            {account.isAnonymous ? <Badge label="Guest account" tone="demo" /> : null}
            {account.isAdmin ? <Badge label="Administrator" tone="warning" /> : null}
            {account.profile?.status === 'suspended' ? (
              <Badge label="Suspended" tone="danger" />
            ) : null}
          </View>
        </View>
      </Card>

      {!account.isGuest && (
        <Card style={styles.group}>
          <View style={styles.photoRow}>
            <ActionButton
              label={account.avatarUrl === null ? 'Add a photo' : 'Change photo'}
              tone="secondary"
              compact
              icon="user"
              onPress={() => void changePhoto()}
              busy={photoBusy}
              style={styles.photoAction}
              testID="profile-change-photo"
            />
            {account.avatarUrl !== null && (
              <ActionButton
                label="Remove"
                tone="secondary"
                compact
                onPress={() => void removePhoto()}
                disabled={photoBusy}
                style={styles.photoAction}
                testID="profile-remove-photo"
              />
            )}
          </View>
          <AppText
            variant="caption"
            color={
              photoStatus === null || photoStatus.startsWith('Photo')
                ? palette.textMuted
                : palette.danger
            }
          >
            {photoStatus ??
              'JPEG, PNG or WebP, up to 2 MB. The photo is visible to anyone who can see your profile.'}
          </AppText>
        </Card>
      )}

      {account.profile?.status === 'suspended' ? (
        <Card style={styles.warning}>
          <Icon name="warning" size={14} color={palette.warning} />
          <AppText variant="caption" color={palette.textSecondary} style={styles.grow}>
            This account has been suspended by an administrator. Signing in and syncing may not
            work until it is restored.
          </AppText>
        </Card>
      ) : null}

      {/* ------------------------------------------------------ completeness */}

      <SectionHeader
        label="Profile"
        detail={`${completion.met} of ${completion.total} parts filled in.`}
        accessory={
          <AppText variant="caption" color={palette.textMuted}>
            {completion.percent}%
          </AppText>
        }
      />
      <Card style={styles.group}>
        <View style={styles.meter}>
          <View
            style={[
              styles.meterFill,
              { width: `${completion.percent}%`, backgroundColor: palette.accent },
            ]}
            // A bar with no text alternative is decoration; this one carries a
            // value, so it carries a label.
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={`Profile ${completion.percent} percent complete`}
            accessibilityValue={{ min: 0, max: 100, now: completion.percent }}
          />
        </View>
        <AppText variant="caption" color={palette.textMuted}>
          {completion.missing.length === 0
            ? 'Every part of the profile has a value.'
            : `Still missing ${listWords(completion.missing)}.`}
        </AppText>
      </Card>

      {/* ---------------------------------------------------------- editing */}

      {account.isGuest ? (
        <Card style={styles.group}>
          <AppText variant="caption" color={palette.textSecondary}>
            {account.cloudAvailable
              ? 'There is no account signed in, so there is no profile to edit and nothing to sync. Signing in creates one — your preferences on this phone are kept either way.'
              : 'This build has no account service configured, so there is no profile to edit. Everything stays on this phone.'}
          </AppText>
          {account.cloudAvailable && onOpenAccount !== undefined ? (
            <ActionButton
              label="Sign in or create an account"
              icon="user"
              onPress={() => {
                onClose();
                onOpenAccount?.();
              }}
            />
          ) : null}
        </Card>
      ) : (
        <>
          <SectionHeader label="Display name" detail="How your name appears in the app." />
          <Card style={styles.group}>
            <TextField
              label="Name"
              value={currentName}
              onChangeText={setDisplayName}
              placeholder="Your name"
              autoCapitalize="words"
              hint={status ?? undefined}
              invalid={status !== null && !status.startsWith('Saved')}
            />
            <ActionButton
              label="Save name"
              onPress={() => {
                void saveName();
              }}
              disabled={!dirty || saving}
              busy={saving}
            />
          </Card>

          <SectionHeader label="Password" detail="Changed through the account provider, never here." />
          <Card style={styles.group}>
            <AppText variant="caption" color={palette.textSecondary}>
              No part of Sanket Vaanni can read your password. Changing it sends a reset link to
              your email address, and the change happens with the account provider. No screen in
              this app can display a password, because none is ever available to it.
            </AppText>
            <ActionButton
              label="Send a password reset link"
              tone="secondary"
              icon="link"
              disabled={account.user?.email === undefined || account.user?.email === null}
              onPress={() => {
                const email = account.user?.email;
                if (email === undefined || email === null) return;
                void account.requestPasswordReset(email).then((result) => {
                  setStatus(
                    result.success
                      ? 'If that address has an account, a reset link is on its way.'
                      : (result.error ?? 'The reset request could not be sent.'),
                  );
                });
              }}
            />
            {status !== null ? (
              <AppText variant="caption" color={palette.textMuted}>
                {status}
              </AppText>
            ) : null}
          </Card>

          <SectionHeader label="Session" />
          <Card style={styles.group}>
            <ListRow
              label="Sign out"
              description="Ends this session on this device. Your preferences stay."
              icon="user"
              onPress={confirmSignOut}
              last
            />
          </Card>

          <SectionHeader
            label="Delete"
            detail="Removes the account and everything stored with it."
          />
          <Card style={styles.group}>
            <ActionButton
              label="Delete my account"
              tone="danger"
              icon="trash"
              onPress={confirmDelete}
            />
          </Card>
        </>
      )}

      {/* ---------------------------------------------------------- support */}

      <SectionHeader label="Support" />
      <Card style={styles.group}>
        <ListRow
          label="Email the team"
          value="sanketvaanni@gmail.com"
          description="Questions, problems, or a request about your data."
          icon="link"
          onPress={() => {
            void Linking.openURL('mailto:sanketvaanni@gmail.com').catch(() => undefined);
          }}
          last
        />
      </Card>

      {/*
        Nothing above writes a preference that this app does not read, and this
        line is the receipt: the settings that follow the account are named.
      */}
      <AppText variant="caption" color={palette.textMuted} style={styles.footer}>
        {
          'Synced with this account: your preferred sign profile, your output language, and your OLED layouts. Everything else — the theme, what is on screen, and any conversation — stays on the device you are holding.'
        }
      </AppText>
      </Screen>

      <DeleteAccountDialog
        visible={deleting}
        email={account.user?.email ?? account.profile?.email ?? null}
        onDeleted={() => {
          account.completeAccountDeletion();
          setDeleting(false);
          onClose();
        }}
        onCancel={() => setDeleting(false)}
      />
    </>
  );
}

/** "a, b and c" — no Oxford comma, because the app does not use one elsewhere. */
function listWords(items: readonly string[]): string {
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    identity: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.lg,
    },
    identityText: {
      flex: 1,
      minWidth: 0,
      gap: spacing.xs,
    },
    badges: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    warning: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      borderColor: palette.warning,
    },
    grow: {
      flex: 1,
    },
    group: {
      gap: spacing.md,
    },
    photoRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    photoAction: {
      flex: 1,
    },
    meter: {
      height: 6,
      borderRadius: 3,
      overflow: 'hidden',
      backgroundColor: palette.surfaceSunken,
    },
    meterFill: {
      height: 6,
      borderRadius: 3,
    },
    footer: {
      marginTop: spacing.md,
      marginBottom: spacing.xl,
    },
  });
