import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { Icon } from './Icon';
import { SpeechOutputWaveform } from './SpeechOutputWaveform';
import { Toggle } from './Toggle';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface VoicePanelProps {
  /** The user's intent — whether they *want* speech output. */
  enabled: boolean;
  onToggle: (next: boolean) => void;
  /** Whether speech output can actually run. */
  available: boolean;
  unavailableReason: string | null;
  /** Text that would be spoken, or null when nothing has been recognised. */
  phrase: string | null;
  /**
   * True while the device is genuinely producing audio.
   */
  speaking?: boolean;
  /** Independent test voice utterance action to verify TTS output before recognition. */
  onTestVoice?: () => void;
  /**
   * Draw the panel's own "Voice" heading. Set false when the caller already
   * renders a `SectionHeader` for this section, so the word is not printed
   * twice. The status badge is drawn either way.
   */
  showTitle?: boolean;
  testID?: string;
}

/**
 * Voice output, in two clearly separated halves.
 *
 * Integrated with the approved 36-bar luminous audio waveform from Google Stitch.
 */
export function VoicePanel({
  enabled,
  onToggle,
  available,
  unavailableReason,
  phrase,
  speaking = false,
  onTestVoice,
  showTitle = true,
  testID,
}: VoicePanelProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const blocked = enabled && !available;

  return (
    <Card testID={testID} style={styles.card}>
      {/*
        The panel titles itself on the Dashboard, where it is the whole of that
        subject. On a settings screen it sits under a `SectionHeader` that
        already says "Speech output", and drawing the phrase twice so close is
        the duplication this flag removes. The badge stays in both cases: it is
        the state, not the label.
      */}
      {showTitle ? (
        <View style={styles.headerRow}>
          <AppText variant="overline" overline color={palette.textMuted}>
            Speech output
          </AppText>
          <VoiceStatusBadge enabled={enabled} blocked={blocked} speaking={speaking} />
        </View>
      ) : (
        <View style={styles.headerRowEnd}>
          <VoiceStatusBadge enabled={enabled} blocked={blocked} speaking={speaking} />
        </View>
      )}

      <View style={styles.toggleRow}>
        <View style={styles.toggleText}>
          <AppText variant="body">Phone voice</AppText>
          <AppText variant="caption" color={palette.textMuted} numberOfLines={2}>
            Speaks recognised signs through the device's text-to-speech engine.
          </AppText>
        </View>
        <Toggle
          value={enabled}
          onValueChange={onToggle}
          accessibilityLabel="Speak recognised signs on the phone"
          accessibilityHint="Turns text-to-speech for recognised phrases on or off"
        />
      </View>

      {/* Approved 36-bar standalone speech waveform */}
      <SpeechOutputWaveform
        enabled={enabled}
        speaking={speaking}
        blocked={blocked}
        testID="speech-output-waveform"
      />

      {blocked && (
        <View style={[styles.notice, { backgroundColor: palette.warningSurface }]}>
          <Icon name="warning" size={14} color={palette.warning} />
          <AppText variant="caption" color={palette.warning} style={styles.noticeText}>
            On, but nothing can be spoken: {unavailableReason ?? 'no speech engine is available.'}
          </AppText>
        </View>
      )}

      <View style={styles.row}>
        <AppText variant="caption" color={palette.textMuted}>
          Would speak
        </AppText>
        <AppText
          variant="reading"
          color={phrase === null ? palette.textMuted : palette.textPrimary}
          numberOfLines={1}
          style={styles.rowValue}
        >
          {phrase ?? 'Nothing yet'}
        </AppText>
      </View>

      {onTestVoice && (
        <View style={styles.testVoiceRow}>
          <ActionButton
            label="Test voice output"
            tone="secondary"
            compact
            icon="volume"
            onPress={onTestVoice}
            disabled={speaking}
            accessibilityLabel="Test device text-to-speech engine"
          />
        </View>
      )}

      {/*
        Not a Toggle. A switch that is permanently off, or that flips to on and
        changes nothing, is the "button that appears functional but silently does
        nothing" the brief rules out. This is a statement, so it is rendered as
        one.
      */}
      <View style={styles.row}>
        <View style={styles.rowText}>
          <AppText variant="body" color={palette.textSecondary}>
            Glove speaker
          </AppText>
          <AppText variant="caption" color={palette.textMuted} numberOfLines={2}>
            Would play audio on the glove itself. Needs a verified command protocol.
          </AppText>
        </View>
        <Badge label="Coming soon" tone="neutral" />
      </View>
    </Card>
  );
}

/**
 * The one place the panel's state is worded.
 *
 * Extracted so the badge that says `Off` / `Unavailable` / `Ready` is defined
 * once and cannot drift between the two layouts the panel is drawn in.
 */
function VoiceStatusBadge({
  enabled,
  blocked,
  speaking,
}: {
  enabled: boolean;
  blocked: boolean;
  speaking: boolean;
}): React.JSX.Element {
  // `Speaking` outranks `Ready`: both are true while audio plays, and the one
  // the user can hear is the one worth naming.
  if (speaking) return <Badge label="Speaking" tone="accent" dot />;
  if (!enabled) return <Badge label="Off" tone="neutral" dot />;
  if (blocked) return <Badge label="Unavailable" tone="warning" dot />;
  return <Badge label="Ready" tone="success" dot />;
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
    // With the panel's own heading suppressed there is only the badge left, and
    // it still belongs on the right, where it sits under the section header's
    // own right edge.
    headerRowEnd: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: spacing.sm,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    toggleText: {
      flex: 1,
      gap: 2,
    },
    notice: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.sm,
    },
    noticeText: {
      flex: 1,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingTop: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    rowText: {
      flex: 1,
      gap: 2,
    },
    rowValue: {
      flexShrink: 1,
      textAlign: 'right',
    },
    testVoiceRow: {
      paddingTop: spacing.sm,
      alignItems: 'flex-start',
    },
  });
