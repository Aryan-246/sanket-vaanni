import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
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
          style={[
            styles.sheet,
            {
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

          <View style={styles.header}>
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

          {children !== undefined && <View style={styles.body}>{children}</View>}
          {footer !== undefined && <View style={styles.footer}>{footer}</View>}
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
      maxHeight: '88%',
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
    body: {
      gap: spacing.xs,
    },
    footer: {
      marginTop: spacing.lg,
      gap: spacing.sm,
    },
  });
