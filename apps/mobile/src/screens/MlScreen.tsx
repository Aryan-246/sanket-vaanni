/**
 * Models and vocabulary.
 *
 * ## The one rule this screen exists to keep
 *
 * Nothing here may state a number that no artefact supports. Not an accuracy
 * figure, not a training progress, not a version string, not a vocabulary size
 * that was not counted from a real list. The `ml/` directory in this repository
 * contains a README and nothing else, so the honest answer to "what does the
 * model do?" is "there is no model", and the screen is designed to say exactly
 * that without looking like a failure.
 *
 * ## What it is for, given that
 *
 * Three things. First, it records what the product *intends* to do — the sign
 * languages and output languages that are planned — so the shape of the
 * finished thing is legible. Second, it states precisely what is missing
 * between here and there, which is the most useful thing this screen can carry.
 * Third, it shows what the app does today, which is nothing, and why.
 *
 * Every count on this screen is derived from `SIGN_LANGUAGE_PROFILES` rather
 * than written down, so adding a profile changes the screen and a stale number
 * is not possible.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { DetailHeader } from '../components/DetailHeader';
import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { useAppState } from '../app/AppState';
import { OUTPUT_LANGUAGES } from '../app/preferences';
import { SIGN_LANGUAGE_PROFILES, type SignLanguageProfile } from '../recognition/profiles';
import { spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';

export interface MlScreenProps {
  onClose: () => void;
}

/**
 * The work that stands between this build and recognition.
 *
 * Written as engineering steps rather than as a roadmap with dates, because a
 * date would be invented and a step list is checkable. Each entry names the
 * artefact that would have to exist — a dataset, a training run, a converted
 * model file — so progress can be judged by whether the artefact is there.
 */
const BLOCKING_WORK: readonly { title: string; detail: string; owner: string }[] = [
  {
    title: 'A sign vocabulary, defined by Deaf signers',
    detail:
      'No list of signs exists in this repository. A vocabulary cannot be invented from sensor data — it is a linguistic decision about which signs a product claims to support, and it has to come from people who use the language.',
    owner: 'Linguistic',
  },
  {
    title: 'Recording sessions on real gloves',
    detail:
      'The firmware directories contain notes, not a working protocol. Until gloves can be worn and their packets verified, there is no way to record a single labelled example.',
    owner: 'Hardware',
  },
  {
    title: 'A labelled dataset',
    detail:
      'Recordings paired with the sign they represent. This does not exist. Nothing on this screen counts how much of it there is, because there is none.',
    owner: 'Data',
  },
  {
    title: 'Training and validation',
    detail:
      'A model trained on the dataset above, with accuracy measured on data held back from training. No run has been done, so no accuracy figure exists — and any figure shown here would be invented.',
    owner: 'Model',
  },
  {
    title: 'Conversion to an on-device model file',
    detail:
      'The trained model has to be converted into something this app can load and run on a phone without a network. No such file exists in this build.',
    owner: 'Model',
  },
  {
    title: 'Signer-independent validation',
    detail:
      'A model that only recognises the people who recorded the training data has not solved the problem. Testing on signers the model has never seen is the step that decides whether recognition works.',
    owner: 'Data',
  },
];

export function MlScreen({ onClose }: MlScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { recognitionAvailable, recognitionUnavailableReason } = useAppState();

  const totalSigns = SIGN_LANGUAGE_PROFILES.reduce(
    (sum, profile) => sum + profile.vocabularySize,
    0,
  );
  const availableProfiles = SIGN_LANGUAGE_PROFILES.filter(
    (profile) => profile.status === 'available',
  ).length;

  return (
    <Screen scroll testID="ml-screen">
      <DetailHeader title="Models and vocabulary" onClose={onClose} subtitle="What is installed, and what is missing" />

      {/* -------------------------------------------------------- the model */}

      <SectionHeader label="Recognition model" />

      <Card style={styles.stack}>
        {/*
          The state is read from the recogniser, not asserted here. On a build
          with a model loaded this line changes on its own, which is what keeps
          the screen from becoming a lie the moment someone ships one.
        */}
        <View style={styles.statusRow}>
          <Icon
            name={recognitionAvailable ? 'check' : 'warning'}
            size={16}
            color={recognitionAvailable ? palette.success : palette.warning}
          />
          <View style={styles.stackTight}>
            <AppText variant="label">
              {recognitionAvailable ? 'A recogniser is loaded' : 'No model is loaded'}
            </AppText>
            <AppText variant="caption" color={palette.textMuted}>
              {recognitionAvailable
                ? 'This build has a recogniser and will produce readings from it.'
                : (recognitionUnavailableReason ??
                  'This build has no recognition model, so signs are not read. Nothing on this screen estimates what a model would say.')}
            </AppText>
          </View>
        </View>

        <AppText variant="caption" color={palette.textMuted}>
          The repository’s ml directory contains a README and no weights, no dataset and no
          training code. This screen reports that rather than presenting a model that does not
          exist.
        </AppText>
      </Card>

      {/* ---------------------------------------------------------- numbers */}

      <SectionHeader
        label="What is defined today"
        detail="Counted from the profiles in this build, not from a figure written here."
      />

      <Card style={styles.stack}>
        <Metric
          label="Sign languages profiled"
          value={`${SIGN_LANGUAGE_PROFILES.length}`}
          note={`${availableProfiles} of them available. The rest are planned.`}
        />
        <Metric
          label="Signs defined across all profiles"
          value={`${totalSigns}`}
          note={
            totalSigns === 0
              ? 'No profile has a vocabulary. A sign language cannot be supported by declaring it — the signs themselves have to be defined and recorded.'
              : 'Counted from the vocabulary lists in each profile.'
          }
        />
        <Metric
          label="Output languages offered"
          value={`${OUTPUT_LANGUAGES.length}`}
          note="Text and speech targets. These are languages the result can be written or spoken in — they are not sign languages and do not imply recognition."
          last
        />
      </Card>

      {/* --------------------------------------------------------- profiles */}

      <SectionHeader label="Sign language profiles" />
      <Card style={styles.stack}>
        {SIGN_LANGUAGE_PROFILES.map((profile, index) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            last={index === SIGN_LANGUAGE_PROFILES.length - 1}
          />
        ))}
      </Card>

      {/* ------------------------------------------------------- vocabulary */}

      <SectionHeader label="Output languages" />
      <Card style={styles.stack}>
        {OUTPUT_LANGUAGES.map((language, index) => (
          <View
            key={language.code}
            style={[
              styles.languageRow,
              index < OUTPUT_LANGUAGES.length - 1 && styles.rowDivided,
            ]}
          >
            <View style={styles.stackTight}>
              <AppText variant="label">{language.name}</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                Written as {language.code.toUpperCase()}, spoken as {language.speechTag}. A voice
                tag is defined for it; whether the phone has voice data installed under that tag
                is a fact about the phone.
              </AppText>
            </View>
          </View>
        ))}
      </Card>
      <AppText variant="caption" color={palette.textMuted}>
        Whether a voice for one of these languages is actually installed is a fact about the
        phone, not about this build. The component status screen checks it against the device.
      </AppText>

      {/* ------------------------------------------------------ what's left */}

      <SectionHeader
        label="What stands between this and recognition"
        detail="Engineering steps, in the order they can be done. No dates: none has been committed to."
      />

      <Card style={styles.stack}>
        {BLOCKING_WORK.map((item, index) => (
          <View
            key={item.title}
            style={[styles.workRow, index < BLOCKING_WORK.length - 1 && styles.rowDivided]}
          >
            <View style={styles.workHead}>
              <AppText variant="label" style={styles.grow}>
                {item.title}
              </AppText>
              <Badge label={item.owner} tone="neutral" />
            </View>
            <AppText variant="caption" color={palette.textMuted}>
              {item.detail}
            </AppText>
          </View>
        ))}
      </Card>

      <Card sunken style={styles.note}>
        <Icon name="info" size={14} color={palette.textMuted} />
        <AppText variant="caption" color={palette.textMuted} style={styles.grow}>
          This screen contains no accuracy figure, no training progress and no model version,
          because none of those exists. It will show them when there is something real to show.
        </AppText>
      </Card>
    </Screen>
  );
}

/* --------------------------------------------------------------- sub-parts */

function Metric({
  label,
  value,
  note,
  last = false,
}: {
  label: string;
  value: string;
  note: string;
  last?: boolean;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  return (
    <View style={[styles.metric, !last && styles.rowDivided]}>
      <View style={styles.metricHead}>
        <AppText variant="caption" color={palette.textMuted} style={styles.grow}>
          {label}
        </AppText>
        <AppText variant="title">{value}</AppText>
      </View>
      <AppText variant="caption" color={palette.textMuted}>
        {note}
      </AppText>
    </View>
  );
}

/** The tone for a profile's lifecycle state. */
const STATUS_TONE: Record<SignLanguageProfile['status'], 'success' | 'warning' | 'neutral'> = {
  available: 'success',
  'in-progress': 'warning',
  planned: 'neutral',
};

const STATUS_LABEL: Record<SignLanguageProfile['status'], string> = {
  available: 'Available',
  'in-progress': 'In progress',
  planned: 'Planned',
};

function ProfileRow({
  profile,
  last,
}: {
  profile: SignLanguageProfile;
  last: boolean;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={[styles.workRow, !last && styles.rowDivided]}>
      <View style={styles.workHead}>
        <AppText variant="label" style={styles.grow}>
          {profile.name}
        </AppText>
        <Badge label={STATUS_LABEL[profile.status]} tone={STATUS_TONE[profile.status]} />
      </View>
      <AppText variant="caption" color={palette.textMuted}>
        {profile.vocabularySize === 0
          ? 'No signs defined. Selecting this profile changes the label on screen and nothing else, because there is nothing to read against.'
          : `${profile.vocabularySize} signs defined.`}
      </AppText>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    stack: {
      gap: spacing.md,
    },
    stackTight: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    grow: {
      flex: 1,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    metric: {
      gap: spacing.xs,
      paddingBottom: spacing.md,
    },
    metricHead: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: spacing.md,
    },
    workRow: {
      gap: spacing.xs,
      paddingBottom: spacing.md,
    },
    workHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    languageRow: {
      paddingBottom: spacing.md,
    },
    rowDivided: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    note: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      marginTop: spacing.md,
      marginBottom: spacing.xl,
    },
  });
