import React from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useStyles } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, spacing } from '../theme';

/**
 * Identifies the status-bar scrim, so a test can assert it is both present and
 * non-interactive — a scrim that swallowed touches would disable the top row of
 * every screen.
 */
export const STATUS_BAR_SCRIM_TEST_ID = 'status-bar-scrim';

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
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
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

      {/*
        An opaque strip behind the status bar, drawn over the scrolling content.

        Android draws this app edge to edge, so the window extends behind the
        system bar and the status bar sits on top of whatever is beneath it. The
        top inset is applied as *content padding*, which places the first row
        correctly at rest — but padding cannot stop content that is scrolled: it
        simply slides up underneath. Measured on the target device, two chips had
        reached y 11–50 inside a status-bar band of 0–88, so "VOICE" and
        "UNAVAILABLE" were drawn through the clock and the signal icons.

        A scrim rather than a solid header, because the screens are lists and a
        header would have to be maintained by each of them. `pointerEvents` is
        what makes this safe: without it the strip would swallow every touch in
        the top 88 px of the window, including the first row of every screen.
      */}
      {insets.top > 0 && (
        <View
          pointerEvents="none"
          style={[styles.statusBarScrim, { height: insets.top }]}
          testID={STATUS_BAR_SCRIM_TEST_ID}
        />
      )}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: palette.background,
    },
    scroll: {
      flex: 1,
    },
    statusBarScrim: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
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
