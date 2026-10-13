import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { BrandHeader } from '../components/BrandHeader';
import { DetectedTextCard } from '../components/DetectedTextCard';
import { DiagnosticsCard } from '../components/DiagnosticsCard';
import { FingerReadings } from '../components/FingerReadings';
import { GloveConnectionBar } from '../components/GloveConnectionBar';
import { GuestBanner } from '../components/GuestBanner';
import { HandViewer } from '../components/HandViewer';
import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { VoicePanel } from '../components/VoicePanel';
import { OrbStage } from '../components/orb/OrbStage';
import { useOrbSignal } from '../components/orb/useOrbSignal';
import {
  useAppState,
  useGlove,
  useGloveActions,
  useLiveTranslation,
  useSpeechState,
} from '../app/AppState';
import { deviceDisplayName } from '../ble/link';
import type { DiscoveredGlove, GloveSide } from '../ble/types';
import { findOutputLanguage } from '../app/preferences';
import { ACTIVE_HAND_ASSET, HAND_ASSET_FINDINGS, HAND_ASSET_ROUTE } from '../hands/viewer';
import { outcomeText } from '../recognition/outcome';
import { useAutoSpeak } from '../speech/useAutoSpeak';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, radii, spacing } from '../theme';

const SIDES: readonly GloveSide[] = ['left', 'right'];

export interface DashboardScreenProps {
  /**
   * Navigates to Settings. Passed in rather than reached for, so this screen has
   * no knowledge of the navigator — which is what lets it be rendered in a test
   * on its own.
   */
  onOpenSettings?: () => void;
  /** Opens the account surface, which the navigator hosts. */
  onOpenAccount?: () => void;
  /** Opens the Textboard tab. */
  onOpenTextboard?: () => void;
}

/** Which explanation, if any, is open over the Dashboard. */
type OpenSheet = 'text' | 'viewer' | 'device' | null;

/**
 * Dashboard — one live-translation experience for one or two hands.
 *
 * ## The composition, and why it is this order
 *
 * The screen is built around a single luminous centre. Above it, only identity:
 * the wordmark, the live language pair, and the user's own avatar. Below it,
 * the things a user reaches for in the order they reach for them:
 *
 *  1. **the orb** — what is happening, in one glance
 *  2. **the gloves** — because nothing below this point can do anything without
 *     a connection, and the control to get one belongs next to the state it
 *     changes
 *  3. **detected text** — the reason the screen exists
 *  4. **the hands** — the evidence behind the text, and the same viewer as before
 *  5. **speech** — what happens to the text next
 *  6. **the numbers** — per-finger readings, collapsed
 *  7. **diagnostics** — collapsed, for whoever is debugging a glove
 *
 * ## What was removed from here, and where it went
 *
 * The Live Translator panel used to sit near the bottom of this screen. It is
 * configuration: a choice made once and then lived with. It now lives in
 * Settings with the rest of configuration, and the *result* of that choice —
 * `ISL → English` — stays in the header where it belongs, visible without being
 * interactive. That is the difference between a setting and a status.
 *
 * The screen previously opened with a `ScreenHeader` reading "Dashboard". It
 * now opens with the brand, because a title that repeats the name of the tab
 * the user just tapped is the loudest element on the screen and the least
 * informative.
 */
export function DashboardScreen({
  onOpenSettings,
  onOpenAccount,
  onOpenTextboard,
}: DashboardScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const {
    preferences,
    updatePreferences,
    calibration,
    controllers,
    recognitionUnavailableReason,
    recognitionAvailable,
    speech: speechController,
  } = useAppState();

  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);
  const [deviceSide, setDeviceSide] = useState<GloveSide | null>(null);
  const [connectingBoth, setConnectingBoth] = useState(false);
  const [guestBannerDismissed, setGuestBannerDismissed] = useState(false);

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
  const orbSignal = useOrbSignal();
  const speech = useSpeechState();

  const detectedText = useMemo(() => outcomeText(outcome), [outcome]);

  /**
   * Speak what was recognised, when the user has switched speech on.
   *
   * The speech control is a persistent switch, so this is what makes it mean
   * something: with it on, new text is spoken as it settles. With it off —
   * which is the default — nothing is ever spoken unprompted.
   */
  useAutoSpeak(speechController, detectedText, preferences.voiceEnabled, {
    language: findOutputLanguage(preferences.targetLanguageCode)?.speechTag,
  });

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
   * A second line under the orb headline.
   *
   * Only produced when it adds something the headline does not already say.
   * Each branch is a fact from the outcome or the connection state — none of
   * them is a reassuring filler line, because a filler line here would be read
   * as a status.
   */
  const orbDetail = useMemo<string | null>(() => {
    if (outcome.kind === 'unavailable') {
      return recognitionAvailable
        ? 'The recogniser is reporting itself available, which this build does not expect.'
        : 'No recognition model is loaded, so signs cannot be read yet. The viewer and the glove are live.';
    }
    if (outcome.kind === 'blocked') return outcome.reason;
    if (outcome.kind === 'idle') {
      const anyConnected = left.link.kind === 'connected' || right.link.kind === 'connected';
      return anyConnected
        ? 'Waiting for the first frame from the glove.'
        : 'Connect a glove to begin.';
    }
    return null;
  }, [outcome, recognitionAvailable, left.link.kind, right.link.kind]);

  /**
   * Why the detected-text card is empty, phrased for this specific situation.
   *
   * "No text yet" is not enough: it does not distinguish "the app is working and
   * you have not signed" from "this build cannot read signs at all". Those are
   * the two states a user most needs told apart, so they are.
   */
  const emptyCopy = useMemo(() => {
    if (!recognitionAvailable) {
      return {
        title: 'Recognition is not available',
        body: recognitionUnavailableReason
          ? 'Sign recognition needs a vocabulary and a trained model. Neither exists in this build yet.'
          : 'No model is loaded in this build.',
      };
    }
    if (outcome.kind === 'blocked') {
      return { title: 'Cannot start', body: outcome.reason };
    }
    return {
      title: 'Nothing detected yet',
      body: 'Recognised signs appear here as text, and can be copied the moment they arrive.',
    };
  }, [recognitionAvailable, recognitionUnavailableReason, outcome]);

  const chooserDevices: readonly DiscoveredGlove[] =
    deviceSide !== null && gloves[deviceSide].link.kind === 'nearby'
      ? gloves[deviceSide].link.discovered
      : [];

  return (
    <Screen scroll bottomInset={layout.tabBarHeight + spacing.xl} testID="dashboard-screen">
      <BrandHeader title="Dashboard" onPressAvatar={onOpenAccount} />

      {guestBannerDismissed ? null : (
        <View style={styles.bannerSlot}>
          <GuestBanner
            onOpenAccount={onOpenAccount ?? (() => undefined)}
            onDismiss={() => setGuestBannerDismissed(true)}
          />
        </View>
      )}

      {/* 2 — Left/right glove connection card. */}
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

      {/* 3 — Approved interactive 3D orb with theme palette control. */}
      <OrbStage signal={orbSignal} detail={orbDetail} testID="orb-stage" />

      {/* 4 — Detected text / recognition card immediately below the orb. */}
      <DetectedTextCard
        text={detectedText}
        provenance={provenance}
        emptyTitle={emptyCopy.title}
        emptyBody={emptyCopy.body}
        onExplain={() => setOpenSheet('text')}
        testID="detected-text-card"
      />

      {/* 4b — Textboard action for conversation navigation. */}
      {onOpenTextboard ? (
        <ActionButton
          label="Open the Textboard"
          tone="ghost"
          icon="chat"
          onPress={onOpenTextboard}
          accessibilityLabel="Open the Textboard"
          accessibilityHint="Live captions and typed messages, for two-way conversation"
        />
      ) : null}

      {/* 5 — Approved Speech Output waveform and ON/OFF switch. */}
      <VoicePanel
        enabled={preferences.voiceEnabled}
        onToggle={(next) => updatePreferences({ voiceEnabled: next })}
        available={speech.available}
        unavailableReason={speech.unavailableReason}
        phrase={detectedText}
        speaking={speech.isSpeaking}
        testID="voice-panel"
      />

      {/* 6 — Existing 2D/3D hand model viewer. */}
      <HandViewer
        frames={frames}
        live={live}
        onExplain={() => setOpenSheet('viewer')}
        testID="hand-viewer"
      />

      {/* 7 — Secondary device, finger readings, calibration, and diagnostics. */}
      <FingerReadings gloves={gloves} calibration={calibration} testID="finger-readings" />

      <DiagnosticsCard gloves={gloves} outcome={outcome} live={live} testID="diagnostics-card" />

      {onOpenSettings !== undefined && (
        <ActionButton
          label="Settings"
          tone="ghost"
          icon="more"
          onPress={onOpenSettings}
          accessibilityLabel="Open settings"
          accessibilityHint="Opens settings, where the sign language, target language and app preferences are configured"
        />
      )}

      <DetectedTextSheet
        visible={openSheet === 'text'}
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
 * What the detected-text panel is showing, in full.
 *
 * The reason the recogniser is unavailable is a fact about this build that a
 * user can reasonably want, but it is a paragraph — so it lives here rather than
 * as a permanent footer under a live screen.
 */
function DetectedTextSheet({
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
      title="About detected text"
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
          Interim and finalised text
        </AppText>
        <AppText variant="caption" color={palette.textSecondary}>
          Text that is still being decided is shown smaller and dimmer, with a trailing ellipsis.
          Text that has been settled is shown large and solid. A settled line is never erased by a
          line still in progress.
        </AppText>

        <AppText variant="overline" overline color={palette.textMuted} style={styles.sheetGap}>
          What the labels mean
        </AppText>
        <Detail
          label="Live"
          value="Every hand being read is a real glove reporting measurements."
        />
        <Detail
          label="Demo"
          value="Every hand being read is a simulator. Nothing here came from hardware."
        />
        <Detail
          label="Mixed"
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
      description="Real-time 3D VR Hands rig and articulated figure."
      footer={<ActionButton label="Close" onPress={onClose} accessibilityLabel="Close" />}
    >
      <View style={styles.sheetBody}>
        <AppText variant="body" color={palette.textSecondary}>
          The viewer draws a rigged hand model that is bundled inside the app, so it needs no
          network and no glove to appear. Finger bend and wrist tilt are applied to the model's
          bones directly; the model itself is not animated by a stored clip.
        </AppText>

        {/*
          Two lists, not one. These used to be a single "Active 3D Asset" block that mixed
          figures measured from the bundled model with the author, licence and geometry of a
          *different* model — a reference asset that was declined and is not in the app. Read
          together they said the shipped rig was authored by someone who did not author it, was
          not downloadable (it is in the APK), and had no animations (it has one).
        */}
        <AppText variant="overline" overline color={palette.textMuted} style={styles.sheetGap}>
          The model in this build
        </AppText>
        <Detail label="Files" value={ACTIVE_HAND_ASSET.fileNames} />
        <Detail
          label="Geometry"
          value={`${ACTIVE_HAND_ASSET.triangles.toLocaleString()} triangles · ${ACTIVE_HAND_ASSET.vertices.toLocaleString()} vertices`}
        />
        <Detail label="Texture" value={ACTIVE_HAND_ASSET.texture} />
        <Detail
          label="Rig"
          value={`${ACTIVE_HAND_ASSET.joints} bones · ${ACTIVE_HAND_ASSET.chains}`}
        />
        <Detail
          label="Animation"
          value={`${ACTIVE_HAND_ASSET.animationClips} bundled clip (${ACTIVE_HAND_ASSET.animationName}), not played back`}
        />
        <Detail
          label="Renderer"
          value={`three.js r${ACTIVE_HAND_ASSET.threeRevision} in an Android WebView`}
        />
        <Detail
          label="Size"
          value={`${Math.round(ACTIVE_HAND_ASSET.fileBytes / 1024)} KB per hand`}
        />

        <AppText variant="overline" overline color={palette.textMuted} style={styles.sheetGap}>
          The reference model that was declined
        </AppText>
        <AppText variant="caption" color={palette.textMuted} style={styles.sheetNote}>
          Recorded from Sketchfab's API on 10 October 2026. It is not in this app and nothing on
          this screen draws it — it is here because it is why the bundled model was used instead.
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
    bannerSlot: {
      marginBottom: spacing.md,
    },
    sheetBody: {
      gap: spacing.sm,
    },
    sheetGap: {
      marginTop: spacing.lg,
    },
    // Sits under a section eyebrow and explains it, so it takes the same gap
    // the eyebrow itself does rather than the sheet body's.
    sheetNote: {
      marginTop: -spacing.xs,
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
      /*
       * A floor, not a width. It aligns the label column down the sheet, and at
       * 1× no label reaches 92. Under 1.4× font scaling "Downloadable" needs
       * about 116, and a fixed 92 clipped it — in a row whose whole job is to
       * name the field. The value column is `flex: 1`, so it gives up the
       * difference.
       */
      minWidth: 92,
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
