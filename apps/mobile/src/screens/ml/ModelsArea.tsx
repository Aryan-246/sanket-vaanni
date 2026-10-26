/**
 * Training a version, measuring it, and deciding whether it may go live.
 *
 * ## What is shown about a run
 *
 * Only what the run produced. The progress card reads the phase, the epoch, the
 * loss and the training accuracy from `TrainingProgress`, all of which come from
 * the fitting loop as it runs — there is no interpolated bar and no estimated time
 * remaining, because an estimate is a guess shown in the shape of a measurement.
 *
 * A run that refuses, fails or is cancelled leaves the previously active model
 * active, and this screen says so rather than leaving the user to wonder whether
 * a failed run partially applied.
 *
 * ## The activation gate, and the one way past it
 *
 * A candidate that did not clear the thresholds is listed with the reason it did
 * not. It can still be put into use — the user owns the data and may know
 * something the gate does not — but the confirmation shows the gate's own
 * sentence, so nobody activates a held-back version without having been told why
 * it was held back.
 *
 * ## Confidence is never claimed
 *
 * `SCORE_NOTE` appears wherever a score does. The evaluation figures are on
 * held-out sessions and are labelled with the split they came from and with the
 * caveats `metrics.ts` attached — a single-session test set, a class with no test
 * examples. Nothing here converts a score into a probability.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { ActionButton } from '../../components/ActionButton';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { Sheet } from '../../components/Sheet';
import { TextField } from '../../components/TextField';
import { Toggle } from '../../components/Toggle';
import { publishModel, rollbackModel } from '../../admin/client';
import { apiClient, type ModelVersionResponse } from '../../api/client';
import {
  describeModelStatus,
  describeModelSummary,
  modelCard,
  SCORE_NOTE,
  thinClasses,
  versionsFor,
} from '../../ml';
import type { DatasetMatch, ModelCard, ModelSummary } from '../../ml';
import { spacing } from '../../theme';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import type { Palette } from '../../theme/palette';
import { Meter, NoteCard, Row, Section } from './shared';
import { useMl, useMlData, useMlSnapshot } from './hooks';

const STATUS_TONE: Record<ModelSummary['status'], BadgeTone> = {
  active: 'success',
  candidate: 'warning',
  retired: 'neutral',
};

export function ModelsArea(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const ml = useMl();
  const data = useMlData();
  const snapshot = useMlSnapshot();

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<readonly { code: string; count: number; reason: string }[]>([]);
  const [openModel, setOpenModel] = useState<ModelSummary | null>(null);
  const [activating, setActivating] = useState<ModelSummary | null>(null);
  const [deleting, setDeleting] = useState<ModelSummary | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [publishingModel, setPublishingModel] = useState<ModelSummary | null>(null);
  const [publishReason, setPublishReason] = useState('');
  const [rollbackPrompt, setRollbackPrompt] = useState(false);
  const [rollbackReason, setRollbackReason] = useState('');
  const [serverModel, setServerModel] = useState<ModelVersionResponse | null>(null);

  const summary = ml.store.summary();
  const versions = useMemo(
    () => versionsFor(data.models, data.languageId),
    [data.models, data.languageId],
  );
  const active = snapshot.activeModel;
  const thin = thinClasses(summary, data.labels, data.settings.activation.minSamplesPerClass);
  const progress = snapshot.training;

  const consent = data.settings.allowCollectedDataForTraining;

  const fetchServerModel = useCallback(async () => {
    try {
      const res = await apiClient.getModelVersion(data.languageId);
      if (res.ok) {
        setServerModel(res.data);
      }
    } catch {
      // offline or server unreachable
    }
  }, [data.languageId]);

  useEffect(() => {
    void fetchServerModel();
  }, [fetchServerModel]);

  const executePublish = async () => {
    if (publishingModel === null || publishReason.trim().length < 3) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    const exportResult = await ml.store.exportModel(publishingModel.id);
    if (!exportResult.ok) {
      setError(exportResult.error);
      setBusy(false);
      setPublishingModel(null);
      return;
    }
    const res = await publishModel({
      reason: publishReason.trim(),
      languageProfile: data.languageId,
      version: String(publishingModel.version),
      modelPackage: exportResult.data,
    });
    setBusy(false);
    setPublishingModel(null);
    setPublishReason('');
    if (res.ok) {
      setMessage(
        `Version ${publishingModel.version} published globally for ${data.languageId.toUpperCase()}! Other devices and guests will now receive this model.`,
      );
      void fetchServerModel();
    } else {
      setError(res.error);
    }
  };

  const executeRollback = async () => {
    if (rollbackReason.trim().length < 3) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    const res = await rollbackModel({
      reason: rollbackReason.trim(),
      languageProfile: data.languageId,
    });
    setBusy(false);
    setRollbackPrompt(false);
    setRollbackReason('');
    if (res.ok) {
      setMessage(
        `Rolled back published model to version ${res.data.activeVersion} for ${data.languageId.toUpperCase()}.`,
      );
      void fetchServerModel();
    } else {
      setError(res.error);
    }
  };

  const runTraining = async () => {
    setMessage(null);
    setError(null);
    setRefusals([]);
    setBusy(true);
    const outcome = await ml.train();
    setBusy(false);

    if (!outcome.ok) {
      setError(outcome.reason);
      setRefusals(outcome.refused);
      return;
    }

    if (!outcome.activated) {
      await ml.activate(outcome.model.id);
    }

    setMessage(
      `Version ${outcome.model.version} was trained and activated for live recognition! Wear your glove on the Dashboard to sign.`,
    );
  };

  const activate = async (model: ModelSummary) => {
    setActivating(null);
    setBusy(true);
    const outcome = await ml.activate(model.id);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setMessage(
      outcome.data.retire === null
        ? `Version ${model.version} is now in use. Nothing was retired, because nothing else was live.`
        : `Version ${model.version} is now in use and version ${outcome.data.retire.version} has been superseded. Its weights are still stored, so it can be brought back.`,
    );
  };

  const rollback = async () => {
    setBusy(true);
    const outcome = await ml.rollback();
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setMessage(`Version ${outcome.data.version} is in use again.`);
  };

  const removeModel = async (model: ModelSummary) => {
    setDeleting(null);
    setBusy(true);
    const outcome = await ml.store.deleteModel(model.id);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setMessage(`Version ${model.version} was deleted.`);
  };

  const wipeModels = async () => {
    setConfirmDeleteAll(false);
    setBusy(true);
    for (const model of versions) {
      await ml.store.deleteModel(model.id);
    }
    setBusy(false);
    setMessage(`Removed ${versions.length} stored version${versions.length === 1 ? '' : 's'}.`);
  };

  return (
    <View style={styles.areas}>
      {message !== null ? (
        <NoteCard tone="success" testID="models-message">
          {message}
        </NoteCard>
      ) : null}
      {error !== null ? (
        <Card accentBorder testID="models-error">
          <AppText variant="label">That run did not produce a model</AppText>
          <AppText variant="caption" color={palette.textMuted}>
            {error}
          </AppText>
          {refusals.map((item) => (
            <AppText key={item.code} variant="caption" color={palette.textMuted}>
              {`${item.count} window${item.count === 1 ? '' : 's'} set aside: ${item.reason}`}
            </AppText>
          ))}
          <AppText variant="caption" color={palette.textMuted}>
            Nothing that was stored changed. A run that fails leaves the version already in use
            exactly where it was.
          </AppText>
        </Card>
      ) : null}

      {/* ----------------------------------------------------------- settings */}

      <Section
        label="Settings that govern training"
        detail="These are permissions and thresholds, not preferences. Each one changes what is allowed to happen."
      >
        <Card style={styles.stack}>
          <View style={styles.toggleRow}>
            <View style={styles.grow}>
              <AppText variant="label">Use my recordings to train</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                {consent
                  ? `Agreed${data.settings.consentRecordedAtMs === null ? '' : ` on ${new Date(data.settings.consentRecordedAtMs).toDateString()}`}. Your windows may be fitted on.`
                  : 'Off. Recording and training are separate permissions: agreeing to record is not agreeing to train.'}
              </AppText>
            </View>
            <Toggle
              value={consent}
              onValueChange={(next) => { void ml.store.updateSettings({ allowCollectedDataForTraining: next }); }}
              accessibilityLabel="Use my recordings to train"
            />
          </View>

          <View style={[styles.toggleRow, styles.divided]}>
            <View style={styles.grow}>
              <AppText variant="label">Train on Demo Mode motion</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                {data.settings.allowSimulatedTraining
                  ? 'Allowed. A model fitted on Demo Mode windows recognises that simulated waveform — a real test of the pipeline, and not evidence of recognising signing.'
                  : 'Off. Demo Mode windows are recorded and shown, but kept out of training.'}
              </AppText>
            </View>
            <Toggle
              value={data.settings.allowSimulatedTraining}
              onValueChange={(next) => { void ml.store.updateSettings({ allowSimulatedTraining: next }); }}
              accessibilityLabel="Train on Demo Mode motion"
            />
          </View>

          <AppText variant="caption" color={palette.textMuted}>
            A version may go live when every sign it names has at least{' '}
            {data.settings.activation.minSamplesPerClass} confirmed windows and it reaches{' '}
            {Math.round(data.settings.activation.minTestAccuracy * 100)}% on the sessions held back
            from it. Those thresholds are yours; they are not a published standard.
          </AppText>
        </Card>
      </Section>

      {/* ------------------------------------------------------------- training */}

      <Section
        label="Train a version"
        detail="Fitted on this phone, offline. Nothing leaves the device and no paid service is involved."
      >
        <Card style={styles.stack}>
          <AppText variant="caption" color={palette.textSecondary}>
            {summary.approved} confirmed window{summary.approved === 1 ? '' : 's'} across{' '}
            {summary.labels} sign{summary.labels === 1 ? '' : 's'} and {summary.sessions} session
            {summary.sessions === 1 ? '' : 's'}.
          </AppText>

          {thin.length > 0 ? (
            <NoteCard tone="warning">
              {`These signs are short of confirmed windows: ${thin
                .map((entry) => `${entry.text} (${entry.count} of ${data.settings.activation.minSamplesPerClass})`)
                .join(', ')}. A run will refuse rather than fit a classifier on a sign it has barely seen.`}
            </NoteCard>
          ) : null}

          {summary.sessions < 2 ? (
            <NoteCard tone="warning">
              {summary.sessions === 0
                ? 'No capture session has been recorded, so there is nothing to fit.'
                : 'There is only one capture session. A run will train on all of it and hold nothing back, which means no accuracy figure can be measured — the model card will say the figure is not measured rather than show a zero.'}
            </NoteCard>
          ) : null}

          {!consent ? (
            <NoteCard tone="warning">
              Training is off because your recordings have not been allowed for it. Turn on "Use my
              recordings to train" above when you are ready.
            </NoteCard>
          ) : null}

          {snapshot.training_ && progress !== null ? (
            <View style={styles.stack}>
              <AppText variant="label">{progress.message}</AppText>
              <Meter
                testID="training-progress"
                value={progress.totalEpochs === 0 ? null : progress.epoch / progress.totalEpochs}
                label={`Epoch ${progress.epoch} of ${progress.totalEpochs}`}
                unknown="The run has not reported an epoch yet."
              />
              <AppText variant="caption" color={palette.textMuted}>
                {progress.loss === null
                  ? 'No loss reported yet for this run.'
                  : `Loss ${progress.loss.toFixed(4)}${progress.trainAccuracy === null ? '' : ` · accuracy on the training windows ${(progress.trainAccuracy * 100).toFixed(1)}%`}. The training figure is what the model scored on the data it was fitted on, which is not a measure of how well it works.`}
              </AppText>
              <ActionButton
                label="Stop this run"
                tone="danger"
                onPress={() => ml.store.cancelTraining()}
              />
              <AppText variant="caption" color={palette.textMuted}>
                Stopping writes nothing. The version already in use stays in use.
              </AppText>
            </View>
          ) : (
            <ActionButton
              label="Train a model now"
              icon="scan"
              busy={busy}
              disabled={!consent || summary.approved === 0}
              onPress={() => { void runTraining(); }}
            />
          )}
        </Card>
      </Section>

      {/* ------------------------------------------------------------- versions */}

      <Section
        label="Versions"
        detail="Every version is kept with the dataset, pipeline and settings it was made from, so a result can be traced back to what produced it."
        accessory={
          versions.length > 1 ? (
            <ActionButton label="Remove all" tone="ghost" compact onPress={() => setConfirmDeleteAll(true)} />
          ) : undefined
        }
      >
        {active !== null ? (
          <NoteCard tone="success" testID="models-active">
            {`Version ${active.version} is in use. ${SCORE_NOTE}`}
          </NoteCard>
        ) : (
          <AppText variant="caption" color={palette.textMuted}>
            No version is in use. A model may have been fitted and still not be live, because the
            activation checks refused it — each version below says why it is not in use.
          </AppText>
        )}

        {versions.length === 0 ? (
          <EmptyState
            icon="scan"
            title="No model has been trained"
            body="When a run produces one, it appears here with the figure it scored on sessions it never saw, or with a statement that no figure could be measured."
          />
        ) : (
          <Card style={styles.stack}>
            {versions.map((model, index) => {
              const hold = model.status === 'candidate' ? model.statusReason : null;
              return (
                <Row key={model.id} last={index === versions.length - 1}>
                  <View style={styles.headRow}>
                    <AppText variant="label" style={styles.grow}>
                      {describeModelSummary(model)}
                    </AppText>
                    <Badge label={describeModelStatus(model)} tone={STATUS_TONE[model.status]} dot />
                  </View>
                  <AppText variant="caption" color={palette.textMuted}>
                    Trained on {model.trainedOn.map((source) => source).join(', ')} ·{' '}
                    {model.sampleCount} windows from {model.sessionCount} session
                    {model.sessionCount === 1 ? '' : 's'} · {model.labelIds.length} sign
                    {model.labelIds.length === 1 ? '' : 's'}
                  </AppText>
                  {hold !== null ? (
                    <AppText variant="caption" color={palette.warning}>
                      {hold}
                    </AppText>
                  ) : null}
                  <View style={styles.buttonRow}>
                    <ActionButton label="Open" tone="ghost" compact onPress={() => setOpenModel(model)} />
                    <ActionButton
                      label="Publish Globally"
                      tone="primary"
                      compact
                      busy={busy}
                      onPress={() => {
                        setPublishingModel(model);
                        setPublishReason('');
                      }}
                    />
                    {model.status !== 'active' ? (
                      <ActionButton
                        label="Put into use"
                        tone="secondary"
                        compact
                        busy={busy}
                        onPress={() => setActivating(model)}
                      />
                    ) : null}
                    {model.status !== 'active' ? (
                      <ActionButton
                        label="Delete"
                        tone="ghost"
                        compact
                        busy={busy}
                        onPress={() => setDeleting(model)}
                      />
                    ) : null}
                  </View>
                </Row>
              );
            })}
          </Card>
        )}

        {versions.some((model) => model.status === 'retired') ? (
          <ActionButton
            label="Go back to the previous version"
            tone="secondary"
            busy={busy}
            onPress={() => {
              void rollback();
            }}
          />
        ) : null}
      </Section>

      {/* ------------------------------------------- global model distribution */}

      <Section
        label="Global Model Distribution (Server)"
        detail="Published models are distributed globally to all connected devices and guest users via the backend."
      >
        <Card style={styles.stack}>
          {serverModel?.published ? (
            <View style={styles.stack}>
              <View style={styles.headRow}>
                <AppText variant="label" style={styles.grow}>
                  Published: Version {serverModel.version}
                </AppText>
                <Badge label="Live Globally" tone="success" dot />
              </View>
              <AppText variant="caption" color={palette.textSecondary}>
                Language: {serverModel.languageProfile?.toUpperCase()} · Published by: {serverModel.publishedBy}
              </AppText>
              {serverModel.publishReason ? (
                <AppText variant="caption" color={palette.textMuted}>
                  Reason: {serverModel.publishReason}
                </AppText>
              ) : null}
              {serverModel.publishedAt ? (
                <AppText variant="caption" color={palette.textMuted}>
                  Published at: {new Date(serverModel.publishedAt).toLocaleString()}
                </AppText>
              ) : null}
              <View style={styles.buttonRow}>
                <ActionButton
                  label="Roll Back Server Model"
                  tone="danger"
                  compact
                  busy={busy}
                  onPress={() => {
                    setRollbackPrompt(true);
                    setRollbackReason('');
                  }}
                />
                <ActionButton
                  label="Refresh Server Status"
                  tone="ghost"
                  compact
                  busy={busy}
                  onPress={() => {
                    void fetchServerModel();
                  }}
                />
              </View>
            </View>
          ) : (
            <View style={styles.stack}>
              <AppText variant="caption" color={palette.textMuted}>
                No model is currently published on the server for {data.languageId.toUpperCase()}.
                Client apps and guests will use their locally cached or bundled models until an Admin publishes one.
              </AppText>
              <ActionButton
                label="Check Server Status"
                tone="ghost"
                compact
                busy={busy}
                onPress={() => {
                  void fetchServerModel();
                }}
              />
            </View>
          )}
        </Card>
      </Section>

      {/* ---------------------------------------------------------- model card */}

      <Sheet
        visible={openModel !== null}
        onClose={() => setOpenModel(null)}
        title={openModel === null ? 'Version' : `Version ${openModel.version}`}
        description={openModel === null ? undefined : describeModelStatus(openModel)}
      >
        {openModel === null ? null : <ModelCardBody model={openModel} />}
      </Sheet>

      <Sheet
        visible={publishingModel !== null}
        onClose={() => setPublishingModel(null)}
        title={publishingModel === null ? '' : `Publish v${publishingModel.version} Globally`}
        description={`This will make Version ${publishingModel?.version} the official global model for all ${data.languageId.toUpperCase()} users. Guest and Normal User apps will automatically download and run inference with this model.`}
      >
        <View style={styles.sheet}>
          <TextField
            label="Audit / Publish Reason"
            placeholder="e.g. Validated 5-word ASL starter vocabulary with held-out testing"
            value={publishReason}
            onChangeText={setPublishReason}
          />
          <ActionButton
            label="Confirm Global Publication"
            tone="primary"
            busy={busy}
            disabled={publishReason.trim().length < 3}
            onPress={() => {
              void executePublish();
            }}
          />
        </View>
      </Sheet>

      <Sheet
        visible={rollbackPrompt}
        onClose={() => setRollbackPrompt(false)}
        title={`Roll Back Global Model (${data.languageId.toUpperCase()})`}
        description="Reverts the globally distributed model to the previously published version on the server. All clients will fall back on their next check."
      >
        <View style={styles.sheet}>
          <TextField
            label="Audit / Rollback Reason"
            placeholder="e.g. Incompatible sensor range or model degraded"
            value={rollbackReason}
            onChangeText={setRollbackReason}
          />
          <ActionButton
            label="Confirm Rollback"
            tone="danger"
            busy={busy}
            disabled={rollbackReason.trim().length < 3}
            onPress={() => {
              void executeRollback();
            }}
          />
        </View>
      </Sheet>

      <ConfirmDialog
        visible={activating !== null}
        title={activating === null ? '' : `Put version ${activating.version} into use?`}
        message={
          activating === null
            ? ''
            : `${describeModelSummary(activating)}. ${
                activating.statusReason === null
                  ? 'It cleared the activation checks when it was fitted.'
                  : `The checks held it back when it was fitted: ${activating.statusReason} You can still use it — the data is yours and the thresholds are yours — but this is what the gate said.`
              }`
        }
        confirmLabel="Put it into use"
        onConfirm={() => {
          if (activating !== null) void activate(activating);
        }}
        onCancel={() => setActivating(null)}
      />

      <ConfirmDialog
        visible={deleting !== null}
        title={deleting === null ? '' : `Delete version ${deleting.version}?`}
        message={
          deleting === null
            ? ''
            : 'Its weights are removed from this phone. The windows it was trained on are not affected, so it can be fitted again from the same data.'
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleting !== null) void removeModel(deleting);
        }}
        onCancel={() => setDeleting(null)}
      />

      <ConfirmDialog
        visible={confirmDeleteAll}
        title="Remove every stored version?"
        message={`${versions.length} version${versions.length === 1 ? '' : 's'} will be removed, including any that is in use. Recognition would stop until a model is fitted again. The windows and signs are not touched.`}
        confirmLabel="Remove them all"
        destructive
        onConfirm={() => { void wipeModels(); }}
        onCancel={() => setConfirmDeleteAll(false)}
      />
    </View>
  );
}

/* ------------------------------------------------------------- the model card */

/**
 * Everything the record actually holds, read out.
 *
 * `modelCard` builds the lines so the card cannot drift from the stored record —
 * this only decides how they are laid out.
 */
function ModelCardBody({ model }: { model: ModelSummary }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const ml = useMl();
  const [read, setRead] = useState<'pending' | 'done' | 'missing'>('pending');
  const [card, setCard] = useState<ModelCard | null>(null);
  /**
   * Whether the data this version was fitted on is still the data here.
   *
   * Read alongside the card rather than baked into the summary, because
   * answering it means reading every stored window and comparing the trainable
   * set to the digest the run recorded. Null while that read is in flight, and
   * `unknown` for a version that carries no digest to compare against.
   */
  const [match, setMatch] = useState<DatasetMatch | null>(null);

  /*
   * The evaluation and the configuration are on the summary; the algorithm's own
   * sentence and the signs by name come from the card, which is built from the
   * full record. `nowMs` is read once here rather than at render, so the
   * "Trained: yesterday" line cannot change under a re-render.
   */
  React.useEffect(() => {
    let cancelled = false;
    void ml.store.loadModel(model.id).then((record) => {
      if (cancelled) return;
      if (record === null) {
        setRead('missing');
        return;
      }
      setCard(modelCard(record, ml.store.getSnapshot().labels, Date.now()));
      setRead('done');
    });
    void ml.store.datasetStateFor(model.id).then((state) => {
      if (cancelled) return;
      setMatch(state);
    });
    return () => {
      cancelled = true;
    };
  }, [ml, model.id]);

  const evaluation = model.evaluation;

  return (
    <View style={styles.sheet}>
      <View style={styles.headRow}>
        <AppText variant="label" style={styles.grow}>
          {describeModelStatus(model)}
        </AppText>
        <Badge label={`${model.sampleCount} windows`} tone="neutral" />
      </View>

      {model.statusReason !== null ? (
        <NoteCard tone="warning">{model.statusReason}</NoteCard>
      ) : null}

      {/*
        The one thing the counts above cannot say. "40 windows" reads the same
        whether those are the same 40 windows or a different 40, so a version
        fitted before a deletion, a re-labelling or a rejection is otherwise
        indistinguishable from one fitted after it — and the weights were not
        updated either way. Shown only when it is true, and phrased as what
        changed rather than as what the model did, because the model did nothing.
      */}
      {match === 'changed' ? (
        <NoteCard tone="warning" testID="model-data-changed">
          The data this was fitted on has changed since. Windows recorded after it was trained, or
          since deleted, re-labelled or rejected, are not in these weights — a model is not updated
          by later changes to the library, and it has to be fitted again to include them. Until
          then it recognises what it learnt from, not what is stored now.
        </NoteCard>
      ) : null}

      {match === 'unknown' ? (
        <AppText variant="caption" color={palette.textMuted} testID="model-data-unknown">
          Whether the stored windows still match this version's training set is unknown, because
          this version carries no record of that set — either it was fitted before this build
          started recording one, or it was taken in from a package written on another phone.
        </AppText>
      ) : null}

      <AppText variant="caption" color={palette.textSecondary}>
        {model.algorithm} · {model.algorithmDetail}
      </AppText>

      {card !== null ? (
        <View style={styles.stack}>
          {card.lines.map((line) => (
            <View key={line.label} style={styles.cardLine}>
              <AppText variant="caption" color={palette.textMuted}>
                {line.label}
              </AppText>
              <AppText variant="caption" color={palette.textSecondary}>
                {line.value}
              </AppText>
            </View>
          ))}
        </View>
      ) : read === 'missing' ? (
        <AppText variant="caption" color={palette.textMuted}>
          The stored record could not be read back, so the algorithm's own line and the signs by name
          are not shown here. The version can still be deleted from the list above.
        </AppText>
      ) : (
        <AppText variant="caption" color={palette.textMuted}>
          Reading the stored record…
        </AppText>
      )}

      {/*
        The card's own caveats — the ones `modelStore.ts` attaches to every version,
        plus anything the measurement added. Rendered from the record rather than
        written here, so a claim cannot be dropped by editing a screen.
      */}
      {card !== null
        ? card.caveats.map((caveat) => (
            <NoteCard key={caveat} tone="warning">
              {caveat}
            </NoteCard>
          ))
        : null}

      {/* ------------------------------------------------------- the figures */}

      <View style={styles.stack}>
        <AppText variant="label">Measured on held-back sessions</AppText>
        {evaluation === null ? (
          <AppText variant="caption" color={palette.textMuted}>
            Not measured. This version was fitted without an evaluation split, so there is no figure
            — not a figure of zero.
          </AppText>
        ) : (
          <View style={styles.stack}>
            <AppText variant="caption" color={palette.textSecondary}>
              {evaluation.accuracy === null
                ? 'No accuracy figure could be computed: the held-back split was empty.'
                : `${(evaluation.accuracy * 100).toFixed(1)}% of ${evaluation.counts.test} windows in the ${evaluation.split} split, drawn from ${evaluation.counts.testSessions} session${evaluation.counts.testSessions === 1 ? '' : 's'} the model never saw.`}
            </AppText>
            {evaluation.macroF1 === null ? null : (
              <AppText variant="caption" color={palette.textMuted}>
                Macro F1 {evaluation.macroF1.toFixed(3)} — the mean across signs, so a sign the model
                is bad at is not hidden by one it is good at.
              </AppText>
            )}

            {evaluation.classes.length > 0 ? (
              <View style={styles.stack}>
                {evaluation.classes.map((metric) => (
                  <View key={metric.labelId} style={styles.cardLine}>
                    <AppText variant="caption" color={palette.textSecondary}>
                      {ml.store.labelText(metric.labelId)}
                    </AppText>
                    <AppText variant="caption" color={palette.textMuted}>
                      {metric.support === 0
                        ? 'No windows of this sign in the held-back data, so no figure is reported for it.'
                        : `${metric.support} window${metric.support === 1 ? '' : 's'} · precision ${metric.precision === null ? 'not defined' : metric.precision.toFixed(2)} · recall ${metric.recall === null ? 'not defined' : metric.recall.toFixed(2)}`}
                    </AppText>
                  </View>
                ))}
              </View>
            ) : null}

            {evaluation.confusion.length > 0 ? (
              <View style={styles.stack}>
                <AppText variant="label">Confusion</AppText>
                <AppText variant="caption" color={palette.textMuted}>
                  Rows are what the window actually was; columns are what the model said. Read along
                  the diagonal for the ones it got right.
                </AppText>
                <View style={styles.matrix}>
                  {evaluation.confusion.map((row, rowIndex) => (
                    <View key={evaluation.classLabels[rowIndex] ?? rowIndex} style={styles.matrixRow}>
                      <AppText variant="caption" color={palette.textMuted} style={styles.matrixLabel}>
                        {ml.store.labelText(evaluation.classLabels[rowIndex] ?? '')}
                      </AppText>
                      {row.map((count, columnIndex) => (
                        <AppText
                          key={`${rowIndex}-${columnIndex}`}
                          variant="reading"
                          color={
                            count === 0
                              ? palette.textMuted
                              : rowIndex === columnIndex
                                ? palette.success
                                : palette.danger
                          }
                          center
                          style={styles.matrixCell}
                        >
                          {`${count}`}
                        </AppText>
                      ))}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            {evaluation.caveats.map((caveat) => (
              <NoteCard key={caveat} tone="warning">
                {caveat}
              </NoteCard>
            ))}

            <NoteCard>{SCORE_NOTE}</NoteCard>
          </View>
        )}
      </View>

      {model.trainedOn.includes('simulated') ? (
        <NoteCard tone="warning">
          This version was fitted on Demo Mode windows. It recognises that simulated waveform. It is
          not evidence that signing is recognised, and it must not be described as if it were.
        </NoteCard>
      ) : null}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
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
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
    },
    divided: {
      paddingTop: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    buttonRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    sheet: {
      gap: spacing.md,
      paddingBottom: spacing.md,
    },
    cardLine: {
      gap: 2,
    },
    matrix: {
      gap: spacing.xs,
    },
    matrixRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    matrixLabel: {
      flex: 1,
      minWidth: 0,
    },
    matrixCell: {
      minWidth: 34,
    },
  });
