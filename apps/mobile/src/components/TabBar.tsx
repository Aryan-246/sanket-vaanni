import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, motion, radii, spacing } from '../theme';

export type TabKey = 'dashboard' | 'oled' | 'audit' | 'more';

export interface TabDefinition {
  readonly key: TabKey;
  readonly label: string;
  readonly icon: IconName;
  /** Announced to screen readers when the label alone is ambiguous. */
  readonly hint: string;
}

/**
 * The four destinations.
 *
 * Order is deliberate: Dashboard is the live product, OLED and Audit are the
 * two working surfaces, More is where configuration lives. Putting More last
 * keeps the three things a user actually opens repeatedly on the left, under
 * the thumb.
 */
export const TABS: readonly TabDefinition[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    icon: 'dashboard',
    hint: 'Live glove state, recognition and the hand viewer',
  },
  {
    key: 'oled',
    label: 'OLED',
    icon: 'oled',
    hint: 'Design what the glove display shows',
  },
  {
    key: 'audit',
    label: 'Audit',
    icon: 'audit',
    hint: 'Component health and diagnostics',
  },
  { key: 'more', label: 'More', icon: 'more', hint: 'Settings and preferences' },
];

export interface TabBarProps {
  active: TabKey;
  onSelect: (key: TabKey) => void;
}

/**
 * Bottom navigation.
 *
 * ## Selection state
 *
 * The active tab is signalled three ways — an accent bar above the item, the
 * icon and label switching to the accent colour, and a raised background —
 * because a colour-only difference is easy to miss on a dim screen in
 * daylight, which is where a glove app gets used.
 *
 * The bar is a sibling of the content rather than an overlay, so no screen
 * ever has to reserve space for it or risk a control sliding underneath.
 */
export function TabBar({ active, onSelect }: TabBarProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const styles = useStyles(makeStyles);

  return (
    <View
      style={[styles.bar, { paddingBottom: insets.bottom }]}
      accessibilityRole="tablist"
      accessibilityLabel="Main navigation"
    >
      {TABS.map((tab) => (
        <TabItem
          key={tab.key}
          tab={tab}
          selected={tab.key === active}
          onPress={() => onSelect(tab.key)}
        />
      ))}
    </View>
  );
}

function TabItem({
  tab,
  selected,
  onPress,
}: {
  tab: TabDefinition;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);
  const progress = useRef(new Animated.Value(selected ? 1 : 0)).current;

  useEffect(() => {
    // Driven from the prop rather than from the press, so a programmatic
    // change (returning to Dashboard from a deep link, or a reset) animates
    // identically to a tap.
    Animated.timing(progress, {
      toValue: selected ? 1 : 0,
      duration: motion.fast,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [selected, progress]);

  const colour = selected ? palette.accent : palette.textMuted;

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={tab.label}
      accessibilityHint={tab.hint}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={styles.item}
    >
      {/* Indicator, scaleX from the centre so it grows outwards symmetrically. */}
      <Animated.View
        style={[
          styles.indicator,
          { backgroundColor: palette.accent, transform: [{ scaleX: progress }] },
        ]}
      />

      <Animated.View
        style={[
          styles.itemInner,
          {
            opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
          },
        ]}
      >
        <Icon name={tab.icon} size={21} color={colour} />
        <AppText variant="caption" color={colour} numberOfLines={1}>
          {tab.label}
        </AppText>
      </Animated.View>
    </Pressable>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      backgroundColor: palette.surfaceRaised,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    item: {
      flex: 1,
      // The bar's own height plus the safe inset, which is applied on the bar.
      height: layout.tabBarHeight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    indicator: {
      position: 'absolute',
      top: 0,
      width: 32,
      height: 2.5,
      borderBottomLeftRadius: radii.pill,
      borderBottomRightRadius: radii.pill,
    },
    itemInner: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      paddingTop: spacing.xs,
    },
  });
