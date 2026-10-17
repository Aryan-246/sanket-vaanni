/**
 * Getting the dataset out, back in, and off the phone.
 *
 * ## Why the clipboard, and what that is not
 *
 * This build has no file picker, no share sheet and no document provider, so a
 * "Save to file" button would call a module that is not there. What it does have
 * is a clipboard native module, used elsewhere in the app and verified against
 * the device. So an export becomes text on the clipboard, which the user pastes
 * wherever they keep things, and a restore reads that text back.
 *
 * That is a real backup and a real restore. It is **not** a cloud backup, and
 * this section says so in those words: nothing is uploaded, there is no server
 * copy, and losing the phone loses the dataset unless the text was kept
 * elsewhere. `describe.ts` lists cloud backup as `not-built` for the same reason.
 *
 * ## Why restore verifies before it writes
 *
 * An export carries a checksum over the sample bodies and the pipeline version
 * that wrote it. A file that was truncated in a message, or was written by a
 * build with a different window pipeline, is refused *before* anything is
 * imported — so a failed restore cannot half-apply and leave the library in a
 * state nobody can reason about.
 *
 * ## Why deletion says what it counts
 *
 * `deleteEverything` returns what it removed rather than nothing, so the
 * confirmation can name the numbers and the result can be checked against them.
 * A destructive action that reports "Done" tells the user nothing about whether
 * it did what it said.
 */
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { ActionButton } from '../../components/ActionButton';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ListRow } from '../../components/ListRow';
import { readClipboard } from '../../native/SanketVaanniNative';
import { useCopy } from '../../hooks/useCopy';
import { verifyExport, type DatasetExport } from '../../ml';
import { MODEL_PACKAGE_FORMAT, MODEL_PACKAGE_VERSION } from '../../ml/modelPackage';
import { spacing } from '../../theme';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import type { Palette } from '../../theme/palette';
import { NoteCard, Row, Section } from './shared';
import { useMl, useMlData } from './hooks';

/**
 * The format string an export carries.
 *
 * Written once, here, and read out on screen so a user can compare it against a
 * file. `verifyExport` is the authority on whether a file is acceptable; this is
 * only what it is called.
 */
const EXPORT_FORMAT = 'sanketvaanni.ml.dataset';

export function TransferSection(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const ml = useMl();
  const data = useMlData();
  const copy = useCopy();

  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [carried, setCarried] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);

  const summary = ml.store.summary();

  const runExport = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    const outcome = await ml.store.exportDataset();
    if (!outcome.ok) {
      setBusy(false);
      setError(outcome.error);
      return;
    }

    /*
     * Plain JSON, indented, because a human reads this and may paste it into
     * something that shows it back. The checksum is shown alongside so it can be
     * compared against the one a restore reports.
     */
    const text = JSON.stringify(outcome.data, null, 2);
    const ok = await copy.copy(text);
    setBusy(false);

    setExported(
      `${outcome.data.samples.length} sample${outcome.data.samples.length === 1 ? '' : 's'}, ${outcome.data.labels.length} sign${outcome.data.labels.length === 1 ? '' : 's'}, ${outcome.data.sessions.length} session${outcome.data.sessions.length === 1 ? '' : 's'} · ${Math.round(text.length / 1024)} KB · checksum ${outcome.data.checksum}`,
    );
    setMessage(
      ok
        ? 'The export is on the clipboard, as JSON. Paste it somewhere you keep things — there is no copy on any server, so the clipboard and wherever you paste it are the only copies.'
        : `The export was built but the clipboard refused it${copy.error === null ? '' : `: ${copy.error}`}. Nothing was lost, and nothing was uploaded — there is nowhere to upload it to.`,
    );
  };

  const runRestore = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);

    const text = await readClipboard();
    if (text === null || text.trim().length === 0) {
      setBusy(false);
      setError(
        text === null
          ? 'The clipboard could not be read in this build, so there is nothing to restore from.'
          : 'The clipboard is empty. Copy an export first.',
      );
      return;
    }

    let payload: DatasetExport;
    try {
      payload = JSON.parse(text) as DatasetExport;
    } catch {
      setBusy(false);
      setError('What is on the clipboard is not an export — it could not be read as JSON.');
      return;
    }

    const verdict = verifyExport(payload);
    if (!verdict.ok) {
      setBusy(false);
      setError(`${verdict.reason} Nothing was imported.`);
      return;
    }

    const outcome = await ml.store.importDataset(payload);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setMessage(
      outcome.data.added === 0
        ? `Everything in the file was already here (${outcome.data.skipped} skipped), so nothing changed. Importing twice does not double the library.`
        : `${outcome.data.added} sample${outcome.data.added === 1 ? '' : 's'} added${outcome.data.skipped > 0 ? `, ${outcome.data.skipped} already present and skipped` : ''}. Its checksum matched, so the file was complete.`,
    );
  };

  const runDelete = async () => {
    setConfirmDelete(false);
    setBusy(true);
    const outcome = await ml.store.deleteEverything();
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setMessage(
      `Removed ${outcome.data.samples} sample${outcome.data.samples === 1 ? '' : 's'}, ${outcome.data.models} model${outcome.data.models === 1 ? '' : 's'} and ${outcome.data.labels} sign${outcome.data.labels === 1 ? '' : 's'} from this phone. Files imported from the device are left where they are, because this app did not put them there.`,
    );
    setExported(null);
  };

  /**
   * Writes one version out, with everything needed to judge it.
   *
   * The sentence that follows the copy names the hand configuration clause
   * specifically, because it is the one fact that can be missing *and* the one
   * that silently changes what the weights mean. A package that cannot state the
   * hand is still worth carrying — but the person carrying it has to be told.
   */
  const runCarryOut = async () => {
    if (chosenModel === null) return;
    setError(null);
    setMessage(null);
    setWarnings([]);
    setCarried(null);
    setBusy(true);

    const outcome = await ml.store.exportModel(chosenModel);
    if (!outcome.ok) {
      setBusy(false);
      setError(outcome.error);
      return;
    }

    const text = JSON.stringify(outcome.data, null, 2);
    const copied = await copy.copy(text);
    setBusy(false);

    const contract = outcome.data.contract;
    const hand =
      contract.handConfiguration.basis === 'no-matching-samples-still-present'
        ? 'It could not say which hand it was made for, because the recordings it was fitted on are no longer on this phone.'
        : contract.handConfiguration.ambiguous
          ? `It was fitted across more than one hand configuration (${contract.handConfiguration.contexts.join(', ')}), so it only behaves as measured when you sign the way those recordings did.`
          : `It was fitted for the ${contract.handConfiguration.contexts.join(' and ')} hand, read off the ${contract.handConfiguration.matchingSampleCount} recording${contract.handConfiguration.matchingSampleCount === 1 ? '' : 's'} still here.`;

    setCarried(
      `Version ${contract.version}, ${contract.sampleCount} windows, ${contract.vocabulary.labelIds.length} sign${contract.vocabulary.labelIds.length === 1 ? '' : 's'} · ${Math.round(text.length / 1024)} KB · digest ${outcome.data.integrity}`,
    );
    setMessage(
      `${copied ? 'The package is on the clipboard, as JSON.' : `The package was built but the clipboard refused it${copy.error === null ? '' : `: ${copy.error}`}.`} ${hand} ${contract.gloveProtocol.state === 'unverified' ? 'It was not fitted on frames read from a glove.' : ''} It does not carry the recordings it was fitted on, and taking it in on another phone does not put it in use there.`,
    );
  };

  /**
   * Reads a version in.
   *
   * Blocking faults are already turned into a single sentence by the verifier —
   * it reports all of them at once, so the operator does not fix one, retry and
   * meet the next. Warnings are listed rather than folded into that sentence:
   * they are the things that are true of a package that *was* accepted, and
   * burying them in an error line would lose them.
   */
  const runCarryIn = async () => {
    setError(null);
    setMessage(null);
    setWarnings([]);
    setCarried(null);
    setBusy(true);

    const text = await readClipboard();
    if (text === null || text.trim().length === 0) {
      setBusy(false);
      setError(
        text === null
          ? 'The clipboard could not be read in this build, so there is nothing to take in.'
          : 'The clipboard is empty. Copy a version package first.',
      );
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      setBusy(false);
      setError('What is on the clipboard is not a version package — it could not be read as JSON.');
      return;
    }

    const outcome = await ml.store.importModel(payload);
    setBusy(false);
    if (!outcome.ok) {
      setError(`${outcome.error} Nothing was stored.`);
      return;
    }

    const stored = outcome.data.summary;
    setWarnings(outcome.data.findings.map((finding) => finding.message));
    setMessage(
      `Version ${stored.version} is stored, from version ${stored.importedFrom?.sourceVersion ?? '?'} on the phone that fitted it. It is not in use: nothing here switches to a version for you, so it stays a candidate until you choose it.`,
    );
  };

  return (
    <View style={styles.areas}>
      <Section
        label="Export and restore"
        detail="Everything you own, as one JSON document you keep yourself. There is no server copy."
      >
        <Card style={styles.stack}>
          <Row>
            <AppText variant="caption" color={palette.textMuted}>
              An export contains every sample — including unconfirmed ones and ones you marked wrong —
              with the signs and sessions they belong to. A rejected window is part of the record of
              what you decided, so dropping it would make an export disagree with the app.
            </AppText>
          </Row>
          <Row last>
            <AppText variant="caption" color={palette.textMuted}>
              Media files are referenced, not embedded: the export says where a photo or video lives on
              this phone. A photo will not travel with the JSON.
            </AppText>
          </Row>

          <ActionButton
            label={copy.label === 'Copy' ? 'Export to the clipboard' : copy.label}
            tone="secondary"
            busy={busy}
            onPress={() => { void runExport(); }}
          />
          <ActionButton
            label="Restore from the clipboard"
            tone="secondary"
            busy={busy}
            onPress={() => { void runRestore(); }}
          />

          {exported !== null ? (
            <AppText variant="caption" color={palette.textSecondary} testID="transfer-export">
              {exported}
            </AppText>
          ) : null}
          {message !== null ? (
            <AppText variant="caption" color={palette.textSecondary} testID="transfer-message">
              {message}
            </AppText>
          ) : null}
          {error !== null ? (
            <NoteCard tone="warning" testID="transfer-error">
              {error}
            </NoteCard>
          ) : null}
        </Card>

        <NoteCard testID="transfer-no-cloud">
          No part of this is a cloud backup. Nothing is uploaded, there is no dataset table on the
          server and there is no copy that survives this phone. If the export is only on the
          clipboard, it is one paste away from being gone.
        </NoteCard>
      </Section>

      <Section
        label="Versions on other phones"
        detail="Carry a fitted version to another phone as a file, and take one in from another phone."
      >
        <Card style={styles.stack}>
          <AppText variant="caption" color={palette.textMuted}>
            A version is a matrix of numbers fitted against this build’s window pipeline and this
            phone’s signs. Sending those numbers somewhere they do not fit produces a version that
            runs, answers confidently and is wrong — so a package carries the facts a receiving phone
            needs to check before it stores anything, and it refuses with a reason when they do not
            match.
          </AppText>
          <AppText variant="caption" color={palette.textMuted}>
            Only the fitted numbers travel. The recordings they were fitted on stay on the phone that
            made them, so the receiving phone cannot retrain or verify them.
          </AppText>

          {data.models.length === 0 ? (
            <NoteCard testID="carry-none">
              There is no version to carry out yet. A version exists once training has produced one.
            </NoteCard>
          ) : (
            data.models.map((model, index) => (
              <ListRow
                key={model.id}
                label={`Version ${model.version}`}
                description={
                  model.importedFrom?.exportedAtMs !== undefined
                    ? `Taken in from another phone, where it was version ${model.importedFrom.sourceVersion}`
                    : `${model.sampleCount} windows · ${model.labelIds.length} sign${model.labelIds.length === 1 ? '' : 's'}${model.evaluation?.accuracy == null ? ' · not measured on held-out data' : ''}`
                }
                value={model.status === 'active' ? 'In use' : model.status === 'candidate' ? 'Not in use' : 'Superseded'}
                accessory={chosenModel === model.id ? <Badge label="Selected" tone="accent" dot /> : undefined}
                onPress={() => setChosenModel(model.id)}
                last={index === data.models.length - 1}
                testID={`carry-pick-${model.version}`}
              />
            ))
          )}

          <ActionButton
            label="Copy this version to the clipboard"
            tone="secondary"
            busy={busy}
            disabled={chosenModel === null}
            testID="carry-out"
            onPress={() => { void runCarryOut(); }}
          />
          <ActionButton
            label="Take a version in from the clipboard"
            tone="secondary"
            busy={busy}
            testID="carry-in"
            onPress={() => { void runCarryIn(); }}
          />

          {carried !== null ? (
            <AppText variant="caption" color={palette.textSecondary} testID="carry-export">
              {carried}
            </AppText>
          ) : null}
          {message !== null ? (
            <AppText variant="caption" color={palette.textSecondary} testID="carry-message">
              {message}
            </AppText>
          ) : null}
          {warnings.map((warning) => (
            <NoteCard key={warning} tone="warning" testID="carry-warning">
              {warning}
            </NoteCard>
          ))}
          {error !== null ? (
            <NoteCard tone="warning" testID="carry-error">
              {error}
            </NoteCard>
          ) : null}
        </Card>

        <NoteCard testID="carry-no-catalogue">
          There is no shared catalogue and no server holding versions. Nothing here uploads, downloads
          or checks for a newer version — the clipboard, and wherever you paste it, are the whole
          transfer. Two phones can only be running the same version because someone carried it.
        </NoteCard>
      </Section>

      <Section
        label="What an export would contain"
        detail="Counted from what is stored, not from a figure written here."
      >
        <Card style={styles.stack}>
          <AppText variant="caption" color={palette.textSecondary}>
            {summary.total} sample{summary.total === 1 ? '' : 's'} · {summary.labels} sign
            {summary.labels === 1 ? '' : 's'} · {summary.sessions} session
            {summary.sessions === 1 ? '' : 's'} · checksum over the sample bodies
          </AppText>
          <AppText variant="caption" color={palette.textMuted}>
            {data.labels.length === 0
              ? 'There is nothing to export yet. An export of an empty library is valid and restores to nothing.'
              : `Changing any window changes the checksum, which is what makes a truncated restore detectable.`}
          </AppText>
        </Card>
      </Section>

      <Section
        label="Delete everything"
        detail="Removes the signs, the windows and the models from this phone. It cannot be undone."
      >
        <Card style={styles.stack}>
          <AppText variant="caption" color={palette.textMuted}>
            A model already trained on this data is removed too, so nothing keeps recognising from
            examples that are no longer here. The file copies of any photos or videos are left alone.
          </AppText>
          <ActionButton
            label="Delete all learning data"
            tone="danger"
            busy={busy}
            disabled={summary.total === 0 && data.labels.length === 0 && data.models.length === 0}
            onPress={() => setConfirmDelete(true)}
          />
          {data.models.length > 0 ? (
            <AppText variant="caption" color={palette.textMuted}>
              This would also remove {data.models.length} trained version
              {data.models.length === 1 ? '' : 's'}
              {data.models.some((model) => model.status === 'active')
                ? ', including the one currently in use. Recognition would stop.'
                : '.'}
            </AppText>
          ) : null}
        </Card>
      </Section>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete all learning data?"
        message={`${summary.total} sample${summary.total === 1 ? '' : 's'}, ${data.labels.length} sign${data.labels.length === 1 ? '' : 's'} and ${data.models.length} model${data.models.length === 1 ? '' : 's'} will be removed from this phone. There is no server copy to restore from, and this cannot be undone.`}
        confirmLabel="Delete everything"
        destructive
        onConfirm={() => { void runDelete(); }}
        onCancel={() => setConfirmDelete(false)}
      />

      {/*
        The format names are the contracts' own strings, so a file a user saved
        can be matched against what a restore expects without either side
        paraphrasing it.
      */}
      <AppText variant="caption" color={palette.textMuted} testID="transfer-format">
        Export format {EXPORT_FORMAT}, with an FNV-1a digest over the canonical form of every sample
        body. Version packages use {MODEL_PACKAGE_FORMAT} version {MODEL_PACKAGE_VERSION}, digested the
        same way over their contract and their weights. Either digest catches a truncated or edited
        file before anything is stored.
      </AppText>
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
  });
