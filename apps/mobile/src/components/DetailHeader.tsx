/**
 * The header for a pushed screen.
 *
 * A back control on the left, a title beside it, and optional trailing content.
 * Distinct from `BrandHeader`, which carries identity: this one carries a way
 * out, because a screen reached from a tab needs one on screen as well as on the
 * system back gesture.
 *
 * The back control is a 48pt target even though the glyph is small — the reason
 * it sits inside a `Pressable` with a `hitSlop` rather than being the glyph
 * itself.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { IconButton } from './IconButton';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, spacing } from '../theme';

export interface DetailHeaderProps {
  title: string;
  onClose: () => void;
  /** One line under the title. Omit when the screen is self-evident. */
  subtitle?: string;
  /** Trailing control, placed at the right edge. */
  right?: React.ReactNode;
  /** Label for the back control, for screen readers. */
  backLabel?: string;
}

export function DetailHeader({
  title,
  onClose,
  subtitle,
  right,
  backLabel,
}: DetailHeaderProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={styles.root}>
      {/*
        The chevron is rotated rather than being a second icon asset, so there is
        one arrow shape in the app. The rotation is applied to a wrapper because
        `IconButton` owns its own styling and takes no `style` prop.
      */}
      <View style={styles.back}>
        <IconButton
          icon="chevronRight"
          onPress={onClose}
          accessibilityLabel={backLabel ?? `Back from ${title}`}
          accessibilityHint="Returns to the previous screen"
        />
      </View>

      <View style={styles.text}>
        <AppText variant="title" numberOfLines={1} accessibilityRole="header">
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color={palette.textMuted} numberOfLines={2}>
            {subtitle}
          </AppText>
        ) : null}
      </View>

      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const makeStyles = (_palette: Palette) =>
  StyleSheet.create({
    root: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: layout.screenPadding - spacing.sm,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
      maxWidth: layout.maxContentWidth,
    },
    back: {
      // Rotated so the single chevron asset serves both directions.
      transform: [{ rotate: '180deg' }],
    },
    text: {
      flex: 1,
      minWidth: 0,
      gap: 1,
    },
    right: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
  });
