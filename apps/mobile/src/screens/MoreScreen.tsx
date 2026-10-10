import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

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
}

/**
 * More — preferences, appearance, and an honest account of what is not built.
 *
 * ## Why the deferred features are listed rather than hidden
 *
 * The brief defers accounts, cloud sync, the BLE transport, the recognition
 * model and the OLED command set. Omitting them would leave a screen that looks
 * finished, which is the more misleading option: a user would reasonably
 * conclude the app is broken somewhere they cannot see. So the last card names
 * each one and says plainly that it does not exist.
 *
 * ## Why there is no sign-in row
 *
 * A row that opened an empty login form would be a dead end. There is no
 * authentication, no user record and nothing that could be stored about one, so
 * the account section is an explanation of that fact rather than a control that
 * cannot do anything.
 */
export function MoreScreen({ onReplayIntro, onOpenOled }: MoreScreenProps): React.JSX.Element {
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
      <ScreenHeader title="More" subtitle="Appearance, languages and what is not built yet" />

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

      {/* --------------------------------------------------- personalisation */}

      <SectionHeader label="Personalisation" />
      <Card style={styles.group}>
        <ListRow
          label="Text size"
          value="Follows system"
          description="The interface uses your phone's font size setting. There is no in-app override, so a large system font enlarges every screen."
          last={onOpenOled === undefined}
        />
        <ListRow
          label="Reduce motion"
          value="Follows system"
          description="When your phone asks for reduced motion, the launch sequence is skipped and animated indicators hold still."
          last={onOpenOled === undefined}
        />
        {onOpenOled !== undefined && (
          <ListRow
            label="OLED layout"
            value="OLED Studio"
            description="Which lines the glove's panel shows, their order and size, and the loading indicator."
            icon="oled"
            onPress={onOpenOled}
            last
          />
        )}
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
        the output language decides how the result is written and spoken. Neither has a
        vocabulary or a model behind it yet.
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

      {/* --------------------------------------------------------- account */}

      <SectionHeader label="Account" />
      <Card style={styles.note}>
        <View style={[styles.noteIcon, { backgroundColor: palette.unknownSurface }]}>
          <Icon name="info" size={18} color={palette.unknown} />
        </View>
        <View style={styles.noteText}>
          <AppText variant="heading">Not implemented</AppText>
          <AppText variant="caption" color={palette.textSecondary}>
            There is no sign-in, no profile and no user record — nothing is stored about you, and
            nothing on this screen is uploaded anywhere. Every preference here lives in this
            device's local storage and is removed when the app's data is cleared.
          </AppText>
          <AppText variant="caption" color={palette.textMuted}>
            The groundwork for a server-backed account is in place: all persistence goes through
            one storage interface and all remote calls would go through one client, so adding
            authentication later would not mean redesigning these screens. None of it exists yet,
            and no credential handling has been written.
          </AppText>
        </View>
      </Card>

      {/* ----------------------------------------------------------- about */}

      <SectionHeader label="About" detail="What this build does and does not contain." />
      <Card style={styles.group}>
        <AboutRow
          label="App"
          value={`Sanket Vaanni ${APP_VERSION}`}
          description="An offline-first companion for a two-glove sign-language device."
        />
        <AboutRow
          label="Bluetooth transport"
          value="Not implemented"
          description="The firmware protocol — service and characteristic identifiers, frame layout, sample rate — has not been verified, so no device is contacted. The Dashboard's Demo Mode is a local simulator."
        />
        <AboutRow
          label="Recognition model"
          value="None"
          description="No vocabulary has been defined and no model has been trained, so no sign is recognised and no confidence is ever reported."
        />
        <AboutRow
          label="Translation"
          value="Not implemented"
          description="Sign languages are not encodings of spoken ones, so this needs a model and a vocabulary rather than a word list."
        />
        <AboutRow
          label="Speech output"
          value="Not implemented"
          description="No text-to-speech engine is wired up. The setting is recorded, and reports itself unavailable rather than failing silently."
        />
        <AboutRow
          label="OLED commands"
          value="Not implemented"
          description="The OLED Studio previews a layout and stores it locally. It sends nothing to a panel, because no command set has been verified."
        />
        <AboutRow
          label="Accounts and sync"
          value="Not implemented"
          description="No login, no cloud storage, no telemetry, no analytics."
          last
        />
      </Card>

      <Card sunken style={styles.note}>
        <Icon name="info" size={14} color={palette.textMuted} />
        <AppText variant="caption" color={palette.textMuted} style={styles.noteText}>
          Every reading marked Simulated on the Dashboard and in the Audit comes from the built-in
          demo transport. It exists so the interface can be built and reviewed before hardware
          arrives, and it is labelled wherever it appears.
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
  noteIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteText: {
    flex: 1,
    gap: spacing.xs,
  },
});
