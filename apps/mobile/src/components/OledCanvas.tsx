import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { AppText } from './AppText';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import {
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  OLED_HEIGHT,
  OLED_LARGE_SCALE,
  OLED_WIDTH,
  type OledFrame,
} from '../oled/layout';
import { radii, spacing } from '../theme';

/**
 * Emulation colours.
 *
 * These are **not** theme tokens and deliberately not derived from the palette.
 * The panel is a piece of hardware, not a themed surface: a physical SSD1306
 * shows one colour regardless of which theme the app is in, so the preview keeps
 * the same appearance in light and dark. Deriving it from the palette would be
 * the visual equivalent of claiming the hardware changed colour.
 *
 * The colour is a property of the module, not of the firmware — these panels ship
 * as white, blue or yellow OLEDs. White with a slight cool cast is used here, and
 * the bezel around it is themed, which is what actually needs to react to the
 * app's theme.
 */
const PANEL_BACKGROUND = '#04070A';
const PANEL_PIXEL = '#E4F4F2';
const PANEL_BEZEL = '#12161A';

export interface OledCanvasProps {
  frame: OledFrame;
  /** Pixels per panel pixel. 2 means the 128×64 panel is drawn 256×128. */
  scale: number;
  testID?: string;
}

/**
 * The 128×64 preview.
 *
 * ## Why this is characters rather than a bitmap
 *
 * The panel is driven in text mode on a 6×8 glyph grid — 21 columns, 8 rows —
 * so rendering the frame as positioned monospace text reproduces what the panel
 * will actually show, at the geometry it will show it at. A bitmap preview would
 * have to invent a font, and the invented font would be the thing the user was
 * approving.
 *
 * The one honest approximation: the glyph *shapes* come from the platform's
 * monospace face rather than the panel's built-in font. Metrics are matched
 * (advance width and cell height are exact), so layout and truncation are
 * faithful; the letterforms are not pixel-identical.
 *
 * ## Monochrome
 *
 * Every glyph is the same colour. There is no state that tints a row, because
 * there is no state the panel could express that way.
 */
export function OledCanvas({ frame, scale, testID }: OledCanvasProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View
      testID={testID}
      style={[styles.bezel, { width: OLED_WIDTH * scale + spacing.sm * 2 }]}
      accessible
      accessibilityRole="image"
      // The screen reader gets the content, not a description of a picture of
      // the content: this is text, and reading it out is more useful than
      // telling someone there is a preview.
      accessibilityLabel={`OLED preview, ${OLED_WIDTH} by ${OLED_HEIGHT} pixels. ${describe(
        frame,
      )}`}
    >
      <View
        style={[
          styles.panel,
          { width: OLED_WIDTH * scale, height: OLED_HEIGHT * scale },
        ]}
      >
        {frame.rows.map((row) => {
          const large = row.size === 'large';
          const cell = large ? GLYPH_HEIGHT * OLED_LARGE_SCALE : GLYPH_HEIGHT;

          return (
            <View
              key={row.itemId}
              style={[
                styles.row,
                { top: row.row * GLYPH_HEIGHT * scale, height: cell * scale },
              ]}
              pointerEvents="none"
            >
              <AppText
                numberOfLines={1}
                // The panel is hardware at a fixed 128×64. Letting the system
                // font scale enlarge these glyphs would draw a panel that does
                // not exist, so scaling is off *here* — and only here. The
                // content is still available to a screen reader through the
                // label above, and the item list below the canvas is ordinary
                // themed text that scales normally.
                allowFontScaling={false}
                maxFontSizeMultiplier={1}
                style={[
                  styles.glyphs,
                  {
                    color: PANEL_PIXEL,
                    // Advance width is 0.6em in the platform monospace face, so
                    // this is the size at which exactly `OLED_COLUMNS` characters
                    // fill the panel's width. Deriving it rather than hardcoding
                    // it is what keeps 21 characters inside 128 pixels.
                    fontSize: (GLYPH_WIDTH / 0.6) * scale,
                    lineHeight: cell * scale,
                    textAlign: row.align,
                  },
                ]}
              >
                {row.text.length > 0 ? row.text : ' '}
              </AppText>
            </View>
          );
        })}

        {/* An empty panel is a real state, and saying so beats a black rectangle
            that could equally be a preview that failed to render. */}
        {frame.rows.length === 0 && (
          <View style={styles.empty}>
            <AppText variant="caption" color={palette.textMuted}>
              Nothing visible
            </AppText>
          </View>
        )}
      </View>
    </View>
  );
}

function describe(frame: OledFrame): string {
  if (frame.rows.length === 0) return 'Nothing is set to show.';
  const lines = frame.rows.map((row) => (row.text.length > 0 ? row.text : 'blank'));
  return lines.join('. ');
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    bezel: {
      alignSelf: 'center',
      padding: spacing.sm,
      borderRadius: radii.md,
      backgroundColor: PANEL_BEZEL,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    panel: {
      backgroundColor: PANEL_BACKGROUND,
      borderRadius: 2,
      overflow: 'hidden',
      // The panel is a light-emitting surface: it stays slightly brighter than
      // its surroundings in both themes, which is what makes the preview read as
      // a screen rather than as a hole in the card.
      position: 'relative',
    },
    row: {
      position: 'absolute',
      left: 0,
      right: 0,
      justifyContent: 'center',
    },
    glyphs: {
      fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
      includeFontPadding: false,
      paddingHorizontal: 0,
    },
    empty: {
      ...StyleSheet.absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
