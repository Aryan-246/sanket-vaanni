import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { useStyles } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { letterSpacing, spacing } from '../theme';

export interface ScreenHeaderProps {
  title: string;
  /** One line under the title. Keep it to a single sentence. */
  subtitle?: string;
  /** Right-aligned accessory — an action button or a status chip. */
  accessory?: React.ReactNode;
}

/**
 * The page title block.
 *
 * Deliberately not a navigation bar: there is no back affordance at the root
 * of a tab, and a bar with nothing in it is wasted vertical space. The title
 * is large because it is the only thing establishing which destination the
 * user is on, alongside the tab bar.
 */
export function ScreenHeader({
  title,
  subtitle,
  accessory,
}: ScreenHeaderProps): React.JSX.Element {
  const styles = useStyles(makeStyles);

  return (
    <View style={styles.header}>
      <View style={styles.row}>
        <AppText variant="title" style={styles.title} numberOfLines={1}>
          {title}
        </AppText>
        {accessory}
      </View>
      {subtitle !== undefined && (
        <AppText variant="caption" color={styles.subtitle.color} style={styles.subtitleText}>
          {subtitle}
        </AppText>
      )}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    header: {
      gap: spacing.xs,
      marginBottom: spacing.lg,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    title: {
      letterSpacing: letterSpacing.tight,
      flexShrink: 1,
    },
    subtitle: {
      color: palette.textSecondary,
    },
    subtitleText: {
      color: palette.textSecondary,
    },
  });
