import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Badge } from './Badge';
import { Card } from './Card';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { ListRow } from './ListRow';
import { LoadingDots } from './LoadingDots';
import { StateChip } from './StateChip';
import type { GloveSnapshot } from '../ble/controller';
import { isSimulatedLink, deviceDisplayName, linkHealth, linkLabel } from '../ble/link';
import type { GloveSide } from '../ble/types';
import { formatAge, sideWord } from '../app/format';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface GloveCardActions {
  scan: () => void;
  connect: (deviceId: string) => void;
  disconnect: () => void;
  retry: () => void;
}

export interface GloveCardProps {
  side: GloveSide;
  snapshot: GloveSnapshot;
  actions: GloveCardActions;
  /** Injectable clock, so tests can assert the staleness wording. */
  nowMs?: number;
  testID?: string;
}

/**
 * One glove's connection card.
 *
 * ## The rule this component exists to honour
 *
 * Every word on it comes from state the transport actually reported. There is no
 * optimistic branch: pressing Connect moves the card to "Connecting", and it
 * reaches "Connected" only when the transport has said so. A scan that finds
 * nothing says it found nothing. A transport that cannot operate says why, and
 * offers no button that would pretend otherwise.
 *
 * That is why this renders a switch over `link.kind` rather than a set of
 * booleans — the state machine's eight states are eight different screens, and
 * collapsing them is where false reassurance comes from.
 *
 * ## Why the body varies so much by state
 *
 * Because the user's question varies. Idle asks "what do I do?" — so it offers an
 * action. Scanning asks "is anything happening?" — so it shows progress.
 * Connected asks "is it working?" — so it shows packet freshness. Each state
 * answers its own question and nothing else.
 */
export function GloveCard({
  side,
  snapshot,
  actions,
  nowMs,
  testID,
}: GloveCardProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { link } = snapshot;
  const hand = sideWord(side);

  const simulated = isSimulatedLink(link);
  const health = linkHealth(link);

  return (
    <Card testID={testID} style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <View style={styles.titleRow}>
            <AppText variant="heading">{hand} glove</AppText>
            {simulated && <Badge label="Demo Mode" tone="demo" dot />}
          </View>
          {/*
            The transport is named rather than implied. `Demo Mode (simulated)`
            and `Bluetooth LE (not implemented)` are the two things a reader most
            needs to know about what is below them.
          */}
          <AppText variant="caption" color={palette.textMuted}>
            {snapshot.transportName}
          </AppText>
        </View>

        <StateChip state={health} />
      </View>

      <AppText variant="label" color={palette.textSecondary}>
        {linkLabel(link, side)}
      </AppText>

      <Body
        side={side}
        snapshot={snapshot}
        actions={actions}
        nowMs={nowMs ?? Date.now()}
      />
    </Card>
  );
}

function Body({
  side,
  snapshot,
  actions,
  nowMs,
}: GloveCardProps & { nowMs: number }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { link } = snapshot;

  switch (link.kind) {
    case 'unavailable':
      return (
        <View style={styles.body}>
          <Reason
            tone="neutral"
            text={link.reason ?? 'This glove cannot be reached on this build.'}
          />
          {/*
            Not called "Retry". Retrying cannot fix a missing protocol, and
            labelling it that way would suggest one more tap might work. What it
            actually does is re-read the transport's current status, so that is
            what it says.
          */}
          <ActionButton
            label="Re-check availability"
            tone="secondary"
            icon="refresh"
            onPress={actions.retry}
            accessibilityLabel={`Re-check ${side} glove availability`}
          />
        </View>
      );

    case 'scanning':
      return (
        <View style={styles.body}>
          <View style={styles.busyRow}>
            <LoadingDots accessibilityLabel="Scanning" />
            <AppText variant="body" color={palette.textSecondary}>
              Scanning for nearby gloves…
            </AppText>
          </View>
          <ActionButton
            label="Cancel"
            tone="ghost"
            onPress={actions.disconnect}
            accessibilityLabel={`Cancel scan for ${side} glove`}
          />
        </View>
      );

    case 'nearby':
      return (
        <View style={styles.body}>
          <View style={styles.deviceList}>
            {link.discovered.map((device, index) => (
              <ListRow
                key={device.id}
                label={deviceDisplayName(device.name)}
                // Signal strength is reported by the scan or it is not; `--`
                // rather than a guessed number when it is absent.
                description={
                  device.rssi === null
                    ? 'Signal strength not reported'
                    : `Signal ${device.rssi} dBm`
                }
                last={index === link.discovered.length - 1}
                accessory={
                  <ActionButton
                    label="Connect"
                    compact
                    tone="secondary"
                    onPress={() => actions.connect(device.id)}
                    accessibilityLabel={`Connect to ${deviceDisplayName(device.name)}`}
                  />
                }
              />
            ))}
          </View>
          <ActionButton
            label="Scan again"
            tone="ghost"
            icon="scan"
            onPress={actions.scan}
            accessibilityLabel={`Scan again for ${side} glove`}
          />
        </View>
      );

    case 'connecting':
      return (
        <View style={styles.body}>
          <View style={styles.busyRow}>
            <LoadingDots accessibilityLabel="Connecting" />
            <AppText variant="body" color={palette.textSecondary}>
              Connecting to{' '}
              {link.deviceName === null ? 'glove' : deviceDisplayName(link.deviceName)}…
            </AppText>
          </View>
          <ActionButton
            label="Cancel"
            tone="ghost"
            onPress={actions.disconnect}
            accessibilityLabel={`Cancel connection to ${side} glove`}
          />
        </View>
      );

    case 'connected': {
      const stale =
        snapshot.lastPacketAtMs === null || nowMs - snapshot.lastPacketAtMs > 1500;
      return (
        <View style={styles.body}>
          <View style={styles.readings}>
            <Reading
              label="Device"
              value={link.deviceName === null ? '—' : deviceDisplayName(link.deviceName)}
            />
            <Reading label="Data frames" value={String(snapshot.packetCount)} />
            <Reading
              label="Last frame"
              value={
                snapshot.lastPacketAtMs === null
                  ? 'none yet'
                  : formatAge(nowMs, snapshot.lastPacketAtMs)
              }
              tone={stale ? palette.warning : undefined}
            />
          </View>

          {/*
            Connected is not the same as working. A link with no fresh packets is
            a distinct, common failure — a paired but silent glove — and saying
            "Connected" alone would hide it.
          */}
          {stale && (
            <Reason
              tone="warning"
              text="The link is up but no sensor frames are arriving. That usually means the glove's firmware is not streaming."
            />
          )}

          <ActionButton
            label="Disconnect"
            tone="secondary"
            icon="close"
            onPress={actions.disconnect}
            accessibilityLabel={`Disconnect ${side} glove`}
          />
        </View>
      );
    }

    case 'disconnected':
      return (
        <View style={styles.body}>
          <Reason
            tone="neutral"
            text={link.reason ?? 'The glove was disconnected.'}
          />
          <ActionButton
            label="Find gloves"
            tone="secondary"
            icon="scan"
            onPress={actions.retry}
            accessibilityLabel={`Find ${side} gloves again`}
          />
        </View>
      );

    case 'error':
      return (
        <View style={styles.body}>
          <Reason tone="danger" text={link.reason ?? 'The last attempt failed.'} />
          <ActionButton
            label="Try again"
            tone="secondary"
            icon="refresh"
            onPress={actions.retry}
            accessibilityLabel={`Try connecting the ${side} glove again`}
          />
        </View>
      );

    default:
      return (
        <View style={styles.body}>
          <EmptyState
            compact
            icon="hand"
            title="No glove connected"
            body="Nothing has been scanned for yet. The demo simulator is the only transport on this build."
            action={
              <ActionButton
                label="Find gloves"
                icon="scan"
                onPress={actions.scan}
                accessibilityLabel={`Find ${side} gloves`}
              />
            }
          />
        </View>
      );
  }
}

function Reading({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View
      style={styles.reading}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <AppText variant="caption" color={palette.textMuted} numberOfLines={1}>
        {label}
      </AppText>
      <AppText variant="reading" color={tone ?? palette.textPrimary} numberOfLines={1}>
        {value}
      </AppText>
    </View>
  );
}

/** A reason, a failure or a caution — never dressed up as a success. */
function Reason({
  tone,
  text,
}: {
  tone: 'neutral' | 'warning' | 'danger';
  text: string;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const color =
    tone === 'warning' ? palette.warning : tone === 'danger' ? palette.danger : palette.textSecondary;
  const surface =
    tone === 'warning'
      ? palette.warningSurface
      : tone === 'danger'
        ? palette.dangerSurface
        : palette.surfaceSunken;

  return (
    <View style={[styles.reason, { backgroundColor: surface }]} accessible>
      <Icon
        name={tone === 'danger' || tone === 'warning' ? 'warning' : 'info'}
        size={14}
        color={color}
      />
      <AppText variant="caption" color={color} style={styles.reasonText}>
        {text}
      </AppText>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
    },
    headerText: {
      flex: 1,
      gap: 2,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      flexWrap: 'wrap',
    },
    body: {
      gap: spacing.md,
    },
    busyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 24,
    },
    deviceList: {
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      overflow: 'hidden',
    },
    readings: {
      flexDirection: 'row',
      gap: spacing.lg,
    },
    reading: {
      flex: 1,
      gap: 2,
    },
    reason: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.sm,
    },
    reasonText: {
      flex: 1,
    },
  });
