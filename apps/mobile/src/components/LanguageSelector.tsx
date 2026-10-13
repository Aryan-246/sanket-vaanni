import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { Icon } from './Icon';
import { SIGN_LANGUAGE_PROFILES } from '../recognition/profiles';
import { OUTPUT_LANGUAGES } from '../app/preferences';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { MIN_TOUCH_TARGET, radii, spacing } from '../theme';

/**
 * The two language axes, each as a list of selectable rows.
 *
 * ## Why this is one component with a `mode`
 *
 * The two lists are configured in two places — inline on the Dashboard, where
 * translation happens, and inside a sheet from More, where preferences live —
 * and the whole point of the brief's language requirement is that the two axes
 * are *not* the same thing. Two hand-written lists would drift; one component
 * with an explicit axis keeps the distinction structural rather than stylistic.
 *
 * ## Why the sign-language list says what it says
 *
 * Every profile is `planned` with a vocabulary of zero. The list therefore
 * presents them as *intended* input profiles rather than as working ones, and
 * spells out that they share no vocabulary. Selecting ASL does not make ASL
 * work; it records an intent that the rest of the app then reports honestly.
 */
export type LanguageAxis = 'sign' | 'translation';

export interface LanguageSelectorProps {
  axis: LanguageAxis;
  /** Selected id: a profile id for `sign`, a language code for `translation`. */
  value: string;
  onChange: (value: string) => void;
  /** Hides the explanatory paragraph, for use where space is tight. */
  compact?: boolean;
}

export function LanguageSelector({
  axis,
  value,
  onChange,
  compact = false,
}: LanguageSelectorProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const options =
    axis === 'sign'
      ? SIGN_LANGUAGE_PROFILES.map((profile) => ({
          id: profile.id,
          label: profile.name,
          detail:
            profile.vocabularySize === 0
              ? 'No vocabulary defined'
              : `${profile.vocabularySize} signs`,
          native: profile.nativeName,
        }))
      : OUTPUT_LANGUAGES.map((language) => ({
          id: language.code,
          label: language.name,
          /*
           * The voice tag, not a claim about whether it works. Whether a phone
           * can actually speak this language depends on voice data installed on
           * *that phone*, which is asked of the engine at runtime in Settings.
           * Asserting "Speech ready" here would be a guess.
           */
          detail: `Voice: ${language.speechTag}`,
          native: language.nativeName,
        }));

  return (
    <View style={styles.host}>
      <View style={styles.list} accessibilityRole="radiogroup">
        {options.map((option, index) => {
          const selected = option.id === value;
          return (
            <Pressable
              key={option.id}
              onPress={() => onChange(option.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={`${option.label}. ${option.detail}`}
              style={({ pressed }) => [
                styles.row,
                index < options.length - 1 && styles.divider,
                selected && styles.rowSelected,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.rowText}>
                {/*
                  The Latin name gets its own line.

                  It used to share one with the native name —
                  `Indian Sign Language  ·  भारतीय सांकेतिक भाषा` — which is
                  about 360 points of text in a row that has roughly 250. Both
                  lines are `numberOfLines={1}`, so the tail was cut, and the
                  tail was the native name: the one thing this column exists to
                  show, lost to an ellipsis in the script it was written in
                  for. With the name alone on the line it always fits.
                */}
                <AppText variant="body" numberOfLines={1}>
                  {option.label}
                </AppText>
                {/*
                  Native name first, then the state. If this line does run out
                  of room the detail is what gives, not the language's own name
                  — and the row's accessibility label still carries both in
                  full for anyone not reading the pixels.
                */}
                <AppText variant="caption" color={palette.textMuted} numberOfLines={1}>
                  {option.native !== null ? `${option.native} · ${option.detail}` : option.detail}
                </AppText>
              </View>

              {selected && <Icon name="check" size={16} color={palette.accent} weight={2} />}
            </Pressable>
          );
        })}
      </View>

      {!compact && (
        <AppText variant="caption" color={palette.textMuted} style={styles.note}>
          {axis === 'sign'
            ? 'Sign languages are not dialects of one another and share no gesture dictionary. Each profile owns its own vocabulary, and none has one yet.'
            : 'The output language is independent of the sign language being read. Changing it does not change which signs can be recognised.'}
        </AppText>
      )}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    host: {
      gap: spacing.sm,
    },
    list: {
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: palette.surface,
    },
    rowSelected: {
      backgroundColor: palette.accentSurface,
    },
    divider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    pressed: {
      opacity: 0.7,
    },
    rowText: {
      flex: 1,
      gap: 1,
    },
    note: {
      paddingHorizontal: spacing.xs,
    },
  });
