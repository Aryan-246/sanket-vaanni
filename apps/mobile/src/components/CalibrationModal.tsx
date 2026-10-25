import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { Icon } from './Icon';
import { SegmentedControl } from './SegmentedControl';
import type { GloveSnapshot } from '../ble/controller';
import type { GloveSide } from '../ble/types';
import type { CalibrationProfile } from '../sensors/calibration';
import type { RawSample } from '../sensors/types';
import {
  CALIBRATION_STEPS,
  processStepSamples,
  validateCalibrationDataset,
  buildProfileFromSummary,
  type CalibrationSummary,
  type StepCaptureResult,
} from '../sensors/hardwareCalibration';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface CalibrationModalProps {
  visible: boolean;
  onClose: () => void;
  gloves: Readonly<Record<GloveSide, GloveSnapshot>>;
  currentCalibration: Readonly<Record<GloveSide, CalibrationProfile>>;
  onSaveCalibration: (side: GloveSide, profile: CalibrationProfile) => Promise<void>;
  onRestoreDefaults?: (side: GloveSide) => Promise<void>;
  initialSide?: GloveSide;
}

const REQUIRED_SAMPLES_PER_STEP = 15; // ~1.5s at 10Hz

export function CalibrationModal({
  visible,
  onClose,
  gloves,
  currentCalibration,
  onSaveCalibration,
  onRestoreDefaults,
  initialSide = 'left',
}: CalibrationModalProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [side, setSide] = useState<GloveSide>(initialSide);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [capturedSteps, setCapturedSteps] = useState<Record<number, StepCaptureResult>>({});
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const sampleBuffer = useRef<RawSample[]>([]);
  const activeGlove = gloves[side];
  const stepConfig = CALIBRATION_STEPS[currentStepIndex];

  // Capture incoming frames when capturing is active
  useEffect(() => {
    if (!capturing || !activeGlove.raw) return;

    sampleBuffer.current.push(activeGlove.raw);
    if (sampleBuffer.current.length >= REQUIRED_SAMPLES_PER_STEP) {
      const result = processStepSamples(sampleBuffer.current);
      if (result) {
        setCapturedSteps((prev) => ({
          ...prev,
          [currentStepIndex]: { ...result, step: currentStepIndex },
        }));
      }
      setCapturing(false);
      sampleBuffer.current = [];
    }
  }, [capturing, activeGlove.raw, currentStepIndex]);

  const handleStartCapture = useCallback(() => {
    sampleBuffer.current = [];
    setCapturing(true);
  }, []);

  const handleRetake = useCallback(() => {
    setCapturedSteps((prev) => {
      const next = { ...prev };
      delete next[currentStepIndex];
      return next;
    });
    sampleBuffer.current = [];
    setCapturing(false);
  }, [currentStepIndex]);

  const handleNextStep = useCallback(() => {
    if (currentStepIndex < CALIBRATION_STEPS.length - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    }
  }, [currentStepIndex]);

  const handlePrevStep = useCallback(() => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  }, [currentStepIndex]);

  const isStepCaptured = capturedSteps[currentStepIndex] !== undefined;
  const allStepsCaptured = CALIBRATION_STEPS.every((_, i) => capturedSteps[i] !== undefined);

  const validationSummary = useMemo<CalibrationSummary | null>(() => {
    if (!allStepsCaptured) return null;
    return validateCalibrationDataset(side, capturedSteps);
  }, [allStepsCaptured, side, capturedSteps]);

  const handleSave = useCallback(async () => {
    if (!validationSummary || !validationSummary.canSave) return;
    setSaving(true);
    try {
      const profile = buildProfileFromSummary(validationSummary, currentCalibration[side]);
      await onSaveCalibration(side, profile);
      setSaveSuccess(true);
      setTimeout(() => {
        setSaveSuccess(false);
        onClose();
      }, 1500);
    } finally {
      setSaving(false);
    }
  }, [validationSummary, currentCalibration, side, onSaveCalibration, onClose]);

  const handleRestore = useCallback(async () => {
    setSaving(true);
    try {
      if (onRestoreDefaults) {
        await onRestoreDefaults(side);
      }
      setCapturedSteps({});
      setCurrentStepIndex(0);
      onClose();
    } finally {
      setSaving(false);
    }
  }, [side, onRestoreDefaults, onClose]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <Icon name="hand" size={20} color={palette.accent} />
              <AppText variant="heading" style={styles.title}>
                Glove Hardware Calibration
              </AppText>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close calibration modal"
              hitSlop={8}
            >
              <Icon name="close" size={20} color={palette.textMuted} />
            </Pressable>
          </View>

          <View style={styles.sideSelector}>
            <SegmentedControl
              options={[
                { value: 'left', label: 'Left Glove' },
                { value: 'right', label: 'Right Glove' },
              ]}
              value={side}
              onChange={(newSide) => {
                setSide(newSide as GloveSide);
                setCapturedSteps({});
                setCurrentStepIndex(0);
              }}
              accessibilityLabel="Choose glove side to calibrate"
            />
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {/* Step Progress Chips */}
            <View style={styles.stepProgressRow}>
              {CALIBRATION_STEPS.map((s, i) => {
                const captured = capturedSteps[i] !== undefined;
                const active = currentStepIndex === i;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => setCurrentStepIndex(i)}
                    style={[
                      styles.stepChip,
                      active && { borderColor: palette.accent, backgroundColor: palette.surfaceRaised },
                      captured && { backgroundColor: palette.accentSurface },
                    ]}
                  >
                    <AppText
                      variant="caption"
                      color={active ? palette.accent : captured ? palette.accent : palette.textMuted}
                    >
                      {i + 1}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>

            {/* Current Step Card */}
            <Card style={styles.stepCard}>
              <View style={styles.stepHeader}>
                <Badge
                  label={`Step ${currentStepIndex + 1} of 7`}
                  tone={isStepCaptured ? 'success' : 'neutral'}
                />
                <AppText variant="label" color={palette.textPrimary}>
                  {stepConfig?.title}
                </AppText>
              </View>

              <AppText variant="body" color={palette.textSecondary} style={styles.instruction}>
                {stepConfig?.instruction}
              </AppText>

              {/* Real-time Hardware Telemetry Channel Monitor */}
              <View style={styles.channelsMonitor}>
                <AppText variant="overline" color={palette.textMuted}>
                  Live ADC Telemetry (COM / BLE)
                </AppText>
                <View style={styles.channelsRow}>
                  {['Thumb', 'Index', 'Mid', 'Ring', 'Pinky'].map((name, ch) => {
                    const rawVal = activeGlove.raw?.flex[ch] ?? 0;
                    const isTarget = stepConfig?.targetFinger !== null && stepConfig?.targetFinger === ['thumb', 'index', 'middle', 'ring', 'pinky'][ch];
                    return (
                      <View
                        key={name}
                        style={[
                          styles.channelBox,
                          isTarget && { borderColor: palette.accent, backgroundColor: palette.surfaceRaised },
                        ]}
                      >
                        <AppText
                          variant="caption"
                          color={isTarget ? palette.accent : palette.textMuted}
                        >
                          {name}
                        </AppText>
                        <AppText variant="label" color={rawVal <= 15 ? palette.danger : palette.textPrimary}>
                          {rawVal}
                        </AppText>
                        {rawVal <= 15 ? (
                          <AppText variant="caption" color={palette.danger}>
                            0V
                          </AppText>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              </View>

              {/* Capture Actions */}
              <View style={styles.actionRow}>
                {!isStepCaptured && !capturing ? (
                  <ActionButton
                    label="Capture Pose Samples"
                    tone="primary"
                    icon="scan"
                    onPress={handleStartCapture}
                    disabled={!activeGlove.receivingData}
                    accessibilityLabel="Start recording samples for this pose"
                  />
                ) : null}

                {capturing ? (
                  <View style={styles.capturingNotice}>
                    <Icon name="refresh" size={16} color={palette.accent} />
                    <AppText variant="label" color={palette.accent}>
                      Hold pose... capturing 15 samples
                    </AppText>
                  </View>
                ) : null}

                {isStepCaptured ? (
                  <View style={styles.capturedSummary}>
                    <Badge label="Captured" tone="success" dot />
                    <AppText variant="caption" color={palette.textSecondary}>
                      Medians: [{capturedSteps[currentStepIndex]?.rawMedians.join(', ')}]
                    </AppText>
                    <ActionButton
                      label="Retake"
                      tone="ghost"
                      compact
                      onPress={handleRetake}
                      accessibilityLabel="Retake this pose"
                    />
                  </View>
                ) : null}
              </View>

              {/* Navigation between steps */}
              <View style={styles.stepNavRow}>
                <ActionButton
                  label="Previous"
                  tone="ghost"
                  compact
                  disabled={currentStepIndex === 0}
                  onPress={handlePrevStep}
                />
                <ActionButton
                  label={currentStepIndex === CALIBRATION_STEPS.length - 1 ? 'Review' : 'Next Step'}
                  tone="secondary"
                  compact
                  disabled={!isStepCaptured}
                  onPress={handleNextStep}
                />
              </View>
            </Card>

            {/* Validation & Save Section (Shown when all 7 steps are complete) */}
            {validationSummary !== null ? (
              <Card style={styles.summaryCard}>
                <AppText variant="heading" color={palette.textPrimary}>
                  Calibration Review & Validation
                </AppText>
                <AppText variant="caption" color={palette.textSecondary}>
                  Repeatability delta: {validationSummary.repeatabilityPassed ? 'PASSED' : 'DRIFT DETECTED'}
                </AppText>

                <View style={styles.table}>
                  {validationSummary.channels.map((ch) => (
                    <View key={ch.finger} style={styles.tableRow}>
                      <View style={styles.colName}>
                        <AppText variant="label">{ch.finger.toUpperCase()}</AppText>
                        <AppText variant="caption" color={palette.textMuted}>
                          Ch{ch.channelIndex}
                        </AppText>
                      </View>
                      <View style={styles.colStats}>
                        <AppText variant="caption" color={palette.textSecondary}>
                          Rest: {ch.rest} · Bend: {ch.fullFlex}
                        </AppText>
                        <AppText variant="caption" color={ch.polarity === 'inverted' ? palette.warning : palette.textMuted}>
                          Span: {ch.span} ({ch.polarity})
                        </AppText>
                        {ch.issue ? (
                          <AppText variant="caption" color={ch.status === 'failed' ? palette.danger : palette.warning}>
                            {ch.issue}
                          </AppText>
                        ) : null}
                      </View>
                      <Badge
                        label={ch.status.toUpperCase()}
                        tone={ch.status === 'valid' ? 'success' : ch.status === 'warning' ? 'warning' : 'danger'}
                      />
                    </View>
                  ))}
                </View>

                {saveSuccess ? (
                  <View style={styles.successBanner}>
                    <Icon name="check" size={16} color={palette.success} />
                    <AppText variant="label" color={palette.success}>
                      Calibration saved to app storage!
                    </AppText>
                  </View>
                ) : (
                  <View style={styles.saveActionRow}>
                    <ActionButton
                      label="Save Hardware Calibration"
                      tone="primary"
                      icon="check"
                      busy={saving}
                      disabled={!validationSummary.canSave}
                      onPress={handleSave}
                      accessibilityLabel="Save verified calibration"
                    />
                    <ActionButton
                      label="Restore Factory Anchors"
                      tone="ghost"
                      compact
                      onPress={handleRestore}
                      accessibilityLabel="Restore default factory anchors"
                    />
                  </View>
                )}
              </Card>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      justifyContent: 'center',
      padding: spacing.md,
    },
    dialog: {
      maxHeight: '90%',
      backgroundColor: palette.surface,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: palette.border,
      overflow: 'hidden',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    headerTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    title: {
      fontSize: 16,
    },
    sideSelector: {
      padding: spacing.sm,
      backgroundColor: palette.surfaceSunken,
    },
    body: {
      flexShrink: 1,
    },
    bodyContent: {
      padding: spacing.md,
      gap: spacing.md,
    },
    stepProgressRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: spacing.xs,
    },
    stepChip: {
      flex: 1,
      paddingVertical: spacing.xs,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surfaceSunken,
    },
    stepCard: {
      gap: spacing.sm,
    },
    stepHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    instruction: {
      lineHeight: 20,
    },
    channelsMonitor: {
      gap: spacing.xs,
      padding: spacing.sm,
      backgroundColor: palette.surfaceSunken,
      borderRadius: radii.md,
    },
    channelsRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: spacing.xs,
    },
    channelBox: {
      flex: 1,
      padding: spacing.xs,
      alignItems: 'center',
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
    },
    actionRow: {
      paddingVertical: spacing.xs,
      alignItems: 'center',
    },
    capturingNotice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    capturedSummary: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      paddingVertical: spacing.xs,
    },
    stepNavRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingTop: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    summaryCard: {
      gap: spacing.sm,
      borderColor: palette.accent,
    },
    table: {
      gap: spacing.xs,
    },
    tableRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    colName: {
      width: 60,
    },
    colStats: {
      flex: 1,
      paddingHorizontal: spacing.sm,
    },
    saveActionRow: {
      gap: spacing.sm,
      paddingTop: spacing.sm,
    },
    successBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.sm,
      backgroundColor: palette.surfaceRaised,
      borderRadius: radii.sm,
    },
  });
