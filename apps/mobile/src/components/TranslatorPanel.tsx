import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { Icon } from './Icon';
import { LanguageSelector } from './LanguageSelector';
import { LoadingDots } from './LoadingDots';
import { Sheet } from './Sheet';
import type { OutputLanguage } from '../app/preferences';
import { findOutputLanguage } from '../app/preferences';
import { findProfile, type SignLanguageProfile } from '../recognition/profiles';
import type { TranslationOutcome } from '../translation';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { MIN_TOUCH_TARGET, radii, spacing } from '../theme';

export interface TranslatorPanelProps {
  outcome: TranslationOutcome;
  signProfileId: string;
  targetLanguageCode: string;
  onChangeSignProfile: (profileId: string) => void;
  onChangeTargetLanguage: (code: string) => void;
  testID?: string;
}

/**
 * Live translator.
 *
 * ## What "live" means here
 *
 * Nothing is live yet, and the panel does not imply otherwise. What it does is
 * put the two language axes side by side, wired to real preferences, so the
 * pipeline is in place for the moment a recognised phrase exists — which is the
 * most that can honestly be built today.
 *
 * ## Distinguishing the empty states
 *
 * The result area never shows a bare "no translation". It says which of the two
 * reasons applies: recognition cannot produce a phrase at all, or a phrase is
 * pending. A single generic message would tell the user to keep signing when the
 * truthful answer is that nothing can be recognised.
 *
 * ## The configuration is in a sheet
 *
 * Two full option lists on the Dashboard would push the live content off the
 * first screen, which is the opposite of what this screen is for. The current
 * pair is shown as a summary, and the lists live one tap away — the same lists,
 * and the same component, that More uses.
 */
export function TranslatorPanel({
  outcome,
  signProfileId,
  targetLanguageCode,
  onChangeSignProfile,
  onChangeTargetLanguage,
  testID,
}: TranslatorPanelProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const [configOpen, setConfigOpen] = useState(false);

  const profile: SignLanguageProfile | undefined = findProfile(signProfileId);
  const language: OutputLanguage | undefined = findOutputLanguage(targetLanguageCode);

  const close = useCallback(() => setConfigOpen(false), []);

  return (
    <Card testID={testID} style={styles.card}>
      <View style={styles.headerRow}>
        <AppText variant="heading">Live translator</AppText>
        <Badge label="Not implemented" tone="neutral" />
      </View>

      <View style={styles.pair}>
        <PairRow
          caption="SIGN LANGUAGE"
          value={profile?.name ?? signProfileId}
          detail={profile?.nativeName ?? null}
          icon="hand"
        />
        <View style={styles.arrow}>
          <Icon name="chevronRight" size={14} color={palette.textMuted} />
        </View>
        <PairRow
          caption="OUTPUT"
          value={language?.name ?? targetLanguageCode}
          detail={language?.nativeName ?? null}
          icon="volume"
        />
      </View>

      <Pressable
        onPress={() => setConfigOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Change languages"
        accessibilityHint="Opens the sign language and output language lists"
        style={({ pressed }) => [styles.configButton, pressed && styles.pressed]}
      >
        <Icon name="refresh" size={16} color={palette.accent} />
        <AppText variant="label" color={palette.accent}>
          Change languages
        </AppText>
      </Pressable>

      <Result outcome={outcome} />

      <AppText variant="caption" color={palette.textMuted} style={styles.footnote}>
        Translation requires a vocabulary and a model, neither of which exists. Until
        then this panel reports why it has nothing to show rather than producing text.
      </AppText>

      <Sheet
        visible={configOpen}
        onClose={close}
        title="Languages"
        description="Two separate settings: what is being signed, and how the result is written."
        footer={<ActionButton label="Done" onPress={close} accessibilityLabel="Done" />}
      >
        <View style={styles.sheetBody}>
          <AppText variant="overline" overline color={palette.textMuted}>
            Sign language
          </AppText>
          <LanguageSelector
            axis="sign"
            value={signProfileId}
            onChange={onChangeSignProfile}
          />

          <AppText variant="overline" overline color={palette.textMuted} style={styles.sheetGap}>
            Output language
          </AppText>
          <LanguageSelector
            axis="translation"
            value={targetLanguageCode}
            onChange={onChangeTargetLanguage}
          />
        </View>
      </Sheet>
    </Card>
  );
}

function PairRow({
  caption,
  value,
  detail,
  icon,
}: {
  caption: string;
  value: string;
  detail: string | null;
  icon: 'hand' | 'volume';
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={styles.pairRow}>
      <View style={styles.pairIcon}>
        <Icon name={icon} size={16} color={palette.textSecondary} />
      </View>
      <View style={styles.pairText}>
        <AppText variant="overline" overline color={palette.textMuted}>
          {caption}
        </AppText>
        <AppText variant="label" numberOfLines={1}>
          {value}
        </AppText>
        {detail !== null && (
          <AppText variant="caption" color={palette.textMuted} numberOfLines={1}>
            {detail}
          </AppText>
        )}
      </View>
    </View>
  );
}

/**
 * The translation itself, or the reason there is none.
 *
 * Note what is absent from every branch: a spinner. Nothing is being computed,
 * so a loading indicator would be an animation that means "wait" when the
 * truthful meaning is "this does not exist". `LoadingDots` is used here only as
 * a static glyph on the pending state, not as a running animation.
 */
function Result({ outcome }: { outcome: TranslationOutcome }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  if (outcome.kind === 'translated') {
    return (
      <View style={styles.result}>
        <AppText variant="caption" color={palette.textMuted}>
          {outcome.sourceText}
        </AppText>
        <AppText variant="title" numberOfLines={3}>
          {outcome.text}
        </AppText>
      </View>
    );
  }

  const blocked = outcome.kind === 'blocked';

  return (
    <View
      style={[
        styles.result,
        styles.resultEmpty,
        { backgroundColor: palette.surfaceSunken },
      ]}
      accessible
      accessibilityLabel={
        blocked ? `Nothing to translate. ${outcome.reason}` : `Translation unavailable. ${outcome.reason}`
      }
    >
      <View style={styles.resultHeading}>
        {blocked ? (
          <LoadingDots size={4} color={palette.textMuted} accessibilityLabel={null} />
        ) : (
          <Icon name="warning" size={14} color={palette.warning} />
        )}
        <AppText variant="label" color={palette.textSecondary}>
          {blocked ? 'Nothing to translate' : 'Cannot translate'}
        </AppText>
      </View>

      <AppText variant="caption" color={palette.textMuted} style={styles.resultBody}>
        {outcome.reason}
      </AppText>

      {outcome.kind === 'unavailable' && (
        <AppText variant="body" color={palette.textSecondary} style={styles.resultBody}>
          {outcome.sourceText}
        </AppText>
      )}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.md,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    pair: {
      gap: spacing.sm,
    },
    pairRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radii.md,
      backgroundColor: palette.surfaceSunken,
    },
    pairIcon: {
      width: 28,
      alignItems: 'center',
    },
    pairText: {
      flex: 1,
      gap: 1,
    },
    arrow: {
      alignItems: 'center',
      // Rotated so the chevron points down between the two rows, which reads as
      // "becomes" rather than as "navigate".
      transform: [{ rotate: '90deg' }],
      marginVertical: -spacing.sm,
    },
    configButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      minHeight: MIN_TOUCH_TARGET,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: palette.border,
    },
    pressed: {
      opacity: 0.7,
    },
    result: {
      gap: spacing.xs,
    },
    resultEmpty: {
      padding: spacing.lg,
      borderRadius: radii.md,
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    resultHeading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    resultBody: {
      // The explanation is a sentence, not a label.
      maxWidth: 320,
    },
    footnote: {
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    sheetBody: {
      gap: spacing.sm,
    },
    sheetGap: {
      marginTop: spacing.lg,
    },
  });
