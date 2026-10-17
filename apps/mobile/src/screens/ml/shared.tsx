/**
 * The parts every learning-centre area draws the same way.
 *
 * ## Why these are here rather than copied into five files
 *
 * A note, a metric and a progress meter appear in every area. Three copies of
 * each would drift, and the rhythm that makes five areas read as one screen is
 * exactly the spacing between a label and its value. One definition, one rhythm.
 *
 * ## The meter only draws measured progress
 *
 * `Meter` takes a fraction that a caller has computed from something real — an
 * epoch count, elapsed milliseconds against a window length. There is no
 * "indeterminate" mode and no idle animation, because a bar that moves while
 * nothing is happening is the most convincing way to fake work. Where a figure
 * is not known, the caller passes `null` and the meter says so in words rather
 * than drawing an empty bar, which would read as "0% done".
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Card } from '../../components/Card';
import { Icon, type IconName } from '../../components/Icon';
import { SectionHeader } from '../../components/SectionHeader';
import type { CapabilityState } from '../../ml';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import type { Palette } from '../../theme/palette';
import { radii, spacing } from '../../theme';

/* ------------------------------------------------------------------- notes */

export type NoteTone = 'muted' | 'warning' | 'success';

/**
 * A sentence the screen wants the reader to actually take in.
 *
 * Not a toast and not an error banner: this is the standing explanation that
 * belongs beside a control — why a figure is absent, what a score does not
 * mean, whose decision an obstacle is.
 */
export function NoteCard({
  children,
  tone = 'muted',
  icon,
  testID,
}: {
  children: React.ReactNode;
  tone?: NoteTone;
  icon?: IconName;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const colour: Record<NoteTone, string> = {
    muted: palette.textMuted,
    warning: palette.warning,
    success: palette.success,
  };
  const glyph: IconName = icon ?? (tone === 'warning' ? 'warning' : 'info');

  return (
    <Card sunken style={styles.note} testID={testID}>
      <Icon name={glyph} size={14} color={colour[tone]} />
      <View style={styles.noteBody}>
        <AppText variant="caption" color={colour[tone]}>
          {children}
        </AppText>
      </View>
    </Card>
  );
}

/* ----------------------------------------------------------------- metrics */

/** A single counted figure with the sentence that explains it. */
export function Metric({
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
    <View style={[styles.metric, !last && styles.divided]}>
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

/**
 * A labelled bar for progress that has actually been measured.
 *
 * `value` is `0..1`, or `null` when the figure is not known — in which case the
 * bar is replaced by the sentence `unknown`, because an empty bar and a bar at
 * zero are indistinguishable on screen and mean different things.
 */
export function Meter({
  value,
  label,
  unknown,
  testID,
}: {
  value: number | null;
  label: string;
  unknown: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  if (value === null) {
    return (
      <AppText variant="caption" color={palette.textMuted} testID={testID}>
        {unknown}
      </AppText>
    );
  }

  const clamped = Math.max(0, Math.min(1, value));
  return (
    <View style={styles.meter} testID={testID}>
      <View style={styles.meterRow}>
        <AppText variant="caption" color={palette.textMuted} style={styles.grow}>
          {label}
        </AppText>
        <AppText variant="caption" color={palette.textSecondary}>
          {`${Math.round(clamped * 100)}%`}
        </AppText>
      </View>
      <View
        style={[styles.track, { backgroundColor: palette.surfaceSunken }]}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
        accessibilityLabel={label}
      >
        <View
          style={[styles.fill, { backgroundColor: palette.accent, width: `${clamped * 100}%` }]}
        />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ badges */

const CAPABILITY_TONE: Record<CapabilityState, BadgeTone> = {
  working: 'success',
  blocked: 'warning',
  'not-built': 'neutral',
};

/** How a capability's state reads. Never a bare colour — always these words. */
export const CAPABILITY_LABEL: Record<CapabilityState, string> = {
  working: 'Working',
  blocked: 'Blocked',
  'not-built': 'Not built',
};

export function CapabilityBadge({ state }: { state: CapabilityState }): React.JSX.Element {
  return <Badge label={CAPABILITY_LABEL[state]} tone={CAPABILITY_TONE[state]} />;
}

/* --------------------------------------------------------------- structure */

/**
 * A heading with a supporting clause, above a card of rows.
 *
 * `SectionHeader` already exists; this pairs it with the gap beneath it so that
 * five areas cannot disagree about the rhythm.
 */
export function Section({
  label,
  detail,
  accessory,
  children,
}: {
  label: string;
  detail?: string;
  accessory?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.group}>
      <SectionHeader label={label} detail={detail} accessory={accessory} />
      {children}
    </View>
  );
}

/** A row inside a card, with the hairline between rows but never after the last. */
export function Row({
  children,
  last = false,
  style,
}: {
  children: React.ReactNode;
  last?: boolean;
  style?: object;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return <View style={[styles.row, !last && styles.divided, style]}>{children}</View>;
}

export const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    note: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    noteBody: {
      flex: 1,
      minWidth: 0,
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
    row: {
      gap: spacing.xs,
      paddingBottom: spacing.md,
    },
    divided: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    grow: {
      flex: 1,
    },
    meter: {
      gap: spacing.xs,
      marginTop: spacing.xs,
    },
    meterRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: spacing.sm,
    },
    track: {
      height: 6,
      borderRadius: radii.pill,
      overflow: 'hidden',
    },
    fill: {
      height: '100%',
      borderRadius: radii.pill,
    },
    group: {
      gap: spacing.sm,
    },
  });
