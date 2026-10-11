import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { LanguageSelector } from '../components/LanguageSelector';
import { ListRow } from '../components/ListRow';
import { Screen } from '../components/Screen';
import { ScreenHeader } from '../components/ScreenHeader';
import { SectionHeader } from '../components/SectionHeader';
import { SegmentedControl } from '../components/SegmentedControl';
import { Sheet } from '../components/Sheet';
import { VoicePanel } from '../components/VoicePanel';
import { useAppState } from '../app/AppState';
import { findOutputLanguage, type ThemeMode } from '../app/preferences';
import { layout as screenLayout, radii, spacing } from '../theme';
import { useTheme } from '../theme/ThemeProvider';

const THEME_OPTIONS: readonly { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

/**
 * Kept in step with `apps/mobile/package.json` by hand.
 *
 * There is no build-time injection of the version in this project, and pulling
 * the whole manifest into the bundle to read one string is not worth the weight.
 */
const APP_VERSION = '0.0.1';

export interface MoreScreenProps {
  /** Replays the launch sequence. Owned by the navigator, not by this screen. */
  onReplayIntro: () => void;
  /** Switches to the OLED tab, where the layout is edited. */
  onOpenOled?: () => void;
  /** Switches to the Audit tab, which is where component status lives. */
  onOpenAudit?: () => void;
}

/**
 * More — the settings that are not about a connected glove.
 *
 * ## What belongs here, and what does not
 *
 * The dividing line is frequency and ownership. Anything a user changes while
 * watching a sign belongs on the Dashboard or in the OLED Studio; anything they
 * set once and forget belongs here. That is why the sign-language and output
 * language choices are here behind rows, while the voice toggle — which is
 * reached for mid-conversation — is also on the Dashboard.
 *
 * ## Why there is no "Not implemented" wall
 *
 * There used to be an account card and six rows listing components that do not
 * exist. Both were removed. The Audit tab exists precisely to say what has and
 * has not reported, in one place, grouped by component — repeating six of its
 * rows here as prose was duplication that made this screen read as broken rather
 * than as a settings page. What remains is a single row pointing at the audit.
 *
 * ## Why there is no sign-in row
 *
 * A row that opened an empty login form would be a dead end. There is no
 * authentication, no user record and nothing that could be stored about one, so
 * there is no account section at all rather than a control that cannot do
 * anything. Authentication is deferred until it is asked for.
 *
 * ## Why some rows have no control
 *
 * "App language", "Text size" and "Reduce motion" are statements, not settings,
 * and are drawn as `ListRow` without `onPress` — so they carry no chevron and
 * look like the facts they are. Each says what the app actually does: it follows
 * the phone. A control that offered an override the app does not implement would
 * be the "button that appears functional but silently does nothing" the brief
 * rules out.
 */
export function MoreScreen({
  onReplayIntro,
  onOpenOled,
  onOpenAudit,
}: MoreScreenProps): React.JSX.Element {
  const { palette, mode, scheme, setMode } = useTheme();
  const { preferences, updatePreferences, profile, speaker } = useAppState();

  const [sheet, setSheet] = useState<'sign' | 'translation' | null>(null);

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

  return (
    <Screen scroll bottomInset={screenLayout.tabBarHeight} testID="more-screen">
      <ScreenHeader title="More" subtitle="Appearance, languages and device settings" />

      {/* ----------------------------------------------------------- intro */}

      <SectionHeader label="Launch" />
      <Card style={styles.group}>
        <ListRow
          label="Replay intro"
          description="Plays the launch sequence again from the start. It also plays automatically on the next cold start."
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
          description="The interface is written in English. No other language pack exists yet, so there is nothing to switch between."
        />
        <ListRow
          label="Text size"
          value="Follows system"
          description="The interface uses your phone's font size setting. There is no in-app override, so a large system font enlarges every screen."
        />
        <ListRow
          label="Reduce motion"
          value="Follows system"
          description="When your phone asks for reduced motion, the launch sequence is skipped and animated indicators hold still."
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
              ? 'Selected profile. No vocabulary is defined for it yet.'
              : `${profile.vocabularySize} signs in this profile.`
          }
          icon="hand"
          onPress={() => setSheet('sign')}
        />
        <ListRow
          label="Output language"
          value={language?.name ?? preferences.targetLanguageCode.toUpperCase()}
          description={
            language?.speechWired === true
              ? 'A voice is wired up for this language.'
              : 'No speech engine is wired up for this language.'
          }
          icon="volume"
          onPress={() => setSheet('translation')}
          last
        />
      </Card>
      <AppText variant="caption" color={palette.textMuted}>
        These are two independent settings. The input profile decides which signs would be read;
        the output language decides how the result is written and spoken. Neither has a vocabulary
        or a model behind it yet.
      </AppText>

      {/* ----------------------------------------------------------- voice */}

      <SectionHeader label="Voice" />
      <VoicePanel
        enabled={preferences.voiceEnabled}
        onToggle={(next) => updatePreferences({ voiceEnabled: next })}
        available={speaker.isAvailable}
        unavailableReason={speaker.unavailableReason}
        phrase={null}
        testID="more-voice-panel"
      />

      {/* --------------------------------------------------------- devices */}

      <SectionHeader label="Devices" detail="Settings for the glove hardware." />
      <Card style={styles.group}>
        {onOpenOled !== undefined && (
          <ListRow
            label="OLED layout"
            value="OLED Studio"
            description="Which lines each glove's panel would show, their order and size, the loading indicator, and the startup view."
            icon="oled"
            onPress={onOpenOled}
            last={onOpenAudit === undefined}
          />
        )}
        {onOpenAudit !== undefined && (
          <ListRow
            label="Component status"
            value="Audit"
            description="What each part reports, and what nothing has reported — the Bluetooth transport, the recognition model, translation and the OLED command set."
            icon="audit"
            onPress={onOpenAudit}
            last
          />
        )}
      </Card>

      {/* ----------------------------------------------------------- about */}

      <SectionHeader label="About" />
      <Card style={styles.group}>
        <AboutRow
          label="App"
          value={`Sanket Vaanni ${APP_VERSION}`}
          description="An offline-first companion for a two-glove sign-language device."
          last
        />
      </Card>

      <Card sunken style={styles.note}>
        <Icon name="info" size={14} color={palette.textMuted} />
        <AppText variant="caption" color={palette.textMuted} style={styles.noteText}>
          Every preference here lives in this device's local storage and is removed when the app's
          data is cleared. Nothing on this screen is uploaded anywhere. Readings marked Simulated
          come from the built-in demo transport, which exists so the interface could be built and
          reviewed before hardware arrived.
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
