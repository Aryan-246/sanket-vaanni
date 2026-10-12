import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from './AppText';
import { Icon } from './Icon';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { motion, radii, spacing } from '../theme';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** Optional line under the title. */
  description?: string;
  children?: React.ReactNode;
  /** Pinned below the scrollable body — usually the primary action. */
  footer?: React.ReactNode;
  /** Set false for a dialog that must be answered, not dismissed. */
  dismissible?: boolean;
}

/**
 * A bottom sheet.
 *
 * Built on `Modal` with `animationType="none"` and animated by hand, because
 * the built-in animations move the *whole* modal contents — scrim included —
 * which reads as the entire screen sliding rather than a panel rising.
 * Animating the two independently is what makes it feel like a sheet.
 *
 * The animation is driven on the native driver, and on close the component
 * waits for the exit animation before unmounting the content, so the sheet
 * never disappears mid-slide.
 */
export function Sheet({
  visible,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
}: SheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);

  // Kept mounted through the exit animation so nothing pops out.
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;

  // Whether the body is taller than the space it was given. Only then do the
  // separators appear — a hairline under a header that has nothing scrolling
  // beneath it is noise.
  const [bodyHeight, setBodyHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const scrollable = contentHeight > bodyHeight + 1;

  /**
   * The tallest the sheet may be.
   *
   * 88% of the screen, but never so tall that it runs under the status bar on a
   * short screen: the sheet is bottom-anchored, so the top is what collides
   * first.
   */
  const maxSheetHeight = useMemo(
    () => Math.min(height * 0.88, height - insets.top - spacing.lg),
    [height, insets.top],
  );

  // A fresh document gets a fresh scroll position, so the next sheet never
  // opens halfway down.
  useEffect(() => {
    setBodyHeight(0);
    setContentHeight(0);
  }, [visible]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: motion.base,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }

    Animated.timing(progress, {
      toValue: 0,
      duration: motion.fast,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, progress]);

  const handleScrimPress = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  if (!mounted) return <></>;

  return (
    <Modal
      visible
      transparent
      // Android back button and the accessibility escape gesture route here.
      onRequestClose={handleScrimPress}
      statusBarTranslucent
      animationType="none"
    >
      <View style={styles.host}>
        <Animated.View style={[styles.scrim, { opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={handleScrimPress}
            accessibilityLabel={dismissible ? 'Close' : undefined}
            accessibilityRole="button"
            disabled={!dismissible}
          />
        </Animated.View>

        <Animated.View
          testID="sheet-panel"
          style={[
            styles.sheet,
            {
              maxHeight: maxSheetHeight,
              paddingBottom: insets.bottom + spacing.lg,
              transform: [
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [Math.min(height * 0.6, 520), 0],
                  }),
                },
              ],
            },
          ]}
        >
          <View style={styles.grabber} />

          <View style={[styles.header, scrollable && styles.headerScrolled]}>
            <View style={styles.headerText}>
              <AppText variant="heading">{title}</AppText>
              {description !== undefined && (
                <AppText variant="caption" color={palette.textSecondary} style={styles.description}>
                  {description}
                </AppText>
              )}
            </View>

            {dismissible && (
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={12}
                style={({ pressed }) => [styles.close, pressed && styles.pressed]}
              >
                <Icon name="close" size={18} color={palette.textSecondary} />
              </Pressable>
            )}
          </View>

          {children !== undefined && (
            // The body is the only part that grows without bound, so it is the
            // only part that scrolls. `flexShrink` lets it give up height to
            // the header and footer, which stay pinned and reachable.
            <ScrollView
              style={styles.bodyScroll}
              contentContainerStyle={styles.body}
              onLayout={(event) => setBodyHeight(event.nativeEvent.layout.height)}
              onContentSizeChange={(_width, contentHeight_) => setContentHeight(contentHeight_)}
              // Keeps taps on controls inside the sheet working while a
              // keyboard is open, instead of being swallowed as a dismiss.
              keyboardShouldPersistTaps="handled"
              // Lets a drag that starts on a nested horizontal chip list still
              // scroll this vertical body on Android.
              nestedScrollEnabled
              overScrollMode="never"
            >
              {children}
            </ScrollView>
          )}
          {footer !== undefined && (
            <View style={[styles.footer, scrollable && styles.footerScrolled]}>{footer}</View>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    host: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    scrim: {
      ...StyleSheet.absoluteFill,
      backgroundColor: palette.scrim,
    },
    sheet: {
      backgroundColor: palette.surfaceRaised,
      borderTopLeftRadius: radii.xl,
      borderTopRightRadius: radii.xl,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      // `maxHeight` is set at render time so it can account for the safe area.
    },
    grabber: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: palette.borderStrong,
      marginBottom: spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      marginBottom: spacing.md,
    },
    // Only when something is scrolling underneath: the hairline tells the user
    // the content continues rather than being cut off.
    headerScrolled: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
      paddingBottom: spacing.md,
    },
    headerText: {
      flex: 1,
      gap: spacing.xs,
    },
    description: {
      marginTop: 2,
    },
    close: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.surfaceSunken,
    },
    pressed: {
      opacity: 0.6,
    },
    bodyScroll: {
      // Shrinks only when the content would otherwise overflow, so a short
      // sheet still hugs its content instead of filling the screen.
      flexShrink: 1,
    },
    body: {
      gap: spacing.xs,
      paddingBottom: spacing.xs,
    },
    footer: {
      marginTop: spacing.lg,
      gap: spacing.sm,
    },
    footerScrolled: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      paddingTop: spacing.md,
    },
  });
