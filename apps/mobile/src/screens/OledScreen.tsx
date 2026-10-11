import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { ListRow } from '../components/ListRow';
import { OledCanvas } from '../components/OledCanvas';
import { Screen } from '../components/Screen';
import { ScreenHeader } from '../components/ScreenHeader';
import { SectionHeader } from '../components/SectionHeader';
import { SegmentedControl } from '../components/SegmentedControl';
import { Sheet } from '../components/Sheet';
import { TextField } from '../components/TextField';
import { Toggle } from '../components/Toggle';
import { useAppState, useGlove, useLiveTranslation } from '../app/AppState';
import { formatDuration } from '../app/format';
import {
  ANIMATION_SPEEDS,
  columnsFor,
  hiddenCount,
  isCustomised,
  MAX_ITEM_COUNT,
  MAX_LABEL_LENGTH,
  MAX_PRESETS,
  OLED_HEIGHT,
  OLED_ITEM_KINDS,
  OLED_KIND_LABEL,
  OLED_NO_VALUE,
  OLED_ROWS,
  OLED_WIDTH,
  type OledAlign,
  type OledItem,
  type OledItemKind,
  type OledLoadingStyle,
  type OledTextSize,
  type OledValues,
} from '../oled/layout';
import { useOledFrame } from '../oled/useOledFrame';
import { useOledStudio, type OledIntent } from '../oled/useOledStudio';
import { oledValuesFrom } from '../oled/values';
import { layout as screenLayout, MIN_TOUCH_TARGET, radii, spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import type { GloveSide } from '../ble/types';

const SIDE_OPTIONS: readonly { value: GloveSide; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

const SIZE_OPTIONS: readonly { value: OledTextSize; label: string }[] = [
  { value: 'normal', label: 'Single' },
  { value: 'large', label: 'Double height' },
];

const ALIGN_OPTIONS: readonly { value: OledAlign; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
];

const LOADING_OPTIONS: readonly { value: OledLoadingStyle; label: string }[] = [
  { value: 'dots', label: 'Dots' },
  { value: 'bar', label: 'Bar' },
  { value: 'none', label: 'None' },
];

/** Kinds whose text the user authors. Bound kinds read from live values. */
const EDITABLE_KINDS: ReadonlySet<OledItemKind> = new Set(['title', 'text']);

const ALIGN_LABEL: Record<OledAlign, string> = {
  left: 'left',
  center: 'centre',
  right: 'right',
};

export interface OledScreenProps {
  /** Injectable clock, so tests can assert preset timestamps without real time. */
  now?: () => number;
}

/**
 * OLED Studio.
 *
 * ## What this is for
 *
 * Designing the layout the glove's 128×64 panel will show: which lines appear,
 * in what order, at what height, and what the loading indicator looks like.
 *
 * ## What it does not do
 *
 * It does not talk to hardware. There is no serialiser and no command encoder,
 * and no BLE characteristic has been verified — so nothing is sent anywhere, and
 * the preview is labelled **Demo Preview** in the header and in the notice above
 * the canvas. The brief is explicit that the app must not "pretend these
 * controls work on a physical glove without a verified firmware protocol", and
 * the way to honour that is a label on the thing itself rather than a warning
 * buried in a menu.
 *
 * The panel geometry, however, is real: 128×64, a 6×8 glyph grid, 21 columns and
 * 8 rows, with `--` for values nothing has reported. A layout that overflows its
 * 8 rows is reported rather than silently clipped, so what the preview shows is
 * what the firmware will have to draw.
 *
 * ## Why the item list has no reorder arrows in it
 *
 * An earlier arrangement put move-up / move-down / hide buttons on every row.
 * It did not fit: on a 360dp screen the row ran out of width before the text
 * did, and the controls ended up far below a finger's width. Reordering, hiding
 * and changing an item's kind therefore live in the item editor, which opens on
 * tapping the row and has room for labelled controls. The list stays a list.
 */
export function OledScreen({ now = Date.now }: OledScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { width } = useWindowDimensions();
  const { storage } = useAppState();

  const studio = useOledStudio(storage, now);
  const { layout, presets, run, savePreset, applyPreset, deletePreset } = studio;

  const [side, setSide] = useState<GloveSide>('right');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [presetSheetOpen, setPresetSheetOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  const glove = useGlove(side);
  // The shared outcome — there is no per-glove recogniser any more. `oledValuesFrom`
  // drops a result that this hand did not produce, so the panel still only ever
  // shows its own glove's sign.
  const { outcome } = useLiveTranslation();

  const values: OledValues = useMemo(() => oledValuesFrom(glove, outcome), [glove, outcome]);

  // The animation runs only while this screen is mounted — and since only the
  // active tab is mounted, that means only while the user is looking at it.
  const frame = useOledFrame(layout, values, true);

  const scale = useMemo(() => {
    const available = width - 2 * screenLayout.screenPadding - 4 * spacing.sm;
    const raw = available / OLED_WIDTH;
    // Floored to a tenth so the caption reads as a clean number rather than a
    // long float, and so the panel's edges land on sensible pixel boundaries.
    return Math.max(1.4, Math.min(2.6, Math.floor(raw * 10) / 10));
  }, [width]);

  const editingIndex = layout.items.findIndex((item) => item.id === editingId);
  const editing = editingIndex === -1 ? null : (layout.items[editingIndex] as OledItem);
  const hidden = hiddenCount(layout);
  const customised = isCustomised(layout);
  const atCapacity = layout.items.length >= MAX_ITEM_COUNT;

  const dispatch = useCallback((intent: OledIntent) => run(intent), [run]);

  const closeEditor = useCallback(() => setEditingId(null), []);

  const closePresetSheet = useCallback(() => {
    setPresetSheetOpen(false);
    setPresetName('');
  }, []);

  const commitPreset = useCallback(() => {
    savePreset(presetName);
    setPresetName('');
    setPresetSheetOpen(false);
  }, [presetName, savePreset]);

  return (
    <Screen scroll bottomInset={screenLayout.tabBarHeight} testID="oled-screen">
      <ScreenHeader
        title="OLED Studio"
        subtitle={`SSD1306 · ${OLED_WIDTH} × ${OLED_HEIGHT} · monochrome`}
        accessory={<Badge label="Demo Preview" tone="demo" dot />}
      />

      {/*
        The standing warning. A card rather than a footnote, because without it
        the whole screen reads as a remote control for a device.
      */}
      <Card sunken style={[styles.notice, { borderColor: palette.demo }]}>
        <Icon name="info" size={16} color={palette.demo} />
        <View style={styles.noticeText}>
          <AppText variant="label" color={palette.demo}>
            Demo Preview
          </AppText>
          <AppText variant="caption" color={palette.textSecondary}>
            Nothing here is sent to hardware. No OLED command set and no BLE characteristic
            has been verified, so a physical panel will not change until firmware exists.
          </AppText>
        </View>
      </Card>

      <View style={styles.sideSelector}>
        <AppText variant="caption" color={palette.textMuted}>
          Previewing values from
        </AppText>
        <SegmentedControl
          options={SIDE_OPTIONS}
          value={side}
          onChange={setSide}
          accessibilityLabel="Which glove's values the preview shows"
        />
      </View>

      <OledCanvas frame={frame} scale={scale} testID="oled-canvas" />

      <AppText variant="caption" color={palette.textMuted} center>
        Shown at {scale.toFixed(1)}× · {columnsFor('normal')} columns × {OLED_ROWS} rows of 6×8
        cells · letterforms come from the platform monospace face, not the panel's own font
      </AppText>

      {frame.overflow.length > 0 && (
        <Card style={[styles.notice, { borderColor: palette.warning }]}>
          <Icon name="warning" size={16} color={palette.warning} />
          <View style={styles.noticeText}>
            <AppText variant="label" color={palette.warning}>
              {frame.overflow.length === 1
                ? '1 item does not fit'
                : `${frame.overflow.length} items do not fit`}
            </AppText>
            <AppText variant="caption" color={palette.textSecondary}>
              The panel has {OLED_ROWS} rows and {frame.rowsUsed} are used, so these are not
              drawn — and would not be drawn on a physical panel either:{' '}
              {frame.overflow.map((item) => OLED_KIND_LABEL[item.kind]).join(', ')}. Hide
              something, remove it, or make a line single height.
            </AppText>
          </View>
        </Card>
      )}

      {/* ------------------------------------------------------------- items */}

      <SectionHeader
        label="Items"
        detail={
          layout.items.length === 0
            ? 'Empty layout'
            : `${layout.items.length} in the layout · ${layout.items.length - hidden} shown · ${
                frame.rowsUsed
              }/${OLED_ROWS} rows used`
        }
      />

      {layout.items.length === 0 ? (
        <Card style={styles.emptyCard}>
          <AppText variant="body" color={palette.textSecondary} center>
            Nothing in this layout. Add a title, a line of text, or one of the live readouts
            below.
          </AppText>
        </Card>
      ) : (
        <View style={styles.group}>
          {layout.items.map((item, index) => (
            <ItemRow
              key={item.id}
              item={item}
              index={index}
              total={layout.items.length}
              onPress={() => setEditingId(item.id)}
              last={index === layout.items.length - 1}
            />
          ))}
        </View>
      )}

      {hidden > 0 && (
        <ActionButton
          label={`Restore ${hidden} hidden ${hidden === 1 ? 'item' : 'items'}`}
          tone="secondary"
          icon="eye"
          onPress={() => dispatch({ type: 'restoreAllHidden' })}
          // Same wording as the visible label, pluralised the same way: a
          // screen reader should not hear "1 hidden items".
          accessibilityLabel={`Restore ${hidden} hidden ${hidden === 1 ? 'item' : 'items'}`}
          accessibilityHint="Shows every hidden item on the panel again"
        />
      )}

      <Card style={styles.card}>
        <View style={styles.cardHead}>
          <AppText variant="label">Add an item</AppText>
          {atCapacity && <Badge label={`Limit ${MAX_ITEM_COUNT}`} tone="neutral" />}
        </View>

        <View style={styles.chips}>
          {OLED_ITEM_KINDS.map((kind) => (
            <Chip
              key={kind}
              icon="plus"
              label={OLED_KIND_LABEL[kind]}
              disabled={atCapacity}
              onPress={() => dispatch({ type: 'add', kind })}
              accessibilityLabel={`Add ${OLED_KIND_LABEL[kind]}`}
            />
          ))}
        </View>

        <AppText variant="caption" color={palette.textMuted}>
          {atCapacity
            ? `The layout holds ${MAX_ITEM_COUNT} items. Remove one to add another.`
            : 'Every item can be reordered, hidden, retyped and removed from its own editor.'}
        </AppText>
      </Card>

      {/* --------------------------------------------------------- animation */}

      <SectionHeader label="Loading animation" />
      <Card style={styles.card}>
        <SegmentedControl
          options={LOADING_OPTIONS}
          value={layout.loadingStyle}
          onChange={(style) => dispatch({ type: 'setLoadingStyle', style })}
          accessibilityLabel="Loading indicator style"
        />

        <View style={styles.speedRow}>
          <AppText variant="body">Frame period</AppText>
          <AppText variant="reading">{formatDuration(layout.animationMs)}</AppText>
        </View>

        <SegmentedControl
          options={ANIMATION_SPEEDS.map((ms) => ({
            value: String(ms),
            label: formatDuration(ms),
          }))}
          value={String(nearestSpeed(layout.animationMs))}
          onChange={(value) => dispatch({ type: 'setAnimationMs', ms: Number(value) })}
          accessibilityLabel="Loading animation frame period"
        />

        <AppText variant="caption" color={palette.textMuted}>
          {layout.loadingStyle === 'none'
            ? 'No indicator is drawn, so no timer runs.'
            : 'The frame counter runs only while this screen is open and the layout has a visible loading item. Leaving the tab stops it rather than hiding a running one.'}
        </AppText>
      </Card>

      {/* ----------------------------------------------------------- presets */}

      <SectionHeader label="Presets" detail={`${presets.length} of ${MAX_PRESETS}`} />

      {presets.length === 0 ? (
        <Card style={styles.emptyCard}>
          <AppText variant="body" color={palette.textSecondary} center>
            No presets saved. A preset is a copy of the current layout, so editing the layout
            afterwards leaves it unchanged.
          </AppText>
        </Card>
      ) : (
        <View style={styles.group}>
          {presets.map((preset, index) => (
            <ListRow
              key={preset.id}
              label={preset.name}
              description={`${preset.layout.items.length} items · ${formatDate(
                preset.createdAtMs,
              )}`}
              icon="clock"
              last={index === presets.length - 1}
              accessory={
                <View style={styles.presetActions}>
                  <ActionButton
                    label="Load"
                    compact
                    tone="secondary"
                    onPress={() => applyPreset(preset.id)}
                    accessibilityLabel={`Load preset ${preset.name}`}
                  />
                  <IconButton
                    icon="trash"
                    tone="danger"
                    onPress={() => deletePreset(preset.id)}
                    accessibilityLabel={`Delete preset ${preset.name}`}
                  />
                </View>
              }
            />
          ))}
        </View>
      )}

      <View style={styles.footerActions}>
        <ActionButton
          label="Save as preset"
          tone="secondary"
          icon="plus"
          onPress={() => setPresetSheetOpen(true)}
          accessibilityLabel="Save current layout as a preset"
        />
        <ActionButton
          label="Reset layout"
          tone="ghost"
          icon="refresh"
          disabled={!customised}
          onPress={() => setConfirmReset(true)}
          accessibilityLabel="Reset layout to defaults"
          accessibilityHint={
            customised
              ? 'Asks for confirmation, because it discards your changes'
              : 'The layout is already at its defaults'
          }
        />
      </View>

      <AppText variant="caption" color={palette.textMuted}>
        A value with nothing behind it is drawn as {OLED_NO_VALUE}, not as a zero. The battery
        line always reads {OLED_NO_VALUE} — no pack has ever reported to this app.
      </AppText>

      {/* ------------------------------------------------------------ sheets */}

      <ItemEditor
        item={editing}
        index={editingIndex}
        total={layout.items.length}
        onClose={closeEditor}
        onDispatch={dispatch}
      />

      <Sheet
        visible={presetSheetOpen}
        onClose={closePresetSheet}
        title="Save preset"
        description={`Stores a copy of the current layout. The newest ${MAX_PRESETS} are kept.`}
        footer={
          <>
            <ActionButton
              label="Save preset"
              onPress={commitPreset}
              disabled={presetName.trim().length === 0}
            />
            <ActionButton label="Cancel" tone="ghost" onPress={closePresetSheet} />
          </>
        }
      >
        <TextField
          label="Preset name"
          value={presetName}
          onChangeText={setPresetName}
          placeholder="Evening class"
          maxLength={24}
          autoFocus
          hint={
            presetName.trim().length === 0
              ? 'A name is required'
              : `${presetName.trim().length}/24`
          }
          invalid={presetName.trim().length === 0}
        />
      </Sheet>

      {/*
        Destructive, so it is confirmed — and the confirmation names what is lost
        rather than asking a generic "are you sure?".
      */}
      <ConfirmDialog
        visible={confirmReset}
        title="Reset layout?"
        message={
          hidden > 0
            ? `This discards your layout and restores the default one, including bringing back ${hidden} hidden ${
                hidden === 1 ? 'item' : 'items'
              }. Saved presets are kept.`
            : 'This discards your layout and restores the default one. Saved presets are kept.'
        }
        confirmLabel="Reset"
        cancelLabel="Keep my layout"
        destructive
        onConfirm={() => {
          dispatch({ type: 'reset' });
          setConfirmReset(false);
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </Screen>
  );
}

/* --------------------------------------------------------------- sub-parts */

function ItemRow({
  item,
  index,
  total,
  onPress,
  last,
}: {
  item: OledItem;
  index: number;
  total: number;
  onPress: () => void;
  last: boolean;
}): React.JSX.Element {
  const { palette } = useTheme();

  return (
    <ListRow
      label={OLED_KIND_LABEL[item.kind]}
      // A preview of what the row will say — the authored text, or a plain
      // statement that the text comes from somewhere else.
      value={describeItem(item)}
      valueColor={item.visible ? palette.textSecondary : palette.textMuted}
      description={`${index + 1} of ${total} · ${
        item.kind === 'loading'
          ? 'Animated'
          : item.size === 'large'
            ? 'Double height'
            : 'Single height'
      } · ${ALIGN_LABEL[item.align]} · ${item.visible ? 'shown' : 'hidden'}`}
      icon={item.visible ? 'eye' : 'eyeOff'}
      onPress={onPress}
      last={last}
    />
  );
}

function ItemEditor({
  item,
  index,
  total,
  onClose,
  onDispatch,
}: {
  item: OledItem | null;
  index: number;
  total: number;
  onClose: () => void;
  onDispatch: (intent: OledIntent) => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  // The sheet stays mounted through its exit animation, so it needs the item it
  // was last showing: `editingId` is cleared the instant it starts closing, and
  // rendering `null` there would collapse the panel mid-slide.
  const retained = useRef<OledItem | null>(null);
  if (item !== null) retained.current = item;
  const shown = retained.current;

  // Drafts are re-seeded only when a *different* item is opened. Re-seeding on
  // every render would fight the user's typing, because each keystroke produces
  // a new item object from the reducer.
  const [seededId, setSeededId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  if (shown !== null && shown.id !== seededId) {
    setSeededId(shown.id);
    setDraftLabel(shown.label);
  }

  if (shown === null) {
    return <Sheet visible={false} onClose={onClose} title="" />;
  }

  const editable = EDITABLE_KINDS.has(shown.kind);
  const maxChars = columnsFor(shown.size);
  const overlong = draftLabel.length > maxChars;

  return (
    <Sheet
      visible={item !== null}
      onClose={onClose}
      title={OLED_KIND_LABEL[shown.kind]}
      description={`Item ${index + 1} of ${total}. Changes reach the preview immediately and are saved as you go.`}
      footer={
        <>
          <ActionButton label="Done" onPress={onClose} />
          <ActionButton
            label="Delete item"
            tone="danger"
            icon="trash"
            onPress={() => {
              onDispatch({ type: 'remove', id: shown.id });
              onClose();
            }}
            accessibilityLabel={`Delete ${OLED_KIND_LABEL[shown.kind]}`}
          />
        </>
      }
    >
      <View style={styles.editor}>
        <AppText variant="caption" color={palette.textMuted}>
          What this row shows
        </AppText>
        <View style={styles.chips}>
          {OLED_ITEM_KINDS.map((kind) => (
            <Chip
              key={kind}
              label={OLED_KIND_LABEL[kind]}
              selected={kind === shown.kind}
              onPress={() => onDispatch({ type: 'setKind', id: shown.id, kind })}
              accessibilityLabel={OLED_KIND_LABEL[kind]}
            />
          ))}
        </View>

        {editable ? (
          <TextField
            label="Text"
            value={draftLabel}
            onChangeText={(next) => {
              setDraftLabel(next);
              onDispatch({ type: 'setLabel', id: shown.id, label: next });
            }}
            placeholder={shown.kind === 'title' ? 'SANKET VAANNI' : 'Text'}
            maxLength={MAX_LABEL_LENGTH}
            hint={
              overlong
                ? `${draftLabel.length} characters — the panel fits ${maxChars} at this height, so the rest will be cut off`
                : `${draftLabel.length}/${maxChars} characters at this height`
            }
            invalid={overlong}
          />
        ) : (
          <View style={[styles.editorNote, { backgroundColor: palette.surfaceSunken }]}>
            <Icon name="info" size={14} color={palette.textSecondary} />
            <AppText
              variant="caption"
              color={palette.textSecondary}
              style={styles.editorNoteText}
            >
              {shown.kind === 'loading'
                ? 'This row draws the animated indicator. Its characters come from the animation, so there is nothing to type.'
                : 'This row shows a live value from the glove. Its text is supplied by the device, so there is nothing to type — and when nothing has reported, it draws a placeholder rather than a guess.'}
            </AppText>
          </View>
        )}

        {shown.kind !== 'loading' && (
          <>
            <AppText variant="caption" color={palette.textMuted} style={styles.editorLabel}>
              Height
            </AppText>
            <SegmentedControl
              options={SIZE_OPTIONS}
              value={shown.size}
              onChange={(size) => onDispatch({ type: 'setSize', id: shown.id, size })}
              accessibilityLabel="Row height"
            />

            <AppText variant="caption" color={palette.textMuted} style={styles.editorLabel}>
              Alignment
            </AppText>
            <SegmentedControl
              options={ALIGN_OPTIONS}
              value={shown.align}
              onChange={(align) => onDispatch({ type: 'setAlign', id: shown.id, align })}
              accessibilityLabel="Text alignment"
            />
          </>
        )}

        <View style={styles.editorRow}>
          <View style={styles.editorRowText}>
            <AppText variant="body">Shown on the panel</AppText>
            <AppText variant="caption" color={palette.textMuted}>
              Hiding keeps the row here so it can be brought back.
            </AppText>
          </View>
          <Toggle
            value={shown.visible}
            onValueChange={(visible) => onDispatch({ type: 'setVisible', id: shown.id, visible })}
            accessibilityLabel={`Show ${OLED_KIND_LABEL[shown.kind]} on the panel`}
          />
        </View>

        <View style={styles.editorRow}>
          <View style={styles.editorRowText}>
            <AppText variant="body">Position</AppText>
            <AppText variant="caption" color={palette.textMuted}>
              {index + 1} of {total}, top to bottom. A move steps over hidden rows, so one press
              is always one position.
            </AppText>
          </View>
          <View style={styles.editorRowActions}>
            <IconButton
              icon="arrowUp"
              onPress={() => onDispatch({ type: 'move', id: shown.id, direction: 'up' })}
              disabled={index === 0}
              accessibilityLabel={`Move ${OLED_KIND_LABEL[shown.kind]} up`}
            />
            <IconButton
              icon="arrowDown"
              onPress={() => onDispatch({ type: 'move', id: shown.id, direction: 'down' })}
              disabled={index === total - 1}
              accessibilityLabel={`Move ${OLED_KIND_LABEL[shown.kind]} down`}
            />
          </View>
        </View>
      </View>
    </Sheet>
  );
}

/**
 * A pill-shaped button.
 *
 * Two roles, distinguished by more than colour: an *action* chip carries a plus
 * and is never selected, a *choice* chip carries a check when selected. One
 * creates an item, the other changes one, and they should not be mistakable.
 */
function Chip({
  label,
  icon,
  selected = false,
  disabled = false,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  icon?: 'plus';
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const tint = disabled ? palette.textMuted : selected ? palette.accent : palette.textSecondary;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={selected ? 'radio' : 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled }}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: selected ? palette.accent : palette.border },
        selected && { backgroundColor: palette.accentSurface },
        pressed && !disabled && styles.chipPressed,
        disabled && styles.chipDisabled,
      ]}
    >
      {(icon !== undefined || selected) && (
        <Icon name={selected ? 'check' : (icon as 'plus')} size={14} color={tint} />
      )}
      <AppText variant="label" color={tint}>
        {label}
      </AppText>
    </Pressable>
  );
}

/* ----------------------------------------------------------------- helpers */

/**
 * What a row will say, as briefly as a list row can show it.
 *
 * Authoring kinds show their own text; bound kinds say where the text comes
 * from instead of showing a sample of it, which would read as a stored value.
 */
function describeItem(item: OledItem): string {
  if (item.kind === 'title' || item.kind === 'text') {
    return item.label.length > 0 ? item.label : 'Empty';
  }
  if (item.kind === 'loading') return 'Animated';
  return 'Live value';
}

/** Picks the offered frame period nearest to a stored value, which may be any number. */
function nearestSpeed(ms: number): number {
  return ANIMATION_SPEEDS.reduce((best, candidate) =>
    Math.abs(candidate - ms) < Math.abs(best - ms) ? candidate : best,
  );
}

/** Short date for a preset row. Locale-dependent, unlike anything on the panel. */
function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'date unknown';
  return new Date(ms).toLocaleDateString();
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    notice: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      borderWidth: 1,
    },
    noticeText: {
      flex: 1,
      gap: 2,
    },
    sideSelector: {
      // Stacked for the same measured reason as the Dashboard's `scopeSelector`:
      // the caption and this control do not share a line without overflowing.
      gap: spacing.sm,
    },
    card: {
      gap: spacing.md,
    },
    cardHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    emptyCard: {
      alignItems: 'center',
    },
    group: {
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      overflow: 'hidden',
      paddingHorizontal: spacing.lg,
    },
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs + 2,
      minHeight: MIN_TOUCH_TARGET,
      paddingHorizontal: spacing.md,
      borderRadius: radii.pill,
      borderWidth: 1,
      backgroundColor: palette.surfaceSunken,
    },
    chipPressed: {
      opacity: 0.7,
    },
    chipDisabled: {
      opacity: 0.4,
    },
    presetActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    speedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    footerActions: {
      gap: spacing.sm,
    },
    editor: {
      gap: spacing.sm,
    },
    editorLabel: {
      marginTop: spacing.md,
    },
    editorNote: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.sm,
    },
    editorNoteText: {
      flex: 1,
    },
    editorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginTop: spacing.md,
    },
    editorRowText: {
      flex: 1,
      gap: 2,
    },
    editorRowActions: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
  });
