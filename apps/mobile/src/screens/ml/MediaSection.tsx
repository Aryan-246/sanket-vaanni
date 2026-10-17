/**
 * Photos and video: their own library, on their own pipeline.
 *
 * ## What this section can honestly do in this build
 *
 * Nothing can read a file from the device, because no picker is installed. This
 * is not a defect being worked around — adding one changes the Android build and
 * needs its own release and its own device test, which is an owner decision.
 *
 * So the buttons exist, are reachable, and explain themselves. A build that hid
 * the feature would leave someone wondering whether the app has it; a build that
 * pretended to import would be worse. `media.ts` refuses in a sentence, and this
 * renders the sentence.
 *
 * ## Why the library is not empty of meaning even so
 *
 * The pipeline behind this section is real: files are validated by MIME, size and
 * duration, each item's fate is recorded separately so a partial import keeps
 * what it accepted, and a repeat pick of the same file is skipped rather than
 * doubled. What is missing is the platform call, and that is stated rather than
 * simulated.
 *
 * ## Why the full samples are loaded, not the headers
 *
 * The library index holds headers, and a header deliberately carries no media
 * reference — the file lives in the sample body. Two things here need the body:
 * the deletion note names the file it is about, and the duplicate check compares
 * against the *URIs* already held. Passing header ids where URIs belong would have
 * made the duplicate check compare against nothing, so every re-import would
 * double the library. Reading the bodies is the only way either is true.
 *
 * ## Modality isolation, in the UI
 *
 * `VISION_NOTE` is shown beside the library. Storing a video does not train the
 * glove model, and a section that let a user believe otherwise would be the
 * single most misleading thing on this screen.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { ActionButton } from '../../components/ActionButton';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { Toggle } from '../../components/Toggle';
import {
  createIdFactory,
  importMedia,
  labelAcceptsMedia,
  mediaDeletionNote,
  VISION_NOTE,
} from '../../ml';
import type { VisionSample } from '../../ml';
import { spacing } from '../../theme';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import type { Palette } from '../../theme/palette';
import { NoteCard, Row, Section } from './shared';
import { useMl, useMlData } from './hooks';

export function MediaSection(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const ml = useMl();
  const data = useMlData();

  /*
   * Consent to import is separate from consent to train, and is asked here
   * rather than inherited. Reading a file off the device and allowing a model to
   * learn from it are two different permissions.
   */
  const [consented, setConsented] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<VisionSample | null>(null);
  const [held, setHeld] = useState<readonly VisionSample[]>([]);

  const newId = useMemo(() => createIdFactory('media'), []);
  const pickerAvailable = ml.picker.isAvailable();

  /*
   * Re-read whenever the index changes — `data.headers` is a stable reference
   * that moves only on a write, so this does not re-run on a capture tick.
   */
  const reload = useCallback(async () => {
    const { samples } = await ml.store.loadAllSamples();
    setHeld(samples.filter((sample): sample is VisionSample => sample.modality === 'vision'));
  }, [ml]);

  useEffect(() => {
    if (!data.ready) return;
    void reload();
  }, [data.ready, data.headers, reload]);

  const signs = data.labels.filter(
    (label) => label.languageId === data.languageId && label.archivedAtMs === null,
  );

  /* The sign the import is filed under, defaulting to the first one there is. */
  const chosen = target ?? signs[0]?.id ?? null;

  const runImport = async (kind: 'photo' | 'video') => {
    setError(null);
    setReport(null);

    const label = data.labels.find((item) => item.id === chosen) ?? null;
    const allowed = labelAcceptsMedia(label, data.languageId);
    if (!allowed.ok) {
      setError(allowed.reason);
      return;
    }

    setBusy(true);
    const outcome = await importMedia({
      picker: ml.picker,
      kind,
      languageId: data.languageId,
      // Every accepted file is filed under the sign chosen above. The label is
      // the user's, chosen before the picker opens, and never read off a file.
      labelId: chosen!,
      // The URIs already held, so picking the same file twice does not store it
      // twice. Header ids would compare against nothing — see the file comment.
      existingUris: held.map((sample) => sample.media.uri),
      consented,
      ownerId: ml.accountInfo.ownerId,
      nowMs: Date.now(),
      newId,
    });

    for (const sample of outcome.imported) {
      await ml.store.saveVisionSample(sample);
    }
    setBusy(false);
    setReport(outcome.note);
    if (outcome.failed.length > 0) {
      setError(outcome.failed.map((failure) => failure.reason).join(' '));
    }
  };

  const remove = async (sampleId: string) => {
    setBusy(true);
    await ml.store.deleteSamples([sampleId]);
    setBusy(false);
    setDeleting(null);
  };

  return (
    <View style={styles.areas}>
      <Section
        label="Photos and video"
        detail="Kept as labelled records beside the glove windows, and never mixed into them."
      >
        <Card style={styles.stack}>
          <View style={styles.statusRow}>
            <Badge
              label={pickerAvailable ? 'Picker available' : 'No picker in this build'}
              tone={pickerAvailable ? 'success' : 'warning'}
              dot
            />
          </View>
          <AppText variant="caption" color={palette.textMuted}>
            {ml.picker.unavailableReason()}
          </AppText>

          <Toggle
            value={consented}
            onValueChange={setConsented}
            accessibilityLabel="Allow importing photos and video"
            accessibilityHint="Asks for your agreement before any file is read from the device."
          />
          <AppText variant="caption" color={palette.textSecondary}>
            {consented
              ? 'You have agreed to importing. Files are kept on this phone; nothing is uploaded.'
              : 'Turn this on to allow importing. It is a separate permission from allowing recordings to be trained on.'}
          </AppText>

          {signs.length === 0 ? (
            <EmptyState
              compact
              icon="warning"
              title="Define a sign first"
              body="An imported file is a labelled record, so it needs a sign to be filed under. There is none for this language yet."
            />
          ) : (
            <View style={styles.stack}>
              <AppText variant="caption" color={palette.textSecondary}>
                File under:
              </AppText>
              {signs.map((label) => (
                <ActionButton
                  key={label.id}
                  label={label.text}
                  tone={chosen === label.id ? 'primary' : 'secondary'}
                  compact
                  onPress={() => setTarget(label.id)}
                />
              ))}
            </View>
          )}

          <View style={styles.buttonRow}>
            <ActionButton
              label="Choose a photo"
              tone="secondary"
              busy={busy}
              disabled={signs.length === 0 || !consented}
              onPress={() => { void runImport('photo'); }}
            />
            <ActionButton
              label="Choose a video"
              tone="secondary"
              busy={busy}
              disabled={signs.length === 0 || !consented}
              onPress={() => { void runImport('video'); }}
            />
          </View>

          {!consented ? (
            <AppText variant="caption" color={palette.textMuted}>
              The buttons are disabled until you agree above. A picker that opened first and asked
              afterwards would have read the device before consent.
            </AppText>
          ) : null}

          {report !== null ? (
            <AppText variant="caption" color={palette.textSecondary} testID="media-report">
              {report}
            </AppText>
          ) : null}
          {error !== null ? (
            <NoteCard tone="warning" testID="media-error">
              {error}
            </NoteCard>
          ) : null}
        </Card>

        <NoteCard testID="media-vision-note">{VISION_NOTE}</NoteCard>
      </Section>

      <Section
        label="In the library"
        detail={
          held.length === 0
            ? 'No photos or video are held.'
            : `${held.length} file record${held.length === 1 ? '' : 's'} held. The files themselves are in the phone's storage, where this app did not put them.`
        }
      >
        {held.length === 0 ? (
          <EmptyState
            compact
            icon="eye"
            title="No photos or video"
            body="Nothing has been imported. Files would be listed here with the sign they were filed under."
          />
        ) : (
          <Card style={styles.stack}>
            {held.map((sample, index) => (
              <Row key={sample.id} last={index === held.length - 1}>
                <View style={styles.headRow}>
                  <AppText variant="label" style={styles.grow}>
                    {data.labels.find((label) => label.id === sample.labelId)?.text ?? 'Unknown sign'}
                  </AppText>
                  <Badge
                    label={sample.approval === 'approved' ? 'Confirmed' : 'Not confirmed'}
                    tone={sample.approval === 'approved' ? 'success' : 'warning'}
                  />
                </View>
                <AppText variant="caption" color={palette.textMuted}>
                  {sample.media.kind === 'photo' ? 'Photo' : 'Video'} ·{' '}
                  {Math.round(sample.media.byteSize / 1024)} KB · {sample.media.width}×
                  {sample.media.height}
                  {sample.media.durationMs === null
                    ? ''
                    : ` · ${(sample.media.durationMs / 1000).toFixed(1)} s`}{' '}
                  · used for training: {sample.usedForTraining ? 'yes' : 'no'}
                </AppText>
                <ActionButton
                  label="Remove from the library"
                  tone="ghost"
                  compact
                  onPress={() => setDeleting(sample)}
                />
              </Row>
            ))}
          </Card>
        )}
      </Section>

      <ConfirmDialog
        visible={deleting !== null}
        title="Remove this file from the library?"
        message={deleting === null ? '' : mediaDeletionNote(deleting.media)}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (deleting !== null) void remove(deleting.id);
        }}
        onCancel={() => setDeleting(null)}
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
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    buttonRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
  });
