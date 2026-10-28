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

import { useAccountSafe } from '../../account/AccountProvider';
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
  const account = useAccountSafe();
  const isAdmin = account?.isAdmin ?? false;

  const [newSign, setNewSign] = useState('');
  const [newSignNote, setNewSignNote] = useState('');
  const [newSignSpoken, setNewSignSpoken] = useState('');
  const [signError, setSignError] = useState<string | null>(null);
  const [cloudNotice, setCloudNotice] = useState<string | null>(null);
  const [syncingCloud, setSyncingCloud] = useState(false);
  const [uploadingSamples, setUploadingSamples] = useState(false);
  const [openSample, setOpenSample] = useState<SampleHeader | null>(null);
  const [deleting, setDeleting] = useState<SampleHeader | null>(null);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<LabelDefinition | null>(null);
  const [permanentDeleteReason, setPermanentDeleteReason] = useState('');
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

  const syncWithCloud = async () => {
    setSyncingCloud(true);
    setCloudNotice(null);
    setSignError(null);
    const vocabRes = await ml.syncSharedVocabulary({ isAdmin });
    let msg = '';
    if (vocabRes.ok) {
      msg = `Synchronized ${vocabRes.data.length} vocabulary signs.`;
    }
    if (isAdmin) {
      const dataRes = await ml.syncSharedTrainingData();
      if (dataRes.ok) {
        msg += ` Downloaded ${dataRes.data.downloaded} shared recordings (total: ${dataRes.data.total}).`;
      }
    }
    setSyncingCloud(false);
    setCloudNotice(msg || 'Vocabulary synchronized from server.');
  };

  const uploadRecordingsToCloud = async () => {
    setUploadingSamples(true);
    setCloudNotice(null);
    setSignError(null);
    const res = await ml.uploadConsentedSamples({
      deviceAlias: "Admin's Phone",
      reason: 'Uploaded consented training samples from ML Studio',
    });
    setUploadingSamples(false);
    if (res.ok) {
      setCloudNotice(`Successfully uploaded ${res.data.uploaded} recordings to cloud dataset!`);
    } else {
      setSignError(res.error);
    }
  };

  const createSign = async () => {
    setSignError(null);
    setCloudNotice(null);
    const outcome = await ml.createSharedWord({
      text: newSign.trim(),
      note: newSignNote.trim() || null,
      spokenPhrase: newSignSpoken.trim() || null,
      deviceAlias: "Admin's Phone",
      isAdmin,
    });
    if (!outcome.ok) {
      setSignError(outcome.error);
      return;
    }
    setNewSign('');
    setNewSignNote('');
    setNewSignSpoken('');
    setCloudNotice(`"${outcome.data.text}" created and synchronized!`);
  };

  const archive = async (label: LabelDefinition) => {
    setSignError(null);
    setCloudNotice(null);
    const outcome = await ml.archiveWord(label.id, {
      isAdmin,
      reason: `Archived word "${label.text}" from active vocabulary`,
    });
    if (!outcome.ok) {
      setSignError(outcome.error);
    } else {
      setCloudNotice(`Archived "${label.text}". Older models and samples remain preserved.`);
    }
  };

  const executePermanentDelete = async () => {
    if (!permanentDeleteTarget) return;
    setBusy(true);
    setSignError(null);
    setCloudNotice(null);
    const outcome = await ml.deleteWordPermanently(permanentDeleteTarget.id, {
      isAdmin,
      reason: permanentDeleteReason.trim() || `Permanently deleted word "${permanentDeleteTarget.text}"`,
    });
    setBusy(false);
    const deletedWordText = permanentDeleteTarget.text;
    setPermanentDeleteTarget(null);
    setPermanentDeleteReason('');
    if (!outcome.ok) {
      setSignError(outcome.error);
    } else {
      setCloudNotice(`Permanently deleted "${deletedWordText}".`);
    }
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

  const labelOf = (labelId: string) => data.labels.find((label) => label.id === labelId) ?? null;

  return (
    <View style={styles.areas}>
      {signError !== null ? (
        <NoteCard tone="warning" testID="dataset-error">
          {signError}
        </NoteCard>
      ) : null}

      {cloudNotice !== null ? (
        <NoteCard tone="success" testID="dataset-cloud-notice">
          {cloudNotice}
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
        detail="Define or manage signs. Shared words synchronize across all authorized admin devices automatically."
        accessory={
          <ActionButton
            label={syncingCloud ? 'Syncing...' : 'Sync Cloud'}
            tone="secondary"
            compact
            busy={syncingCloud}
            onPress={() => { void syncWithCloud(); }}
          />
        }
      >
        <Card style={styles.stack}>
          <View style={styles.headRow}>
            <ActionButton
              label={syncingCloud ? 'Syncing...' : 'Sync Cloud Words & Data'}
              tone="primary"
              busy={syncingCloud}
              onPress={() => { void syncWithCloud(); }}
            />
            {isAdmin && windows.filter((w) => w.approval === 'approved').length > 0 ? (
              <ActionButton
                label={uploadingSamples ? 'Uploading...' : 'Upload Consented Recordings'}
                tone="secondary"
                busy={uploadingSamples}
                onPress={() => { void uploadRecordingsToCloud(); }}
              />
            ) : null}
          </View>

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
            placeholder="e.g. palm facing down, wave motion"
            hint="Stored on the sign so a later recording session knows what gesture was meant."
          />
          <TextField
            label="Spoken translation (optional)"
            value={newSignSpoken}
            onChangeText={setNewSignSpoken}
            placeholder="e.g. Hello"
            hint="Spoken phrase pronounced when this sign is recognised."
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
            body="A window cannot be filed without a name. You can load starter words or sync from the cloud registry."
            action={
              <ActionButton
                label="Sync / Load Words"
                tone="primary"
                onPress={() => { void syncWithCloud(); }}
              />
            }
          />
        ) : (
          <Card style={styles.stack}>
            {signs.map((label, index) => {
              const statusTone: BadgeTone =
                label.status === 'published'
                  ? 'success'
                  : label.status === 'trained'
                    ? 'neutral'
                    : label.status === 'archived'
                      ? 'danger'
                      : 'warning';

              return (
                <Row key={label.id} last={index === signs.length - 1}>
                  <View style={styles.headRow}>
                    <AppText variant="label" style={styles.grow}>
                      {label.text}
                    </AppText>
                    {label.status ? (
                      <Badge label={label.status.toUpperCase()} tone={statusTone} />
                    ) : null}
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
                  {label.createdDeviceAlias ? (
                    <AppText variant="caption" color={palette.textMuted}>
                      📱 Created on: {label.createdDeviceAlias}
                    </AppText>
                  ) : null}
                  {label.modelVersions && label.modelVersions.length > 0 ? (
                    <AppText variant="caption" color={palette.success}>
                      Included in published model: v{label.modelVersions.join(', v')}
                    </AppText>
                  ) : null}
                  <View style={styles.headRow}>
                    <AppText variant="caption" color={palette.textMuted} style={styles.grow}>
                      {label.archivedAtMs === null
                        ? 'In use. Windows can be filed under it.'
                        : 'Retired / Archived. Historical windows keep their label.'}
                    </AppText>
                    <View style={styles.headRow}>
                      {label.archivedAtMs === null ? (
                        <ActionButton
                          label="Archive"
                          tone="ghost"
                          compact
                          onPress={() => { void archive(label); }}
                        />
                      ) : null}
                      <ActionButton
                        label="Delete..."
                        tone="danger"
                        compact
                        onPress={() => setPermanentDeleteTarget(label)}
                      />
                    </View>
                  </View>
                </Row>
              );
            })}
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
        visible={permanentDeleteTarget !== null}
        title={`Permanently delete “${permanentDeleteTarget?.text ?? ''}”?`}
        message={
          permanentDeleteTarget === null
            ? ''
            : permanentDeleteTarget.modelVersions && permanentDeleteTarget.modelVersions.length > 0
              ? `This word is included in published model version(s) [${permanentDeleteTarget.modelVersions.join(', ')}]. It CANNOT be permanently deleted because doing so would corrupt past model evaluation history. Please use "Archive" instead.`
              : `This will permanently delete the word “${permanentDeleteTarget.text}” from the shared cloud vocabulary and local storage. This action is irreversible and recorded in the audit log.`
        }
        confirmLabel={
          permanentDeleteTarget?.modelVersions && permanentDeleteTarget.modelVersions.length > 0
            ? 'Close'
            : 'Permanently Delete'
        }
        destructive={!(permanentDeleteTarget?.modelVersions && permanentDeleteTarget.modelVersions.length > 0)}
        onConfirm={() => {
          if (permanentDeleteTarget?.modelVersions && permanentDeleteTarget.modelVersions.length > 0) {
            setPermanentDeleteTarget(null);
          } else {
            void executePermanentDelete();
          }
        }}
        onCancel={() => setPermanentDeleteTarget(null)}
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
