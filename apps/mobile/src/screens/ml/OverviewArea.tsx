/**
 * Where the learning centre starts: what is connected, what is set, and what is
 * missing.
 *
 * ## The order is the order someone meets the obstacles
 *
 * Source first — with no frames there is nothing to do at all. Then the two
 * choices that have to be made before recording (sign language, modality). Then
 * the readiness list, unmet items first, so the next thing to do is the first
 * thing on screen. Only then the full capability table, which is reference
 * rather than instruction.
 *
 * ## Every claim is computed
 *
 * Nothing here states a number or a state by hand. The readiness list comes from
 * `readiness()`, the capability table from `describeCapabilities()` — both shown
 * from the modules the tests pin, not written into this file. That is what keeps
 * a screen from continuing to assert something the code stopped doing.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { ListRow } from '../../components/ListRow';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StateChip } from '../../components/StateChip';
import { useAppState, useGlove } from '../../app/AppState';
import { OUTPUT_LANGUAGES } from '../../app/preferences';
import {
  activeModelDrift,
  describeCapabilities,
  describeDataset,
  interruptedSessions,
  provenanceWarning,
  readiness,
  SOURCE_LABEL,
  versionsFor,
} from '../../ml';
import type { Modality } from '../../ml';
import { SIGN_LANGUAGE_PROFILES } from '../../recognition/profiles';
import { spacing } from '../../theme';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import type { Palette } from '../../theme/palette';
import { CapabilityBadge, Metric, NoteCard, Row, Section } from './shared';
import { useMl, useMlData, useMlSnapshot } from './hooks';

const MODES: readonly { value: Modality; label: string }[] = [
  { value: 'glove-sensor', label: 'Glove' },
  { value: 'vision', label: 'Photos' },
];

/**
 * When the latest capture session started.
 *
 * Read at day scale, because a dataset is built over weeks and `formatAge` tops
 * out at minutes — "2013 minutes ago" is a number nobody converts.
 */
function newestSession(sessions: readonly { readonly startedAtMs: number }[]): number {
  return sessions.reduce((latest, session) => Math.max(latest, session.startedAtMs), 0);
}

function describeAge(startedAtMs: number): string {
  const minutes = Math.round((Date.now() - startedAtMs) / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function OverviewArea(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const ml = useMl();
  const data = useMlData();
  const state = useMlSnapshot();
  const { profile, preferences, calibration, recognitionAvailable, recognitionUnavailableReason } =
    useAppState();

  const right = useGlove('right');
  const left = useGlove('left');

  const summary = ml.store.summary();
  const drift = activeModelDrift({
    model: state.activeModel,
    labels: data.labels,
    settings: data.settings,
  });
  const simulated = summary.bySource.simulated ?? 0;
  const provenance = provenanceWarning(summary);
  const interrupted = interruptedSessions(data.sessions);
  /*
   * The thinnest class, counted from the approved windows per label. Not from a
   * nominal target: `perLabel` is what `summarise` actually counted.
   */
  const activeLabels = data.labels.filter((label) => label.archivedAtMs === null);
  const thinnest =
    activeLabels.length === 0
      ? 0
      : Math.min(...activeLabels.map((label) => summary.perLabel[label.id] ?? 0));
  const versions = versionsFor(data.models, data.languageId);

  const steps = readiness({
    summary,
    settings: data.settings,
    languageSelected: data.languageId.length > 0,
    gloveConnected: right.source !== 'none' || left.source !== 'none',
    thinnestClass: thinnest,
  });
  // Unmet first, and within that the order they have to be done in. A list that
  // puts a met step above an unmet one buries the next action.
  const ordered = [...steps].sort((a, b) => Number(a.met) - Number(b.met));

  const capabilities = describeCapabilities({
    transportSynthetic: right.synthetic,
    transportName: right.transportName,
    linkConnected: right.source !== 'none',
    pickerAvailable: ml.picker.isAvailable(),
    pickerReason: ml.picker.unavailableReason(),
    settings: data.settings,
    summary,
    activeModel: state.activeModel,
    candidateCount: versions.filter((model) => model.status === 'candidate').length,
    signedIn: ml.accountInfo.signedIn,
  });

  const gloveState = (glove: typeof right) => {
    if (glove.source === 'none') return 'disconnected' as const;
    return glove.synthetic ? ('warning' as const) : ('healthy' as const);
  };

  return (
    <View style={styles.areas}>
      {/* ------------------------------------------------------------ source */}

      <Section
        label="Where frames come from"
        detail="Recording needs a live source. Demo Mode produces a simulated waveform, and windows recorded from it say so."
      >
        <Card style={styles.stack}>
          <View style={styles.statusRow}>
            <Icon
              name={right.source === 'none' ? 'warning' : 'signal'}
              size={16}
              color={right.source === 'none' ? palette.warning : palette.success}
            />
            <View style={styles.growColumn}>
              <AppText variant="label">Right hand — {right.transportName}</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                {right.source === 'none'
                  ? 'No frames are arriving, so nothing can be recorded from this glove yet.'
                  : `${right.packetCount} packets received. ${
                      right.synthetic
                        ? 'These readings are generated by a simulator, not by a glove.'
                        : 'These readings come from the connected glove.'
                    }`}
              </AppText>
            </View>
            <StateChip state={gloveState(right)} />
          </View>

          <View style={[styles.statusRow, styles.divided]}>
            <Icon
              name={left.source === 'none' ? 'warning' : 'signal'}
              size={16}
              color={left.source === 'none' ? palette.warning : palette.success}
            />
            <View style={styles.growColumn}>
              <AppText variant="label">Left hand — {left.transportName}</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                {left.source === 'none'
                  ? 'No frames are arriving from this glove.'
                  : `${left.packetCount} packets received.`}
              </AppText>
            </View>
            <StateChip state={gloveState(left)} />
          </View>

          <AppText variant="caption" color={palette.textMuted}>
            Calibration in use: version {calibration.right.version} (right), version{' '}
            {calibration.left.version} (left). Every window records which calibration produced its
            frames, so a model can never be read against a different one without that being visible.
          </AppText>

          <AppText variant="caption" color={palette.textMuted}>
            Connecting and scanning happen on the OLED screen, which owns the link. This screen
            reports what that link is doing rather than offering a second way to open it.
          </AppText>
        </Card>
      </Section>

      {/* ------------------------------------------------------- what is set */}

      <Section
        label="Sign language and modality"
        detail="Windows are filed under both, and training only ever looks at one pair at a time."
      >
        <SegmentedControl
          options={SIGN_LANGUAGE_PROFILES.map((item) => ({ value: item.id, label: item.name.split(' ')[0]! }))}
          value={data.languageId}
          onChange={(next) => {
            ml.store.setContext(next, data.modality);
          }}
          accessibilityLabel="Sign language"
        />
        <AppText variant="caption" color={palette.textMuted}>
          {SIGN_LANGUAGE_PROFILES.find((item) => item.id === data.languageId)?.name ?? data.languageId}
          . The profile you are set to in Settings is{' '}
          {profile.name}; this switch changes which one the learning centre files new windows under.
        </AppText>

        <SegmentedControl
          options={MODES}
          value={data.modality}
          onChange={(next) => {
            ml.store.setContext(data.languageId, next);
          }}
          accessibilityLabel="Modality"
        />
        <NoteCard>
          {data.modality === 'vision'
            ? 'Photos and video are their own pipeline. This build has no vision model, and a photo or video stored here never becomes a glove feature vector.'
            : 'Glove windows are resampled to a fixed 30-frame window and reduced to statistics. Photos and video are a separate library and never enter this pipeline.'}
        </NoteCard>
      </Section>

      {/* --------------------------------------------------------- readiness */}

      <Section
        label="To a first trained model"
        detail="In the order they have to be done. Unmet steps come first."
      >
        <Card style={styles.stack}>
          {ordered.map((step, index) => (
            <Row key={step.id} last={index === ordered.length - 1}>
              <View style={styles.statusRow}>
                <Icon
                  name={step.met ? 'check' : 'warning'}
                  size={16}
                  color={step.met ? palette.success : palette.warning}
                />
                <AppText
                  variant="label"
                  color={step.met ? palette.textSecondary : palette.textPrimary}
                  style={styles.grow}
                >
                  {step.text}
                </AppText>
              </View>
            </Row>
          ))}
        </Card>
      </Section>

      {/* ------------------------------------------------------------- things
          that are true right now and would otherwise be easy to miss */}

      {provenance !== null ? (
        <NoteCard tone="warning" testID="ml-provenance-warning">
          {provenance}
        </NoteCard>
      ) : null}

      {interrupted.length > 0 ? (
        <NoteCard tone="warning" testID="ml-interrupted-warning">
          {interrupted.length === 1
            ? 'One capture session was cut off before it was closed. Its windows were saved as they were confirmed, so nothing was lost — but the session is recorded as interrupted rather than as one that finished.'
            : `${interrupted.length} capture sessions were cut off before they were closed. Every confirmed window in them was written immediately, so nothing was lost, but they are recorded as interrupted rather than as sessions that finished.`}
        </NoteCard>
      ) : null}

      {drift !== null ? (
        <NoteCard tone="warning" testID="ml-drift-warning">
          {drift}
        </NoteCard>
      ) : null}

      {data.damaged.length > 0 ? (
        <NoteCard tone="warning" testID="ml-damaged-warning">
          {data.damaged.length === 1
            ? 'One stored window could not be read back and is not counted anywhere below. It is listed in the library so it can be deleted.'
            : `${data.damaged.length} stored windows could not be read back and are not counted anywhere below. They are listed in the library so they can be deleted.`}
        </NoteCard>
      ) : null}

      {data.error !== null ? (
        <NoteCard tone="warning" testID="ml-error">
          {data.error}
        </NoteCard>
      ) : null}

      {/* ------------------------------------------------------------ figures */}

      <Section label="What is held on this phone" detail={describeDataset(summary)}>
        <Card style={styles.stack}>
          <Metric
            label="Signs defined"
            value={`${summary.labels}`}
            note={
              summary.labels === 0
                ? 'None yet. A window cannot be filed without a name to file it under, and nothing here invents one from the motion.'
                : 'Your own working names. They are not a published vocabulary — no Deaf-led review has happened, and the model card says so.'
            }
          />
          <Metric
            label="Windows confirmed"
            value={`${summary.approved}`}
            note={
              summary.approved === 0
                ? 'None confirmed, so nothing can be trained on. Unconfirmed windows are stored but the trainer refuses them.'
                : 'Confirmed by you, which is the only thing that makes a window a training example.'
            }
          />
          <Metric
            label="Windows waiting to be confirmed"
            value={`${summary.pending}`}
            note="Recorded but not yet labelled. Held safely and kept out of training."
          />
          <Metric
            label="Windows from Demo Mode"
            value={`${simulated}`}
            note={
              simulated === 0
                ? 'None. Every window came from a real source or from a file.'
                : `A model fitted on these recognises a simulation, not signing. They are marked ${SOURCE_LABEL.simulated} everywhere they appear.`
            }
          />
          <Metric
            label="Capture sessions"
            value={`${summary.sessions}`}
            note={
              summary.sessions >= 2
                ? 'Enough to hold a whole session back, so a measured figure means something.'
                : 'One session or none. With a single sitting there is nothing to hold back, and no accuracy figure can be measured at all.'
            }
            last
          />
        </Card>
      </Section>

      {/* -------------------------------------------------------- recognition */}

      <Section label="Recognition in the rest of the app">
        <Card style={styles.stack}>
          <View style={styles.statusRow}>
            <Icon
              name={recognitionAvailable ? 'check' : 'warning'}
              size={16}
              color={recognitionAvailable ? palette.success : palette.warning}
            />
            <View style={styles.growColumn}>
              <AppText variant="label">
                {recognitionAvailable ? 'A recogniser is loaded' : 'No recogniser is loaded'}
              </AppText>
              <AppText variant="caption" color={palette.textMuted}>
                {recognitionAvailable
                  ? 'The dashboard will produce readings from it.'
                  : (recognitionUnavailableReason ??
                    'The dashboard has no recognition model, so signs are not read there.')}
              </AppText>
            </View>
          </View>
          <AppText variant="caption" color={palette.textMuted}>
            A model trained here is used by the Live area on this screen. Wiring it into the
            dashboard's result line is a separate change and has not been made — so a version can be
            live and still not change what the dashboard shows.
          </AppText>
        </Card>
      </Section>

      {/* ------------------------------------------------------- capabilities */}

      <Section
        label="Every capability, as it actually stands"
        detail="Computed from the app's real state, not written here. Nothing on this list may overstate what works."
      >
        <Card style={styles.stack}>
          {capabilities.map((capability, index) => (
            <Row key={capability.id} last={index === capabilities.length - 1}>
              <View style={styles.capHead}>
                <AppText variant="label" style={styles.grow}>
                  {capability.title}
                </AppText>
                <CapabilityBadge state={capability.state} />
              </View>
              <AppText variant="caption" color={palette.textMuted}>
                {capability.detail}
              </AppText>
              {capability.action !== null ? (
                <AppText variant="caption" color={palette.textSecondary}>
                  {capability.action}
                </AppText>
              ) : null}
            </Row>
          ))}
        </Card>
      </Section>

      <Section label="Preferences in force">
        <Card>
          <ListRow
            label="Settings language profile"
            value={profile.name}
            description={`Chosen in Settings. ${preferences.signProfileId === data.languageId ? 'It matches the learning centre.' : `The learning centre is filed under ${data.languageId}.`}`}
            last
          />
        </Card>
        <AppText variant="caption" color={palette.textMuted}>
          No sign vocabulary is published for this build: every profile in Settings is still marked
          planned with no signs. Labels you define here are your own working names for your own
          recordings, which is why every screen that shows one also says whose it is.
        </AppText>
      </Section>

      {/*
        The two things the old screen carried that are still true. It also carried
        a list of the engineering steps to recognition — no dataset, no training
        run, no held-out measurement — and that list is now false, so it is gone
        rather than left standing.
      */}
      <Section
        label="Sign language profiles"
        detail="Counted from the profiles in this build, not from a figure written here."
      >
        <Card style={styles.stack}>
          {SIGN_LANGUAGE_PROFILES.map((item, index) => (
            <Row key={item.id} last={index === SIGN_LANGUAGE_PROFILES.length - 1}>
              <View style={styles.capHead}>
                <AppText variant="label" style={styles.grow}>
                  {item.name}
                </AppText>
                <Badge
                  label={
                    item.status === 'available'
                      ? 'Available'
                      : item.status === 'in-progress'
                        ? 'In progress'
                        : 'Planned'
                  }
                  tone={
                    item.status === 'available'
                      ? 'success'
                      : item.status === 'in-progress'
                        ? 'warning'
                        : 'neutral'
                  }
                />
              </View>
              <AppText variant="caption" color={palette.textMuted}>
                {item.vocabularySize === 0
                  ? 'No signs defined. Selecting this profile changes which language your own windows are filed under, and nothing else — there is no published list to read against.'
                  : `${item.vocabularySize} signs defined.`}
              </AppText>
            </Row>
          ))}
        </Card>
      </Section>

      <Section label="Output languages">
        <Card style={styles.stack}>
          {OUTPUT_LANGUAGES.map((language, index) => (
            <Row key={language.code} last={index === OUTPUT_LANGUAGES.length - 1}>
              <AppText variant="label">{language.name}</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                Written as {language.code.toUpperCase()}, spoken as {language.speechTag}. Which
                languages can be written or spoken is a property of this build; whether the phone
                has a voice installed under that tag is a fact about the phone.
              </AppText>
            </Row>
          ))}
        </Card>
        <AppText variant="caption" color={palette.textMuted}>
          These are languages a result can be written or spoken in. They are not sign languages, and
          listing one does not mean signing in it is recognised.
        </AppText>
      </Section>

      <NoteCard>
        {data.sessions.length === 0
          ? 'No capture session has been recorded on this phone yet, so there is nothing here that a model could be fitted on.'
          : `The most recent capture session began ${describeAge(newestSession(data.sessions))}. Nothing on this screen reports a figure it did not read from storage.`}
      </NoteCard>
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
    statusRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    growColumn: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    grow: {
      flex: 1,
    },
    capHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    divided: {
      paddingTop: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
  });
