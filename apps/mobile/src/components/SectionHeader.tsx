import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { useStyles } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { spacing } from '../theme';

export interface SectionHeaderProps {
  label: string;
  /** Right-aligned accessory — usually a badge or a small action. */
  accessory?: React.ReactNode;
  /** Optional second line, for the "why" of a section. */
  detail?: string;
}

/**
 * The small tracked label above a group of content.
 *
 * One component rather than a repeated `<AppText overline>` so the spacing
 * between a label and its content is identical everywhere — that rhythm is
 * most of what separates a designed screen from an assembled one.
 */
export function SectionHeader({
  label,
  accessory,
  detail,
}: SectionHeaderProps): React.JSX.Element {
  const styles = useStyles(makeStyles);

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <AppText variant="overline" color={styles.label.color} overline style={styles.label}>
          {label}
        </AppText>
        {accessory}
      </View>
      {detail !== undefined && (
        <AppText variant="caption" color={styles.detail.color} style={styles.detailText}>
          {detail}
        </AppText>
      )}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    wrap: {
      gap: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    label: {
      color: palette.textMuted,
      flexShrink: 1,
    },
    detail: {
      color: palette.textMuted,
    },
    detailText: {
      color: palette.textMuted,
    },
  });
