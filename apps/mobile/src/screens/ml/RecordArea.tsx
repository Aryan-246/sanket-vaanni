/**
 * Recording a window, and asking a person what it was.
 *
 * ## The screen is the state machine, drawn
 *
 * `CaptureController` has six phases and each one has exactly one thing the user
 * can sensibly do next. This renders that phase — not a form with every control
 * always live — so it is not possible to press "Finish now" while idle, or to
 * start a window while one is waiting for a label. The controller refuses those
 * anyway; the screen not offering them is the difference between an app that
 * says no and one that never asks.
 *
 * ## The label prompt is the point
 *
 * Everything else here is machinery for delivering one thing: a window of
 * motion, and the person's own answer to "what was that?". There is no path that
 * skips it. "I'm not sure" is a first-class answer — it keeps the motion, marks
 * it unconfirmed, and the trainer refuses it — because a wrong label is worse
 * than a missing one, and guessing is exactly what this pipeline exists to
 * avoid.
 *
 * ## Checkpointing is stated, not implied
 *
 * Each confirmed window is written the moment it is confirmed, and the session
 * count is written with it. The card says so, and says what happens to a session
 * that is interrupted, because a user deciding whether to record twenty more
 * windows deserves to know that closing the app does not undo them.
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { ActionButton } from '../../components/ActionButton';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { SegmentedControl } from '../../components/SegmentedControl';
import { TextField } from '../../components/TextField';
import { useAppState } from '../../app/AppState';
import { SOURCE_LABEL } from '../../ml';
import type { HandContext } from '../../ml';
import type { GloveSide } from '../../sensors/types';
import { spacing } from '../../theme';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import type { Palette } from '../../theme/palette';
import { Meter, NoteCard, Row, Section } from './shared';
import { useMl, useMlData, useMlSnapshot } from './hooks';
import type { MlArea } from './areas';

const RECORD_MODES: readonly { value: 'word' | 'sentence'; label: string }[] = [
  { value: 'word', label: 'Word (250 frames · 0.5s)' },
  { value: 'sentence', label: 'Sentence (Custom)' },
];

const SENTENCE_FRAMES: readonly { value: '50' | '100' | '250' | '500'; label: string }[] = [
  { value: '50', label: '50 frames' },
  { value: '100', label: '100 frames' },
  { value: '250', label: '250 frames' },
  { value: '500', label: '500 frames' },
];

const SENTENCE_INTERVALS: readonly { value: '200' | '500' | '1000'; label: string }[] = [
  { value: '200', label: '0.2s interval' },
  { value: '500', label: '0.5s interval' },
  { value: '1000', label: '1.0s interval' },
];

const LANGUAGES: readonly { value: string; label: string }[] = [
  { value: 'isl', label: 'ISL (Indian Sign Language)' },
  { value: 'asl', label: 'ASL (American Sign Language)' },
  { value: 'bsl', label: 'BSL (British Sign Language)' },
];

const SIDES: readonly { value: GloveSide; label: string }[] = [
  { value: 'right', label: 'Right glove' },
  { value: 'left', label: 'Left glove' },
];

const HANDS: readonly { value: HandContext; label: string }[] = [
  { value: 'right', label: 'Right-handed' },
  { value: 'left', label: 'Left-handed' },
  { value: 'both', label: 'Two-handed' },
];

export function RecordArea({ onOpenArea }: { onOpenArea: (area: MlArea) => void }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const ml = useMl();
  const snapshot = useMlSnapshot();
  const data = useMlData();
  const { calibration } = useAppState();

  const capture = ml.capture;
  const state = snapshot.capture;

  const [recordMode, setRecordMode] = useState<'word' | 'sentence'>('word');
  const [side, setSide] = useState<GloveSide>('right');
  const [handContext, setHandContext] = useState<HandContext>('right');
  const [sentenceFramesStr, setSentenceFramesStr] = useState<'50' | '100' | '250' | '500'>('100');
  const [sentenceIntervalStr, setSentenceIntervalStr] = useState<'200' | '500' | '1000'>('500');
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  const [showAllLabelsInReview, setShowAllLabelsInReview] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const labels = useMemo(
    () =>
      data.labels.filter(
        (label) => label.languageId === data.languageId && label.archivedAtMs === null,
      ),
    [data.labels, data.languageId],
  );

  const activeLabelId = selectedLabelId ?? labels[0]?.id ?? null;
  const activeLabel = labels.find((l) => l.id === activeLabelId) ?? null;

  const elapsed = state.elapsedMs;
  const target = state.targetMs;

  const start = async () => {
    setNotice(null);
    const targetFrames = recordMode === 'word' ? 250 : Number(sentenceFramesStr);
    const sampleIntervalMs = recordMode === 'word' ? 500 : Number(sentenceIntervalStr);
    const targetMs = targetFrames * sampleIntervalMs;
    const outcome = await ml.beginCapture({
      side: recordMode === 'word' ? 'right' : side,
      handContext: recordMode === 'word' ? 'right' : handContext,
      targetMs,
      targetFrames,
      sampleIntervalMs,
      recordMode,
      languageId: data.languageId,
    });
    if (!outcome.ok) setNotice(outcome.reason);
  };

  const confirmLabel = async (labelId: string | null) => {
    const outcome = await capture.confirm(labelId);
    if (!outcome.ok) setNotice(outcome.reason);
    setShowAllLabelsInReview(false);
  };

  const beginWindow = () => {
    const outcome = capture.beginWindow();
    if (!outcome.ok) setNotice(outcome.reason);
  };

  const rejectLast = async () => {
    const last = state.lastSaved;
    if (last === null) return;
    await capture.rejectLast(last.sampleId, rejectReason.trim());
    setRejecting(false);
    setRejectReason('');
  };

  const session = state.session;

  return (
    <View style={styles.areas}>
      {notice !== null ? (
        <Card accentBorder testID="capture-notice">
          <View style={styles.noticeRow}>
            <Icon name="warning" size={16} color={palette.warning} />
            <View style={styles.grow}>
              <AppText variant="label">That cannot be done yet</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                {notice}
              </AppText>
            </View>
          </View>
        </Card>
      ) : null}

      {state.error !== null ? (
        <NoteCard tone="warning" testID="capture-error">
          {state.error}
        </NoteCard>
      ) : null}

      {/* ------------------------------------------------------- open a session */}

      {session === null ? (
        <Section
          label="Recording Setup"
          detail="Train real signs using calibrated glove telemetry. Words capture 250 frames at 0.5s each for the Right Glove."
        >
          <Card style={styles.stack}>
            <AppText variant="caption" color={palette.textSecondary}>
              Sign Language Profile
            </AppText>
            <SegmentedControl
              options={LANGUAGES}
              value={data.languageId}
              onChange={(l) => ml.setLanguage(l)}
              accessibilityLabel="Sign language profile"
            />

            <AppText variant="caption" color={palette.textSecondary}>
              Training Type
            </AppText>
            <SegmentedControl
              options={RECORD_MODES}
              value={recordMode}
              onChange={setRecordMode}
              accessibilityLabel="Training type"
            />

            {recordMode === 'word' ? (
              <NoteCard tone="muted">
                Word Mode: Exactly 250 frames at 0.5s detection interval using the Right Hand Glove. Appends into the dataset (right_glove_dataset.csv).
              </NoteCard>
            ) : (
              <View style={styles.stack}>
                <AppText variant="caption" color={palette.textSecondary}>
                  Sentence Frames
                </AppText>
                <SegmentedControl
                  options={SENTENCE_FRAMES}
                  value={sentenceFramesStr}
                  onChange={setSentenceFramesStr}
                  accessibilityLabel="Sentence frames"
                />

                <AppText variant="caption" color={palette.textSecondary}>
                  Sampling Interval (Time per Frame)
                </AppText>
                <SegmentedControl
                  options={SENTENCE_INTERVALS}
                  value={sentenceIntervalStr}
                  onChange={setSentenceIntervalStr}
                  accessibilityLabel="Sentence frame interval"
                />

                <AppText variant="caption" color={palette.textSecondary}>
                  Which glove are you recording from?
                </AppText>
                <SegmentedControl
                  options={SIDES}
                  value={side}
                  onChange={setSide}
                  accessibilityLabel="Glove to record from"
                />

                <AppText variant="caption" color={palette.textSecondary}>
                  Signing Hand Context
                </AppText>
                <SegmentedControl
                  options={HANDS}
                  value={handContext}
                  onChange={setHandContext}
                  accessibilityLabel="Signing hand"
                />
              </View>
            )}

            <ActionButton
              label={recordMode === 'word' ? 'Start Session (250 frames · 0.5s · Right Glove)' : 'Start Sentence Session'}
              icon="plus"
              onPress={() => {
                void start();
              }}
            />
          </Card>
        </Section>
      ) : (
        <Section label="This session">
          <Card style={styles.stack}>
            <Row>
              <View style={styles.headRow}>
                <AppText variant="label" style={styles.grow}>
                  Recording from {session.deviceLabel ?? 'Right Glove'} ({state.recordMode === 'word' ? 'Word · 250 frames' : `Sentence · ${state.targetFrames} frames`})
                </AppText>
                <AppText variant="caption" color={palette.textMuted}>
                  {SOURCE_LABEL[session.source]}
                </AppText>
              </View>
              <AppText variant="caption" color={palette.textMuted}>
                Filing windows under {session.languageId.toUpperCase()} ({session.source === 'simulated' ? 'simulated' : 'real BLE'}). Sampling at {(state.sampleIntervalMs / 1000).toFixed(1)}s per frame ({state.targetFrames} frames total).
              </AppText>
            </Row>
            <Row last>
              <AppText variant="caption" color={palette.textMuted}>
                {session.sampleCount === 0
                  ? 'No window has been confirmed in this session yet.'
                  : `${session.sampleCount} window${session.sampleCount === 1 ? '' : 's'} confirmed and written in this session.`}
              </AppText>
            </Row>
          </Card>
        </Section>
      )}

      {/* ------------------------------------------------------------- capture */}

      {state.phase === 'ready' ? (
        <Section
          label="Record a window"
          detail={`Each window is exactly ${(target / 1000).toFixed(1)} seconds of motion (${target >= 5000 ? '~50' : '~30'} raw readings resampled to 30 frames for high accuracy). Select your sign before recording.`}
        >
          {labels.length === 0 ? (
            <EmptyState
              icon="scan"
              title="No signs are defined yet"
              body="A window has to be filed under a sign you have named. Nothing here reads a name off the motion, so this is the one step that cannot be skipped."
              action={
                <View style={styles.buttonRow}>
                  <ActionButton
                    label="Load 5 Starter Signs (ASL)"
                    tone="primary"
                    onPress={() => { void ml.store.ensureCanonicalLabels(data.languageId); }}
                  />
                  <ActionButton
                    label="Define a custom sign"
                    tone="secondary"
                    onPress={() => onOpenArea('dataset')}
                  />
                </View>
              }
            />
          ) : (
            <Card style={styles.stack}>
              <AppText variant="label">1. Select Target Sign BEFORE Recording</AppText>
              <View style={styles.buttonRow}>
                {labels.map((l) => {
                  const isSelected = l.id === activeLabelId;
                  return (
                    <ActionButton
                      key={l.id}
                      label={l.text}
                      tone={isSelected ? 'primary' : 'secondary'}
                      onPress={() => setSelectedLabelId(l.id)}
                    />
                  );
                })}
              </View>

              <AppText variant="caption" color={palette.textMuted}>
                Selected: {activeLabel ? `“${activeLabel.text}”` : 'None selected'}. Perform the gesture naturally over the {(target / 1000).toFixed(1)}s window.
              </AppText>

              <AppText variant="label">2. Record {state.targetFrames || 250} Frames ({(state.targetMs / 1000).toFixed(1)}s)</AppText>
              <ActionButton
                label={activeLabel ? `Record “${activeLabel.text}” (${state.targetFrames || 250} frames · ${(state.targetMs / 1000).toFixed(1)}s)` : 'Select a sign above to record'}
                disabled={!activeLabel}
                onPress={beginWindow}
                icon="scan"
                tone="primary"
              />
            </Card>
          )}
        </Section>
      ) : null}

      {state.phase === 'recording' ? (
        <Section label="Recording in progress">
          <Card style={styles.stack} accentBorder>
            <View style={styles.headRow}>
              <AppText variant="title">
                Target Sign: {activeLabel ? activeLabel.text : 'Selected Sign'}
              </AppText>
            </View>
            <AppText variant="caption" color={palette.textSecondary}>
              Hold or perform the sign with the {side === 'left' ? 'Left' : 'Right'} glove. Capturing {state.targetFrames || 250} frames at {(state.sampleIntervalMs / 1000).toFixed(1)}s intervals for maximum ML accuracy.
            </AppText>

            <Meter
              testID="capture-progress"
              value={state.targetFrames > 0 ? Math.min(1, state.frames / state.targetFrames) : null}
              label={`${state.frames} of ${state.targetFrames || 250} frames (${(state.frames * (state.sampleIntervalMs / 1000)).toFixed(1)}s)`}
              unknown="Waiting for the first reading."
            />
            <AppText variant="caption" color={palette.textMuted}>
              {state.frames} frame{state.frames === 1 ? '' : 's'} recorded at {(state.sampleIntervalMs / 1000).toFixed(1)}s per frame. Real Right Glove BLE stream.
            </AppText>
            <View style={styles.buttonRow}>
              <ActionButton
                label="Finish now"
                tone="secondary"
                onPress={() => { void capture.finishWindow(); }}
              />
              <ActionButton
                label="Discard"
                tone="danger"
                onPress={() => setConfirmDiscard(true)}
              />
            </View>
          </Card>
        </Section>
      ) : null}

      {state.phase === 'awaiting-label' ? (
        <Section
          label="Review Captured Window"
          detail="Review the window and explicitly save under your target sign or discard."
        >
          <Card style={styles.stack} accentBorder>
            <View style={styles.headRow}>
              <AppText variant="title">
                Recorded: {activeLabel ? `“${activeLabel.text}”` : 'Captured Window'}
              </AppText>
            </View>

            {state.qualityNote !== null ? (
              <NoteCard tone="warning">{state.qualityNote}</NoteCard>
            ) : (
              <AppText variant="caption" color={palette.textMuted}>
                {state.pending === null
                  ? 'The window was built.'
                  : `${state.pending.quality.frameCount} readings across ${(state.targetMs / 1000).toFixed(1)} seconds, resampled to 30 frames.`}
              </AppText>
            )}

            <ActionButton
              label={activeLabel ? `Confirm & Save “${activeLabel.text}”` : 'Confirm & Save'}
              tone="primary"
              onPress={() => { void confirmLabel(activeLabel?.id ?? null); }}
            />

            <View style={styles.buttonRow}>
              <ActionButton
                label={showAllLabelsInReview ? 'Hide other signs' : 'Change sign label'}
                tone="secondary"
                onPress={() => setShowAllLabelsInReview((v) => !v)}
              />
              <ActionButton
                label="Discard this window"
                tone="danger"
                onPress={() => setConfirmDiscard(true)}
              />
            </View>

            {showAllLabelsInReview ? (
              <View style={styles.stack}>
                <AppText variant="caption" color={palette.textSecondary}>
                  Choose an alternative sign to file this window under:
                </AppText>
                <View style={styles.buttonRow}>
                  {labels.map((label) => (
                    <ActionButton
                      key={label.id}
                      label={label.text}
                      tone={label.id === activeLabelId ? 'primary' : 'secondary'}
                      onPress={() => {
                        setSelectedLabelId(label.id);
                        void confirmLabel(label.id);
                      }}
                    />
                  ))}
                </View>
                <ActionButton
                  label="I am not sure what I just did (save unconfirmed)"
                  tone="ghost"
                  onPress={() => { void confirmLabel(null); }}
                />
              </View>
            ) : null}
          </Card>
        </Section>
      ) : null}

      {state.phase === 'saving' ? (
        <Card style={styles.stack}>
          <AppText variant="label">Writing the window…</AppText>
          <AppText variant="caption" color={palette.textMuted}>
            The window and the session's count are written together, so the session can never claim
            more windows than were stored.
          </AppText>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------- what happened */}

      {state.lastSaved !== null ? (
        <Section label="Just saved">
          <Card style={styles.stack}>
            <AppText variant="body">
              Recorded as “{ml.store.labelText(state.lastSaved.labelId)}”.
            </AppText>

            {/*
              The correction is inline rather than behind a dialog, because it has
              an optional free-text reason and a dialog cannot hold a field. The
              two buttons carry the decision, and the wording says what happens to
              the window either way.
            */}
            {rejecting ? (
              <View style={styles.stack}>
                <TextField
                  label="Why was it wrong?"
                  value={rejectReason}
                  onChangeText={setRejectReason}
                  hint="Optional. It is stored on the window, so the reason stays with the decision."
                  multiline
                />
                <View style={styles.buttonRow}>
                  <ActionButton
                    label="Mark it wrong"
                    tone="danger"
                    onPress={() => {
                      void rejectLast();
                    }}
                  />
                  <ActionButton
                    label="Leave it as it is"
                    tone="ghost"
                    onPress={() => {
                      setRejecting(false);
                      setRejectReason('');
                    }}
                  />
                </View>
                <AppText variant="caption" color={palette.textMuted}>
                  The window is kept and flagged, not deleted. A window you rejected is evidence that
                  a sign is hard to tell apart, and deleting it would throw that away.
                </AppText>
              </View>
            ) : (
              <View style={styles.stack}>
                <ActionButton
                  label="That was not the sign I made"
                  tone="secondary"
                  onPress={() => setRejecting(true)}
                />
                <AppText variant="caption" color={palette.textMuted}>
                  Flagging it keeps the window out of training without deleting the evidence that it
                  was recorded.
                </AppText>
              </View>
            )}
          </Card>
        </Section>
      ) : null}

      {/* ---------------------------------------------------------- close it */}

      {session !== null ? (
        <Section label="End the session">
          <Card style={styles.stack}>
            <ActionButton
              label="End this recording session"
              tone="secondary"
              onPress={() => { void capture.closeSession(); }}
            />
            <AppText variant="caption" color={palette.textMuted}>
              Every confirmed window was already written. Closing the session stamps its end; it does
              not save anything that was still in memory, because nothing is held in memory until the
              end.
            </AppText>
          </Card>
        </Section>
      ) : null}

      <Section label="If the app is closed">
        <Card>
          <AppText variant="caption" color={palette.textMuted}>
            Each confirmed window is written as it is confirmed, and the unconfirmed window is written
            before the label prompt appears. A launch that is cut off mid-session is recovered with
            every saved window intact and the session marked interrupted rather than complete.
          </AppText>
        </Card>
      </Section>

      <ConfirmDialog
        visible={confirmDiscard}
        title="Throw this window away?"
        message={
          state.phase === 'awaiting-label'
            ? 'The recorded window will be deleted. It was never labelled, so it was never a training example — nothing a model was fitted on changes.'
            : 'The partial recording will be discarded. It will not be padded to full length, because a padded window is one you never made.'
        }
        confirmLabel="Throw it away"
        destructive
        onConfirm={() => {
          setConfirmDiscard(false);
          void capture.cancel();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </View>
  );
}

const makeStyles = (_palette: Palette) =>
  StyleSheet.create({
    areas: {
      gap: spacing.lg,
    },
    stack: {
      gap: spacing.md,
    },
    grow: {
      flex: 1,
      minWidth: 0,
    },
    headRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: spacing.sm,
    },
    noticeRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    buttonRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
  });
