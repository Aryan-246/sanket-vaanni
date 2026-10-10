import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { useAppState } from '../app/AppState';
import { apiClient } from '../api/client';
import { SIGN_LANGUAGE_PROFILES } from '../recognition';
import { colors, spacing } from '../theme';

export interface SettingsScreenProps {
  onClose: () => void;
  onReplayIntro: () => void;
}

function Row({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <AppText variant="body" color={colors.textSecondary}>
        {label}
      </AppText>
      <AppText
        variant="body"
        color={valueColor ?? colors.textPrimary}
        style={styles.rowValue}
      >
        {value}
      </AppText>
    </View>
  );
}

export function SettingsScreen({
  onClose,
  onReplayIntro,
}: SettingsScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { transport, recognitionUnavailableReason, speechUnavailableReason } = useAppState();

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <AppText variant="title">Settings</AppText>
        <ActionButton label="Done" tone="ghost" onPress={onClose} style={styles.done} />
      </View>

      {/* --- Intro ------------------------------------------------------- */}
      <Card style={styles.section}>
        <AppText variant="overline" color={colors.textMuted} overline>
          Intro animation
        </AppText>
        <AppText variant="body" color={colors.textSecondary}>
          The opening animation plays once on first launch. You can watch it again
          at any time.
        </AppText>
        <ActionButton
          label="Replay intro"
          tone="secondary"
          onPress={onReplayIntro}
          style={styles.action}
        />
      </Card>

      {/* --- Sign language profiles -------------------------------------- */}
      <Card style={styles.section}>
        <AppText variant="overline" color={colors.textMuted} overline>
          Sign language profiles
        </AppText>
        <AppText variant="caption" color={colors.textMuted}>
          Sign languages do not share a gesture dictionary, so each is a separate
          profile. No vocabulary has been defined yet.
        </AppText>
        <View style={styles.profileList}>
          {SIGN_LANGUAGE_PROFILES.map((profile) => (
            <View key={profile.id} style={styles.profileRow}>
              <View style={styles.profileText}>
                <AppText variant="body">{profile.name}</AppText>
                {profile.nativeName !== null && (
                  <AppText variant="caption" color={colors.textMuted}>
                    {profile.nativeName}
                  </AppText>
                )}
              </View>
              <Badge tone="neutral" label={`${profile.status} · 0 signs`} />
            </View>
          ))}
        </View>
      </Card>

      {/* --- Diagnostics -------------------------------------------------- */}
      <Card style={styles.section}>
        <AppText variant="overline" color={colors.textMuted} overline>
          Diagnostics
        </AppText>
        <View style={styles.diag}>
          <Row label="Transport" value={transport.name} />
          <Row
            label="Data source"
            value={transport.isSynthetic ? 'Simulated' : 'Hardware'}
            valueColor={transport.isSynthetic ? colors.warning : colors.textPrimary}
          />
          <Row
            label="Backend"
            value={apiClient.baseUrl ?? 'Not configured'}
            valueColor={apiClient.baseUrl === null ? colors.textMuted : colors.textPrimary}
          />
        </View>
      </Card>

      {/* --- Not implemented --------------------------------------------- */}
      <Card style={styles.section}>
        <AppText variant="overline" color={colors.textMuted} overline>
          Not implemented yet
        </AppText>
        <View style={styles.notImplemented}>
          <AppText variant="caption" color={colors.textMuted}>
            Recognition
          </AppText>
          <AppText variant="caption" color={colors.textSecondary}>
            {recognitionUnavailableReason ?? 'Unavailable'}
          </AppText>
          <AppText variant="caption" color={colors.textMuted} style={styles.gapTop}>
            Speech
          </AppText>
          <AppText variant="caption" color={colors.textSecondary}>
            {speechUnavailableReason ?? 'Unavailable'}
          </AppText>
        </View>
      </Card>

      <AppText variant="caption" color={colors.textMuted} center>
        Sanket Vaanni · foundation build
      </AppText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  done: {
    paddingHorizontal: spacing.lg,
    minHeight: 40,
  },
  section: {
    gap: spacing.sm,
  },
  action: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
  },
  profileList: {
    marginTop: spacing.sm,
    gap: spacing.md,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  profileText: {
    flexShrink: 1,
  },
  diag: {
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  rowValue: {
    flexShrink: 1,
    textAlign: 'right',
  },
  notImplemented: {
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  gapTop: {
    marginTop: spacing.sm,
  },
});
