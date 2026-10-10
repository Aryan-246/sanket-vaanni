import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { GloveCard } from '../components/GloveCard';
import { GloveStatusStrip } from '../components/GloveStatusStrip';
import { HandFigure } from '../components/HandFigure';
import { Icon } from '../components/Icon';
import { RecognitionPanel } from '../components/RecognitionPanel';
import { Screen } from '../components/Screen';
import { ScreenHeader } from '../components/ScreenHeader';
import { SectionHeader } from '../components/SectionHeader';
import { SensorPanel } from '../components/SensorPanel';
import { SegmentedControl } from '../components/SegmentedControl';
import { Sheet } from '../components/Sheet';
import { TranslatorPanel } from '../components/TranslatorPanel';
import { VoicePanel } from '../components/VoicePanel';
import { useAppState, useGlove, useGloveActions, useRecognition } from '../app/AppState';
import { findOutputLanguage } from '../app/preferences';
import { useViewerFrame } from '../hands/usePose';
import { HAND_ASSET_BLOCKER, HAND_ASSET_FINDINGS, HAND_ASSET_ROUTE } from '../hands/viewer';
import { evaluateTranslation } from '../translation';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import type { GloveSide } from '../ble/types';
import { layout, radii, spacing } from '../theme';

const SIDE_OPTIONS: readonly { value: GloveSide; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

export interface DashboardScreenProps {
  /**
   * Navigates to More. Passed in rather than reached for, so this screen has no
   * knowledge of the navigator — which is what lets it be rendered in a test on
   * its own.
   */
  onOpenSettings?: () => void;
}

/**
 * Dashboard — the live screen.
 *
 * ## The order is the argument
 *
 * The screen is arranged so that the things that change in real time are above
 * the fold and the things you configure once are below it:
 *
 *  1. which gloves are connected (a strip, one line each)
 *  2. what was recognised
 *  3. what the hand is doing
 *  4. whether it will be spoken and translated
 *  5. the raw per-finger numbers
 *  6. the connection controls
 *
 * ## Which hand the screen is about
 *
 * One selector — the strip at the top — chooses the hand that the recognition
 * panel, the viewer and the sensor list are all showing. Two independent
 * selectors would let a user see the left hand's pose beside the right hand's
 * recognition result without noticing, which is precisely the kind of quiet
 * confusion this app cannot afford.
 *
 * Both gloves' connection state is always visible, and both cards are always
 * present further down: the selector chooses what is *displayed*, never what is
 * *connected*.
 */
export function DashboardScreen({ onOpenSettings }: DashboardScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { width } = useWindowDimensions();

  const {
    preferences,
    updatePreferences,
    profile,
    calibration,
    speaker,
    translator,
    recognitionUnavailableReason,
  } = useAppState();

  const [focused, setFocused] = useState<GloveSide>('right');
  const [assetSheetOpen, setAssetSheetOpen] = useState(false);

  const left = useGlove('left');
  const right = useGlove('right');
  const gloves = useMemo(() => ({ left, right }), [left, right]);

  const focusedGlove = gloves[focused];
  const outcome = useRecognition(focused);
  const frame = useViewerFrame(focused);

  const leftActions = useGloveActions('left');
  const rightActions = useGloveActions('right');

  const language = findOutputLanguage(preferences.targetLanguageCode);
  const translation = useMemo(
    () => evaluateTranslation(translator, outcome, preferences.targetLanguageCode),
    [translator, outcome, preferences.targetLanguageCode],
  );

  const figureWidth = Math.min(200, Math.max(140, width - 2 * layout.screenPadding - 4 * spacing.lg));

  const closeSheet = useCallback(() => setAssetSheetOpen(false), []);

  return (
    <Screen scroll bottomInset={layout.tabBarHeight} testID="dashboard-screen">
      <ScreenHeader
        title="Dashboard"
        subtitle={`${profile.name} → ${language?.name ?? preferences.targetLanguageCode}`}
        accessory={
          <Badge
            label={frame.pose.source === 'simulated' ? 'Demo Mode' : frame.pose.source === 'real' ? 'Live' : 'Idle'}
            tone={frame.pose.source === 'simulated' ? 'demo' : frame.pose.source === 'real' ? 'success' : 'neutral'}
            dot
          />
        }
      />

      <GloveStatusStrip gloves={gloves} active={focused} onSelect={setFocused} />

      <View style={styles.scopeSelector}>
        <AppText variant="caption" color={palette.textMuted}>
          Viewing
        </AppText>
        <SegmentedControl
          options={SIDE_OPTIONS}
          value={focused}
          onChange={setFocused}
          accessibilityLabel="Which hand the viewer, sensors and recognition are showing"
        />
      </View>

      {/* B — the result, deliberately the first thing under the glove status. */}
      <RecognitionPanel
        side={focused}
        outcome={outcome}
        profile={profile}
        glove={focusedGlove}
        testID="recognition-panel"
      />

      {/* D — the hand. */}
      <SectionHeader
        label="Hand viewer"
        accessory={<Badge label="Articulated preview" tone="neutral" />}
      />
      <Card style={styles.viewerCard}>
        <HandFigure frame={frame} width={figureWidth} testID="hand-figure" />

        <View style={styles.wrist}>
          <WristReading
            label="Pitch"
            value={degrees(frame.pose.wrist.pitch)}
            note="From the accelerometer, uncorrected for bias."
          />
          <WristReading
            label="Roll"
            value={degrees(frame.pose.wrist.roll)}
            note="From the accelerometer, uncorrected for bias."
          />
          <WristReading
            label="Yaw"
            value="Not measurable"
            note="The MPU6050 has no magnetometer, so rotation about the vertical axis is unobservable."
          />
        </View>

        {frame.pose.confidence !== null && (
          <AppText variant="caption" color={palette.textSecondary}>
            Pose confidence {Math.round(frame.pose.confidence * 100)}%
          </AppText>
        )}

        <ActionButton
          label="Why this is not the 3D viewer"
          tone="ghost"
          icon="info"
          compact
          onPress={() => setAssetSheetOpen(true)}
          accessibilityLabel="Why this is not the 3D viewer"
        />
      </Card>

      {/* E — voice and translation. */}
      <VoicePanel
        enabled={preferences.voiceEnabled}
        onToggle={(next) => updatePreferences({ voiceEnabled: next })}
        available={speaker.isAvailable}
        unavailableReason={speaker.unavailableReason}
        phrase={outcome.kind === 'result' ? outcome.candidate.label : null}
        testID="voice-panel"
      />

      <TranslatorPanel
        outcome={translation}
        signProfileId={preferences.signProfileId}
        targetLanguageCode={preferences.targetLanguageCode}
        onChangeSignProfile={(id) => updatePreferences({ signProfileId: id })}
        onChangeTargetLanguage={(code) => updatePreferences({ targetLanguageCode: code })}
        testID="translator-panel"
      />

      {/* C — the raw numbers, below the live content and above the controls. */}
      <SectionHeader label="Flex sensors" />
      <SensorPanel
        side={focused}
        glove={focusedGlove}
        calibration={calibration[focused]}
        testID="sensor-panel"
      />

      {/* A — the full connection controls, last because they are set up once. */}
      <SectionHeader label="Connection" detail="Both gloves" />
      <GloveCard
        side="left"
        snapshot={left}
        actions={leftActions}
        testID="glove-card-left"
      />
      <GloveCard
        side="right"
        snapshot={right}
        actions={rightActions}
        testID="glove-card-right"
      />

      <View style={styles.footer}>
        <Icon name="info" size={14} color={palette.textMuted} />
        <AppText variant="caption" color={palette.textMuted} style={styles.footerText}>
          {recognitionUnavailableReason !== null
            ? recognitionUnavailableReason
            : 'Recognition is reported as available, which should not be possible on this build.'}
        </AppText>
      </View>

      {onOpenSettings !== undefined && (
        <ActionButton
          label="Settings"
          tone="ghost"
          icon="more"
          onPress={onOpenSettings}
          accessibilityLabel="Open settings"
        />
      )}

      <AssetSheet visible={assetSheetOpen} onClose={closeSheet} />
    </Screen>
  );
}

/** Named in one place, so the pitch and roll rows cannot accidentally diverge. */
function degrees(radians: number | null): string {
  if (radians === null) return 'Not available';
  return `${Math.round((radians * 180) / Math.PI)}°`;
}

function WristReading({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const unavailable = value === 'Not available' || value === 'Not measurable';

  return (
    <View style={styles.wristRow} accessible accessibilityLabel={`Wrist ${label}: ${value}`}>
      <AppText variant="caption" color={palette.textMuted} style={styles.wristLabel}>
        {label}
      </AppText>
      <View style={styles.wristValue}>
        <AppText variant="reading" color={unavailable ? palette.textMuted : palette.textPrimary}>
          {value}
        </AppText>
        <AppText variant="caption" color={palette.textMuted}>
          {note}
        </AppText>
      </View>
    </View>
  );
}

/**
 * The 3D asset finding, in full.
 *
 * Kept out of the main flow because it is an explanation, not a control — but
 * reachable in one tap from the figure it explains, because a viewer that is not
 * what it looks like must say so where a user would ask.
 */
function AssetSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="About the hand viewer"
      description="What this is, and what the 3D version is waiting on."
      footer={<ActionButton label="Close" onPress={onClose} accessibilityLabel="Close" />}
    >
      <View style={styles.sheetBody}>
        <AppText variant="body" color={palette.textSecondary}>
          You are looking at an articulated figure: fifteen finger segments positioned by
          forward kinematics from the measured bend of each finger. Bend a finger and the
          figure's finger bends by the amount the sensor reported.
        </AppText>

        <View style={[styles.notice, { backgroundColor: palette.warningSurface }]}>
          <Icon name="warning" size={14} color={palette.warning} />
          <AppText variant="caption" color={palette.warning} style={styles.noticeText}>
            {HAND_ASSET_BLOCKER}
          </AppText>
        </View>

        <AppText variant="overline" overline color={palette.textMuted} style={styles.sheetGap}>
          The reference model
        </AppText>
        <Detail label="Author" value={HAND_ASSET_FINDINGS.author} />
        <Detail
          label="Licence"
          value={`${HAND_ASSET_FINDINGS.licenceLabel} (${HAND_ASSET_FINDINGS.licenceSlug})`}
        />
        <Detail
          label="Downloadable"
          value={HAND_ASSET_FINDINGS.downloadable ? 'Yes' : 'No — download returns 401'}
        />
        <Detail
          label="Animations"
          value={String(HAND_ASSET_FINDINGS.animationCount)}
        />
        <Detail
          label="Geometry"
          value={`${HAND_ASSET_FINDINGS.faceCount.toLocaleString()} faces · ${HAND_ASSET_FINDINGS.vertexCount.toLocaleString()} vertices`}
        />
        <Detail label="Pipeline" value={HAND_ASSET_FINDINGS.pipeline} />

        <AppText variant="overline" overline color={palette.textMuted} style={styles.sheetGap}>
          Proposed route
        </AppText>
        {HAND_ASSET_ROUTE.map((step, index) => (
          <View key={step} style={styles.step}>
            <AppText variant="caption" color={palette.accent}>
              {index + 1}
            </AppText>
            <AppText variant="caption" color={palette.textSecondary} style={styles.stepText}>
              {step}
            </AppText>
          </View>
        ))}
      </View>
    </Sheet>
  );
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={styles.detail}>
      <AppText variant="caption" color={palette.textMuted} style={styles.detailLabel}>
        {label}
      </AppText>
      <AppText variant="caption" color={palette.textSecondary} style={styles.detailValue}>
        {value}
      </AppText>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    scopeSelector: {
      // Stacked, not a caption-then-control row.
      //
      // The control's segments are `flex: 1`, so the control takes whatever
      // width it is offered. Measured on the target device (1080 x 2408), the
      // row laid "Viewing" beside it and the pair overflowed the screen by about
      // 100 px: the two segments came out 482 px and 386 px instead of equal,
      // and the selected one was clipped at the right edge. A width-driven
      // bug like this is invisible to a jsdom test, so the reason is recorded
      // here rather than left to be rediscovered.
      gap: spacing.sm,
    },
    viewerCard: {
      alignItems: 'center',
      gap: spacing.lg,
      paddingVertical: spacing.xl,
    },
    wrist: {
      alignSelf: 'stretch',
      gap: spacing.sm,
      paddingTop: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    wristRow: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    wristLabel: {
      width: 46,
      paddingTop: 2,
    },
    wristValue: {
      flex: 1,
      gap: 1,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      paddingTop: spacing.md,
    },
    footerText: {
      flex: 1,
    },
    sheetBody: {
      gap: spacing.sm,
    },
    sheetGap: {
      marginTop: spacing.lg,
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
    detail: {
      flexDirection: 'row',
      gap: spacing.md,
      alignItems: 'flex-start',
    },
    detailLabel: {
      width: 92,
    },
    detailValue: {
      flex: 1,
    },
    step: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'flex-start',
    },
    stepText: {
      flex: 1,
    },
  });
