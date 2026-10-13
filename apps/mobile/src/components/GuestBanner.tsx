/**
 * The guest banner.
 *
 * ## What it says, and what it refuses to say
 *
 * A guest's data is on this device only. That is a real limitation with real
 * consequences — uninstalling the app loses everything — so the banner states
 * it. What it does not do is imply that an account is required, or that the app
 * is somehow broken without one. Guest-first means guest is a supported way to
 * use the product, not a trial.
 *
 * ## The two kinds of guest
 *
 * There are two, and they are genuinely different:
 *
 *  - **Local only.** Supabase is not configured, or the user has never been
 *    given an anonymous session. The server has never heard of this person and
 *    cannot list them. Nothing about them can be recovered.
 *  - **Anonymous account.** Supabase issued an anonymous session, so the server
 *    does know the account exists and its synced data can follow the device.
 *
 * The banner says which one applies, because "your data is on this device"
 * and "your data is tied to an anonymous account" are different promises. It
 * never claims an administrator can see a local-only user, because they cannot.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Icon } from './Icon';
import { useAccount } from '../account/AccountProvider';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface GuestBannerProps {
  /** Opens the account screen. */
  onOpenAccount: () => void;
  /** Hides the banner for this session. */
  onDismiss?: () => void;
}

export function GuestBanner({ onOpenAccount, onDismiss }: GuestBannerProps): React.JSX.Element | null {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { isGuest, isAnonymous, cloudAvailable } = useAccount();

  if (!isGuest) return null;

  const body = !cloudAvailable
    ? 'This device is not connected to an account service, so everything stays on this phone and no server has a copy. Uninstalling the app will remove it.'
    : isAnonymous
      ? 'You are using an anonymous account. The service knows this account exists, but it is tied to this device and can be lost if the app is removed.'
      : 'You are browsing as a guest. Everything stays on this phone, no server has a copy of it, and no administrator can see it. Uninstalling the app will remove it.';

  return (
    <View style={[styles.root, { backgroundColor: palette.accentSurface }]} testID="guest-banner">
      <Icon name="user" size={16} color={palette.accentSoft} />

      <View style={styles.text}>
        <AppText variant="label" color={palette.accentSoft}>
          {isAnonymous ? 'Anonymous account' : 'Guest mode'}
        </AppText>
        <AppText variant="caption" color={palette.textSecondary}>
          {body}
        </AppText>
      </View>

      <View style={styles.actions}>
        <ActionButton
          label={cloudAvailable ? 'Sign in' : 'Details'}
          tone="secondary"
          compact
          onPress={onOpenAccount}
          accessibilityLabel={cloudAvailable ? 'Sign in or create an account' : 'About guest mode'}
        />
        {onDismiss ? (
          <ActionButton
            label="Dismiss"
            tone="ghost"
            compact
            onPress={onDismiss}
            accessibilityLabel="Dismiss the guest notice"
          />
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    root: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.accentDim,
    },
    text: {
      flex: 1,
      gap: 2,
    },
    actions: {
      gap: spacing.xs,
      alignItems: 'flex-end',
    },
  });
