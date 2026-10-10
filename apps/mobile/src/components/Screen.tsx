import React from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useStyles } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, spacing } from '../theme';

export interface ScreenProps {
  children: React.ReactNode;
  /** Wrap the content in a ScrollView. Default true. */
  scroll?: boolean;
  /**
   * Extra bottom padding. Tab screens pass the tab bar height so the last row
   * is never trapped under it.
   */
  bottomInset?: number;
  /** Centre the content and cap its width; for tablet layouts. */
  constrain?: boolean;
  contentContainerStyle?: ViewStyle | ViewStyle[];
  testID?: string;
}

/**
 * Screen shell.
 *
 * Applies the palette background and the top safe-area inset once, so no
 * individual screen has to remember either. The horizontal padding is uniform
 * across every destination, which is most of what makes four screens look like
 * one product.
 *
 * `constrain` caps the content width and centres it. On a 1080dp-wide tablet a
 * full-bleed card grid reads as a stretched phone layout; capping it keeps the
 * type measure sane.
 */
export function Screen({
  children,
  scroll = true,
  bottomInset = 0,
  constrain = false,
  contentContainerStyle,
  testID,
}: ScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const styles = useStyles(makeStyles);

  const padding = {
    paddingTop: insets.top + spacing.md,
    paddingBottom: insets.bottom + bottomInset + spacing.xxl,
  };

  if (!scroll) {
    return (
      <View style={[styles.root, padding, contentContainerStyle]} testID={testID}>
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        padding,
        constrain && styles.constrained,
        contentContainerStyle,
      ]}
      showsVerticalScrollIndicator={false}
      // Lets a tap dismiss the keyboard without stealing the first tap on a
      // control — `on-drag` rather than `handled`.
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: palette.background,
    },
    content: {
      paddingHorizontal: layout.screenPadding,
    },
    constrained: {
      alignSelf: 'center',
      width: '100%',
      maxWidth: layout.maxContentWidth,
    },
  });
