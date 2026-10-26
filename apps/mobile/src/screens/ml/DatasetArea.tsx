/**
 * The labelled dataset library: the signs, the windows, and the sittings.
 *
 * ## Every window shows its provenance
 *
 * A window's row carries where it came from — a real glove, the Demo Mode
 * producer, an imported recording, a photo — and whether it has been confirmed.
 * Those two facts are what decide whether a model can ever be fitted on it, and
 * a library that hides them makes the dataset look bigger and more solid than it
 * is.
 *
 * ## Nothing is deleted without the reason being visible
 *
 * A rejected window is kept and flagged. Deleting is available but is a separate,
 * deliberate action with a confirmation, because the useful thing about a window
 * you got wrong is that it marks a sign you cannot yet tell apart.
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { ActionButton } from '../../components/ActionButton';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Sheet } from '../../components/Sheet';
import { TextField } from '../../components/TextField';
import { describeDataset, MODALITY_LABEL, SOURCE_LABEL, thinClasses } from '../../ml';
import type { LabelDefinition, SampleHeader } from '../../ml';
import { spacing } from '../../theme';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import type { Palette } from '../../theme/palette';
import { NoteCard, Row, Section } from './shared';
import { useMl, useMlData } from './hooks';

const APPROVAL_TONE: Record<SampleHeader['approval'], BadgeTone> = {
  approved: 'success',
  pending: 'warning',
  rejected: 'danger',
};

const APPROVAL_LABEL: Record<SampleHeader['approval'], string> = {
  approved: 'Confirmed',
  pending: 'Not confirmed',
  rejected: 'Marked wrong',
};

const LANGUAGE_OPTIONS = [
  { value: 'isl', label: 'ISL (Indian Sign Language)' },
  { value: 'asl', label: 'ASL (American Sign Language)' },
  { value: 'bsl', label: 'BSL (British Sign Language)' },
];

export function DatasetArea(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const ml = useMl();
  const data = useMlData();

  const [newSign, setNewSign] = useState('');
  const [newSignNote, setNewSignNote] = useState('');
  const [signError, setSignError] = useState<string | null>(null);
  const [openSample, setOpenSample] = useState<SampleHeader | null>(null);
  const [deleting, setDeleting] = useState<SampleHeader | null>(null);
  const [deletingLabel, setDeletingLabel] = useState<LabelDefinition | null>(null);
  const [busy, setBusy] = useState(false);

  const summary = ml.store.summary();

  const signs = useMemo(
    () => data.labels.filter((label) => label.languageId === data.languageId),
    [data.labels, data.languageId],
  );

  /*
   * Only this language and this modality. A library that mixed them would let a
   * glove window and a photograph sit in one list as if they were the same kind
   * of thing, which is the confusion the separate pipelines exist to prevent.
   */
  const windows = useMemo(
    () =>
      data.headers
        .filter((header) => header.languageId === data.languageId && header.modality === data.modality)
        .sort((a, b) => b.capturedAtMs - a.capturedAtMs),
    [data.headers, data.languageId, data.modality],
  );

  const thin = thinClasses(summary, signs, data.settings.activation.minSamplesPerClass);

  const createSign = async () => {
    setSignError(null);
    const outcome = await ml.store.createLabel(newSign.trim(), newSignNote.trim() || null);
    if (!outcome.ok) {
      setSignError(outcome.error);
      return;
    }
    setNewSign('');
    setNewSignNote('');
  };

  const archive = async (labelId: string) => {
    const outcome = await ml.store.archiveLabel(labelId);
    setSignError(outcome.ok ? null : outcome.error);
  };

  const relabel = async (sampleId: string, labelId: string) => {
    setBusy(true);
    const outcome = await ml.store.relabel(sampleId, labelId);
    setBusy(false);
    setOpenSample(null);
    if (!outcome.ok) setSignError(outcome.error);
  };

  const rejectSample = async (sampleId: string, reason: string) => {
    setBusy(true);
    await ml.store.markRejected(sampleId, reason);
    setBusy(false);
    setOpenSample(null);
  };

  const deleteSample = async (sampleId: string) => {
    setBusy(true);
    const outcome = await ml.store.deleteSamples([sampleId]);
    setBusy(false);
    setDeleting(null);
    if (!outcome.ok) setSignError(outcome.error);
  };

  const deleteSign = async (labelId: string) => {
    setBusy(true);
    const outcome = await ml.store.deleteLabel(labelId);
    setBusy(false);
    setDeletingLabel(null);
    if (!outcome.ok) setSignError(outcome.error);
  };

  const labelOf = (labelId: string) => data.labels.find((label) => label.id === labelId) ?? null;

  return (
    <View style={styles.areas}>
      {signError !== null ? (
        <NoteCard tone="warning" testID="dataset-error">
          {signError}
        </NoteCard>
      ) : null}

      <Section
        label="Sign Language Profile"
        detail="Choose the sign language you are defining words and training for."
      >
        <SegmentedControl
          options={LANGUAGE_OPTIONS}
          value={data.languageId}
          onChange={(lang) => ml.setLanguage(lang)}
          accessibilityLabel="Sign language"
        />
      </Section>

      {/* ------------------------------------------------------------ the signs */}

      <Section
        label="Signs & Vocabulary"
        detail="Define or remove signs. You can delete incorrect words or their dataset samples anytime."
      >
        <Card style={styles.stack}>
          <TextField
            label="New sign"
            value={newSign}
            onChangeText={setNewSign}
            placeholder="e.g. नमस्ते / Hello"
            hint="The name you will recognise. Two signs are the fewest a classifier can tell apart."
          />
          <TextField
            label="Note (optional)"
            value={newSignNote}
            onChangeText={setNewSignNote}
            placeholder="e.g. palm facing down, one movement"
            hint="Stored on the sign so a later recording session knows what was meant."
          />
          <ActionButton
            label="Define this sign"
            tone="secondary"
            onPress={() => { void createSign(); }}
            disabled={newSign.trim().length === 0}
          />
        </Card>

        {signs.length === 0 ? (
          <EmptyState
            compact
            icon="scan"
            title="No signs defined for this language"
            body="A window cannot be filed without a name, and this is where the names are made."
            action={
              <ActionButton
                label="Load Starter Words"
                tone="primary"
                onPress={() => { void ml.store.ensureCanonicalLabels(data.languageId); }}
              />
            }
          />
        ) : (
          <Card style={styles.stack}>
            {signs.map((label, index) => (
              <Row key={label.id} last={index === signs.length - 1}>
                <View style={styles.headRow}>
                  <AppText variant="label" style={styles.grow}>
                    {label.text}
                  </AppText>
                  <Badge
                    label={`${summary.perLabel[label.id] ?? 0} confirmed`}
                    tone={(summary.perLabel[label.id] ?? 0) > 0 ? 'neutral' : 'warning'}
                  />
                </View>
                {label.note !== null ? (
                  <AppText variant="caption" color={palette.textMuted}>
                    {label.note}
                  </AppText>
                ) : null}
                <View style={styles.headRow}>
                  <AppText variant="caption" color={palette.textMuted} style={styles.grow}>
                    {label.archivedAtMs === null
                      ? 'In use. Windows can be filed under it.'
                      : 'Retired. Existing windows keep their label.'}
                  </AppText>
                  <View style={styles.headRow}>
                    {label.archivedAtMs === null ? (
                      <ActionButton
                        label="Retire"
                        tone="ghost"
                        compact
                        onPress={() => { void archive(label.id); }}
                      />
                    ) : null}
                    <ActionButton
                      label="Delete"
                      tone="danger"
                      compact
                      onPress={() => setDeletingLabel(label)}
                    />
                  </View>
                </View>
              </Row>
            ))}
          </Card>
        )}

        {thin.length > 0 ? (
          <NoteCard tone="warning" testID="dataset-thin-classes">
            {`Short of examples: ${thin
              .map((entry) => `${entry.text} (${entry.count})`)
              .join(', ')}. Training needs at least ${data.settings.activation.minSamplesPerClass} confirmed windows of every sign it is asked to tell apart.`}
          </NoteCard>
        ) : null}
      </Section>

      {/* ----------------------------------------------------------- the library */}

      <Section
        label="Windows"
        detail={describeDataset(summary)}
        accessory={<Badge label={MODALITY_LABEL[data.modality]} tone="neutral" />}
      >
        {windows.length === 0 ? (
          <EmptyState
            icon="scan"
            title="Nothing recorded for this language yet"
            body="Record in the Record area, or bring in a photo or video below. Until then there is nothing for a model to be fitted on."
          />
        ) : (
          <Card style={styles.stack}>
            {windows.map((header, index) => {
              const label = labelOf(header.labelId);
              return (
                <Row key={header.id} last={index === windows.length - 1}>
                  <View style={styles.headRow}>
                    <AppText variant="label" style={styles.grow}>
                      {label === null ? 'Unknown sign' : label.text}
                    </AppText>
                    <Badge
                      label={APPROVAL_LABEL[header.approval]}
                      tone={APPROVAL_TONE[header.approval]}
                      dot
                    />
                  </View>
                  <AppText variant="caption" color={palette.textMuted}>
                    {SOURCE_LABEL[header.source]} · {header.handContext === 'both' ? 'two-handed' : `${header.handContext} hand`} ·{' '}
                    {header.quality.frameCount} readings · calibration{' '}
                    {header.calibrationVersion ?? 'none'}
                  </AppText>
                  {header.rejectionReason !== null ? (
                    <AppText variant="caption" color={palette.danger}>
                      Marked wrong: {header.rejectionReason}
                    </AppText>
                  ) : null}
                  <View style={styles.headRow}>
                    <AppText variant="caption" color={palette.textMuted} style={styles.grow}>
                      {header.fingerprint.slice(0, 12)}
                    </AppText>
                    <ActionButton
                      label="Open"
                      tone="ghost"
                      compact
                      onPress={() => setOpenSample(header)}
                    />
                  </View>
                </Row>
              );
            })}
          </Card>
        )}

        {data.damaged.length > 0 ? (
          <NoteCard tone="warning">
            {data.damaged.length === 1
              ? 'One stored window could not be read back. It is not counted above, and it is listed here so it can be removed.'
              : `${data.damaged.length} stored windows could not be read back. They are not counted above, and they are listed here so they can be removed.`}
          </NoteCard>
        ) : null}
      </Section>

      {/* ---------------------------------------------------------- the sittings */}

      <Section
        label="Capture sessions"
        detail="Kept together when a model is measured, because windows from one sitting are near-duplicates and a split that separated them would score the model on its own echoes."
      >
        {data.sessions.length === 0 ? (
          <EmptyState
            compact
            icon="clock"
            title="No sessions"
            body="A session is opened in the Record area and is closed when you finish a sitting."
          />
        ) : (
          <Card style={styles.stack}>
            {[...data.sessions]
              .sort((a, b) => b.startedAtMs - a.startedAtMs)
              .map((session, index, all) => (
                <Row key={session.id} last={index === all.length - 1}>
                  <View style={styles.headRow}>
                    <AppText variant="label" style={styles.grow}>
                      {session.deviceLabel ?? 'Unknown source'}
                    </AppText>
                    <Badge
                      label={
                        session.status === 'closed'
                          ? 'Finished'
                          : session.status === 'open'
                            ? 'Open'
                            : 'Interrupted'
                      }
                      tone={session.status === 'closed' ? 'success' : 'warning'}
                    />
                  </View>
                  <AppText variant="caption" color={palette.textMuted}>
                    {session.sampleCount} window{session.sampleCount === 1 ? '' : 's'} ·{' '}
                    {SOURCE_LABEL[session.source]} · calibration {session.calibrationVersion ?? 'none'}
                    {session.status === 'interrupted'
                      ? ' · the app was closed before this session ended, so the windows it had already written were kept'
                      : ''}
                  </AppText>
                </Row>
              ))}
          </Card>
        )}
      </Section>

      {/* ------------------------------------------------------ one window's sheet */}

      <Sheet
        visible={openSample !== null}
        onClose={() => setOpenSample(null)}
        title={openSample === null ? 'Window' : (labelOf(openSample.labelId)?.text ?? 'Unknown sign')}
        description={
          openSample === null
            ? undefined
            : `${SOURCE_LABEL[openSample.source]} · ${
                openSample.handContext === 'both' ? 'two-handed' : `${openSample.handContext} hand`
              } · window pipeline ${openSample.preprocessingVersion}`
        }
      >
        {openSample === null ? null : (
          <View style={styles.sheet}>
            <AppText variant="caption" color={palette.textMuted}>
              Changing the sign recomputes the window's fingerprint, because the fingerprint describes
              what the window is labelled as. Two windows with the same motion and the same sign are
              treated as duplicates.
            </AppText>

            <AppText variant="label">This window is</AppText>
            {signs
              .filter((label) => label.id !== openSample.labelId)
              .map((label) => (
                <ActionButton
                  key={label.id}
                  label={label.text}
                  tone="secondary"
                  busy={busy}
                  onPress={() => { void relabel(openSample.id, label.id); }}
                />
              ))}
            {openSample.approval !== 'approved' ? (
              <ActionButton
                label="Confirm it under the sign it has"
                tone="secondary"
                busy={busy}
                onPress={() => { void relabel(openSample.id, openSample.labelId); }}
              />
            ) : null}

            <ActionButton
              label="Mark it as the wrong sign"
              tone="ghost"
              busy={busy}
              onPress={() => { void rejectSample(openSample.id, 'Marked wrong from the library'); }}
            />
            <ActionButton
              label="Delete this window"
              tone="danger"
              busy={busy}
              onPress={() => {
                setDeleting(openSample);
                setOpenSample(null);
              }}
            />
          </View>
        )}
      </Sheet>

      <ConfirmDialog
        visible={deleting !== null}
        title="Delete this window?"
        message={
          deleting === null
            ? ''
            : `The window and its ${deleting.quality.frameCount} readings are removed from this phone. A model already trained on it is not changed — it would have to be trained again to forget this example.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleting !== null) void deleteSample(deleting.id);
        }}
        onCancel={() => setDeleting(null)}
      />

      <ConfirmDialog
        visible={deletingLabel !== null}
        title={`Delete “${deletingLabel?.text ?? ''}”?`}
        message={
          deletingLabel === null
            ? ''
            : `This will permanently delete the word “${deletingLabel.text}” and remove all recorded dataset samples for it. This action cannot be undone.`
        }
        confirmLabel="Delete Word & Data"
        destructive
        onConfirm={() => {
          if (deletingLabel !== null) void deleteSign(deletingLabel.id);
        }}
        onCancel={() => setDeletingLabel(null)}
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
      alignItems: 'center',
      gap: spacing.sm,
    },
    sheet: {
      gap: spacing.md,
      paddingBottom: spacing.md,
    },
  });
