import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { AppText } from './AppText';
import { ActionButton } from './ActionButton';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { SegmentedControl } from './SegmentedControl';
import type { GloveSide, RawSample } from '../sensors/types';
import type { GloveSnapshot } from '../ble/controller';
import {
  ORIENTATION_STEPS,
  buildOrientationProfile,
  processOrientationSamples,
  type OrientationCalibrationProfile,
  type OrientationCaptureResult,
} from '../sensors/orientationCalibration';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface OrientationCalibrationModalProps {
  visible: boolean;
  gloves: Readonly<Record<GloveSide, GloveSnapshot>>;
  currentProfile: Readonly<Record<GloveSide, OrientationCalibrationProfile>>;
  initialSide?: GloveSide;
  onClose: () => void;
  onSaveProfile: (side: GloveSide, profile: OrientationCalibrationProfile) => Promise<void>;
  onRestoreDefaults?: (side: GloveSide) => Promise<void>;
}

export function OrientationCalibrationModal({
  visible,
  gloves,
  currentProfile: _currentProfile,
  initialSide = 'left',
  onClose,
  onSaveProfile,
  onRestoreDefaults: _onRestoreDefaults,
}: OrientationCalibrationModalProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [side, setSide] = useState<GloveSide>(initialSide);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [capturedSteps, setCapturedSteps] = useState<Record<number, OrientationCaptureResult>>({});
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const sampleBuffer = useRef<RawSample[]>([]);
  const gloveSnapshot = gloves[side];
  const isLive = gloveSnapshot.source === 'real';
  const currentStep = ORIENTATION_STEPS[currentStepIndex] ?? ORIENTATION_STEPS[0]!;

  // Collect samples during explicit capture
  useEffect(() => {
    if (!capturing) return;
    const raw = gloveSnapshot.raw;
    if (raw) {
      sampleBuffer.current.push(raw);
      if (sampleBuffer.current.length >= 16) {
        const result = processOrientationSamples(sampleBuffer.current, currentStepIndex);
        if (result) {
          setCapturedSteps((prev) => ({
            ...prev,
            [currentStepIndex]: result,
          }));
        }
        setCapturing(false);
        sampleBuffer.current = [];
      }
    }
  }, [capturing, gloveSnapshot.raw, currentStepIndex]);

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
    if (currentStepIndex < ORIENTATION_STEPS.length - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    }
  }, [currentStepIndex]);

  const handlePrevStep = useCallback(() => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  }, [currentStepIndex]);

  const isStepCaptured = capturedSteps[currentStepIndex] !== undefined;
  const allStepsCaptured = ORIENTATION_STEPS.every((_, i) => capturedSteps[i] !== undefined);

  const validationSummary = useMemo<OrientationCalibrationProfile | null>(() => {
    if (!allStepsCaptured) return null;
    return buildOrientationProfile(side, capturedSteps);
  }, [allStepsCaptured, side, capturedSteps]);

  const handleSave = useCallback(async () => {
    if (!validationSummary) return;
    setSaving(true);
    try {
      await onSaveProfile(side, validationSummary);
      setSaveSuccess(true);
      setTimeout(() => {
        setSaveSuccess(false);
        onClose();
      }, 1500);
    } finally {
      setSaving(false);
    }
  }, [validationSummary, side, onSaveProfile, onClose]);

  const liveRaw = gloveSnapshot.raw;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <Icon name="hand" size={20} color={palette.accent} />
              <View>
                <AppText variant="heading" style={styles.title}>
                  3D Hand Orientation Calibration
                </AppText>
                <AppText variant="caption" color={palette.textMuted}>
                  त्रिविमीय हाथ अभिविन्यास अंशांकन
                </AppText>
              </View>
            </View>
            <IconButton icon="close" onPress={onClose} accessibilityLabel="Close calibration wizard" />
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {/* Glove Side Selector */}
            <View style={styles.sidePicker}>
              <SegmentedControl
                options={[
                  { value: 'left', label: 'Left Glove' },
                  { value: 'right', label: 'Right Glove' },
                ]}
                value={side}
                onChange={(s) => {
                  setSide(s as GloveSide);
                  setCapturedSteps({});
                  setCurrentStepIndex(0);
                }}
                accessibilityLabel="Choose glove side to calibrate"
              />
            </View>

            {/* Hardware Live Stream Status */}
            <View style={styles.liveBar}>
              <View style={styles.liveIndicator}>
                <View style={[styles.liveDot, { backgroundColor: isLive ? palette.success : palette.warning }]} />
                <AppText variant="label">
                  {isLive ? `${side.toUpperCase()} Glove Streaming` : `${side.toUpperCase()} Glove Offline`}
                </AppText>
              </View>
              <Badge
                label={isLive ? '10 Hz Active' : 'No Data'}
                tone={isLive ? 'success' : 'neutral'}
                dot={isLive}
              />
            </View>

            {/* Step Progress Pills */}
            <View style={styles.stepProgressRow}>
              {ORIENTATION_STEPS.map((step, idx) => {
                const captured = capturedSteps[idx] !== undefined;
                const isCurrent = currentStepIndex === idx;
                return (
                  <Pressable
                    key={step.id}
                    onPress={() => setCurrentStepIndex(idx)}
                    style={[
                      styles.stepDot,
                      captured && styles.stepDotCaptured,
                      isCurrent && styles.stepDotCurrent,
                    ]}
                    accessibilityLabel={`Go to Step ${idx + 1}: ${step.title}`}
                  >
                    <AppText
                      variant="caption"
                      style={[
                        styles.stepDotText,
                        captured && styles.stepDotTextCaptured,
                        isCurrent && styles.stepDotTextCurrent,
                      ]}
                    >
                      {idx + 1}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>

            {/* Instruction Card */}
            <View style={styles.instructionCard}>
              <View style={styles.instructionHeader}>
                <AppText variant="label" color={palette.accent}>
                  Step {currentStepIndex + 1} of 6
                </AppText>
                <AppText variant="heading" style={styles.stepTitle}>
                  {currentStep.title}
                </AppText>
                <AppText variant="body" color={palette.accent} style={styles.hindiTitle}>
                  {currentStep.hindiTitle}
                </AppText>
              </View>

              <View style={styles.instructionBody}>
                <AppText variant="body" color={palette.textSecondary}>
                  {currentStep.instruction}
                </AppText>
                <AppText variant="caption" color={palette.textMuted} style={styles.hindiInstruction}>
                  {currentStep.hindiInstruction}
                </AppText>
              </View>

              {/* Target Pose Visual Indicator */}
              <View style={styles.targetPoseBadge}>
                <Icon name="hand" size={24} color={palette.accent} />
                <AppText variant="caption" color={palette.textSecondary}>
                  Target: {currentStep.targetPose.replace('_', ' ').toUpperCase()}
                </AppText>
              </View>
            </View>

            {/* Live IMU Sensor Values Card */}
            <View style={styles.telemetryCard}>
              <View style={styles.telemetryHeader}>
                <AppText variant="overline" overline color={palette.textMuted}>
                  Live MPU6050 & Flex Stream
                </AppText>
                <AppText variant="caption" color={palette.textMuted}>
                  {capturing ? 'Recording batch...' : isStepCaptured ? 'Captured' : 'Streaming'}
                </AppText>
              </View>

              <View style={styles.metricsGrid}>
                <View style={styles.metricItem}>
                  <AppText variant="caption" color={palette.textMuted}>
                    Pitch
                  </AppText>
                  <AppText variant="body" style={styles.metricValue}>
                    {liveRaw?.pitch !== undefined ? `${liveRaw.pitch.toFixed(1)}°` : '--°'}
                  </AppText>
                </View>
                <View style={styles.metricItem}>
                  <AppText variant="caption" color={palette.textMuted}>
                    Roll
                  </AppText>
                  <AppText variant="body" style={styles.metricValue}>
                    {liveRaw?.roll !== undefined ? `${liveRaw.roll.toFixed(1)}°` : '--°'}
                  </AppText>
                </View>
                <View style={styles.metricItem}>
                  <AppText variant="caption" color={palette.textMuted}>
                    Acc Z
                  </AppText>
                  <AppText variant="body" style={styles.metricValue}>
                    {liveRaw?.accel ? `${liveRaw.accel.z}` : '--'}
                  </AppText>
                </View>
                <View style={styles.metricItem}>
                  <AppText variant="caption" color={palette.textMuted}>
                    Flex Med
                  </AppText>
                  <AppText variant="body" style={styles.metricValue}>
                    {liveRaw?.flex ? `${liveRaw.flex[0]}` : '--'}
                  </AppText>
                </View>
              </View>

              {/* Captured Step Summary if already captured */}
              {isStepCaptured && (
                <View style={styles.capturedSummary}>
                  <View style={styles.capturedRow}>
                    <Icon name="check" size={16} color={palette.success} />
                    <AppText variant="caption" color={palette.success}>
                      Captured: Pitch {capturedSteps[currentStepIndex]?.pitchMedian}° · Roll{' '}
                      {capturedSteps[currentStepIndex]?.rollMedian}°
                    </AppText>
                  </View>
                  <AppText variant="caption" color={palette.textMuted}>
                    Stability: {capturedSteps[currentStepIndex]?.stabilityScore}% ({capturedSteps[currentStepIndex]?.sampleCount} frames)
                  </AppText>
                </View>
              )}
            </View>

            {/* Validation Summary if all 6 steps captured */}
            {allStepsCaptured && validationSummary && (
              <View style={styles.summaryCard}>
                <View style={styles.summaryTitleRow}>
                  <Icon name="check" size={20} color={palette.success} />
                  <AppText variant="heading" style={styles.summaryTitle}>
                    Orientation Profile Ready
                  </AppText>
                </View>

                <View style={styles.summaryDetails}>
                  <AppText variant="caption" color={palette.textSecondary}>
                    • Neutral Rest Pitch: {validationSummary.restPitch}°
                  </AppText>
                  <AppText variant="caption" color={palette.textSecondary}>
                    • Neutral Rest Roll: {validationSummary.restRoll}°
                  </AppText>
                  <AppText variant="caption" color={palette.textSecondary}>
                    • Repeatability Drift: {validationSummary.repeatabilityDriftDeg}° ({validationSummary.repeatabilityPassed ? 'PASSED' : 'CHECK'})
                  </AppText>
                  <AppText variant="caption" color={palette.textSecondary}>
                    • Alignment Quality: {validationSummary.quality.toUpperCase()}
                  </AppText>
                </View>
              </View>
            )}
          </ScrollView>

          {/* Action Footer */}
          <View style={styles.footer}>
            {allStepsCaptured ? (
              <View style={styles.footerRow}>
                <ActionButton
                  label="Retake All"
                  tone="ghost"
                  onPress={() => {
                    setCapturedSteps({});
                    setCurrentStepIndex(0);
                  }}
                  accessibilityLabel="Retake all orientation calibration steps"
                />
                <ActionButton
                  label={saving ? 'Saving...' : saveSuccess ? 'Saved ✓' : 'Save Profile'}
                  tone="primary"
                  onPress={handleSave}
                  disabled={saving || saveSuccess}
                  accessibilityLabel="Save orientation profile"
                />
              </View>
            ) : (
              <View style={styles.footerRow}>
                <ActionButton
                  label="Previous"
                  tone="ghost"
                  onPress={handlePrevStep}
                  disabled={currentStepIndex === 0 || capturing}
                  accessibilityLabel="Go to previous step"
                />

                {!isStepCaptured ? (
                  <ActionButton
                    label={capturing ? 'Recording...' : 'Capture This Pose'}
                    tone="primary"
                    onPress={handleStartCapture}
                    disabled={!isLive || capturing}
                    accessibilityLabel="Capture this orientation pose"
                  />
                ) : (
                  <View style={styles.stepSuccessActions}>
                    <ActionButton
                      label="Retake"
                      tone="ghost"
                      onPress={handleRetake}
                      accessibilityLabel="Retake current step"
                    />
                    <ActionButton
                      label="Next Step"
                      tone="primary"
                      onPress={handleNextStep}
                      accessibilityLabel="Advance to next step"
                    />
                  </View>
                )}
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.65)',
      justifyContent: 'flex-end',
    },
    dialog: {
      backgroundColor: palette.surface,
      borderTopLeftRadius: radii.xl,
      borderTopRightRadius: radii.xl,
      maxHeight: '88%',
      minHeight: '60%',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
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
    body: {
      flex: 1,
    },
    bodyContent: {
      padding: spacing.lg,
      gap: spacing.md,
    },
    sidePicker: {
      marginBottom: spacing.xs,
    },
    liveBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: palette.surfaceRaised,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radii.md,
    },
    liveIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    liveDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    stepProgressRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginVertical: spacing.xs,
    },
    stepDot: {
      width: 32,
      height: 32,
      borderRadius: 16,
      borderWidth: 1.5,
      borderColor: palette.border,
      backgroundColor: palette.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepDotCaptured: {
      borderColor: palette.success,
      backgroundColor: palette.surfaceRaised,
    },
    stepDotCurrent: {
      borderColor: palette.accent,
      backgroundColor: palette.surface,
    },
    stepDotText: {
      color: palette.textMuted,
      fontSize: 12,
      fontWeight: '600',
    },
    stepDotTextCaptured: {
      color: palette.success,
    },
    stepDotTextCurrent: {
      color: palette.accent,
    },
    instructionCard: {
      backgroundColor: palette.surfaceRaised,
      borderRadius: radii.lg,
      padding: spacing.md,
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: palette.border,
    },
    instructionHeader: {
      gap: spacing.xs,
    },
    stepTitle: {
      fontSize: 15,
    },
    hindiTitle: {
      fontSize: 13,
      fontWeight: '500',
    },
    instructionBody: {
      gap: spacing.xs,
    },
    hindiInstruction: {
      lineHeight: 18,
    },
    targetPoseBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: palette.surface,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radii.sm,
      alignSelf: 'flex-start',
      marginTop: spacing.xs,
    },
    telemetryCard: {
      backgroundColor: palette.surfaceRaised,
      borderRadius: radii.lg,
      padding: spacing.md,
      gap: spacing.sm,
    },
    telemetryHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    metricsGrid: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    metricItem: {
      alignItems: 'center',
      gap: 2,
    },
    metricValue: {
      fontFamily: 'monospace',
      fontWeight: '700',
    },
    capturedSummary: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      paddingTop: spacing.xs,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    capturedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    summaryCard: {
      backgroundColor: palette.surfaceRaised,
      borderRadius: radii.lg,
      padding: spacing.md,
      gap: spacing.sm,
      borderWidth: 1.5,
      borderColor: palette.success,
    },
    summaryTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    summaryTitle: {
      fontSize: 15,
      color: palette.success,
    },
    summaryDetails: {
      gap: 4,
    },
    footer: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      backgroundColor: palette.surface,
    },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    stepSuccessActions: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
  });
