import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { LoadingDots } from './LoadingDots';
import type { GloveSnapshot } from '../ble/controller';
import { deviceDisplayName, isSimulatedLink, linkHealth } from '../ble/link';
import type { GloveSide } from '../ble/types';
import type { GloveActions } from '../app/AppState';
import type { HealthState } from '../audit/status';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface GloveConnectionBarProps {
  gloves: Readonly<Record<GloveSide, GloveSnapshot>>;
  actions: Readonly<Record<GloveSide, GloveActions>>;
  /** Scans both gloves and connects the first device each one finds. */
  onConnectBoth: () => void;
  /** True while `onConnectBoth`'s sequence is running. */
  connectingBoth: boolean;
  /** Opens the device chooser for a side that found more than one glove. */
  onChooseDevice: (side: GloveSide) => void;
  testID?: string;
}

const SIDES: readonly GloveSide[] = ['left', 'right'];

/**
 * Both gloves, side by side, in one compact block.
 *
 * ## What this replaces
 *
 * Two full-width `GloveCard`s at the bottom of the Dashboard. Between them they
 * repeated the connection state that the status strip at the top already showed,
 * and they occupied more vertical space than the live readings did — on a screen
 * whose whole purpose is showing what a hand is doing. The connection controls
 * are setup, and setup does not deserve the largest card on the screen.
 *
 * ## What it keeps
 *
 * Every state the cards rendered, because those are the states a user has to be
 * able to tell apart: scanning, found-nothing, nearby, connecting, connected,
 * disconnected, unavailable, failed. Each side collapses to one word and one
 * button, and the button is whatever that state's next step actually is.
 *
 * A tap on either side never *becomes* a connection. `connect` is dispatched
 * only by the transport reporting one, so pressing Connect and having it fail
 * leaves the side saying so.
 */
export function GloveConnectionBar({
  gloves,
  actions,
  onConnectBoth,
  connectingBoth,
  onChooseDevice,
  testID,
}: GloveConnectionBarProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const bothConnected = SIDES.every((side) => gloves[side].link.kind === 'connected');
  const anyNearby = SIDES.some((side) => gloves[side].link.kind === 'nearby');

  return (
    <Card testID={testID} style={styles.card}>
      <View style={styles.headerRow}>
        <AppText variant="overline" overline color={palette.textMuted}>
          Gloves
        </AppText>
        <AppText variant="caption" color={palette.textMuted}>
          {bothConnected ? 'Both connected' : 'Independent links'}
        </AppText>
      </View>

      <View style={styles.cells}>
        {SIDES.map((side) => (
          <GloveCell
            key={side}
            side={side}
            snapshot={gloves[side]}
            actions={actions[side]}
            onChooseDevice={onChooseDevice}
          />
        ))}
      </View>

      <ActionButton
        label={bothConnected ? 'Both gloves connected' : anyNearby ? 'Connect both' : 'Find gloves'}
        tone={bothConnected ? 'ghost' : 'primary'}
        icon={bothConnected ? 'check' : anyNearby ? 'link' : 'scan'}
        busy={connectingBoth}
        disabled={bothConnected}
        compact
        onPress={onConnectBoth}
        accessibilityLabel={bothConnected ? 'Both gloves connected' : anyNearby ? 'Connect both gloves' : 'Find gloves'}
        accessibilityHint="Scans for nearby compatible left and right gloves and connects"
      />
    </Card>
  );
}

interface GloveCellProps {
  side: GloveSide;
  snapshot: GloveSnapshot;
  actions: GloveActions;
  onChooseDevice: (side: GloveSide) => void;
}

/**
 * One glove's cell.
 *
 * The switch over `link.kind` is deliberate: eight link states are eight
 * different situations, and a set of booleans would flatten them into a cell
 * that says the same thing when a scan found nothing as when it is still
 * running.
 */
function GloveCell({
  side,
  snapshot,
  actions,
  onChooseDevice,
}: GloveCellProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { link } = snapshot;

  const health = linkHealth(link);
  const simulated = isSimulatedLink(link);
  const hand = side === 'left' ? 'Left' : 'Right';

  return (
    <View
      style={[styles.cell, link.kind === 'connected' && styles.cellConnected]}
      testID={`glove-cell-${side}`}
    >
      <View style={styles.cellHead}>
        <View
          style={[
            styles.dot,
            { backgroundColor: palette[DOT_COLOR[health]] },
          ]}
        />
        <AppText variant="label" numberOfLines={1} style={styles.cellName}>
          {hand}
        </AppText>
        {simulated && <Badge label="Demo" tone="demo" />}
      </View>

      <AppText variant="caption" color={palette.textSecondary} numberOfLines={2} style={styles.state}>
        {stateWord(snapshot)}
      </AppText>

      <CellAction
        side={side}
        snapshot={snapshot}
        actions={actions}
        onChooseDevice={onChooseDevice}
      />
    </View>
  );
}

/** The single next step available for a side, whatever its state. */
function CellAction({
  side,
  snapshot,
  actions,
  onChooseDevice,
}: GloveCellProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { link } = snapshot;
  const label = side === 'left' ? 'left' : 'right';

  switch (link.kind) {
    case 'scanning':
      return (
        <View style={styles.busyRow}>
          <LoadingDots accessibilityLabel={`Scanning for the ${label} glove`} />
          <ActionButton
            label="Cancel"
            tone="ghost"
            compact
            onPress={() => {
              void actions.disconnect();
            }}
            accessibilityLabel={`Cancel the ${label} glove scan`}
          />
        </View>
      );

    case 'connecting':
      return (
        <View style={styles.busyRow}>
          <LoadingDots accessibilityLabel={`Connecting the ${label} glove`} />
          <ActionButton
            label="Cancel"
            tone="ghost"
            compact
            onPress={() => {
              void actions.disconnect();
            }}
            accessibilityLabel={`Cancel connecting the ${label} glove`}
          />
        </View>
      );

    case 'nearby': {
      const first = link.discovered[0];
      if (first === undefined) {
        return <CellNote text="Nothing found. Scanning again may help." tone="muted" />;
      }
      return (
        <ActionButton
          label={link.discovered.length > 1 ? `Choose (${link.discovered.length})` : 'Connect'}
          tone="secondary"
          compact
          onPress={() => {
            if (link.discovered.length > 1) {
              onChooseDevice(side);
              return;
            }
            void actions.connect(first.id);
          }}
          accessibilityLabel={
            link.discovered.length > 1
              ? `Choose a ${label} glove to connect`
              : `Connect ${deviceDisplayName(first.name)} as the ${label} glove`
          }
        />
      );
    }

    case 'connected':
      return (
        <ActionButton
          label="Disconnect"
          tone="ghost"
          compact
          onPress={() => {
            void actions.disconnect();
          }}
          accessibilityLabel={`Disconnect the ${label} glove`}
        />
      );

    case 'unavailable':
      return (
        <ActionButton
          // Not "Retry": retrying cannot recover a protocol that does not exist
          // yet, and saying so would suggest one more tap might work.
          label="Re-check"
          tone="ghost"
          compact
          onPress={() => {
            void actions.retry();
          }}
          accessibilityLabel={`Re-check whether the ${label} glove can be reached`}
        />
      );

    case 'error':
    case 'disconnected':
      return (
        <ActionButton
          label="Retry"
          tone="secondary"
          compact
          onPress={() => {
            void actions.retry();
          }}
          accessibilityLabel={`Retry finding or connecting the ${label} glove`}
        />
      );

    default:
      if (link.reason) {
        return (
          <ActionButton
            label="Retry"
            tone="secondary"
            compact
            onPress={() => {
              void actions.scan();
            }}
            accessibilityLabel={`Retry finding the ${label} glove`}
          />
        );
      }
      return (
        <ActionButton
          label="Find"
          tone="secondary"
          compact
          onPress={() => {
            void actions.scan();
          }}
          accessibilityLabel={`Find the ${label} glove`}
        />
      );
  }
}

function CellNote({
  text,
  tone,
}: {
  text: string;
  tone: 'muted' | 'warning';
}): React.JSX.Element {
  const { palette } = useTheme();
  return (
    <AppText variant="caption" color={tone === 'warning' ? palette.warning : palette.textMuted}>
      {text}
    </AppText>
  );
}

/**
 * One word per link state.
 *
 * Deliberately shorter than `linkLabel`, which prefixes the hand: the cell
 * already names the hand, and repeating it in the state line made two lines of
 * text say one thing.
 */
function stateWord(snapshot: GloveSnapshot): string {
  const { link } = snapshot;
  switch (link.kind) {
    case 'scanning':
      return 'Scanning…';
    case 'nearby':
      return link.discovered.length === 1
        ? `Found ${deviceDisplayName(link.discovered[0]?.name ?? '')}`
        : `${link.discovered.length} found`;
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      if (isSimulatedLink(link)) {
        return 'Simulated stream';
      }
      return snapshot.receivingData ? 'Receiving data' : 'Connected to app';
    case 'unavailable':
      return 'Protocol unverified';
    case 'error':
      return link.reason ?? 'Last attempt failed';
    case 'disconnected':
      return 'Disconnected';
    default:
      return link.reason ?? 'Not connected';
  }
}

/**
 * Colour token per health state.
 *
 * Typed as a literal union rather than `keyof Palette` because `Palette` also
 * carries `scheme` and `shadowOpacity`, so a general key would widen the result
 * and `backgroundColor` would reject it.
 */
const DOT_COLOR: Record<HealthState, 'success' | 'warning' | 'danger' | 'unknown'> = {
  healthy: 'success',
  warning: 'warning',
  disconnected: 'danger',
  unavailable: 'unknown',
  unknown: 'unknown',
};

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.md,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    cells: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    cell: {
      flex: 1,
      gap: spacing.xs,
      padding: spacing.md,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      backgroundColor: palette.surfaceSunken,
    },
    cellConnected: {
      borderColor: palette.borderStrong,
    },
    cellHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    cellName: {
      flexShrink: 1,
    },
    state: {
      minHeight: 32,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    busyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      minHeight: 36,
    },
  });
