/**
 * The user's avatar.
 *
 * ## What it will not do
 *
 * It never invents a photograph. There is no stock portrait, no generated
 * face, no default silhouette standing in for a real person. The three states
 * are exactly the three things that can actually be true:
 *
 *  1. The account has a photo in the private `user-media` bucket → show it.
 *  2. The account has a name → show initials derived from that name.
 *  3. Neither → show a neutral `user` glyph.
 *
 * ## Why initials rather than a coloured blob
 *
 * Initials come from the user's own name, so they are information rather than
 * decoration. The tint is a pure function of that name, so a given account
 * always gets the same colour across the app and across launches — which is
 * what makes it read as an identity marker instead of noise.
 */
import React, { useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { Icon } from './Icon';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { MIN_TOUCH_TARGET } from '../theme';

/** The three greens plus two supporting hues, so adjacent avatars differ. */
const TINTS = ['accent', 'success', 'demo', 'warning', 'danger'] as const;

/**
 * Turns a display name into one or two initials.
 *
 * Splits on whitespace and takes the first letter of the first and last word,
 * which handles "Meera Krishnan Nair" → "MN" without needing to know which
 * part is a surname. Returns null when there is nothing usable, so the caller
 * can fall through to the glyph rather than rendering an empty circle.
 */
export function initialsFrom(name: string | null | undefined): string | null {
  if (!name) return null;
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length === 0) return null;

  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : null;
  const initials = (first + (last ?? '')).toLocaleUpperCase();
  return initials.length > 0 ? initials : null;
}

/**
 * Picks a stable tint for a name.
 *
 * A simple character-sum rather than a hash library: the only requirement is
 * that it is deterministic and spreads names across the five tints, and this
 * does both without a dependency.
 */
function tintFor(name: string | null | undefined): (typeof TINTS)[number] {
  if (!name) return 'accent';
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) sum = (sum + name.charCodeAt(i)) % 9973;
  return TINTS[sum % TINTS.length];
}

export interface AvatarProps {
  /** Display name used for initials and the accessibility label. */
  name?: string | null;
  /** Photo URL, if the account has one. */
  uri?: string | null;
  /** Diameter in points. Defaults to 40, which clears the 48pt target with padding. */
  size?: number;
  onPress?: () => void;
  /** Overrides the generated label, e.g. to say "Open account settings". */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function Avatar({
  name,
  uri,
  size = 40,
  onPress,
  accessibilityLabel,
  style,
}: AvatarProps): React.JSX.Element {
  const palette = useTheme().palette;
  const styles = useStyles(makeStyles);
  const initials = useMemo(() => initialsFrom(name), [name]);
  const tint = tintFor(name);

  const label =
    accessibilityLabel ?? (name ? `${name}, account menu` : 'Account menu');

  const inner = (
    <View
      style={[
        styles.root,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: palette[tint + 'Surface' as keyof Palette] as string,
          borderColor: palette[tint as keyof Palette] as string,
        },
      ]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          // Decorative: the label is on the wrapper, and reading the file name
          // aloud adds nothing.
          accessible={false}
        />
      ) : initials ? (
        <Text
          style={[
            styles.initials,
            {
              fontSize: Math.round(size * 0.38),
              color: palette[tint as keyof Palette] as string,
            },
          ]}
          // The parent carries the label; a nested accessible Text would make
          // TalkBack announce the initials a second time.
          accessible={false}
        >
          {initials}
        </Text>
      ) : (
        <Icon
          name="user"
          size={Math.round(size * 0.5)}
          color={palette[tint as keyof Palette] as string}
        />
      )}
    </View>
  );

  if (!onPress) return <View style={style}>{inner}</View>;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      // The visual is 40pt; the target is expanded to 48 so it is comfortably
      // tappable without making the header taller.
      hitSlop={(MIN_TOUCH_TARGET - size) / 2 + 4}
      style={({ pressed }) => [style, pressed && styles.pressed]}
    >
      {inner}
    </Pressable>
  );
}

const makeStyles = (_palette: Palette) =>
  StyleSheet.create({
    root: {
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth * 2,
      overflow: 'hidden',
    },
    initials: {
      fontWeight: '700',
      letterSpacing: 0.5,
      // Android centres text on the baseline rather than the box; this nudges
      // the initials onto the optical centre of the circle.
      includeFontPadding: false,
      textAlignVertical: 'center',
    },
    pressed: {
      opacity: 0.7,
    },
  });
