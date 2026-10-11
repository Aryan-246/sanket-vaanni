import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { FingerReadings } from '../components/FingerReadings';
import { GloveConnectionBar } from '../components/GloveConnectionBar';
import { HandViewer } from '../components/HandViewer';
import { Icon } from '../components/Icon';
import { RecognitionPanel } from '../components/RecognitionPanel';
import { Screen } from '../components/Screen';
import { ScreenHeader } from '../components/ScreenHeader';
import { Sheet } from '../components/Sheet';
import { TranslatorPanel } from '../components/TranslatorPanel';
import { VoicePanel } from '../components/VoicePanel';
import {
  useAppState,
  useGlove,
  useGloveActions,
  useLiveTranslation,
} from '../app/AppState';
import { findOutputLanguage } from '../app/preferences';
import { deviceDisplayName } from '../ble/link';
import type { DiscoveredGlove, GloveSide } from '../ble/types';
import { HAND_ASSET_BLOCKER, HAND_ASSET_FINDINGS, HAND_ASSET_ROUTE } from '../hands/viewer';
import { evaluateTranslation } from '../translation';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, radii, spacing } from '../theme';

const SIDES: readonly GloveSide[] = ['left', 'right'];

export interface DashboardScreenProps {
  /**
   * Navigates to More. Passed in rather than reached for, so this screen has no
   * knowledge of the navigator — which is what lets it be rendered in a test on
   * its own.
   */
  onOpenSettings?: () => void;
}

/** Which explanation, if any, is open over the Dashboard. */
type OpenSheet = 'recognition' | 'viewer' | 'device' | null;

/**
 * Dashboard — one live-translation experience for one or two hands.
 *
 * ## What changed, and why
 *
 * The previous Dashboard asked the user to choose a hand and then showed that
 * hand's result, that hand's pose and that hand's sensors, with a full connection
 * card for each glove underneath. Four things followed from that, and all four
 * were wrong:
 *
 *  1. **A mandatory selector.** Half the app was about one hand, so a two-handed
 *     sign had nowhere to be recognised even if a model had existed.
 *  2. **Duplication.** Connection state appeared in the status strip, in both
 *     cards, and again as badges. Five of ten sensor rows carried the same note.
 *  3. **Setup above content.** The largest elements on a screen about what a hand
 *     is doing were the controls for connecting it.
 *  4. **Prose instead of labels.** Wrist rows each repeated a paragraph on the
 *     accelerometer; a permanent footer carried a technical explanation.
 *
 * Now the screen has one state, computed once in `useLiveTranslation`, and the
 * hand selector is gone entirely: which hands feed the recogniser is decided by
 * the vocabulary (`planInput`), and the viewer shows both hands at once. Which
 * hands are *connected* is still shown honestly — a missing hand is drawn at rest
 * and labelled, not omitted and not filled in from the other hand.
 *
 * ## The order is still the argument
 *
 * Live content first, in the order the user's question arrives:
 *
 *  1. which gloves are connected
 *  2. what was recognised — the primary experience
 *  3. what the hands are doing
 *  4. the per-finger numbers, behind a disclosure
 *  5. whether it will be spoken
 *  6. the Live Translator
 *
 * Setup is at the top because it is brief now, and configuration is at the
 * bottom because it is rare. The paragraphs moved into the sheets behind the ⓘ
 * buttons, where a user who wants them can ask for them.
 */
export function DashboardScreen({ onOpenSettings }: DashboardScreenProps): React.JSX.Element {
  const {
    preferences,
    updatePreferences,
    profile,
    calibration,
    speaker,
    translator,
    controllers,
    recognitionUnavailableReason,
  } = useAppState();

  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);
  const [deviceSide, setDeviceSide] = useState<GloveSide | null>(null);
  const [connectingBoth, setConnectingBoth] = useState(false);

  const left = useGlove('left');
  const right = useGlove('right');
  const gloves = useMemo(() => ({ left, right }), [left, right]);

  const leftActions = useGloveActions('left');
  const rightActions = useGloveActions('right');
  const actions = useMemo(
    () => ({ left: leftActions, right: rightActions }),
    [leftActions, rightActions],
  );

  const { plan, outcome, frames, live, provenance } = useLiveTranslation();

  const language = findOutputLanguage(preferences.targetLanguageCode);
  const translation = useMemo(
    () => evaluateTranslation(translator, outcome, preferences.targetLanguageCode),
    [translator, outcome, preferences.targetLanguageCode],
  );

  /**
   * Connect both gloves: scan each side, connect the first device it finds.
   *
   * A re-entrancy guard rather than disabled-button logic, because the button
   * lives in another component and a second tap can land before the first state
   * update renders.
   *
   * There is no try/catch. `GloveController.scan` and `.connect` never reject —
   * they fold a transport failure into the link state, which is what the glove
   * cells display. Catching here would add a second, quieter place for failures
   * to be reported, and the visible one would still be the link.
   */
  const connectingBothRef = useRef(false);
  const connectBoth = useCallback(async () => {
    if (connectingBothRef.current) return;
    connectingBothRef.current = true;
    setConnectingBoth(true);
    try {
      await Promise.all(
        SIDES.map(async (side) => {
          const controller = controllers[side];
          const before = controller.getSnapshot().link.kind;
          // Already live or mid-attempt: leave it alone rather than restarting
          // a connection the user may be watching.
          if (before === 'connected' || before === 'connecting' || before === 'scanning') return;

          const found = await controller.scan();
          const first = found[0];
          if (first === undefined) return;

          // The scan may have connected this side already on a transport that
          // auto-connects; check again before issuing a second connect.
          if (controller.getSnapshot().link.kind === 'connected') return;
          await controller.connect(first.id);
        }),
      );
    } finally {
      connectingBothRef.current = false;
      setConnectingBoth(false);
    }
  }, [controllers]);

  const openDeviceChooser = useCallback((side: GloveSide) => {
    setDeviceSide(side);
    setOpenSheet('device');
  }, []);

  const closeSheet = useCallback(() => setOpenSheet(null), []);

  /**
   * The devices found by the side whose chooser is open.
   *
   * Read from the live link at render time rather than captured when the sheet
   * opened, so a rescan while the sheet is up updates the list instead of
   * leaving a stale one on screen.
   */
  const chooserDevices: readonly DiscoveredGlove[] =
    deviceSide !== null && gloves[deviceSide].link.kind === 'nearby'
      ? gloves[deviceSide].link.discovered
      : [];

  return (
    <Screen scroll bottomInset={layout.tabBarHeight} testID="dashboard-screen">
      <ScreenHeader
        title="Dashboard"
        subtitle={`${profile.name} → ${language?.name ?? preferences.targetLanguageCode}`}
      />

      {/* 1 — connection, compact. Both gloves, whichever are present. */}
      <GloveConnectionBar
        gloves={gloves}
        actions={actions}
        onConnectBoth={() => {
          void connectBoth();
        }}
        connectingBoth={connectingBoth}
        onChooseDevice={openDeviceChooser}
        testID="glove-connection-bar"
      />

      {/* 2 — the primary experience: the one place a result appears. */}
      <RecognitionPanel
        outcome={outcome}
        plan={plan}
        profile={profile}
        provenance={provenance}
        onExplain={() => setOpenSheet('recognition')}
        testID="recognition-panel"
      />

      {/* 3 — the hands, both at once. */}
      <HandViewer
        frames={frames}
        live={live}
        onExplain={() => setOpenSheet('viewer')}
        testID="hand-viewer"
      />

      {/* 4 — the numbers, collapsed. Ten channels is a lot of screen for a
             detail most users look at occasionally. */}
      <FingerReadings gloves={gloves} calibration={calibration} testID="finger-readings" />

      {/* 5 — speech, phone and glove kept separate. */}
      <VoicePanel
        enabled={preferences.voiceEnabled}
        onToggle={(next) => updatePreferences({ voiceEnabled: next })}
        available={speaker.isAvailable}
        unavailableReason={speaker.unavailableReason}
        phrase={outcome.kind === 'result' ? outcome.candidate.label : null}
        testID="voice-panel"
      />

      {/* 6 — the Live Translator, below the recognition experience it depends
             on, with the language lists behind its own sheet. */}
      <TranslatorPanel
        outcome={translation}
        signProfileId={preferences.signProfileId}
        targetLanguageCode={preferences.targetLanguageCode}
        onChangeSignProfile={(id) => updatePreferences({ signProfileId: id })}
        onChangeTargetLanguage={(code) => updatePreferences({ targetLanguageCode: code })}
        testID="translator-panel"
      />

      {/*
        The only route from this screen into configuration that does not belong
        on a live screen. Everything else moved to More; this stays because the
        choice immediately above it is the one users change most.
      */}
      {onOpenSettings !== undefined && (
        <ActionButton
          label="Language and app settings"
          tone="ghost"
          icon="more"
          onPress={onOpenSettings}
          accessibilityLabel="Open settings"
          accessibilityHint="Opens More, where the sign language, target language and app preferences are configured"
        />
      )}

      <RecognitionSheet
        visible={openSheet === 'recognition'}
        onClose={closeSheet}
        planKind={plan.kind}
        provenance={provenance}
        unavailableReason={recognitionUnavailableReason}
      />

      <HandViewerSheet visible={openSheet === 'viewer'} onClose={closeSheet} />

      <DeviceSheet
        visible={openSheet === 'device'}
        side={deviceSide}
        devices={chooserDevices}
        onClose={closeSheet}
        onPick={(side, deviceId) => {
          setOpenSheet(null);
          void actions[side].connect(deviceId);
        }}
        onRescan={(side) => {
          void actions[side].scan();
        }}
      />
    </Screen>
  );
}

/**
 * What the result panel is showing, in full.
 *
 * The reason the recogniser is unavailable is a fact about this build that a
 * user can reasonably want, but it is a paragraph — so it lives here rather than
 * as a permanent footer under a live screen.
 */
function RecognitionSheet({
  visible,
  onClose,
  planKind,
  provenance,
  unavailableReason,
}: {
  visible: boolean;
  onClose: () => void;
  planKind: 'ready' | 'blocked';
  provenance: 'real' | 'simulated' | 'mixed' | 'none';
  unavailableReason: string | null;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="About the result panel"
      description="What is recognised, and by what."
      footer={<ActionButton label="Close" onPress={onClose} accessibilityLabel="Close" />}
    >
      <View style={styles.sheetBody}>
        <AppText variant="body" color={palette.textSecondary}>
          This panel is the only place a recognised sign appears. When one is recognised it says
          which hand produced it, so nothing depends on having selected a hand first.
        </AppText>

        <View style={[styles.notice, { backgroundColor: palette.warningSurface }]}>
          <Icon name="warning" size={14} color={palette.warning} />
          <AppText variant="caption" color={palette.warning} style={styles.noticeText}>
            {unavailableReason ??
              'The recogniser is reporting itself as available, which should not be possible on this build.'}
          </AppText>
        </View>

        <AppText variant="overline" overline color={palette.textMuted} style={styles.sheetGap}>
          What the labels mean
        </AppText>
        <Detail
          label="Live"
          value="Every hand being read is a real glove reporting measurements."
        />
        <Detail
          label="Demo Mode"
          value="Every hand being read is a simulator. Nothing here came from hardware."
        />
        <Detail
          label="Mixed data"
          value="One hand is hardware and one is a simulator. Read the two hand badges in the viewer to see which is which."
        />
        <Detail
          label="No data"
          value="No glove is sending frames, so no pose and no reading is being claimed."
        />

        <AppText variant="overline" overline color={palette.textMuted} style={styles.sheetGap}>
          Which hands are read
        </AppText>
        <AppText variant="caption" color={palette.textSecondary}>
          {planKind === 'blocked'
            ? 'The recogniser is not being fed any hand yet. Which hands it needs comes from the vocabulary of the selected sign language, not from a setting on this screen.'
            : 'The recogniser is being fed the hands the selected vocabulary requires, whether that is one hand or both together.'}
        </AppText>
        <AppText variant="caption" color={palette.textMuted}>
          Current source: {PROVENANCE_SENTENCE[provenance]}
        </AppText>

        <AppText variant="overline" overline color={palette.textMuted} style={styles.sheetGap}>
          Confidence
        </AppText>
        <AppText variant="caption" color={palette.textSecondary}>
          A percentage is shown only when a model reports one. Model confidence is not a measure
          of correctness, and it is not invented when no model is loaded.
        </AppText>
      </View>
    </Sheet>
  );
}

const PROVENANCE_SENTENCE: Record<'real' | 'simulated' | 'mixed' | 'none', string> = {
  real: 'measured on hardware.',
  simulated: 'produced by the simulator.',
  mixed: 'hardware on one hand, simulator on the other.',
  none: 'no glove is sending frames.',
};

/**
 * The 3D asset finding, in full.
 *
 * Kept out of the live flow because it is an explanation, not a control — but
 * reachable in one tap from the figure it explains, because a viewer that is not
 * what it looks like must say so where a user would ask.
 */
function HandViewerSheet({
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
          figure's finger bends by the amount the sensor reported. It is not a 3D model.
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
        <Detail label="Animations" value={String(HAND_ASSET_FINDINGS.animationCount)} />
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

/**
 * Picking one device when a scan found several.
 *
 * Only reachable when a side found more than one glove, so there is nothing here
 * for the common case. Choosing a device connects *that* device — it does not
 * mark the side connected, and a connect that fails returns to the link state the
 * cell already shows.
 */
function DeviceSheet({
  visible,
  side,
  devices,
  onClose,
  onPick,
  onRescan,
}: {
  visible: boolean;
  side: GloveSide | null;
  devices: readonly DiscoveredGlove[];
  onClose: () => void;
  onPick: (side: GloveSide, deviceId: string) => void;
  onRescan: (side: GloveSide) => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const hand = side === 'left' ? 'left' : 'right';

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={`Choose a ${hand} glove`}
      description="Only the device you pick is connected."
      footer={<ActionButton label="Close" onPress={onClose} accessibilityLabel="Close" />}
    >
      <View style={styles.sheetBody}>
        {devices.length === 0 ? (
          <AppText variant="caption" color={palette.textMuted}>
            No devices are listed. The scan results may have been replaced by a new scan — close
            this and scan again.
          </AppText>
        ) : (
          devices.map((device) => (
            <View key={device.id} style={styles.device}>
              <View style={styles.deviceText}>
                <AppText variant="body" numberOfLines={1}>
                  {deviceDisplayName(device.name)}
                </AppText>
                <AppText variant="caption" color={palette.textMuted}>
                  {device.rssi === null || device.rssi === undefined
                    ? 'Signal strength not reported'
                    : `${device.rssi} dBm`}
                </AppText>
              </View>
              {side !== null && (
                <ActionButton
                  label="Connect"
                  tone="secondary"
                  compact
                  onPress={() => onPick(side, device.id)}
                  accessibilityLabel={`Connect ${deviceDisplayName(device.name)} as the ${hand} glove`}
                />
              )}
            </View>
          ))
        )}

        {side !== null && (
          <ActionButton
            label="Scan again"
            tone="ghost"
            icon="refresh"
            compact
            onPress={() => onRescan(side)}
            accessibilityLabel={`Scan again for the ${hand} glove`}
          />
        )}

        <View style={[styles.notice, { backgroundColor: palette.surfaceSunken }]}>
          <Icon name="info" size={14} color={palette.textMuted} />
          <AppText variant="caption" color={palette.textMuted} style={styles.noticeText}>
            Device names come from the scan. The glove protocol and its service identifiers are
            not verified, so a device that appears here may not be a Sanket Vaanni glove.
          </AppText>
        </View>
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
    device: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    deviceText: {
      flex: 1,
      gap: 2,
    },
  });
