import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { BrandHeader } from '../components/BrandHeader';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { LanguageSelector } from '../components/LanguageSelector';
import { ListRow } from '../components/ListRow';
import { NoticesCard } from '../components/NoticesCard';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { SegmentedControl } from '../components/SegmentedControl';
import { Sheet } from '../components/Sheet';
import { VoicePanel } from '../components/VoicePanel';
import { useAccount } from '../account/AccountProvider';
import { useBuildFacts } from '../hooks/useBuildFacts';
import { PRODUCT_NAME } from '../config/app';
import { syncManager } from '../supabase/sync';
import type { SyncState } from '../supabase/types';
import { layout as screenLayout, radii, spacing } from '../theme';
import { useTheme } from '../theme/ThemeProvider';
import { findOutputLanguage, type ThemeMode } from '../app/preferences';
import { useAppState, usePushState, useNoticesState } from '../app/AppState';
import { describePushRow } from '../notifications/pushRow';

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: 'System', value: 'system' },
  { label: 'Dark', value: 'dark' },
  { label: 'Light', value: 'light' },
];

export interface MoreScreenProps {
  onReplayIntro?: () => void;
  onOpenOled?: () => void;
  onOpenAudit?: () => void;
  /** Opens the profile screen. Shown whether or not an account is signed in. */
  onOpenProfile?: () => void;
  /** Opens About Us. */
  onOpenAbout?: () => void;
  /** Opens the Super Admin section. */
  onOpenAdmin?: () => void;
  /** Opens the ML Learning Centre. */
  onOpenMl?: () => void;
  /** Opens the account surface, which the navigator hosts. */
  onOpenAccount?: () => void;
  initialRecoveryMode?: boolean;
  onCloseAccount?: () => void;
}

/**
 * Settings — everything that is not about a connected glove.
 *
 * ## Why this is called Settings now
 *
 * It was "More", which is what a screen is called when nobody decided what it
 * is. Every row on it is a setting or a fact about the build, and calling it
 * "Settings" means the header answers the question the user arrived with.
 */
export function MoreScreen({
  onReplayIntro,
  onOpenOled,
  onOpenAudit,
  onOpenProfile,
  onOpenAbout,
  onOpenAdmin,
  onOpenMl,
  onOpenAccount,
  initialRecoveryMode = false,
  onCloseAccount,
}: MoreScreenProps): React.JSX.Element {
  const { palette, mode, scheme, setMode } = useTheme();
  const { preferences, updatePreferences, profile, speaker } = useAppState();
  const { push } = useAppState();
  const pushState = usePushState();
  const { announcements } = useAppState();
  const notices = useNoticesState();
  const account = useAccount();
  const build = useBuildFacts();

  /*
   * The recognition row used to live here.
   *
   * It read "Models and vocabulary", counted trained versions and reported the
   * active one — and it was drawn for everybody, including a guest with no
   * account. That was wrong in kind, not in degree: every control behind it
   * trains, versions or activates a model, and none of those are a user's to
   * perform. It now lives in the administration console, which is where those
   * controls are authorised. Nothing here reads the learning centre any more, so
   * this screen no longer subscribes to it at all.
   */

  const [sheet, setSheet] = useState<'sign' | 'translation' | null>(null);
  const [syncState, setSyncState] = useState<SyncState>(syncManager.getState());

  /*
   * Sync status only.
   *
   * The session itself now comes from `useAccount()`. This screen used to hold
   * its own `getCurrentSession()` + `subscribeToAuthState` subscription as
   * well, which gave the app two independent sources of truth for whether
   * anyone was signed in — and a second subscription to keep in step.
   */
  useEffect(() => {
    const syncSub = syncManager.subscribe((state) => {
      setSyncState(state);
    });
    return syncSub;
  }, []);

  useEffect(() => {
    if (initialRecoveryMode) {
      onOpenAccount?.();
    }
    onCloseAccount?.();
  }, [initialRecoveryMode, onOpenAccount, onCloseAccount]);

  const language = findOutputLanguage(preferences.targetLanguageCode);
  const resolved = scheme === 'dark' ? 'Dark' : 'Light';

  /*
   * Which option the segmented control shows. When the preference is `system`,
   * the resolved scheme is shown next to it rather than instead of it — the
   * control must keep showing what the user chose, or selecting "System" would
   * appear to do nothing.
   */
  const themeDetail = useMemo(
    () =>
      mode === 'system'
        ? `Following your phone, which is currently in ${resolved.toLowerCase()} mode.`
        : `${resolved} mode, regardless of your phone's setting.`,
    [mode, resolved],
  );

  const closeSheet = useCallback(() => setSheet(null), []);

  /**
   * What the notification switch is actually doing, in one sentence.
   *
   * The wording lives in `../notifications/pushRow` and is tested there. It was
   * a chain of `if`s on this screen until a real device showed the difference it
   * was missing: the phone's own notification setting can be switched off — or
   * withdrawn by Android — long after the user switched notifications on here,
   * and the row went on saying they were on. The decision needs the platform's
   * answer, so it is made where that answer is available and asserted, not in
   * the middle of a layout.
   */
  const pushDetail = useMemo(() => describePushRow(pushState), [pushState]);

  /**
   * Hiding a notice.
   *
   * Recorded on this device and nowhere else, which is why the card's own footer
   * says so — a user who thinks a dismissal removes a warning for their whole
   * team would have been misled by the interface, not by the copy.
   */
  const dismissNotice = useCallback(
    (id: string) => {
      announcements.dismiss(id);
    },
    [announcements],
  );

  /**
   * Asking again after a failed notice check.
   *
   * The rejection is swallowed rather than left unhandled: the reader reports
   * failure through its state, which is what the card renders, so a rejected
   * promise here would be a second report of something already on screen.
   */
  const retryNotices = useCallback(() => {
    announcements.refresh().catch(() => undefined);
  }, [announcements]);

  return (
    <Screen scroll bottomInset={screenLayout.tabBarHeight} testID="more-screen">
      <BrandHeader title="Settings" showLanguages={false} onPressAvatar={onOpenAccount} />

      {/*
        * Notices sit above everything else on this screen, because a message an
        * administrator published for everybody outranks the settings below it.
        *
        * It renders nothing at all when there is nothing to show — that decision
        * lives in `announcements/reader.ts` and is tested there, rather than
        * being spread across this layout.
        */}
      <NoticesCard state={notices} onDismiss={dismissNotice} onRetry={retryNotices} />

      {/* ----------------------------------------------- cloud & account */}

      <SectionHeader label="Cloud & Account" detail="Cloud sync for preferences and OLED profiles." />
      <Card style={styles.group}>
        <ListRow
          label={account.displayName ?? (account.isGuest ? 'Local only' : 'Signed in')}
          value={
            account.isGuest
              ? 'Guest'
              : syncState.status === 'synced'
                ? 'Synced'
                : syncState.status === 'syncing'
                  ? 'Syncing...'
                  : syncState.status === 'error'
                    ? 'Sync error'
                    : 'Active'
          }
          description={
            account.isGuest
              ? account.cloudAvailable
                ? 'Everything lives on this phone. Tap to sign in and carry it across devices.'
                : 'No account service is configured, so everything stays on this phone. Tap for details.'
              : 'Signed in. Tap to manage your account, sync, or sign out.'
          }
          icon="link"
          onPress={onOpenAccount}
          testID="cloud-account-row"
          last={onOpenProfile === undefined}
        />
        {onOpenProfile !== undefined && (
          <ListRow
            label="Profile"
            value={account.isGuest ? 'Guest' : 'Your details'}
            description="Display name, photo and account controls."
            icon="user"
            onPress={onOpenProfile}
            last
            testID="profile-row"
          />
        )}
      </Card>

      {/* --------------------------------------------------- notifications */}

      <SectionHeader
        label="Notifications"
        detail="Messages sent to this phone by the Sanket Vaanni team."
      />
      <Card style={styles.group}>
        {pushState.available ? (
          <View style={styles.pushRow}>
            <Icon
              name="bell"
              size={18}
              color={pushState.enabled ? palette.accent : palette.textMuted}
            />
            <View style={styles.pushText}>
              <AppText variant="label">Push notifications</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                {pushDetail}
              </AppText>
            </View>
            <ActionButton
              label={pushState.enabled ? 'Turn off' : 'Turn on'}
              tone={pushState.enabled ? 'secondary' : 'primary'}
              compact
              busy={pushState.status === 'enabling'}
              onPress={() => {
                void (pushState.enabled ? push.disable() : push.enable());
              }}
              accessibilityLabel={
                pushState.enabled
                  ? 'Turn push notifications off for this phone'
                  : 'Turn push notifications on for this phone'
              }
            />
          </View>
        ) : (
          /*
           * No switch, because there is nothing it could do. A phone with no
           * Google Play services, or a build assembled without a Firebase
           * project, cannot receive these messages at all — and offering a
           * control that cannot work is worse than saying why.
           */
          <View style={styles.pushRow}>
            <Icon name="warning" size={18} color={palette.warning} />
            <AppText variant="caption" color={palette.textSecondary} style={styles.pushText}>
              {pushState.unavailableReason}
            </AppText>
          </View>
        )}
      </Card>

      {/* ----------------------------------------------------------- intro */}

      <SectionHeader label="Launch" />
      <Card style={styles.group}>
        <ListRow
          label="Replay intro"
          description="Plays the launch sequence again. It also plays on every cold start."
          icon="refresh"
          onPress={onReplayIntro}
          last
          testID="replay-intro-row"
        />
      </Card>

      {/* ------------------------------------------------------ appearance */}

      <SectionHeader label="Appearance" />
      <Card style={styles.card}>
        <SegmentedControl
          options={THEME_OPTIONS}
          value={mode}
          onChange={setMode}
          accessibilityLabel="Theme"
        />
        <AppText variant="caption" color={palette.textMuted}>
          {themeDetail} Saved on this device, applied immediately, and it needs no account.
        </AppText>
      </Card>

      {/* --------------------------------------------------- accessibility */}

      <SectionHeader label="Accessibility" detail="What the app takes from your phone." />
      <Card style={styles.group}>
        <ListRow
          label="App language"
          value="English"
          description="No other language pack exists yet, so there is nothing to switch between."
        />
        <ListRow
          label="Text size"
          value="Follows system"
          description="Uses your phone's font size setting. There is no in-app override."
        />
        <ListRow
          label="Reduce motion"
          value="Follows system"
          description="Skips the launch sequence when your phone asks for reduced motion."
          last
        />
      </Card>

      {/* ------------------------------------------------------- languages */}

      <SectionHeader label="Languages" />
      <Card style={styles.group}>
        <ListRow
          label="Sign language input"
          value={profile.name}
          description={
            profile.vocabularySize === 0
              ? 'Selected profile — no vocabulary defined for it yet.'
              : `${profile.vocabularySize} signs in this profile.`
          }
          icon="hand"
          onPress={() => setSheet('sign')}
        />
        <ListRow
          label="Output language"
          value={language?.name ?? preferences.targetLanguageCode.toUpperCase()}
          description={
            language
              ? `Spoken as ${language.speechTag}. Recognised vocabulary speaks directly in ${language.name}.`
              : `Spoken as ${preferences.targetLanguageCode.toUpperCase()}.`
          }
          icon="volume"
          onPress={() => setSheet('translation')}
          last
        />
      </Card>
      {/*
        One line, not four. This used to explain the relationship at length and
        then repeat the vocabulary gap the two rows above already state. What is
        left is the part a user cannot infer from the rows: that the two settings
        are independent, so choosing one does not imply the other.
      */}
      <AppText variant="caption" color={palette.textMuted}>
        These are two independent settings — the profile decides which signs would be read, the
        language decides how the result is written.
      </AppText>

      {/* ----------------------------------------------------------- voice */}

      <SectionHeader label="Speech output" />
      <VoicePanel
        enabled={preferences.voiceEnabled}
        onToggle={(next) => updatePreferences({ voiceEnabled: next })}
        available={speaker.isAvailable}
        unavailableReason={speaker.unavailableReason}
        phrase={null}
        showTitle={false}
        testID="more-voice-panel"
      />

      {/* --------------------------------------------------------- devices */}

      <SectionHeader label="Devices" detail="Settings for the glove hardware." />
      <Card style={styles.group}>
        {onOpenOled !== undefined && (
          <ListRow
            label="OLED layout"
            value="OLED Studio"
            description="Line layout, order, size and startup view for each glove's panel."
            icon="oled"
            onPress={onOpenOled}
            last={onOpenAudit === undefined}
          />
        )}
        {onOpenAudit !== undefined && (
          <ListRow
            label="Component status"
            value="Audit"
            description="What each part reports, and what nothing has reported."
            icon="audit"
            onPress={onOpenAudit}
            last
          />
        )}
      </Card>

      {/* ----------------------------------------------------------- about */}

      <SectionHeader label="About" />
      <Card style={styles.group}>
        {onOpenAbout !== undefined && (
          <ListRow
            label="About Us"
            value="Team and project"
            description="Who is building Sanket Vaanni, and what this build does and does not do."
            icon="info"
            onPress={onOpenAbout}
            testID="about-row"
          />
        )}
        <AboutRow
          label="App"
          value={build === null ? `${PRODUCT_NAME}` : `${PRODUCT_NAME} ${build.versionName}`}
          description="An offline-first companion for a two-glove sign-language device."
          last={onOpenAdmin === undefined && onOpenMl === undefined}
        />
        {onOpenMl !== undefined && (
          <ListRow
            label="[Admin] Learning & Vocabulary"
            value="ML Studio"
            description="Admin only: Capture gestures, train models, and publish."
            icon="hand"
            onPress={onOpenMl}
            last={onOpenAdmin === undefined}
            testID="ml-studio-row"
          />
        )}
        {onOpenAdmin !== undefined && (
          <ListRow
            label="Super Admin"
            value="Restricted"
            description="User administration, announcements and maintenance mode."
            icon="warning"
            onPress={onOpenAdmin}
            last
            testID="admin-row"
          />
        )}
      </Card>

      <Card sunken style={styles.note}>
        <Icon name="info" size={14} color={palette.textMuted} />
        <AppText variant="caption" color={palette.textMuted} style={styles.noteText}>
          {account.isGuest
            ? 'Every preference here lives in this device’s local storage and is removed when the app’s data is cleared. Nothing on this screen is uploaded anywhere.'
            : 'Preferences here are stored on this device and synced to your account when a connection is available.'}
        </AppText>
      </Card>

      {/* ---------------------------------------------------------- sheets */}

      <Sheet
        visible={sheet === 'sign'}
        onClose={closeSheet}
        title="Sign language input"
        description="Which vocabulary the glove would be read against."
        footer={<ActionButton label="Done" onPress={closeSheet} />}
      >
        <LanguageSelector
          axis="sign"
          value={preferences.signProfileId}
          onChange={(id) => updatePreferences({ signProfileId: id })}
        />
      </Sheet>

      <Sheet
        visible={sheet === 'translation'}
        onClose={closeSheet}
        title="Output language"
        description="How recognised text would be written and spoken."
        footer={<ActionButton label="Done" onPress={closeSheet} />}
      >
        <LanguageSelector
          axis="translation"
          value={preferences.targetLanguageCode}
          onChange={(code) => updatePreferences({ targetLanguageCode: code })}
        />
      </Sheet>

    </Screen>
  );
}

/* --------------------------------------------------------------- sub-parts */

/**
 * A fact about the build.
 *
 * Non-interactive by construction: `ListRow` without `onPress` draws no chevron,
 * so nothing here looks like it opens something.
 */
function AboutRow({
  label,
  value,
  description,
  last = false,
}: {
  label: string;
  value: string;
  description: string;
  last?: boolean;
}): React.JSX.Element {
  const { palette } = useTheme();
  const notImplemented = value === 'Not implemented' || value === 'None';

  return (
    <ListRow
      label={label}
      value={value}
      valueColor={notImplemented ? palette.textMuted : palette.textSecondary}
      description={description}
      last={last}
    />
  );
}

/**
 * Static geometry only.
 *
 * No palette argument: every colour on this screen is either a component's own
 * default or set inline on the element that needs it, so this sheet is the same
 * in both themes and is built once at module load.
 */
const styles = StyleSheet.create({
  /*
   * The notification row: icon, words, control.
   *
   * `alignItems: 'flex-start'` rather than `center` because the description can
   * wrap to two or three lines — a permanent refusal and a guest's unlinked
   * token both need a sentence — and centring a three-line paragraph against a
   * button puts the button in the middle of the text.
   */
  pushRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  pushText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  card: {
    gap: spacing.md,
  },
  group: {
    paddingVertical: 0,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderRadius: radii.md,
  },
  noteText: {
    flex: 1,
  },
});
