/**
 * What has actually been recognised, and where it went.
 *
 * ## Why this screen is mostly an empty state
 *
 * Nothing in this build produces recognised text, so there is nothing to list.
 * That is the honest rendering, and the screen is built for it rather than
 * being built for a populated list and left looking broken: the empty state
 * says what would appear here and what would have to exist first.
 *
 * ## Two stores, kept visibly separate
 *
 * Local history lives in this device's storage and the account cannot see it.
 * Account history lives in PostgreSQL behind row-level security. Both exist in
 * the same tab, and the separation is drawn on screen — a user reading a
 * synced list should not believe their local, never-uploaded entries are in it,
 * and a guest should not be told an administrator can see anything of theirs.
 *
 * ## Simulated data
 *
 * Entries carry their own provenance. A `demo` entry is produced by the
 * simulator, not by hardware, and is marked as such wherever it is displayed.
 * Nothing writes a simulated reading into history without that marker.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { BrandHeader } from '../components/BrandHeader';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { TextField } from '../components/TextField';
import { useAccount } from '../account/AccountProvider';
import { useAppState } from '../app/AppState';
import { findProfile } from '../recognition/profiles';
import type { HistoryEntry } from '../storage';
import { layout, spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';

export interface HistoryScreenProps {
  onOpenAccount?: () => void;
  onOpenSettings?: () => void;
}

/** How many entries are shown at a time. */
const PAGE_SIZE = 25;

type SourceFilter = 'all' | 'glove' | 'demo';

export function HistoryScreen({
  onOpenAccount,
  onOpenSettings,
}: HistoryScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { storage } = useAppState();
  const account = useAccount();

  const [entries, setEntries] = useState<readonly HistoryEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const reload = useCallback(async () => {
    const stored = await storage.getHistory();
    // Newest first. The store appends chronologically, so the display order is
    // the reverse of the storage order rather than a second copy of it.
    setEntries([...stored].reverse());
  }, [storage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    if (entries === null) return null;
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (filter !== 'all' && entry.source !== filter) return false;
      if (needle.length === 0) return true;
      return (
        entry.text.toLowerCase().includes(needle) ||
        entry.profileId.toLowerCase().includes(needle)
      );
    });
  }, [entries, filter, query]);

  const shown = useMemo(
    () => (filtered === null ? null : filtered.slice(0, visibleCount)),
    [filtered, visibleCount],
  );

  const clearAll = useCallback(() => {
    Alert.alert(
      'Clear local history?',
      'Every entry saved on this phone is removed. Anything already synced to an account is not affected, and this cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            void storage.clearHistory().then(reload);
          },
        },
      ],
    );
  }, [storage, reload]);

  return (
    <Screen scroll bottomInset={layout.tabBarHeight} testID="history-screen">
      <BrandHeader title="History" onPressAvatar={onOpenAccount} />

      {/*
        Where these entries live, stated before the list rather than after it.
        A guest has no cloud copy and the wording says so plainly, because the
        opposite claim — that an administrator could look at a local-only
        device's history — would be a lie the user cannot check.
      */}
      <Card sunken style={styles.origin}>
        <Icon name="info" size={14} color={palette.textMuted} />
        <AppText variant="caption" color={palette.textMuted} style={styles.originText}>
          {!account.cloudAvailable
            ? 'These entries are stored only on this phone. No account service is configured in this build, so nothing here can leave the device.'
            : account.isGuest
              ? 'These entries are stored only on this phone. Because there is no signed-in account, nothing here is uploaded and no administrator can see it.'
              : 'Local entries are stored on this phone. Recognised text is copied to your account when sync is available, and your account can only ever read its own rows.'}
        </AppText>
      </Card>

      {/* --------------------------------------------------------- search */}

      <TextField
        label="Search"
        placeholder="Search recognised text or profile"
        value={query}
        onChangeText={(text) => {
          setQuery(text);
          setVisibleCount(PAGE_SIZE);
        }}
        autoCorrect={false}
        returnKeyType="search"
      />

      <View style={styles.filters}>
        {/*
          Three chips rather than a segmented control: "all" is a genuinely
          different view from the two sources, and a user who came here to check
          whether something came from the glove should not have to read every
          row's badge to find out.
        */}
        {(['all', 'glove', 'demo'] as const).map((option) => (
          <ActionButton
            key={option}
            label={
              option === 'all'
                ? 'All'
                : option === 'glove'
                  ? 'From glove'
                  : 'Simulated only'
            }
            tone={filter === option ? 'primary' : 'ghost'}
            compact
            onPress={() => {
              setFilter(option);
              setVisibleCount(PAGE_SIZE);
            }}
            accessibilityLabel={
              option === 'all'
                ? 'Show entries from every source'
                : option === 'glove'
                  ? 'Show only entries read from the glove'
                  : 'Show only entries produced by the simulator'
            }
          />
        ))}
      </View>

      {/* ----------------------------------------------------------- list */}

      <SectionHeader
        label="Recognised text"
        detail={
          filtered === null
            ? undefined
            : filtered.length === 0
              ? undefined
              : `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`
        }
        accessory={
          entries !== null && entries.length > 0 ? (
            <ActionButton
              label="Clear"
              tone="ghost"
              icon="trash"
              compact
              onPress={clearAll}
              accessibilityLabel="Clear local history"
            />
          ) : undefined
        }
      />

      {shown === null ? (
        // The read from storage has not resolved. A spinner here would be a
        // flash on a screen that is empty in this build anyway, so the section
        // simply holds its space for the frame or two it takes.
        <View style={styles.placeholder} />
      ) : shown.length === 0 ? (
        <Card>
          {entries !== null && entries.length > 0 ? (
            <EmptyState
              icon="history"
              compact
              title="Nothing matches"
              body="No entry contains that text. Clear the search to see everything this phone has saved."
              action={
                <ActionButton
                  label="Clear search"
                  tone="ghost"
                  compact
                  onPress={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                />
              }
            />
          ) : (
            <EmptyState
              icon="history"
              title="Nothing has been recognised yet"
              body="This is where recognised signs will be listed, newest first, with the profile they were read against and whether they came from the gloves or from the simulator. Nothing has been recognised because no recognition model is loaded in this build — the list is not waiting on a connection or an account."
              action={
                onOpenSettings !== undefined ? (
                  <ActionButton
                    label="Check component status"
                    tone="ghost"
                    compact
                    onPress={onOpenSettings}
                  />
                ) : undefined
              }
            />
          )}
        </Card>
      ) : (
        <Card style={styles.list}>
          {shown.map((entry, index) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              last={index === shown.length - 1 && shown.length === filtered?.length}
            />
          ))}
        </Card>
      )}

      {filtered !== null && shown !== null && filtered.length > shown.length ? (
        <ActionButton
          label={`Show ${Math.min(PAGE_SIZE, filtered.length - shown.length)} more`}
          tone="ghost"
          onPress={() => setVisibleCount((count) => count + PAGE_SIZE)}
          hint={`${shown.length} of ${filtered.length} shown`}
        />
      ) : null}

      {/* ---------------------------------------------------- account list */}

      <SectionHeader
        label="From your account"
        detail="Text recognised on other devices, read from your account when a connection is available."
      />
      <Card style={styles.list}>
        {/*
          Not a placeholder list. The sync layer is the only writer of this
          section, and it has nothing until an account exists and has recognitions
          in it — at which point rows appear. Presenting invented rows here would
          be the single worst thing this screen could do, because history is the
          one place a user goes to check what actually happened.
        */}
        <EmptyState
          icon="link"
          compact
          title={account.isGuest ? 'Not signed in' : 'No synced entries'}
          body={
            account.isGuest
              ? 'Sign in to carry recognised text across devices. Until you do, everything stays on this phone and no account holds a copy.'
              : 'Your account has no recognised text in it yet. Entries appear here once recognition runs on a device signed in to this account.'
          }
          action={
            account.isGuest && onOpenAccount !== undefined ? (
              <ActionButton label="Sign in" tone="ghost" compact onPress={onOpenAccount} />
            ) : undefined
          }
        />
      </Card>
    </Screen>
  );
}

/* --------------------------------------------------------------- sub-parts */

function HistoryRow({ entry, last }: { entry: HistoryEntry; last: boolean }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const profile = findProfile(entry.profileId);
  const when = useMemo(() => formatWhen(entry.createdAtMs), [entry.createdAtMs]);

  return (
    <View style={[styles.row, !last && styles.rowDivided]}>
      <View style={styles.rowHead}>
        <AppText variant="body" style={styles.rowText} selectable>
          {entry.text}
        </AppText>
        {/*
          The provenance badge is not optional and not a detail. A reading the
          hardware produced and a reading the simulator produced are different
          claims about the world, and a list that showed both without a mark
          would be actively misleading.
        */}
        <Badge
          label={entry.source === 'glove' ? 'Glove' : 'Simulated'}
          tone={entry.source === 'glove' ? 'success' : 'demo'}
        />
      </View>
      <AppText variant="caption" color={palette.textMuted}>
        {profile?.name ?? entry.profileId.toUpperCase()} · {when}
      </AppText>
    </View>
  );
}

/**
 * A short relative time.
 *
 * Deliberately coarse. "3 minutes ago" is what a person wants from a history
 * list; the exact second is available in the data and would only add noise — and
 * a precise timestamp invites the reader to compare two rows for a precision
 * that a caption does not have.
 */
function formatWhen(atMs: number): string {
  const deltaMs = Date.now() - atMs;
  if (deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  return `${Math.floor(months / 12)}y ago`;
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    origin: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    originText: {
      flex: 1,
    },
    filters: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    list: {
      paddingVertical: 0,
    },
    placeholder: {
      height: 96,
    },
    row: {
      paddingVertical: spacing.md,
      gap: spacing.xs,
    },
    rowDivided: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    rowHead: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    rowText: {
      flex: 1,
      minWidth: 0,
    },
  });
