/**
 * Icon set.
 *
 * ## Why these are drawn with `View` rather than an icon font or SVG
 *
 * Adding `react-native-svg` (or an icon font) means a native dependency, a
 * rebuild, and a new way for the Android build to fail — for what is roughly
 * forty small shapes. Every icon below is composed from rounded `View`s on a
 * 24×24 grid, which costs nothing at runtime, links against nothing, and
 * inherits the active palette automatically.
 *
 * The trade-off is real and worth stating: these are geometric marks, not
 * illustrated glyphs. Anything needing a genuine curve (a hand, a bin) is
 * abstracted to its simplest recognisable form rather than approximated badly.
 *
 * Icons are decorative. Every one is paired with a text label in the UI, and
 * they are hidden from screen readers so the label is announced once, not
 * twice.
 */
import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';

/*
 * `react-native/no-inline-styles` is disabled for this file, deliberately.
 *
 * Every style below is geometry computed from `size` and `stroke` — a glyph is a
 * handful of Views whose positions are arithmetic on the icon's own scale. There
 * is nothing static to hoist into a stylesheet: two icons in the same file share
 * no coordinates, and the same icon at two sizes shares none either. The rule's
 * advice (move the object into `StyleSheet.create`) is inapplicable rather than
 * being ignored, and silencing it here keeps the warning list meaningful
 * everywhere else in the app.
 */
/* eslint-disable react-native/no-inline-styles */

export type IconName =
  | 'dashboard'
  | 'oled'
  | 'audit'
  | 'more'
  | 'chevronRight'
  | 'chevronDown'
  | 'close'
  | 'plus'
  | 'check'
  | 'warning'
  | 'refresh'
  | 'signal'
  | 'battery'
  | 'eye'
  | 'eyeOff'
  | 'hand'
  | 'sun'
  | 'moon'
  | 'volume'
  | 'volumeOff'
  | 'trash'
  | 'clock'
  | 'link'
  | 'info'
  | 'scan'
  | 'arrowUp'
  | 'arrowDown';

export interface IconProps {
  name: IconName;
  /** Bounding box in dp. The grid scales with it. */
  size?: number;
  color?: string;
  /** Overrides the stroke weight of outlined icons. */
  weight?: number;
}

/** The grid every icon is drawn on. Coordinates below are in these units. */
const GRID = 24;

export function Icon({ name, size = 22, color, weight }: IconProps): React.JSX.Element {
  const { palette } = useTheme();
  const tint = color ?? palette.textPrimary;
  // Unit scale: every coordinate below is multiplied by this.
  const u = size / GRID;
  const stroke = weight ?? Math.max(1.5, 1.8 * u);

  const box: ViewStyle = { width: size, height: size };

  return (
    <View
      style={[styles.box, box]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {render(name, { u, tint, stroke, palette, size })}
    </View>
  );
}

interface Ctx {
  /** Unit scale factor. */
  u: number;
  tint: string;
  stroke: number;
  palette: Palette;
  size: number;
}

function render(name: IconName, ctx: Ctx): React.ReactNode {
  switch (name) {
    case 'dashboard':
      return <Grid ctx={ctx} />;
    case 'oled':
      return <ScreenIcon ctx={ctx} />;
    case 'audit':
      return <Bars ctx={ctx} />;
    case 'more':
      return <Dots ctx={ctx} />;
    case 'chevronRight':
      return <Chevron ctx={ctx} direction="right" />;
    case 'chevronDown':
      return <Chevron ctx={ctx} direction="down" />;
    case 'arrowUp':
      return <Chevron ctx={ctx} direction="up" />;
    case 'arrowDown':
      return <Chevron ctx={ctx} direction="down" />;
    case 'close':
      return <Cross ctx={ctx} />;
    case 'plus':
      return <Plus ctx={ctx} />;
    case 'check':
      return <Check ctx={ctx} />;
    case 'warning':
      return <Warning ctx={ctx} />;
    case 'info':
      return <Info ctx={ctx} />;
    case 'refresh':
      return <Arc ctx={ctx} turns={0.78} />;
    case 'scan':
      return <Scan ctx={ctx} />;
    case 'signal':
      return <Signal ctx={ctx} />;
    case 'battery':
      return <Battery ctx={ctx} />;
    case 'eye':
      return <Eye ctx={ctx} off={false} />;
    case 'eyeOff':
      return <Eye ctx={ctx} off />;
    case 'hand':
      return <Hand ctx={ctx} />;
    case 'sun':
      return <Sun ctx={ctx} />;
    case 'moon':
      return <Moon ctx={ctx} />;
    case 'volume':
      return <Volume ctx={ctx} muted={false} />;
    case 'volumeOff':
      return <Volume ctx={ctx} muted />;
    case 'trash':
      return <Trash ctx={ctx} />;
    case 'clock':
      return <Clock ctx={ctx} />;
    case 'link':
      return <Link ctx={ctx} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ shapes */

function Grid({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const cell = 9 * ctx.u;
  const gap = 3 * ctx.u;
  const radius = 2.4 * ctx.u;
  const tile: ViewStyle = {
    width: cell,
    height: cell,
    borderRadius: radius,
    backgroundColor: ctx.tint,
  };
  return (
    <View style={[styles.fill, { gap, justifyContent: 'center' }]}>
      <View style={{ flexDirection: 'row', gap }}>
        <View style={tile} />
        <View style={tile} />
      </View>
      <View style={{ flexDirection: 'row', gap }}>
        <View style={tile} />
        <View style={tile} />
      </View>
    </View>
  );
}

function ScreenIcon({ ctx }: { ctx: Ctx }): React.JSX.Element {
  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          width: 20 * ctx.u,
          height: 14 * ctx.u,
          borderRadius: 3 * ctx.u,
          borderWidth: ctx.stroke,
          borderColor: ctx.tint,
          justifyContent: 'center',
          paddingHorizontal: 3 * ctx.u,
          gap: 2 * ctx.u,
        }}
      >
        {/* Two text lines, standing for the displayable content. */}
        <View
          style={{
            height: Math.max(1.5, 2 * ctx.u),
            width: '70%',
            borderRadius: 2,
            backgroundColor: ctx.tint,
            opacity: 0.9,
          }}
        />
        <View
          style={{
            height: Math.max(1.5, 2 * ctx.u),
            width: '45%',
            borderRadius: 2,
            backgroundColor: ctx.tint,
            opacity: 0.5,
          }}
        />
      </View>
    </View>
  );
}

function Bars({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const widths = [3.2, 6.5, 10, 6.5];
  return (
    <View style={[styles.fill, styles.center]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2.6 * ctx.u }}>
        {widths.map((height, index) => (
          <View
            key={index}
            style={{
              width: Math.max(2, 2.6 * ctx.u),
              height: height * ctx.u,
              borderRadius: 2,
              backgroundColor: ctx.tint,
              opacity: index === 2 ? 1 : 0.55,
            }}
          />
        ))}
      </View>
    </View>
  );
}

function Dots({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const dot = 3.4 * ctx.u;
  const style: ViewStyle = { width: dot, height: dot, borderRadius: dot, backgroundColor: ctx.tint };
  return (
    <View style={[styles.fill, styles.center]}>
      <View style={{ flexDirection: 'row', gap: 3.4 * ctx.u }}>
        <View style={style} />
        <View style={style} />
        <View style={style} />
      </View>
    </View>
  );
}

function Chevron({
  ctx,
  direction,
}: {
  ctx: Ctx;
  direction: 'right' | 'down' | 'up';
}): React.JSX.Element {
  const arm = 7 * ctx.u;
  const rotation = direction === 'right' ? '45deg' : direction === 'down' ? '135deg' : '-45deg';
  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          width: arm,
          height: arm,
          borderTopWidth: ctx.stroke,
          borderRightWidth: ctx.stroke,
          borderColor: ctx.tint,
          transform: [{ rotate: rotation }],
          // Nudge so the rotated square's visual centre matches the box.
          marginRight: direction === 'right' ? 0 : 0,
          marginTop: direction === 'down' ? -arm / 3 : direction === 'up' ? arm / 3 : 0,
        }}
      />
    </View>
  );
}

function Cross({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const length = 13 * ctx.u;
  const bar: ViewStyle = {
    position: 'absolute',
    width: length,
    height: ctx.stroke,
    borderRadius: 2,
    backgroundColor: ctx.tint,
  };
  return (
    <View style={[styles.fill, styles.center]}>
      <View style={[bar, { transform: [{ rotate: '45deg' }] }]} />
      <View style={[bar, { transform: [{ rotate: '-45deg' }] }]} />
    </View>
  );
}

function Plus({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const length = 13 * ctx.u;
  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          position: 'absolute',
          width: length,
          height: ctx.stroke,
          borderRadius: 2,
          backgroundColor: ctx.tint,
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: ctx.stroke,
          height: length,
          borderRadius: 2,
          backgroundColor: ctx.tint,
        }}
      />
    </View>
  );
}

function Check({ ctx }: { ctx: Ctx }): React.JSX.Element {
  // One arm rotated, one short arm rotated the other way — the standard tick.
  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          position: 'absolute',
          width: 13 * ctx.u,
          height: ctx.stroke,
          borderRadius: 2,
          backgroundColor: ctx.tint,
          transform: [{ rotate: '-45deg' }],
          marginLeft: 2 * ctx.u,
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: 6 * ctx.u,
          height: ctx.stroke,
          borderRadius: 2,
          backgroundColor: ctx.tint,
          transform: [{ rotate: '45deg' }],
          marginLeft: -6 * ctx.u,
          marginTop: 2 * ctx.u,
        }}
      />
    </View>
  );
}

function Warning({ ctx }: { ctx: Ctx }): React.JSX.Element {
  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          width: 19 * ctx.u,
          height: 19 * ctx.u,
          borderRadius: 19 * ctx.u,
          borderWidth: ctx.stroke,
          borderColor: ctx.tint,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: Math.max(1.6, ctx.stroke),
            height: 6.5 * ctx.u,
            borderRadius: 2,
            backgroundColor: ctx.tint,
            marginBottom: 2.2 * ctx.u,
          }}
        />
        <View
          style={{
            width: Math.max(1.6, ctx.stroke),
            height: Math.max(1.6, ctx.stroke),
            borderRadius: 2,
            backgroundColor: ctx.tint,
          }}
        />
      </View>
    </View>
  );
}

function Info({ ctx }: { ctx: Ctx }): React.JSX.Element {
  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          width: 19 * ctx.u,
          height: 19 * ctx.u,
          borderRadius: 19 * ctx.u,
          borderWidth: ctx.stroke,
          borderColor: ctx.tint,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: Math.max(1.6, ctx.stroke),
            height: Math.max(1.6, ctx.stroke),
            borderRadius: 2,
            backgroundColor: ctx.tint,
            marginBottom: 2.2 * ctx.u,
          }}
        />
        <View
          style={{
            width: Math.max(1.6, ctx.stroke),
            height: 6.5 * ctx.u,
            borderRadius: 2,
            backgroundColor: ctx.tint,
          }}
        />
      </View>
    </View>
  );
}

/**
 * A circular arc, by colouring only some of a bordered circle's edges.
 *
 * Turns are expressed as a fraction of the circle; the remaining edges are
 * transparent. Precision is limited to whole edges, which is why `turns` snaps
 * to sensible values rather than being continuous.
 */
function Arc({ ctx, turns }: { ctx: Ctx; turns: number }): React.JSX.Element {
  const transparent = 'transparent';
  const showTop = true;
  const showRight = turns > 0.25;
  const showBottom = turns > 0.5;
  const showLeft = turns > 0.75;

  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          width: 17 * ctx.u,
          height: 17 * ctx.u,
          borderRadius: 17 * ctx.u,
          borderWidth: ctx.stroke,
          borderTopColor: showTop ? ctx.tint : transparent,
          borderRightColor: showRight ? ctx.tint : transparent,
          borderBottomColor: showBottom ? ctx.tint : transparent,
          borderLeftColor: showLeft ? ctx.tint : transparent,
        }}
      />
    </View>
  );
}

function Scan({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const ring = (diameter: number, opacity: number) => (
    <View
      key={diameter}
      style={{
        position: 'absolute',
        width: diameter * ctx.u,
        height: diameter * ctx.u,
        borderRadius: diameter * ctx.u,
        borderWidth: ctx.stroke,
        borderColor: ctx.tint,
        opacity,
      }}
    />
  );
  return (
    <View style={[styles.fill, styles.center]}>
      {ring(20, 0.45)}
      {ring(12, 0.75)}
      <View
        style={{
          width: 4 * ctx.u,
          height: 4 * ctx.u,
          borderRadius: 4 * ctx.u,
          backgroundColor: ctx.tint,
        }}
      />
    </View>
  );
}

function Signal({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const heights = [4, 7, 10, 13];
  return (
    <View style={[styles.fill, styles.center]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2.4 * ctx.u }}>
        {heights.map((height, index) => (
          <View
            key={index}
            style={{
              width: Math.max(2, 2.8 * ctx.u),
              height: height * ctx.u,
              borderRadius: 1.6,
              backgroundColor: ctx.tint,
              opacity: index === 3 ? 0.4 : 1,
            }}
          />
        ))}
      </View>
    </View>
  );
}

function Battery({ ctx }: { ctx: Ctx }): React.JSX.Element {
  return (
    <View style={[styles.fill, styles.center]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1.6 * ctx.u }}>
        <View
          style={{
            width: 17 * ctx.u,
            height: 10 * ctx.u,
            borderRadius: 2.6 * ctx.u,
            borderWidth: ctx.stroke,
            borderColor: ctx.tint,
            justifyContent: 'center',
            paddingHorizontal: 1.6 * ctx.u,
          }}
        >
          {/* A hollow fill: level is unknown, so no charge is implied. */}
          <View
            style={{
              width: '38%',
              height: 4.4 * ctx.u,
              borderRadius: 1.2,
              backgroundColor: ctx.tint,
              opacity: 0.45,
            }}
          />
        </View>
        <View
          style={{
            width: 2 * ctx.u,
            height: 5 * ctx.u,
            borderTopRightRadius: 2,
            borderBottomRightRadius: 2,
            backgroundColor: ctx.tint,
          }}
        />
      </View>
    </View>
  );
}

function Eye({ ctx, off }: { ctx: Ctx; off: boolean }): React.JSX.Element {
  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          width: 20 * ctx.u,
          height: 13 * ctx.u,
          borderRadius: 999,
          borderWidth: ctx.stroke,
          borderColor: ctx.tint,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: 5 * ctx.u,
            height: 5 * ctx.u,
            borderRadius: 5 * ctx.u,
            backgroundColor: ctx.tint,
          }}
        />
      </View>
      {off && (
        <View
          style={{
            position: 'absolute',
            width: 22 * ctx.u,
            height: ctx.stroke + 0.6,
            borderRadius: 2,
            backgroundColor: ctx.tint,
            transform: [{ rotate: '45deg' }],
          }}
        />
      )}
    </View>
  );
}

/**
 * Hand: a palm plus five fingers.
 *
 * Abstract on purpose. A literal hand cannot be drawn convincingly from
 * rectangles, and a bad literal drawing would look worse than an honest
 * diagram. This reads as a hand at 22dp without pretending to be illustration.
 */
function Hand({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const fingerWidth = Math.max(1.8, 2.4 * ctx.u);
  const finger = (height: number, key: string, opacity = 1) => (
    <View
      key={key}
      style={{
        width: fingerWidth,
        height: height * ctx.u,
        borderRadius: fingerWidth,
        backgroundColor: ctx.tint,
        opacity,
      }}
    />
  );

  return (
    <View style={[styles.fill, styles.center]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1.6 * ctx.u }}>
        {finger(7, 'pinky', 0.7)}
        {finger(10, 'ring', 0.8)}
        {finger(11, 'middle', 0.9)}
        {finger(9.5, 'index')}
        {/* Thumb: shorter and offset, angled away from the palm. */}
        <View
          style={{
            width: fingerWidth,
            height: 6 * ctx.u,
            borderRadius: fingerWidth,
            backgroundColor: ctx.tint,
            transform: [{ rotate: '-32deg' }],
            marginLeft: 0.6 * ctx.u,
            marginBottom: 0.6 * ctx.u,
          }}
        />
      </View>
      <View
        style={{
          width: 14 * ctx.u,
          height: 9 * ctx.u,
          borderBottomLeftRadius: 4 * ctx.u,
          borderBottomRightRadius: 4 * ctx.u,
          borderTopLeftRadius: 1.6 * ctx.u,
          borderTopRightRadius: 1.6 * ctx.u,
          backgroundColor: ctx.tint,
        }}
      />
    </View>
  );
}

function Sun({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const core = 9 * ctx.u;
  const ray = (key: string, rotation: string) => (
    <View
      key={key}
      style={{
        position: 'absolute',
        width: Math.max(1.6, 1.9 * ctx.u),
        height: 4 * ctx.u,
        borderRadius: 2,
        backgroundColor: ctx.tint,
        transform: [{ rotate: rotation }, { translateY: -9 * ctx.u }],
      }}
    />
  );
  return (
    <View style={[styles.fill, styles.center]}>
      {['0deg', '45deg', '90deg', '135deg', '180deg', '225deg', '270deg', '315deg'].map((r) =>
        ray(r, r),
      )}
      <View
        style={{ width: core, height: core, borderRadius: core, backgroundColor: ctx.tint }}
      />
    </View>
  );
}

/**
 * Moon: a circle with a second circle bitten out of it.
 *
 * The bite has to be the colour *behind* the icon, so it cannot be a fixed
 * token. Callers pass the surface it sits on via `color`; the default assumes
 * a card, which is where the theme selector lives.
 */
function Moon({ ctx }: { ctx: Ctx }): React.JSX.Element {
  const body = 15 * ctx.u;
  return (
    <View style={[styles.fill, styles.center]}>
      <View style={{ width: body, height: body, borderRadius: body, backgroundColor: ctx.tint }} />
      <View
        style={{
          position: 'absolute',
          width: body,
          height: body,
          borderRadius: body,
          backgroundColor: ctx.palette.surface,
          left: 6 * ctx.u,
          top: -2.5 * ctx.u,
        }}
      />
    </View>
  );
}

function Volume({ ctx, muted }: { ctx: Ctx; muted: boolean }): React.JSX.Element {
  return (
    <View style={[styles.fill, styles.center]}>
      {/* Speaker body: a rectangle plus a triangle-ish cone. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginRight: 4 * ctx.u,
        }}
      >
        <View
          style={{
            width: 3.6 * ctx.u,
            height: 6 * ctx.u,
            backgroundColor: ctx.tint,
            borderTopLeftRadius: 1.4,
            borderBottomLeftRadius: 1.4,
          }}
        />
        <View
          style={{
            width: 5 * ctx.u,
            height: 13 * ctx.u,
            backgroundColor: ctx.tint,
            borderTopRightRadius: 2,
            borderBottomRightRadius: 2,
          }}
        />
      </View>
      {muted ? (
        <View
          style={{
            position: 'absolute',
            width: 12 * ctx.u,
            height: ctx.stroke,
            borderRadius: 2,
            backgroundColor: ctx.tint,
            marginLeft: 9 * ctx.u,
            transform: [{ rotate: '-45deg' }],
          }}
        />
      ) : (
        <>
          <View
            style={{
              position: 'absolute',
              width: 7 * ctx.u,
              height: 7 * ctx.u,
              borderRadius: 7 * ctx.u,
              borderWidth: ctx.stroke,
              borderColor: 'transparent',
              borderRightColor: ctx.tint,
              marginLeft: 11 * ctx.u,
            }}
          />
          <View
            style={{
              position: 'absolute',
              width: 12 * ctx.u,
              height: 12 * ctx.u,
              borderRadius: 12 * ctx.u,
              borderWidth: ctx.stroke,
              borderColor: 'transparent',
              borderRightColor: ctx.tint,
              marginLeft: 12 * ctx.u,
              opacity: 0.55,
            }}
          />
        </>
      )}
    </View>
  );
}

function Trash({ ctx }: { ctx: Ctx }): React.JSX.Element {
  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          width: 11 * ctx.u,
          height: 3 * ctx.u,
          borderRadius: 1.4,
          backgroundColor: ctx.tint,
          marginBottom: 1.4 * ctx.u,
        }}
      />
      <View
        style={{
          width: 15 * ctx.u,
          height: ctx.stroke,
          backgroundColor: ctx.tint,
          borderRadius: 1.4,
          marginBottom: 1.4 * ctx.u,
        }}
      />
      <View
        style={{
          width: 12 * ctx.u,
          height: 11 * ctx.u,
          borderWidth: ctx.stroke,
          borderTopWidth: 0,
          borderColor: ctx.tint,
          borderBottomLeftRadius: 2.6 * ctx.u,
          borderBottomRightRadius: 2.6 * ctx.u,
        }}
      />
    </View>
  );
}

function Clock({ ctx }: { ctx: Ctx }): React.JSX.Element {
  return (
    <View style={[styles.fill, styles.center]}>
      <View
        style={{
          width: 19 * ctx.u,
          height: 19 * ctx.u,
          borderRadius: 19 * ctx.u,
          borderWidth: ctx.stroke,
          borderColor: ctx.tint,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            position: 'absolute',
            width: ctx.stroke,
            height: 6 * ctx.u,
            borderRadius: 2,
            backgroundColor: ctx.tint,
            marginTop: -3 * ctx.u,
          }}
        />
        <View
          style={{
            position: 'absolute',
            width: 4.5 * ctx.u,
            height: ctx.stroke,
            borderRadius: 2,
            backgroundColor: ctx.tint,
            marginLeft: 4.5 * ctx.u,
          }}
        />
      </View>
    </View>
  );
}

function Link({ ctx }: { ctx: Ctx }): React.JSX.Element {
  // Two interlocking rounded outlines, rotated — a chain link.
  const ring: ViewStyle = {
    position: 'absolute',
    width: 14 * ctx.u,
    height: 8 * ctx.u,
    borderRadius: 999,
    borderWidth: ctx.stroke,
    borderColor: ctx.tint,
  };
  return (
    <View style={[styles.fill, styles.center]}>
      <View style={[ring, { transform: [{ rotate: '-40deg' }], marginLeft: -5 * ctx.u }]} />
      <View
        style={[
          ring,
          { transform: [{ rotate: '-40deg' }], marginLeft: 5 * ctx.u, opacity: 0.75 },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fill: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
