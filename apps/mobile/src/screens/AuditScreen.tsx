import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { ScreenHeader } from '../components/ScreenHeader';
import { SectionHeader } from '../components/SectionHeader';
import { StateChip } from '../components/StateChip';
import { useAppState, useGlove, useLiveTranslation } from '../app/AppState';
import { findOutputLanguage } from '../app/preferences';
import {
  appFindings,
  describeSummary,
  gloveFindings,
  summarise,
  worstOf,
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
 * ## Why there is no single "all good" badge
 *
 * The brief rules it out: "Never display a single generic green Connected badge
 * as proof that every component is working." The summary at the top therefore
 * gives counts and names the worst state rather than pronouncing a verdict, and
 * the only case where a plain positive is shown is when *every* row is healthy —
 * which cannot happen on this build, because the components the firmware has not
 * reported on are permanently `unknown`.
 *
 * ## Refresh
 *
 * Refresh re-reads each glove's transport state. It deliberately does **not**
 * attempt a connection: `retry()` on a glove that is already reachable would
 * open a link the user did not ask for, which is not what a refresh button
 * means. Only gloves whose transport is `unavailable` are re-checked, because
 * for those `retry()` is exactly a re-read.
 */
export function AuditScreen(): React.JSX.Element {
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

  const gloveFindingsFor = useCallback(
    (side: GloveSide) =>
      gloveFindings({
        snapshot: side === 'left' ? left : right,
        calibration: calibration[side],
        nowMs: measuredAtMs,
      }),
    [calibration, left, measuredAtMs, right],
  );

  const findingsBySide = useMemo(
    () => ({ left: gloveFindingsFor('left'), right: gloveFindingsFor('right') }),
    [gloveFindingsFor],
  );

  const targetLanguage = findOutputLanguage(preferences.targetLanguageCode);
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
        targetLanguageSpeechWired: targetLanguage?.speechWired ?? false,
      }),
    [outcome, preferences, profile, speaker, targetLanguage, translator],
  );

  const everything = useMemo(
    () => [...findingsBySide.left, ...findingsBySide.right, ...app],
    [app, findingsBySide],
  );
  const summary = useMemo(() => summarise(everything), [everything]);
  const verdict = worstOf(everything);

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
      <ScreenHeader
        title="Audit"
        subtitle="What each part reports, and what nothing has reported"
        accessory={<StateChip state={verdict} />}
      />

      {/* ------------------------------------------------------------ summary */}

      <Card style={styles.summary} accentBorder={verdict !== 'healthy' && verdict !== 'unknown'}>
        <View style={styles.summaryRow}>
          <StateChip state={verdict} />
          <AppText variant="caption" color={palette.textMuted}>
            worst of {summary.total}
          </AppText>
        </View>

        <AppText variant="body" color={palette.textSecondary}>
          {describeSummary(summary)}.
        </AppText>

        <AppText variant="caption" color={palette.textMuted}>
          {HEALTH_MEANING[verdict]}
          {summary.counts.unknown > 0
            ? ' An unknown row is not a fault: it is a component nothing has reported on yet.'
            : ''}
        </AppText>

        <AppText variant="caption" color={palette.textMuted}>
          Readings as of {new Date(measuredAtMs).toLocaleTimeString()}. Refreshing re-reads each
          glove's transport state and does not attempt a connection.
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
          accessibilityHint="Re-reads each glove's transport state. Does not attempt to connect."
        />
      </Card>

      {/* ------------------------------------------------------------- gloves */}

      {SIDES.map((side) => {
        const findings = findingsBySide[side];
        const worst = worstOf(findings);
        return (
          <View key={side} style={styles.section}>
            <SectionHeader
              label={side === 'left' ? 'Left glove' : 'Right glove'}
              accessory={<StateChip state={worst} />}
              detail="Every row states where its answer came from."
            />
            <Card style={styles.group}>
              {findings.map((finding, index) => (
                <FindingRow
                  key={finding.key}
                  finding={finding}
                  last={index === findings.length - 1}
                />
              ))}
            </Card>
          </View>
        );
      })}

      {/* ---------------------------------------------------------------- app */}

      <SectionHeader label="App" detail="Independent of which gloves are connected." />
      <Card style={styles.group}>
        {app.map((finding, index) => (
          <FindingRow key={finding.key} finding={finding} last={index === app.length - 1} />
        ))}
      </Card>

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
 * One finding.
 *
 * The badge order is deliberate: the state word first, then provenance. Health
 * and source are orthogonal — simulated data can be perfectly healthy, real data
 * can be broken — so they are shown as two facts rather than merged into one.
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

      <AppText variant="caption" color={palette.textSecondary}>
        {finding.detail}
      </AppText>

      {finding.source !== undefined && (
        <Badge
          label={DATA_SOURCE_LABEL[finding.source]}
          tone={finding.source === 'simulated' ? 'demo' : 'neutral'}
        />
      )}
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
    section: {
      gap: spacing.sm,
    },
    group: {
      gap: 0,
      paddingVertical: 0,
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
