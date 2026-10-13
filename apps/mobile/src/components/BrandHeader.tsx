/**
 * The app header.
 *
 * ## What it is for
 *
 * The reference composition opens on a near-black field with one luminous
 * element. A large "Dashboard" title would fight that — it is the loudest thing
 * on screen and it says the least. So the header carries identity instead:
 *
 *   संकेत वाणी
 *   Dashboard · ISL → English                            (avatar)
 *
 * The wordmark is the brand; the screen name is small because the user already
 * knows which tab they tapped; and the translation pair is there because it is
 * the one piece of *state* a signing user needs visible at all times — it is
 * the answer to "what is this thing doing right now", and getting it wrong
 * mid-conversation is a real failure. It is read from the live preferences,
 * never hardcoded.
 *
 * ## The Devanagari
 *
 * `संकेत वाणी` renders in the platform's Devanagari face (Noto Sans Devanagari
 * on Android, Kohinoor/Kailasa on iOS). No font is bundled and no proprietary
 * typeface is claimed — this is the system face, which is present on every
 * device the app ships to and is the correct one for the script.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from './Avatar';
import { useAccount } from '../account/AccountProvider';
import { useAppState } from '../app/AppState';
import { findOutputLanguage } from '../app/preferences';
import { findProfile } from '../recognition/profiles';
import { useStyles } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, radii, spacing, typography } from '../theme';

/** The brand name, in Devanagari, as it appears on the product. */
export const BRAND_NAME = 'संकेत वाणी';

/**
 * The short form of a sign-language profile, e.g. `ISL`.
 *
 * Derived from the profile id rather than stored, so adding a profile cannot
 * produce a header that says one language and an abbreviation for another.
 */
export function shortProfileLabel(profileId: string): string {
  const profile = findProfile(profileId);
  if (!profile) return profileId.toLocaleUpperCase();
  return profile.id.toLocaleUpperCase();
}

export interface BrandHeaderProps {
  /** The current screen, shown small under the wordmark. */
  title?: string;
  /**
   * Whether to show the live translation pair. Off on screens where it is not
   * the subject — Settings, Admin, About — because repeating it everywhere
   * turns a status readout into wallpaper.
   */
  showLanguages?: boolean;
  /** Called when the avatar is tapped. Omit to render the avatar inert. */
  onPressAvatar?: () => void;
  /** Optional trailing control, placed left of the avatar. */
  right?: React.ReactNode;
  /** Optional content rendered under the header row, inside the same panel. */
  children?: React.ReactNode;
}

export function BrandHeader({
  title,
  showLanguages = true,
  onPressAvatar,
  right,
  children,
}: BrandHeaderProps): React.JSX.Element {
  const { preferences } = useAppState();
  const account = useAccount();
  const styles = useStyles(makeStyles);

  const profile = findProfile(preferences.signProfileId);
  const language = findOutputLanguage(preferences.targetLanguageCode);

  // Both halves come from the live preferences. If a stored profile id no
  // longer resolves we show the raw id rather than a friendly guess, because
  // silently substituting "Indian Sign Language" for an unrecognised id would
  // misreport what the app is configured to do.
  const sourceLabel = shortProfileLabel(preferences.signProfileId);
  const targetLabel = language?.name ?? preferences.targetLanguageCode.toLocaleUpperCase();

  const accessibilityPair = `Translating ${profile?.name ?? preferences.signProfileId} to ${targetLabel}`;

  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <View style={styles.titleBlock}>
          <Text style={styles.wordmark} accessibilityRole="header" allowFontScaling>
            {BRAND_NAME}
          </Text>

          <View style={styles.subtitleRow}>
            {title ? <Text style={styles.screenName}>{title}</Text> : null}
            {title && showLanguages ? <Text style={styles.dot}>·</Text> : null}
            {showLanguages ? (
              <View
                style={styles.pair}
                accessibilityRole="text"
                accessibilityLabel={accessibilityPair}
              >
                <Text style={styles.pairSource} allowFontScaling>
                  {sourceLabel}
                </Text>
                <Text style={styles.pairArrow}>→</Text>
                <Text style={styles.pairTarget} allowFontScaling>
                  {targetLabel}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.actions}>
          {right}
          <Avatar
            name={account.displayName}
            uri={account.avatarUrl}
            size={38}
            onPress={onPressAvatar}
            accessibilityLabel={
              account.isGuest
                ? 'Guest account. Open account options'
                : `${account.displayName ?? 'Account'}. Open account options`
            }
          />
        </View>
      </View>

      {children}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    root: {
      paddingHorizontal: layout.screenPadding,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      maxWidth: layout.maxContentWidth,
    },
    titleBlock: {
      flex: 1,
      // `minWidth: 0` lets the wordmark shrink rather than pushing the avatar
      // off screen on a narrow device with large font scaling on.
      minWidth: 0,
    },
    wordmark: {
      ...typography.title,
      color: palette.textPrimary,
      // Devanagari sits high on the line; the negative tracking the Latin type
      // scale uses would crowd the conjuncts, so it is not applied here.
      letterSpacing: 0,
    },
    subtitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: 1,
      flexWrap: 'wrap',
    },
    screenName: {
      ...typography.caption,
      color: palette.textMuted,
    },
    dot: {
      ...typography.caption,
      color: palette.textMuted,
    },
    pair: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radii.pill,
      backgroundColor: palette.accentSurface,
    },
    pairSource: {
      ...typography.caption,
      color: palette.accentSoft,
    },
    pairArrow: {
      ...typography.caption,
      color: palette.accent,
    },
    pairTarget: {
      ...typography.caption,
      color: palette.accent,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
  });
