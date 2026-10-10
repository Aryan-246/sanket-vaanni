import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { useStyles } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  /** One or two sentences. Say what would fill this space, and how. */
  body?: string;
  /** Optional action, e.g. a button. */
  action?: React.ReactNode;
  /** Compact variant for use inside a panel rather than a whole page. */
  compact?: boolean;
}

/**
 * The "nothing here yet" state.
 *
 * Every list and panel in this app is empty by construction, because no
 * recognition or hardware exists. So this is not an edge case — it is the
 * default rendering of half the product, and it gets a designed treatment
 * rather than a bare dash.
 *
 * The body is required in spirit: an empty state that does not say what would
 * fill it is a dead end.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  compact = false,
}: EmptyStateProps): React.JSX.Element {
  const styles = useStyles(makeStyles);

  return (
    <View style={[styles.wrap, compact && styles.compact]}>
      {icon !== undefined && (
        <View style={styles.iconWell}>
          <Icon name={icon} size={compact ? 20 : 26} color={styles.iconWell.borderColor as string} />
        </View>
      )}
      <AppText
        variant={compact ? 'label' : 'heading'}
        color={styles.title.color}
        center
        style={styles.titleText}
      >
        {title}
      </AppText>
      {body !== undefined && (
        <AppText variant="caption" color={styles.body.color} center style={styles.bodyText}>
          {body}
        </AppText>
      )}
      {action !== undefined && <View style={styles.action}>{action}</View>}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    wrap: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
    },
    compact: {
      paddingVertical: spacing.lg,
    },
    iconWell: {
      width: 52,
      height: 52,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: palette.borderStrong,
      backgroundColor: palette.surfaceSunken,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.xs,
    },
    title: {
      color: palette.textPrimary,
    },
    titleText: {
      color: palette.textPrimary,
    },
    body: {
      color: palette.textMuted,
    },
    bodyText: {
      color: palette.textMuted,
      maxWidth: 320,
    },
    action: {
      marginTop: spacing.sm,
    },
  });
