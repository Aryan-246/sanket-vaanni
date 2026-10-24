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
import { useAppState, useGlove, useGloveActions, useLiveTranslation } from '../app/AppState';
import { formatDuration } from '../app/format';
import {
  ANIMATION_SPEEDS,
  columnsFor,
  hiddenCount,
  isCustomised,
  MAX_ITEM_COUNT,
  MAX_LABEL_LENGTH,
  OLED_HEIGHT,
  OLED_ITEM_KINDS,
  OLED_KIND_LABEL,
  OLED_KIND_NEEDS_TELEMETRY,
  OLED_NO_VALUE,
  OLED_ROWS,
  OLED_TIMING_LABEL,
  OLED_WIDTH,
  type OledAlign,
  type OledItem,
  type OledItemKind,
  type OledItemTiming,
  type OledLayout,
  type OledLoadingStyle,
  type OledPhase,
  type OledTextSize,
  type OledValues,
} from '../oled/layout';
import {
  clampIntroMs,
  INTRO_DURATION_PRESETS,
  MAX_INTRO_MS,
  MAX_PROFILE_NAME,
  MAX_PROFILES,
  startupViewIsDistinct,
  type OledProfile,
} from '../oled/profiles';
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

const TIMING_OPTIONS: readonly { value: OledItemTiming; label: string }[] = [
  { value: 'always', label: 'Always' },
  { value: 'startup', label: 'Startup only' },
];

const PHASE_OPTIONS: readonly { value: OledPhase; label: string }[] = [
  { value: 'persistent', label: 'Running view' },
  { value: 'startup', label: 'Startup view' },
];

/** Kinds whose text the user authors. Bound kinds read from live values. */
const EDITABLE_KINDS: ReadonlySet<OledItemKind> = new Set(['title', 'text']);

const ALIGN_LABEL: Record<OledAlign, string> = {
  left: 'left',
  center: 'centre',
  right: 'right',
};

/**
 * Bytes one full frame occupies in the panel's own memory.
 *
 * 128 × 64 pixels at one bit per pixel. Arithmetic on the geometry, not a
 * measurement: it says what a *single* frame costs, not how fast one can be
 * sent. The transport's budget is unknown, which is why the media section
 * promises no frame count and no playback rate.
 */
const FRAME_BYTES = (OLED_WIDTH * OLED_HEIGHT) / 8;

/** What a name sheet is being used for. */type NameMode = 'create' | 'saveAsNew' | 'rename';

/**
 * The "no startup view" label.
 *
 * Deliberately not "Off": the word already means whether the *panel* is wanted
 * on, and one screen using it for two unrelated settings is how a user ends up
 * reading the wrong one.
 */
const NO_HOLD = 'No hold';
/** A pending destructive action, held here so the dialog can name its target. */
type Confirm =
  | { readonly kind: 'restore' }
  | { readonly kind: 'delete'; readonly id: string; readonly name: string }
  /**
   * Unsaved edits are about to be lost. `next` is whatever the user was trying
   * to do, run only after they confirm discarding.
   */
  | { readonly kind: 'discard'; readonly next: (() => void) | null };

export interface OledScreenProps {
  /** Injectable clock, so tests can assert profile timestamps without real time. */
  now?: () => number;
}

/**
 * OLED Studio.
 *
 * ## What this is for
 *
 * Designing what each glove's 128×64 panel will show: which lines appear, in
 * what order, in which of the panel's two views, and how it starts up. Left and
 * right are separate panels and are configured separately; a *profile* saves
 * both of them together under one name.
 *
 * ## What it does not do
 *
 * It does not talk to hardware. There is no serialiser and no command encoder,
 * and no BLE characteristic has been verified — so nothing is sent anywhere. Two
 * things on this screen could be read as a hardware remote control and are
 * therefore labelled where they appear rather than in a menu:
 *
 *  - the preview is marked **Demo Preview**, in the header and in the notice
 *    above the canvas;
 *  - each hand's on/off is labelled **desired**, and the panel's own state is
 *    reported as *not reported* rather than inferred from that flag. A saved
 *    `On` is not evidence the panel is lit.
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
  const {
    profiles,
    active,
    isLoaded,
    isDirty,
    save,
    discard,
    run,
    setEnabled,
    setIntro,
    setLayout,
    createProfile,
    saveAsNew,
    renameProfile,
    duplicateProfile,
    switchProfile,
    deleteProfile,
    restoreActive,
  } = studio;

  const [side, setSide] = useState<GloveSide>('right');
  const [phase, setPhase] = useState<OledPhase>('persistent');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [nameMode, setNameMode] = useState<NameMode | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  /*
   * Everything on this screen renders the *draft*, not the committed profile.
   * The preview and the controls therefore reflect unsaved edits immediately,
   * while storage still holds the last saved configuration until Save.
   */
  const hand = studio.draft[side];
  const { layout, intro } = hand;

  const glove = useGlove(side);
  const actions = useGloveActions(side);
  const isHardwareConnected = glove.link.kind === 'connected' && !glove.synthetic;
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const handleApplyToGlove = useCallback(async () => {
    if (!isHardwareConnected || !actions.sendOledCommand) return;
    try {
      setIsSyncing(true);
      setSyncStatus('Applying layout to glove hardware...');
      const titleItem = layout.items.find((i) => i.kind === 'title' && i.visible);
      const batteryItem = layout.items.find((i) => i.kind === 'battery' && i.visible);
      const cmd: Record<string, unknown> = {
        set_layout: 1,
        titleX: titleItem ? 0 : 0,
        titleY: 0,
        batteryX: batteryItem ? 80 : 80,
        batteryY: 0,
        tempX: 80,
        tempY: 16,
      };
      await actions.sendOledCommand(cmd);
      setSyncStatus('✓ Layout saved to glove NVS.');
    } catch (err) {
      setSyncStatus(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSyncing(false);
    }
  }, [actions, isHardwareConnected, layout.items]);

  const handleRestoreDefault = useCallback(async () => {
    if (!isHardwareConnected || !actions.sendOledCommand) return;
    try {
      setIsSyncing(true);
      setSyncStatus('Restoring factory default layout on glove...');
      await actions.sendOledCommand({ restore_default: 1 });
      setSyncStatus('✓ Factory default layout restored.');
    } catch (err) {
      setSyncStatus(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSyncing(false);
    }
  }, [actions, isHardwareConnected]);

  // The shared outcome — there is no per-glove recogniser any more. `oledValuesFrom`
  // drops a result that this hand did not produce, so the panel still only ever
  // shows its own glove's sign.
  const { outcome } = useLiveTranslation();

  const values: OledValues = useMemo(() => oledValuesFrom(glove, outcome), [glove, outcome]);

  // The animation runs only while this screen is mounted — and since only the
  // active tab is mounted, that means only while the user is looking at it.
  const frame = useOledFrame(layout, values, true, phase);

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
  const handName = side === 'left' ? 'Left' : 'Right';

  const startupOnly = layout.items.filter(
    (item) => item.timing === 'startup' && item.visible,
  ).length;

  const dispatch = useCallback((intent: OledIntent) => run(side, intent), [run, side]);

  /*
   * The item editor is a *nested* editor. It opens over a draft that may already
   * hold unsaved edits, so "close" has to mean "cancel what I did in here"
   * rather than "keep it" — otherwise the X button silently keeps changes, which
   * is the exact defect this milestone fixes.
   *
   * It therefore snapshots the layout when it opens and puts it back on the way
   * out. `keepEditor` is the deliberate opposite: it closes and leaves the edits
   * in the draft, still pending the studio's Save.
   */
  const [editorSnapshot, setEditorSnapshot] = useState<OledLayout | null>(null);

  const openEditor = useCallback(
    (id: string) => {
      setEditorSnapshot(layout);
      setEditingId(id);
    },
    [layout],
  );

  /** X, back and the scrim: discard what this sheet changed. */
  const closeEditor = useCallback(() => {
    if (editorSnapshot !== null) setLayout(side, editorSnapshot);
    setEditorSnapshot(null);
    setEditingId(null);
  }, [editorSnapshot, setLayout, side]);

  /** The sheet's explicit "Done": keep the edits in the draft. */
  const keepEditor = useCallback(() => {
    setEditorSnapshot(null);
    setEditingId(null);
  }, []);

  /**
   * Runs an action that would throw the draft away, asking first if there is
   * anything to lose. With nothing pending there is no question to ask, so the
   * action just happens.
   */
  const guarded = useCallback(
    (next: () => void) => {
      if (isDirty) setConfirm({ kind: 'discard', next });
      else next();
    },
    [isDirty],
  );

  const closeNameSheet = useCallback(() => {
    setNameMode(null);
    setRenameTarget(null);
    setDraftName('');
  }, []);

  const commitName = useCallback(() => {
    const name = draftName.trim();
    if (name.length === 0) return;
    if (nameMode === 'create') createProfile(name);
    if (nameMode === 'saveAsNew') saveAsNew(name);
    if (nameMode === 'rename' && renameTarget !== null) renameProfile(renameTarget, name);
    closeNameSheet();
  }, [closeNameSheet, createProfile, draftName, nameMode, renameProfile, renameTarget, saveAsNew]);

  const openNameSheet = useCallback((mode: NameMode, target: string | null, initial: string) => {
    setNameMode(mode);
    setRenameTarget(target);
    setDraftName(initial);
  }, []);

  return (
    <Screen
      scroll
      bottomInset={screenLayout.tabBarHeight}
      testID="oled-screen"
      /*
       * Pinned, because the controls that make a draft dirty are spread over a
       * long screen: an edit made next to the intro settings must not require
       * scrolling back up to commit. It appears only when there is something to
       * commit, so a settled studio shows no bar at all.
       */
      stickyFooter={
        isDirty ? (
          <Card style={styles.dirtyBar}>
            <View style={styles.dirtyText}>
              <AppText variant="label" color={palette.warning}>
                Unsaved changes
              </AppText>
              <AppText variant="caption" color={palette.textMuted}>
                {`“${active.name}” is not stored yet.`}
              </AppText>
            </View>
            <View style={styles.dirtyActions}>
              <ActionButton
                label="Discard"
                tone="ghost"
                onPress={discard}
                accessibilityLabel="Discard unsaved changes"
              />
              <ActionButton
                label="Save"
                onPress={save}
                accessibilityLabel="Save this profile"
              />
            </View>
          </Card>
        ) : undefined
      }
    >
      <ScreenHeader
        title="OLED Studio"
        subtitle={`Monochrome ${OLED_WIDTH} × ${OLED_HEIGHT} panel · preview only`}
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
            {isLoaded
              ? 'Nothing here is sent to hardware. No OLED command set and no BLE characteristic has been verified, so a physical panel will not change until firmware exists.'
              : 'Reading your saved profiles…'}
          </AppText>
        </View>
      </Card>

      {/* ------------------------------------------------------------ profile */}

      <SectionHeader
        label="Profile"
        detail={`${profiles.length} of ${MAX_PROFILES}`}
      />

      <Card style={styles.card}>
        <View style={styles.cardHead}>
          <View style={styles.cardHeadText}>
            <AppText variant="label" numberOfLines={1}>
              {active.name}
            </AppText>
            <AppText variant="caption" color={palette.textMuted}>
              Left and right panel configurations are saved together in a profile.
            </AppText>
          </View>
          <Badge label="Active" tone="accent" />
        </View>

        <ActionButton
          label="Manage profiles"
          tone="secondary"
          icon="eye"
          onPress={() => setProfilesOpen(true)}
          accessibilityLabel="Manage OLED profiles"
          accessibilityHint="Create, rename, duplicate, switch, delete or restore a profile"
        />
      </Card>

      {/* -------------------------------------------------------- which hand */}

      <SectionHeader label="Panel" detail={`Editing the ${handName.toLowerCase()} glove`} />

      {/*
        This is a per-hand *editor*, not a mode the rest of the app inherits: the
        Dashboard shows both hands at once and needs no chooser. Left and right
        are separate physical panels, so configuring one at a time is the honest
        shape for the work.
      */}
      <SegmentedControl
        options={SIDE_OPTIONS}
        value={side}
        onChange={setSide}
        accessibilityLabel="Which glove's panel to edit"
      />

      {/* Hardware sync card */}
      <Card style={styles.card}>
        <View style={styles.cardHead}>
          <View style={styles.cardHeadText}>
            <AppText variant="label">
              {isHardwareConnected
                ? `Hardware Linked: ${handName} (${glove.link.deviceName ?? 'SanketVaanni'})`
                : `${handName} Glove Disconnected`}
            </AppText>
            <AppText variant="caption" color={palette.textMuted}>
              {isHardwareConnected
                ? 'Send customized coordinates or restore locked factory defaults on physical SSD1306.'
                : 'Connect this glove in the Dashboard tab to send commands to physical OLED.'}
            </AppText>
          </View>
          <Badge
            label={isHardwareConnected ? 'Hardware Linked' : 'Offline'}
            tone={isHardwareConnected ? 'success' : 'neutral'}
          />
        </View>

        {syncStatus && (
          <AppText variant="caption" color={palette.accent}>
            {syncStatus}
          </AppText>
        )}

        {isHardwareConnected && (
          <View style={styles.dirtyActions}>
            <ActionButton
              label="Restore Default"
              tone="ghost"
              disabled={isSyncing}
              onPress={handleRestoreDefault}
              accessibilityLabel="Restore default OLED layout on hardware"
            />
            <ActionButton
              label="Apply to Glove"
              busy={isSyncing}
              onPress={handleApplyToGlove}
              accessibilityLabel="Apply layout to glove OLED"
            />
          </View>
        )}
      </Card>

      <Card style={styles.card}>
        <View style={styles.stateRow}>
          <View style={styles.stateRowText}>
            <AppText variant="body">{handName} panel desired</AppText>
            <AppText variant="caption" color={palette.textMuted}>
              A saved On is a desired setting, not a report from the hardware.
            </AppText>
          </View>
          <Toggle
            value={hand.enabled}
            onValueChange={(next) => setEnabled(side, next)}
            accessibilityLabel={`Desired: ${handName.toLowerCase()} panel on`}
          />
        </View>

        <View style={styles.divider} />

        <Detail label="Desired" value={hand.enabled ? 'On' : 'Off'} />
        <Detail
          label="Reported by the panel"
          value="Not reported"
          note="The app has no read-back, so it cannot know whether this panel is lit."
        />
      </Card>

      {/* ---------------------------------------------------------- preview */}

      <SectionHeader label="Preview" />

      <SegmentedControl
        options={PHASE_OPTIONS}
        value={phase}
        onChange={setPhase}
        accessibilityLabel="Which panel view to preview"
      />

      <OledCanvas frame={frame} scale={scale} testID="oled-canvas" />

      <AppText variant="caption" color={palette.textMuted} center>
        {phase === 'startup' ? 'Startup view' : 'Running view'} at {scale.toFixed(1)}× ·{' '}
        {columnsFor('normal')} columns × {OLED_ROWS} rows of 6×8 cells · letterforms come from the
        platform monospace face, not the panel's own font
      </AppText>

      {phase === 'persistent' && startupOnly > 0 && (
        <AppText variant="caption" color={palette.textMuted}>
          {startupOnly === 1
            ? '1 item belongs to the startup view, so it is not drawn here.'
            : `${startupOnly} items belong to the startup view, so they are not drawn here.`}{' '}
          Switch to the Startup view to see them.
        </AppText>
      )}

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
              This view has {OLED_ROWS} rows and {frame.rowsUsed} are used, so these are not
              drawn — and would not be drawn on a physical panel either:{' '}
              {frame.overflow.map((item) => OLED_KIND_LABEL[item.kind]).join(', ')}. Hide
              something, remove it, or move it to the other view.
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
              onPress={() => openEditor(item.id)}
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
          accessibilityHint="Shows every hidden item in the panel view again"
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
            : 'Every item can be reordered, hidden, retyped, moved between views and removed from its own editor.'}
        </AppText>

        <AppText variant="caption" color={palette.textMuted}>
          Battery is the one item with no source: no pack has ever reported a percentage to this
          app, so it draws {OLED_NO_VALUE} and is marked as awaiting telemetry.
        </AppText>
      </Card>

      {/* --------------------------------------------------- startup view */}

      <SectionHeader label="Startup view" />
      <Card style={styles.card}>
        <View style={styles.stateRow}>
          <View style={styles.stateRowText}>
            <AppText variant="body">Hold the startup view</AppText>
            <AppText variant="caption" color={palette.textMuted}>
              How long the {handName.toLowerCase()} panel stays on startup content before the
              running view takes over. Requires firmware support for a startup view.
            </AppText>
          </View>
          <AppText variant="reading">
            {intro.durationMs === 0 ? NO_HOLD : formatDuration(intro.durationMs)}
          </AppText>
        </View>

        <SegmentedControl
          options={INTRO_DURATION_PRESETS.map((ms) => ({
            value: String(ms),
            label: ms === 0 ? NO_HOLD : formatDuration(ms),
          }))}
          /*
           * A stored hold need not be one of the presets — the field below takes
           * any value in range. Passing the empty string then leaves nothing
           * highlighted, which is the honest state: none of these four *is* the
           * setting. Highlighting the nearest one would show a value the user
           * did not choose.
           */
          value={introDurationPreset(intro.durationMs)}
          onChange={(value) => setIntro(side, { durationMs: clampIntroMs(Number(value)) })}
          accessibilityLabel="Startup view hold duration"
        />

        <TextField
          label="Exact hold, in milliseconds"
          value={String(intro.durationMs)}
          onChangeText={(text) => {
            const parsed = Number(text.replace(/[^0-9]/g, ''));
            setIntro(side, { durationMs: clampIntroMs(parsed) });
          }}
          keyboardType="number-pad"
          maxLength={5}
          hint={`0 to ${MAX_INTRO_MS}. Edits stay in the preview until you press Save.`}
        />

        <View style={styles.stateRow}>
          <View style={styles.stateRowText}>
            <AppText variant="body">Animate the loading indicator</AppText>
            <AppText variant="caption" color={palette.textMuted}>
              The panel can move an indicator without a converted bitmap sequence.
            </AppText>
          </View>
          <Toggle
            value={intro.animate}
            onValueChange={(next) => setIntro(side, { animate: next })}
            accessibilityLabel="Animate the loading indicator during the startup view"
          />
        </View>

        {intro.durationMs > 0 && !startupViewIsDistinct(layout) && (
          <View style={[styles.inlineWarn, { borderColor: palette.warning }]}>
            <Icon name="warning" size={14} color={palette.warning} />
            <AppText variant="caption" color={palette.textSecondary} style={styles.inlineWarnText}>
              No item is set to Startup only, so the startup view is identical to the running
              view and this hold changes nothing. Set an item's timing, or set the hold to Off.
            </AppText>
          </View>
        )}
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

        <View style={styles.stateRow}>
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
            : 'The frame counter runs only while this screen is open and this view has a visible loading item. Leaving the tab stops it rather than hiding a running one.'}
        </AppText>
      </Card>

      {/* ------------------------------------------------------------- media */}

      <SectionHeader label="Images and animations" />
      {/*
        Deliberately a notice and not a picker. No image decoder or dithering step
        exists in this build, so a control here would open a picker and produce
        nothing. The constraint below is the part that is real — the panel's own
        geometry — and the rest says the conversion is absent. The workflow that
        would fill this in, and the verification it is blocked on, are recorded in
        `docs/oled-media.md`.
      */}
      <Card style={styles.card}>
        <View style={styles.cardHead}>
          <AppText variant="label">Bitmap and frame-sequence items</AppText>
          <Badge label="Not implemented" tone="warning" />
        </View>

        {/*
          One paragraph, not two. The first used to name the app's own missing
          image decoder and dither step, and the second restated the transport
          caveat the standing warning already carries. What is load-bearing stays:
          the conversion is absent, and the frame size is the one figure here that
          is arithmetic rather than a measurement.
        */}
        <AppText variant="caption" color={palette.textSecondary}>
          A still image would have to be converted to a monochrome {OLED_WIDTH} × {OLED_HEIGHT}
          one-bit bitmap — {FRAME_BYTES} bytes per frame — and that conversion is not part of this
          build, so there is nothing here to preview and no control that would pretend otherwise.
        </AppText>
      </Card>

      <View style={styles.footerActions}>
        <ActionButton
          label="Restore defaults"
          tone="ghost"
          icon="refresh"
          disabled={!customised}
          onPress={() => setConfirm({ kind: 'restore' })}
          accessibilityLabel="Restore this profile's defaults"
          accessibilityHint={
            customised
              ? 'Asks for confirmation, because it discards both hands of this profile'
              : 'Both hands of this profile are already at their defaults'
          }
        />
      </View>

      <AppText variant="caption" color={palette.textMuted}>
        A value with nothing behind it is drawn as {OLED_NO_VALUE}, not as a zero.
      </AppText>

      {/* ------------------------------------------------------------ sheets */}

      <ItemEditor
        item={editing}
        index={editingIndex}
        total={layout.items.length}
        onClose={closeEditor}
        onKeep={keepEditor}
        onDispatch={dispatch}
      />

      <ProfilesSheet
        visible={profilesOpen}
        onClose={() => setProfilesOpen(false)}
        profiles={profiles}
        activeId={active.id}
        // Switching, creating and duplicating all move the active profile, and
        // the draft is bound to it — so each would drop unsaved edits. They ask
        // first, but only when there is something to lose.
        onSwitch={(id) => guarded(() => switchProfile(id))}
        onDuplicate={(id) => guarded(() => duplicateProfile(id))}
        onDelete={(id, name) => {
          setProfilesOpen(false);
          const ask = (): void => setConfirm({ kind: 'delete', id, name });
          // Deleting some other profile costs nothing; deleting the one being
          // edited costs the draft, so that case asks about the draft first.
          if (isDirty && id === active.id) setConfirm({ kind: 'discard', next: ask });
          else ask();
        }}
        onRename={(id, name) => openNameSheet('rename', id, name)}
        onCreate={() => guarded(() => openNameSheet('create', null, ''))}
        // Not guarded: this copies the *draft*, so the edits the user has made
        // are carried into the new profile rather than lost.
        onSaveAsNew={() => openNameSheet('saveAsNew', null, `${active.name} copy`)}
      />

      <Sheet
        visible={nameMode !== null}
        onClose={closeNameSheet}
        title={
          nameMode === 'rename'
            ? 'Rename profile'
            : nameMode === 'create'
              ? 'New profile'
              : 'Save as a new profile'
        }
        description={
          nameMode === 'create'
            ? `Starts from the defaults for both hands. The newest ${MAX_PROFILES} profiles are kept.`
            : nameMode === 'saveAsNew'
              ? 'Copies both hands of this profile into a new one, which then becomes active.'
              : 'Renames this profile only. No other saved profile is touched.'
        }
        footer={
          <>
            <ActionButton
              label={nameMode === 'rename' ? 'Rename' : 'Save profile'}
              onPress={commitName}
              disabled={draftName.trim().length === 0}
            />
            <ActionButton label="Cancel" tone="ghost" onPress={closeNameSheet} />
          </>
        }
      >
        <TextField
          label="Profile name"
          value={draftName}
          onChangeText={setDraftName}
          placeholder="Evening class"
          maxLength={MAX_PROFILE_NAME}
          autoFocus
          hint={
            draftName.trim().length === 0
              ? 'A name is required'
              : `${draftName.trim().length}/${MAX_PROFILE_NAME}`
          }
          invalid={draftName.trim().length === 0}
        />
      </Sheet>

      {/*
        Destructive, so it is confirmed — and the confirmation names what is lost
        rather than asking a generic "are you sure?".
      */}
      <ConfirmDialog
        visible={confirm !== null}
        title={
          confirm?.kind === 'delete'
            ? 'Delete this profile?'
            : confirm?.kind === 'discard'
              ? 'Discard unsaved changes?'
              : 'Restore defaults?'
        }
        message={confirmMessage(confirm, active.name, hidden)}
        confirmLabel={
          confirm?.kind === 'delete'
            ? 'Delete'
            : confirm?.kind === 'discard'
              ? 'Discard changes'
              : 'Restore'
        }
        cancelLabel={
          confirm?.kind === 'delete'
            ? 'Keep it'
            : confirm?.kind === 'discard'
              ? 'Keep editing'
              : 'Keep my layout'
        }
        destructive
        onConfirm={() => {
          const pending = confirm;
          setConfirm(null);
          if (pending?.kind === 'delete') deleteProfile(pending.id);
          if (pending?.kind === 'restore') restoreActive();
          if (pending?.kind === 'discard') {
            discard();
            // Whatever the user was trying to do, now that the draft is gone.
            pending.next?.();
          }
        }}
        onCancel={() => setConfirm(null)}
      />
    </Screen>
  );
}

/** What each confirmation is about to discard, said in full. */
function confirmMessage(confirm: Confirm | null, activeName: string, hidden: number): string {
  if (confirm?.kind === 'delete') {
    return `This removes the profile "${confirm.name}" from this device, including both of its panel configurations. No other profile is changed.`;
  }
  if (confirm?.kind === 'discard') {
    return `The changes you have made to "${activeName}" have not been saved. Discarding puts both panels back to the last saved version of this profile. Nothing that has been saved is affected.`;
  }
  /*
   * The restore is a draft edit, so the wording has to promise less than the old
   * version did: it replaces the working copy in front of the user, and storage
   * is not touched until Save. Saying "discards" here without that would read as
   * a write that has already happened.
   */
  const tail = ' Other profiles are kept. Nothing is stored until you press Save.';
  return hidden > 0
    ? `This replaces both hands of "${activeName}" with the default layout, including bringing back ${hidden} hidden ${
        hidden === 1 ? 'item' : 'items'
      }.${tail}`
    : `This replaces both hands of "${activeName}" with the default layout.${tail}`;
}

/* --------------------------------------------------------------- sub-parts */

/** A label and a value, with an optional explanation underneath. */
function Detail({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={styles.detail}>
      <View style={styles.detailHead}>
        <AppText variant="caption" color={palette.textSecondary} style={styles.detailLabel}>
          {label}
        </AppText>
        <AppText variant="label" style={styles.detailValue}>
          {value}
        </AppText>
      </View>
      {note !== undefined && (
        <AppText variant="caption" color={palette.textMuted}>
          {note}
        </AppText>
      )}
    </View>
  );
}

/**
 * The profile list, and everything that can be done to a profile.
 *
 * ## Why the row actions are labelled buttons and not icons
 *
 * There is no pencil in the icon set, and reaching for a wrong glyph — `link`,
 * `info` — to mean "rename" would make the control unguessable. So the two
 * per-row actions that exist say what they are. Everything else acts on the
 * active profile from the footer: switching to a profile and then operating on
 * it is one extra tap, and it means a destructive action is always taken against
 * the profile the user is looking at.
 */
function ProfilesSheet({
  visible,
  onClose,
  profiles,
  activeId,
  onSwitch,
  onDuplicate,
  onDelete,
  onRename,
  onCreate,
  onSaveAsNew,
}: {
  visible: boolean;
  onClose: () => void;
  profiles: readonly OledProfile[];
  activeId: string;
  onSwitch: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  onRename: (id: string, name: string) => void;
  onCreate: () => void;
  onSaveAsNew: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const full = profiles.length >= MAX_PROFILES;
  const active = profiles.find((profile) => profile.id === activeId);
  const lastOne = profiles.length <= 1;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Profiles"
      description="A profile holds both panels. Switching profiles changes which one is being edited and saved — nothing is sent to a glove either way."
      footer={
        <>
          <ActionButton
            label="New profile"
            icon="plus"
            onPress={onCreate}
            disabled={full}
            accessibilityLabel="Create a new profile"
          />
          <ActionButton
            label="Save as a new profile"
            tone="secondary"
            onPress={onSaveAsNew}
            disabled={full}
            accessibilityLabel="Save the active profile as a new one"
          />
          <ActionButton
            label={active === undefined ? 'Delete profile' : `Delete ${active.name}`}
            tone="danger"
            // The last profile cannot be removed: every hand must have a
            // configuration, and an empty set has no active member.
            disabled={lastOne || active === undefined}
            onPress={() => {
              if (active !== undefined) onDelete(active.id, active.name);
            }}
            accessibilityLabel="Delete the active profile"
            accessibilityHint={
              lastOne
                ? 'This is the only profile, so it cannot be deleted'
                : 'Asks for confirmation, because both of its panel configurations are removed'
            }
          />
        </>
      }
    >
      {full && (
        <AppText variant="caption" color={palette.warning}>
          {MAX_PROFILES} profiles is the limit. Delete one to create another.
        </AppText>
      )}

      <View style={styles.group}>
        {profiles.map((profile, index) => {
          const isActive = profile.id === activeId;
          return (
            <ListRow
              key={profile.id}
              label={profile.name}
              description={profileDetail(profile)}
              icon={isActive ? 'check' : 'clock'}
              onPress={isActive ? undefined : () => onSwitch(profile.id)}
              disabled={isActive}
              last={index === profiles.length - 1}
              accessory={
                <View style={styles.rowActions}>
                  {isActive ? (
                    <ActionButton
                      label="Rename"
                      tone="ghost"
                      compact
                      onPress={() => onRename(profile.id, profile.name)}
                      accessibilityLabel={`Rename profile ${profile.name}`}
                    />
                  ) : (
                    <ActionButton
                      label="Duplicate"
                      tone="ghost"
                      compact
                      disabled={full}
                      onPress={() => onDuplicate(profile.id)}
                      accessibilityLabel={`Duplicate profile ${profile.name}`}
                    />
                  )}
                </View>
              }
            />
          );
        })}
      </View>

      {lastOne && (
        <AppText variant="caption" color={palette.textMuted}>
          The last profile cannot be deleted. Create another first if you want to replace this
          one.
        </AppText>
      )}
    </Sheet>
  );
}

function profileDetail(profile: OledProfile): string {
  const left = profile.left.enabled ? 'on' : 'off';
  const right = profile.right.enabled ? 'on' : 'off';
  const items = profile.left.layout.items.length + profile.right.layout.items.length;
  return `Desired: left ${left}, right ${right} · ${items} items across both panels`;
}

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
      } · ${ALIGN_LABEL[item.align]} · ${OLED_TIMING_LABEL[item.timing]} · ${
        item.visible ? 'shown' : 'hidden'
      }`}
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
  onKeep,
  onDispatch,
}: {
  item: OledItem | null;
  index: number;
  total: number;
  /** Discards what this sheet changed — the X, back and the scrim all mean this. */
  onClose: () => void;
  /** Keeps what this sheet changed, pending the studio's Save. */
  onKeep: () => void;
  onDispatch: (intent: OledIntent) => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  // The sheet stays mounted through its exit animation, so it needs the item it
  // was last showing: `editingId` is cleared the instant it starts closing, and
  // rendering `null` there would collapse the panel mid-slide.
  //
  // The index is retained with it. Reading it fresh would show "Item 0 of 4"
  // for the length of the exit animation, because a cleared id searches to -1.
  const retained = useRef<{ item: OledItem; index: number } | null>(null);
  if (item !== null && index >= 0) retained.current = { item, index };
  const shown = retained.current?.item ?? null;
  const shownIndex = retained.current?.index ?? 0;

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
      description={`Item ${shownIndex + 1} of ${total}. Edits appear in the preview straight away. The X discards them; Done keeps them until you press Save in the Studio.`}
      footer={
        <>
          <ActionButton
            label="Delete item"
            tone="danger"
            icon="trash"
            onPress={() => {
              onDispatch({ type: 'remove', id: shown.id });
              // `onKeep`, not `onClose`: closing would restore the snapshot and
              // put the row straight back.
              onKeep();
            }}
            accessibilityLabel={`Delete ${OLED_KIND_LABEL[shown.kind]}`}
          />
          <View style={styles.editorActions}>
            <ActionButton
              label="Cancel"
              tone="ghost"
              onPress={onClose}
              style={styles.editorAction}
            />
            <ActionButton
              label="Done"
              onPress={onKeep}
              style={styles.editorAction}
            />
          </View>
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

        {OLED_KIND_NEEDS_TELEMETRY.has(shown.kind) && (
          <View style={[styles.editorNote, { backgroundColor: palette.surfaceSunken }]}>
            <Icon name="warning" size={14} color={palette.warning} />
            <AppText
              variant="caption"
              color={palette.textSecondary}
              style={styles.editorNoteText}
            >
              No battery telemetry exists yet, so this row draws a placeholder on every frame
              rather than a percentage.
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

        <AppText variant="caption" color={palette.textMuted} style={styles.editorLabel}>
          Which view this row belongs to
        </AppText>
        <SegmentedControl
          options={TIMING_OPTIONS}
          value={shown.timing}
          onChange={(timing) => onDispatch({ type: 'setTiming', id: shown.id, timing })}
          accessibilityLabel="Which panel view this row belongs to"
        />
        <AppText variant="caption" color={palette.textMuted}>
          {shown.timing === 'startup'
            ? 'Drawn only while the panel is showing its startup content. The running view will not draw it.'
            : 'Drawn in both views, so it is present from power-on onwards.'}
        </AppText>

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
          <View style={styles.rowActions}>
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

/**
 * The preset that *is* this hold, or the empty string when none is.
 *
 * Returning `''` rather than the nearest preset is the difference between "you
 * chose the 1 s preset" and "your hold is 1300 ms, which is not one of these".
 * The latter is true and the former is not, so nothing is highlighted.
 */
function introDurationPreset(ms: number): string {
  return INTRO_DURATION_PRESETS.some((preset) => preset === ms) ? String(ms) : '';
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
    card: {
      gap: spacing.md,
    },
    cardHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    cardHeadText: {
      flex: 1,
      gap: 2,
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
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: palette.border,
    },
    detail: {
      gap: 2,
    },
    detailHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    /*
     * Both sides need a shrink floor. Without one, a long label beside a long
     * value has nothing to give: the row is `space-between`, so neither child
     * yields and the pair overflows the card instead of one of them wrapping.
     * Seen at 360 dp with the 1.4x font scale, where "Reported by the panel" and
     * "Not reported" are together wider than the card's measure.
     */
    detailLabel: {
      flexShrink: 1,
    },
    detailValue: {
      flexShrink: 1,
      textAlign: 'right',
    },
    inlineWarn: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.sm,
      borderWidth: 1,
    },
    inlineWarnText: {
      flex: 1,
    },
    stateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    stateRowText: {
      flex: 1,
      gap: 2,
    },
    rowActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
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
    /*
     * The pinned Save/Discard bar.
     *
     * Opaque rather than translucent: it floats over the scrolling content, and
     * a half-transparent bar would let button labels and panel rows show
     * through the buttons, which at this size reads as a rendering fault.
     */
    dirtyBar: {
      gap: spacing.md,
      borderColor: palette.warning,
    },
    dirtyText: {
      gap: 2,
    },
    dirtyActions: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    /** Cancel and Done share the row, so each takes half of it. */
    editorActions: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    editorAction: {
      flex: 1,
    },
  });
