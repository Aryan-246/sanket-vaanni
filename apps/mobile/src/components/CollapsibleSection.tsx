import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Card } from './Card';
import { Icon } from './Icon';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { MIN_TOUCH_TARGET, iconSize, spacing } from '../theme';

export interface CollapsibleSectionProps {
  /** The accessibility name of the toggle, and the section's heading. */
  label: string;
  /** One line saying what the section covers. Shown whether open or closed. */
  detail?: string;
  /** Right-aligned accessory on the header — usually a state chip. */
  accessory?: React.ReactNode;
  /**
   * Whether the section opens itself when the user has not said otherwise.
   *
   * Not merely the initial state: a section whose `defaultOpen` turns true later
   * — because a refresh found a fault — opens then, which is the only way a
   * problem discovered by a refresh is not hidden behind a tap the user has no
   * reason to make.
   */
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * A section whose body can be folded away behind its heading.
 *
 * ## Why the open state is an override rather than a boolean
 *
 * Holding a plain `open` boolean seeded from `defaultOpen` would mean the prop
 * applied once, at mount, and never again. That reads as a trap: a section that
 * is closed when the screen loads, and whose contents later become faulty, would
 * stay shut. Storing `null | true | false` — "user has not chosen", "user opened
 * it", "user closed it" — lets the prop keep working until the user disagrees
 * with it, at which point the user wins and nothing moves under their finger.
 *
 * The whole header is the control, so the target is comfortably above the
 * minimum touch size rather than a chevron a few points wide.
 */
export function CollapsibleSection({
  label,
  detail,
  accessory,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? defaultOpen;

  return (
    <Card style={styles.card}>
      <Pressable
        onPress={() => setOverride(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        accessibilityHint={open ? 'Hides these rows.' : 'Shows these rows.'}
        style={styles.header}
      >
        <Icon
          name={open ? 'chevronDown' : 'chevronRight'}
          size={iconSize.sm}
          color={palette.textMuted}
        />
        <View style={styles.headerText}>
          <AppText variant="label">{label}</AppText>
          {detail !== undefined && (
            <AppText variant="caption" color={palette.textMuted}>
              {detail}
            </AppText>
          )}
        </View>
        {accessory}
      </Pressable>

      {open && <View style={styles.body}>{children}</View>}
    </Card>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      // The card supplies no padding of its own: the header and the body each set
      // their own gutter, so the rows can carry a divider inset to the same edge
      // as the text rather than running border to border.
      paddingHorizontal: 0,
      paddingVertical: 0,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: MIN_TOUCH_TARGET,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
    },
    headerText: {
      flex: 1,
      gap: 2,
    },
    body: {
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
  });
