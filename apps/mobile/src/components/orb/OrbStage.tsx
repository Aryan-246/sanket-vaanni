/**
 * The orb with its caption and quick theme switcher.
 *
 * Integrated from the approved Google Stitch design:
 * (Sanket Vaanni Standalone 3D Interactive Orb Component, screen fae1a784eed349cdb7648ba97c32b795)
 */
import React, { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '../AppText';
import { Orb } from './Orb';
import { useOrbState, type OrbSignal, type OrbState } from './useOrbState';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import {
  ACCENT_COLOR_IDS,
  ACCENT_PALETTES,
  type AccentColorId,
  type Palette,
} from '../../theme/palette';
import { radii, spacing } from '../../theme';

export interface OrbStageProps {
  signal: OrbSignal;
  /** Diameter of the orb. */
  size?: number;
  /**
   * A second line explaining the state. Supplied by the caller because only the
   * caller knows the surrounding facts — which glove is connected, whether a
   * model exists — and inventing a generic one here would produce a line that
   * was true of the orb and misleading about the app.
   */
  detail?: string | null;
  testID?: string;
}

/**
 * The headline for each state.
 */
export const ORB_HEADLINE: Record<OrbState, string> = {
  idle: 'No glove connected',
  connecting: 'Connecting',
  ready: 'Ready',
  receiving: 'Receiving data',
  recognising: 'Recognising',
  'text-updating': 'Text updated',
  speaking: 'Speaking',
  error: 'Glove error',
};

/** Accent colour for the headline, so the words carry the same signal as the orb. */
function headlineColour(state: OrbState, palette: Palette): string {
  switch (state) {
    case 'error':
      return palette.danger;
    case 'connecting':
      return palette.warning;
    case 'idle':
      return palette.textSecondary;
    default:
      return palette.accent;
  }
}

export function OrbStage({ signal, size = 180, detail, testID }: OrbStageProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette, accentColor, setAccentColor } = useTheme();
  const state = useOrbState(signal);
  const [pickerOpen, setPickerOpen] = useState(false);

  const headline = ORB_HEADLINE[state];
  const colour = useMemo(() => headlineColour(state, palette), [state, palette]);

  const cyclePalette = () => {
    const currentIndex = ACCENT_COLOR_IDS.indexOf(accentColor);
    const nextIndex = (currentIndex + 1) % ACCENT_COLOR_IDS.length;
    setAccentColor(ACCENT_COLOR_IDS[nextIndex]);
  };

  return (
    <View style={styles.root} testID={testID}>
      {/* Upper context bar with live indicator & floating palette switcher */}
      <View style={styles.topControlRow}>
        <View style={styles.liveMeta}>
          <View style={[styles.liveDot, { backgroundColor: colour }]} />
          <AppText variant="overline" overline color={palette.textMuted}>
            ORB STAGE
          </AppText>
        </View>

        {/* Floating Accent Palette Switcher button */}
        <Pressable
          style={[
            styles.paletteButton,
            { borderColor: pickerOpen ? palette.accent : palette.border },
          ]}
          onPress={cyclePalette}
          onLongPress={() => setPickerOpen(true)}
          hitSlop={16}
          accessibilityRole="button"
          accessibilityLabel="Switch Accent Palette"
          accessibilityHint="Cycles through accent palettes across the orb and speech waveform. Long press for palette menu."
        >
          <View style={[styles.activeColorSwatch, { backgroundColor: palette.accent }]} />
        </Pressable>
      </View>

      {/* Palette Popover Picker Modal */}
      <Modal
        transparent
        visible={pickerOpen}
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setPickerOpen(false)}
          accessibilityLabel="Dismiss palette chooser"
        >
          <Pressable style={styles.pickerPopover} onPress={(e) => e.stopPropagation()}>
            <AppText variant="overline" overline color={palette.textMuted} style={styles.pickerHeader}>
              THEME PALETTE
            </AppText>
            {ACCENT_COLOR_IDS.map((id) => {
              const def = ACCENT_PALETTES[id];
              const isSelected = accentColor === id;
              return (
                <Pressable
                  key={id}
                  style={[
                    styles.pickerRow,
                    isSelected && { backgroundColor: palette.accentSurface },
                  ]}
                  onPress={() => {
                    setAccentColor(id);
                    setPickerOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`${def.name} theme`}
                >
                  <View style={[styles.pickerSwatch, { backgroundColor: def.hex }]} />
                  <AppText
                    variant="caption"
                    color={isSelected ? palette.accent : palette.textPrimary}
                    style={styles.pickerLabel}
                  >
                    {def.name}
                  </AppText>
                  {isSelected && (
                    <View style={[styles.pickerSelectedDot, { backgroundColor: palette.accent }]} />
                  )}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* The Central Volumetric 3D Orb */}
      <Orb state={state} size={size} />

      {/*
        `polite` rather than `assertive`: this changes while the user is signing,
        and interrupting them to announce every transition would make the screen
        unusable with a screen reader. The orb's own label carries the state for
        a user who goes looking; this announces it when there is a pause.
      */}
      <AppText
        variant="title"
        color={colour}
        center
        style={styles.headline}
        accessibilityLiveRegion="polite"
      >
        {headline}
      </AppText>

      {detail ? (
        <AppText variant="caption" color={palette.textMuted} center style={styles.detail}>
          {detail}
        </AppText>
      ) : null}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    root: {
      alignItems: 'center',
      paddingVertical: spacing.lg,
      gap: spacing.md,
      position: 'relative',
      width: '100%',
    },
    topControlRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      paddingHorizontal: spacing.sm,
      marginBottom: -spacing.xs,
      zIndex: 10,
    },
    liveMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    liveDot: {
      width: 6,
      height: 6,
      borderRadius: radii.pill,
    },
    paletteButton: {
      width: 28,
      height: 28,
      borderRadius: radii.pill,
      backgroundColor: palette.surfaceRaised,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    activeColorSwatch: {
      width: 14,
      height: 14,
      borderRadius: radii.pill,
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing.xl,
    },
    pickerPopover: {
      backgroundColor: palette.surfaceRaised,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.borderStrong,
      padding: spacing.sm,
      minWidth: 200,
      shadowColor: palette.shadow,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.4,
      shadowRadius: 12,
      elevation: 10,
    },
    pickerHeader: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
    },
    pickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 6,
      paddingHorizontal: spacing.sm,
      borderRadius: radii.sm,
      gap: spacing.sm,
    },
    pickerSwatch: {
      width: 12,
      height: 12,
      borderRadius: radii.pill,
    },
    pickerLabel: {
      flex: 1,
      fontWeight: '600',
    },
    pickerSelectedDot: {
      width: 5,
      height: 5,
      borderRadius: radii.pill,
    },
    headline: {
      letterSpacing: -0.3,
    },
    detail: {
      maxWidth: 320,
    },
  });
