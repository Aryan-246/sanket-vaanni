/**
 * About Us.
 *
 * ## What this screen is for
 *
 * Two questions, answered honestly and in that order: *who is building this*,
 * and *what does this build actually do*. The second matters more than it
 * sounds — a product page that lists capabilities the software does not have is
 * a liability for a tool meant to be relied on in a conversation, so the list
 * below is derived from the app's own state where it can be, and states plainly
 * where it cannot.
 *
 * ## The team section
 *
 * Five members, all unfilled, because no real names, roles, biographies or
 * photographs have been supplied and none may be invented. See
 * `about/team.ts` for why the slots are empty rather than filled with plausible
 * placeholders. The section says so on screen, so a reader is not left wondering
 * whether the app failed to load something.
 */
import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { DetailHeader } from '../components/DetailHeader';
import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { TEAM_MEMBERS, isMemberUnfilled, type TeamMember } from '../about/team';
import { PRODUCT_NAME, PRODUCT_NAME_DEVANAGARI } from '../config/app';
import { useBuildFacts } from '../hooks/useBuildFacts';
import { useAppState, useSpeechState } from '../app/AppState';
import { SIGN_LANGUAGE_PROFILES } from '../recognition/profiles';
import { OUTPUT_LANGUAGES } from '../app/preferences';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { spacing } from '../theme';

export interface AboutScreenProps {
  onClose: () => void;
}

export function AboutScreen({ onClose }: AboutScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { recognitionAvailable, recognitionUnavailableReason } = useAppState();
  const speech = useSpeechState();
  const build = useBuildFacts();

  const unfilledCount = TEAM_MEMBERS.filter(isMemberUnfilled).length;

  return (
    <Screen scroll testID="about-screen">
      <DetailHeader title="About Us" onClose={onClose} subtitle="The team and the product" />

      {/* ------------------------------------------------------------- team */}

      <SectionHeader
        label="Team"
        detail={
          unfilledCount === TEAM_MEMBERS.length
            ? 'Five roles, not yet filled in'
            : `${TEAM_MEMBERS.length - unfilledCount} of ${TEAM_MEMBERS.length} listed`
        }
      />

      <Card style={styles.group}>
        {TEAM_MEMBERS.map((member, index) => (
          <TeamRow key={member.id} member={member} last={index === TEAM_MEMBERS.length - 1} />
        ))}
      </Card>

      {unfilledCount > 0 ? (
        <Card sunken style={styles.note}>
          <Icon name="info" size={14} color={palette.textMuted} />
          <AppText variant="caption" color={palette.textMuted} style={styles.noteText}>
            {unfilledCount === TEAM_MEMBERS.length
              ? 'No team member details have been provided. Names, roles, biographies and photographs are not invented to fill this space — they are added when the people themselves supply them.'
              : 'The remaining slots are unfilled. Their details are not invented to fill the space.'}
          </AppText>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------- product */}

      <SectionHeader label="The product" />
      <Card style={styles.group}>
        <AppText variant="body" color={palette.textSecondary}>
          Sanket Vaanni is an offline-first companion for a pair of sensor gloves. It reads
          finger and wrist measurements from the gloves, draws the hands in real time, and is
          designed to turn Indian Sign Language into written and spoken language.
        </AppText>
        <AppText variant="body" color={palette.textSecondary}>
          It is built to work without a network. Everything a conversation needs runs on the
          phone, and anything that cannot run on this phone says so instead of failing quietly.
        </AppText>
      </Card>

      {/* --------------------------------------------------- what works now */}

      <SectionHeader label="What this build does" detail="Measured, not claimed." />

      <Card style={styles.group}>
        <Capability
          label="Two-glove sensor link"
          detail="Bluetooth transport, with a simulator standing in when no hardware is present."
          working
        />
        <Capability
          label="Live hand viewer"
          detail="3D rig and 2D figure, both driven by the incoming pose."
          working
        />
        <Capability
          label="Screen reader and large text"
          detail="Every control is labelled, and the layout follows the system font scale and reduce-motion setting."
          working
        />
        <Capability
          label="Speech output"
          detail={
            speech.available
              ? 'Speaks through this device’s own text-to-speech engine. No network, no account.'
              : (speech.unavailableReason ?? 'Not available on this device.')
          }
          working={speech.available}
        />
        <Capability
          label="Sign recognition"
          detail={
            recognitionAvailable
              ? 'A recogniser is loaded in this build.'
              : (recognitionUnavailableReason ??
                'No recognition model is loaded, so signs are not read yet.')
          }
          working={recognitionAvailable}
        />
        <Capability
          label="Bluetooth hardware protocol"
          detail="The glove's service identifiers and packet layout are unverified, so a scanned device may not be a Sanket Vaanni glove."
          working={false}
        />
      </Card>

      {/* How many signs are recognised, stated from the profiles themselves
          rather than from a number written into this screen. */}
      <Card style={styles.group}>
        <AppText variant="overline" overline color={palette.textMuted}>
          Sign vocabulary
        </AppText>
        <AppText variant="caption" color={palette.textSecondary}>
          {SIGN_LANGUAGE_PROFILES.every((profile) => profile.vocabularySize === 0)
            ? `None of the ${SIGN_LANGUAGE_PROFILES.length} sign language profiles has any signs defined yet. Defining them is a Deaf-led linguistic task, and no dataset has been produced.`
            : 'Some profiles have signs defined. Their coverage is listed under Models and vocabulary in Settings.'}
        </AppText>
        <AppText variant="caption" color={palette.textMuted}>
          Output languages offered: {OUTPUT_LANGUAGES.map((language) => language.name).join(', ')}.
        </AppText>
      </Card>

      {/* ------------------------------------------------------------ build */}

      <SectionHeader label="Build" />
      <Card style={styles.group}>
        {/*
          Blank for the few frames before the bridge answers, rather than a
          placeholder that is about to be replaced. `build === null` means "not
          read yet"; `fromDevice === false` means "read, and this platform has
          no installed package to report".
        */}
        <Fact
          label="Version"
          value={build === null ? ' ' : build.versionName}
          pending={build === null}
        />
        <Fact
          label="Package"
          value={build === null ? ' ' : build.packageLabel}
          pending={build === null}
        />
        <Fact
          label="Device"
          value={build === null ? ' ' : build.platformLabel}
          pending={build === null}
        />
        <Fact label="Works offline" value="Yes — no feature requires a network connection." last />
      </Card>

      <ActionButton
        label="Email the team"
        tone="ghost"
        icon="link"
        onPress={() => {
          void Linking.openURL('mailto:hello@sanketvaanni.in').catch(() => undefined);
        }}
        accessibilityLabel="Email the team"
        accessibilityHint="Opens your email app with the team's address"
      />

      <AppText variant="caption" color={palette.textMuted} center style={styles.footer}>
        {PRODUCT_NAME} · {PRODUCT_NAME_DEVANAGARI}
      </AppText>
    </Screen>
  );
}

/* --------------------------------------------------------------- sub-parts */

function TeamRow({ member, last }: { member: TeamMember; last: boolean }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const unfilled = isMemberUnfilled(member);

  return (
    <View style={[styles.row, !last && styles.rowDivided]}>
      {/*
        `Avatar` renders initials from the name when there is one and a neutral
        glyph when there is not — it never substitutes a stock portrait. An
        unfilled slot therefore looks like a slot, which is the honest rendering.
      */}
      <Avatar name={member.name} uri={null} size={44} />

      <View style={styles.rowText}>
        <AppText variant="body" color={unfilled ? palette.textMuted : palette.textPrimary}>
          {member.name ?? 'Name to be added'}
        </AppText>
        <AppText variant="caption" color={palette.textMuted}>
          {member.role ?? (unfilled ? 'Role to be added' : 'Role not stated')}
        </AppText>
        {member.bio === null ? null : (
          <AppText variant="caption" color={palette.textSecondary}>
            {member.bio}
          </AppText>
        )}
      </View>
    </View>
  );
}

function Capability({
  label,
  detail,
  working,
}: {
  label: string;
  detail: string;
  working: boolean;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={styles.capability}>
      <Icon
        name={working ? 'check' : 'warning'}
        size={16}
        color={working ? palette.success : palette.warning}
      />
      <View style={styles.rowText}>
        <AppText variant="label">{label}</AppText>
        <AppText variant="caption" color={palette.textMuted}>
          {detail}
        </AppText>
      </View>
    </View>
  );
}

function Fact({
  label,
  value,
  last,
  pending = false,
}: {
  label: string;
  value: string;
  last?: boolean;
  /** Renders a placeholder rather than a value, while the value is unknown. */
  pending?: boolean;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={[styles.fact, last === true && styles.factLast]}>
      <AppText variant="caption" color={palette.textMuted} style={styles.factLabel}>
        {label}
      </AppText>
      {pending ? (
        // A one-space run, not an em dash: a dash is a value, and the point of
        // this state is that there is no value yet.
        <AppText variant="caption" color={palette.textMuted} style={styles.factValue}>
          {' '}
        </AppText>
      ) : (
        <AppText variant="caption" color={palette.textSecondary} style={styles.factValue}>
          {value}
        </AppText>
      )}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    group: {
      gap: spacing.md,
    },
    note: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    noteText: {
      flex: 1,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingBottom: spacing.md,
    },
    rowDivided: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    rowText: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    capability: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    fact: {
      flexDirection: 'row',
      gap: spacing.md,
      alignItems: 'flex-start',
      paddingBottom: spacing.sm,
    },
    factLast: {
      paddingBottom: 0,
    },
    factLabel: {
      // A floor, not a width: aligns the label column, and at large font scales
      // the value column gives up the difference rather than clipping the label.
      minWidth: 110,
    },
    factValue: {
      flex: 1,
    },
    footer: {
      marginTop: spacing.lg,
      marginBottom: spacing.xl,
    },
  });
