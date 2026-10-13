import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { Icon } from '../components/Icon';
import { DetailHeader } from '../components/DetailHeader';
import { Screen } from '../components/Screen';
import { StateChip } from '../components/StateChip';
import { useAppState, useGlove, useLiveTranslation } from '../app/AppState';
import { findOutputLanguage } from '../app/preferences';
import { DeviceSpeaker } from '../speech/nativeSpeaker';
import {
  appFindings,
  describeSummary,
  gloveFindings,
  groupFindings,
  opensByDefault,
  summarise,
  worstOf,
  type AuditGroup,
  type Finding,
} from '../audit/findings';
import { DATA_SOURCE_LABEL, HEALTH_MEANING } from '../audit/status';
import { layout as screenLayout, radii, spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import type { GloveSide } from '../ble/types';

const SIDES: readonly GloveSide[] = ['left', 'right'];

/**
 * Audit — what is actually known, and what is not.
 *
 * ## The design problem
 *
 * Almost everything this screen can report is either `unknown` or `unavailable`,
 * because the firmware reports nothing and no model exists. A screen that
 * rendered that as a wall of grey would be useless, and one that rendered it as
 * green ticks would be a lie. So the screen is built around a single question:
 * *what is the evidence for this row?* Every row carries a sentence saying where
 * its state came from, and the row that has no evidence says so.
 *
 * That produced a second problem: seventeen rows, each with a paragraph, is a
 * page of prose nobody reads. The rows are therefore folded into the nine
 * diagnostic areas the brief names, and only the headline and the area headings
 * are visible until a heading is tapped.
 *
 * ## Why the groups are drawn rather than the flat list
 *
 * The rows were previously split by *subject* — one block per glove, one for the
 * app — which meant a reader investigating the IMU had to read the left glove's
 * link, packets, controller and flex rows to reach it, and then do it again on
 * the right. Grouping by component puts the two hands' IMU rows together, which
 * is the comparison a fault actually calls for.
 *
 * ## Why there is no single "all good" badge
 *
 * The brief rules it out: "Never display a single generic green Connected badge
 * as proof that every component is working." The summary at the top therefore
 * gives counts, names the worst state, and names the groups that need attention
 * rather than pronouncing a verdict. The only case where a plain positive is
 * shown is when *every* row is healthy — which cannot happen on this build,
 * because the components the firmware has not reported on are permanently
 * `unknown`.
 *
 * ## Refresh
 *
 * Refresh re-reads each glove's transport state. It deliberately does **not**
 * attempt a connection: `retry()` on a glove that is already reachable would
 * open a link the user did not ask for, which is not what a refresh button
 * means. Only gloves whose transport is `unavailable` are re-checked, because
 * for those `retry()` is exactly a re-read. It issues no command to any device
 * and starts no scan.
 */
export function AuditScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { controllers, profile, calibration, speaker, translator, preferences } = useAppState();

  const left = useGlove('left');
  const right = useGlove('right');
  // One outcome for the conversation, not one per glove — matching the
  // Dashboard, which shows exactly this value.
  const { outcome } = useLiveTranslation();

  /**
   * When the readings on screen were last looked at.
   *
   * Started at mount and moved only by an explicit refresh. It is not a ticking
   * clock: a self-updating "3 s ago" would need its own interval on a screen
   * whose whole point is to avoid gratuitous background work, and the numbers
   * refresh when their data does, which is when they are worth re-reading.
   */
  const [measuredAtMs, setMeasuredAtMs] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);

  const findingsBySide = useMemo(
    () => ({
      left: gloveFindings({ snapshot: left, calibration: calibration.left, nowMs: measuredAtMs }),
      right: gloveFindings({ snapshot: right, calibration: calibration.right, nowMs: measuredAtMs }),
    }),
    [calibration, left, measuredAtMs, right],
  );

  const targetLanguage = findOutputLanguage(preferences.targetLanguageCode);
  const speechTag = targetLanguage?.speechTag ?? 'en-IN';

  /**
   * Whether this device actually has a voice for the configured language.
   *
   * Asked of the speech engine rather than asserted by the app, because it is a
   * fact about the phone's installed voice data and not about this build. The
   * result is `null` until the engine answers, which the findings render as
   * `unknown` rather than as a failure.
   */
  const [voiceInstalled, setVoiceInstalled] = useState<{
    installed: boolean | null;
    reason: string | null;
  }>({ installed: null, reason: null });
  const [voiceCheckedFor, setVoiceCheckedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!(speaker instanceof DeviceSpeaker)) return;
    if (voiceCheckedFor === speechTag) return;

    let cancelled = false;
    const speakerForCheck = speaker;

    void speakerForCheck
      .checkLanguage(speechTag)
      .then((result) => {
        if (cancelled) return;
        setVoiceInstalled({ installed: result.available, reason: result.reason ?? null });
        setVoiceCheckedFor(speechTag);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setVoiceInstalled({
          installed: false,
          reason: error instanceof Error ? error.message : 'The language check failed.',
        });
        setVoiceCheckedFor(speechTag);
      });

    return () => {
      cancelled = true;
    };
  }, [speaker, speechTag, voiceCheckedFor]);

  const app = useMemo(
    () =>
      appFindings({
        profile,
        preferences,
        translator,
        speaker,
        recognition: outcome,
        targetLanguageName:
          targetLanguage?.name ?? preferences.targetLanguageCode.toUpperCase(),
        targetLanguageSpeechTag: speechTag,
        targetLanguageVoiceInstalled: voiceInstalled.installed,
        targetLanguageVoiceReason: voiceInstalled.reason,
      }),
    [
      outcome,
      preferences,
      profile,
      speaker,
      speechTag,
      targetLanguage,
      translator,
      voiceInstalled.installed,
      voiceInstalled.reason,
    ],
  );

  const everything = useMemo(
    () => [...findingsBySide.left, ...findingsBySide.right, ...app],
    [app, findingsBySide],
  );
  const summary = useMemo(() => summarise(everything), [everything]);
  const verdict = worstOf(everything);
  const groups = useMemo(() => groupFindings(everything), [everything]);

  /** The groups that contain something actually wrong, named in the summary. */
  const attention = useMemo(() => groups.filter(opensByDefault), [groups]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      /*
       * Only transports that cannot operate are re-read. For an `unavailable`
       * link the controller re-reads its transport and dispatches nothing else,
       * so this cannot turn into an unrequested connection — whereas calling it
       * on a reachable glove would scan and connect.
       */
      for (const side of SIDES) {
        if (controllers[side].getSnapshot().link.kind === 'unavailable') {
          await controllers[side].retry();
        }
      }
    } finally {
      setMeasuredAtMs(Date.now());
      setRefreshing(false);
    }
  }, [controllers]);

  return (
    <Screen scroll bottomInset={screenLayout.tabBarHeight} testID="audit-screen">
      {/*
        No verdict chip in the header. It was here *and* at the top of the summary
        card forty points below, so the same word appeared twice before the reader
        had seen a single row. The summary card is where it belongs: that is where
        "worst of N" gives it a meaning.
      */}
      <DetailHeader
        title="Audit"
        onClose={onClose}
        subtitle="What each part reports, and what nothing has reported"
      />

      {/* ------------------------------------------------------------ summary */}

      <Card style={styles.summary} accentBorder={attention.length > 0}>
        <View style={styles.summaryRow}>
          <StateChip state={verdict} />
          <AppText variant="caption" color={palette.textMuted}>
            worst of {summary.total}
          </AppText>
        </View>

        <AppText variant="body" color={palette.textSecondary}>
          {describeSummary(summary)}.
        </AppText>

        {/*
          What the worst state means here. Kept because the whole point of this
          vocabulary is that `unknown` and `unavailable` are not faults, and a
          reader who assumes otherwise will read the counts above as bad news.
        */}
        <AppText variant="caption" color={palette.textMuted}>
          {HEALTH_MEANING[verdict]}
        </AppText>

        {/*
          The one line that answers "is anything wrong". Naming the groups is
          what makes it actionable — the counts say how many rows are which, but
          not which part to look at.
        */}
        <AppText variant="caption" color={palette.textMuted}>
          {attention.length === 0
            ? 'No group reports a fault. Rows that are unknown or unavailable are not broken — nothing has reported one way or the other.'
            : `Needs attention: ${attention.map((group) => group.label).join(', ')}.`}
        </AppText>

        <AppText variant="caption" color={palette.textMuted}>
          Readings as of {new Date(measuredAtMs).toLocaleTimeString()}. Refresh re-reads transport
          state only — it does not scan or connect.
        </AppText>

        <ActionButton
          label={refreshing ? 'Refreshing' : 'Refresh diagnostics'}
          tone="secondary"
          icon="refresh"
          busy={refreshing}
          onPress={() => {
            void refresh();
          }}
          accessibilityLabel="Refresh diagnostics"
          accessibilityHint="Re-reads each glove's transport state. Does not connect or scan."
        />
      </Card>

      {/* ------------------------------------------------------------- groups */}

      {groups.map((group) => (
        <FindingsGroup key={group.key} group={group} />
      ))}

      <Card sunken style={styles.note}>
        <Icon name="info" size={14} color={palette.textMuted} />
        <AppText variant="caption" color={palette.textMuted} style={styles.noteText}>
          Nothing on this screen is a measurement taken by this app. Rows marked Simulated are
          produced by the built-in demo transport, which is clearly labelled wherever its
          readings appear. Rows marked No data have nothing behind them at all, which is a
          different thing from a value of zero.
        </AppText>
      </Card>
    </Screen>
  );
}

/* --------------------------------------------------------------- sub-parts */

/**
 * One diagnostic area, folded away behind its heading.
 *
 * The heading carries the group's worst state so the collapsed screen still says
 * where to look, and the blurb says what the group covers so a reader who does
 * not know what an ADS1115 is can tell whether it is worth opening.
 */
function FindingsGroup({ group }: { group: AuditGroup }): React.JSX.Element {
  return (
    <CollapsibleSection
      label={group.label}
      // The row count belongs on the collapsed view: without it, the only way to
      // find out whether a group has one row or six is to open it.
      detail={`${group.blurb} ${group.findings.length} ${
        group.findings.length === 1 ? 'row' : 'rows'
      }.`}
      accessory={<StateChip state={group.worst} />}
      defaultOpen={opensByDefault(group)}
    >
      {group.findings.map((finding, index) => (
        <FindingRow
          key={finding.key}
          finding={finding}
          last={index === group.findings.length - 1}
        />
      ))}
    </CollapsibleSection>
  );
}

/**
 * One finding.
 *
 * The row's facts are shown in the order a reader needs them: which part and
 * which hand, then the state, then the evidence for it, then where the reading
 * came from. Hand and provenance are chips rather than words because both are
 * classifications — and because, now that a group holds both hands' rows, "which
 * hand" is no longer answered by the surrounding heading.
 */
function FindingRow({ finding, last }: { finding: Finding; last: boolean }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={[styles.row, !last && styles.divider]}>
      <View style={styles.rowHead}>
        <AppText variant="body" style={styles.rowLabel}>
          {finding.label}
        </AppText>
        <StateChip state={finding.state} />
      </View>

      <View style={styles.chips}>
        {finding.side !== undefined && (
          <Badge label={finding.side === 'left' ? 'Left' : 'Right'} tone="neutral" />
        )}
        {finding.source !== undefined && (
          <Badge
            label={DATA_SOURCE_LABEL[finding.source]}
            tone={finding.source === 'simulated' ? 'demo' : 'neutral'}
          />
        )}
      </View>

      <AppText variant="caption" color={palette.textSecondary}>
        {finding.detail}
      </AppText>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    summary: {
      gap: spacing.md,
    },
    summaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    row: {
      paddingVertical: spacing.md,
      gap: spacing.sm,
    },
    divider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    rowHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    rowLabel: {
      flex: 1,
    },
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    note: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      borderRadius: radii.md,
    },
    noteText: {
      flex: 1,
    },
  });
