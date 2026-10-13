import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DetailHeader } from '../components/DetailHeader';
import { EmptyState } from '../components/EmptyState';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { SegmentedControl } from '../components/SegmentedControl';
import { StateChip } from '../components/StateChip';
import { TextField } from '../components/TextField';
import { Toggle } from '../components/Toggle';
import { useAccount } from '../account/AccountProvider';
import {
  ADMIN_PAGE_SIZE,
  createAnnouncement,
  listAnnouncements,
  listAudit,
  listUsers,
  readMaintenance,
  requestPasswordReset,
  setMaintenance,
  setRole,
  setSuspension,
  updateAnnouncement,
  type AdminUserSummary,
} from '../admin/client';
import { config } from '../config/env';
import { spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import type { AdminAuditRow, AnnouncementRow } from '../supabase/types';

type AdminSection = 'people' | 'audit' | 'announcements' | 'service';

const SECTIONS: readonly { value: AdminSection; label: string }[] = [
  { value: 'people', label: 'People' },
  { value: 'audit', label: 'Audit' },
  { value: 'announcements', label: 'Notices' },
  { value: 'service', label: 'Service' },
];

/**
 * The administrator console.
 *
 * ## What this screen is not
 *
 * It is not a security boundary. Every control here calls the backend, which
 * reads the account's role and status from the database on each request and
 * refuses anyone else. Hiding a button would change nothing about who can act:
 * the mobile bundle is public, and an attacker with a token does not need this
 * screen to call the API. The screen exists so that an administrator has a way
 * to do these things, and `RootNavigator` only offers the route to an account
 * whose profile says `admin` so that everyone else is not shown a door that
 * would not open.
 *
 * ## Why every write asks for a reason first
 *
 * The backend refuses a request without one and the audit table has a CHECK
 * constraint, so this could not be skipped even if the field were removed here.
 * Asking in the UI as well means the reason is written when the administrator
 * still remembers why, rather than being reconstructed afterwards from an error.
 *
 * ## What is deliberately absent
 *
 * There is no way to read a user's recognitions, conversations, calibration or
 * history from this screen, and no way to see or set a password. Administrating
 * accounts does not require reading what people said, and the API has no
 * endpoint that could.
 */
export function AdminScreen({ onClose }: { onClose: () => void }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { user } = useAccount();

  const [section, setSection] = useState<AdminSection>('people');

  /*
   * The backend URL is checked before anything is drawn.
   *
   * Without it every request would come back with a network error, which would
   * read as "the server is down" rather than "this build has no server
   * configured" — two problems with completely different fixes.
   */
  if (!config.isApiConfigured) {
    return (
      <Screen scroll>
        <DetailHeader title="Administration" onClose={onClose} />
        <EmptyState
          icon="warning"
          title="No backend is configured"
          body={
            'This build has no API_BASE_URL, so the administration API cannot be reached. ' +
            'Set it in apps/mobile/.env and rebuild. Administration is deliberately server-side: ' +
            'it cannot be done from the app alone.'
          }
        />
      </Screen>
    );
  }

  return (
    <Screen scroll testID="admin-screen">
      <DetailHeader
        title="Administration"
        onClose={onClose}
        subtitle="Account control, with a record of every action"
      />

      <SegmentedControl
        options={SECTIONS}
        value={section}
        onChange={setSection}
        accessibilityLabel="Administration area"
      />

      <Card sunken style={styles.notice}>
        <AppText variant="caption" color={palette.textMuted}>
          Every action on this screen is recorded with your account, the time, and the reason you
          give. The record cannot be edited or deleted afterwards — by you, or by anyone else.
          {user?.email ? ` Signed in as ${user.email}.` : ''}
        </AppText>
      </Card>

      {section === 'people' ? <PeopleSection /> : null}
      {section === 'audit' ? <AuditSection /> : null}
      {section === 'announcements' ? <AnnouncementsSection /> : null}
      {section === 'service' ? <ServiceSection /> : null}
    </Screen>
  );
}

/* --------------------------------------------------------------------- shared */

/**
 * A load state, drawn the same way by every section.
 *
 * `error` is a first-class outcome rather than an empty list. A failed read that
 * rendered as "no users" would tell an administrator the project has no accounts
 * when in fact the request never arrived.
 */
function Loading({ label }: { label: string }): React.JSX.Element {
  const { palette } = useTheme();
  return (
    <View style={stylesShared.loading}>
      <ActivityIndicator color={palette.accent} />
      <AppText variant="caption" color={palette.textMuted}>
        {label}
      </AppText>
    </View>
  );
}

function Failure({ message }: { message: string }): React.JSX.Element {
  const { palette } = useTheme();
  return (
    <Card sunken>
      <Badge label="Could not load" tone="danger" dot />
      <AppText variant="body" color={palette.textSecondary}>
        {message}
      </AppText>
    </Card>
  );
}

/** The reason field plus the confirm step, shared by every consequential action. */
interface ReasonGateProps {
  /** What the action is, in the imperative, for the dialog's title. */
  action: string;
  /** What will happen, for the dialog body. */
  consequence: string;
  destructive?: boolean;
  confirmLabel: string;
  /** Returns the error message to display, or null on success. */
  run: (reason: string) => Promise<string | null>;
  onDone: () => void;
}

function ReasonGate({
  action,
  consequence,
  destructive,
  confirmLabel,
  run,
  onDone,
}: ReasonGateProps): React.JSX.Element {
  const { palette } = useTheme();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = reason.trim().length < 3;

  const submit = useCallback(async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    const failure = await run(reason.trim());
    setBusy(false);
    if (failure === null) {
      setReason('');
      onDone();
      return;
    }
    setError(failure);
  }, [onDone, reason, run]);

  return (
    <View style={sharedStyles.gate}>
      <TextField
        label="Reason"
        value={reason}
        onChangeText={setReason}
        placeholder="Why this action is being taken"
        hint="Stored in the audit log. It cannot be changed afterwards."
        editable={!busy}
        multiline
      />
      <ActionButton
        label={confirmLabel}
        tone={destructive ? 'danger' : 'secondary'}
        compact
        busy={busy}
        disabled={tooShort}
        onPress={() => setConfirming(true)}
      />
      {tooShort ? (
        <AppText variant="caption" color={palette.textMuted}>
          A few words are required before this can be confirmed.
        </AppText>
      ) : null}
      {error ? (
        <AppText variant="caption" color={palette.danger}>
          {error}
        </AppText>
      ) : null}

      <ConfirmDialog
        visible={confirming}
        title={action}
        message={consequence}
        confirmLabel={confirmLabel}
        destructive={destructive}
        onConfirm={() => {
          void submit();
        }}
        onCancel={() => setConfirming(false)}
      />
    </View>
  );
}

/* -------------------------------------------------------------------- people */

function PeopleSection(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { user: me } = useAccount();

  const [users, setUsers] = useState<readonly AdminUserSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'suspended'>('all');
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(
    async (nextPage: number, replace: boolean) => {
      setError(null);
      const result = await listUsers({
        page: nextPage,
        q: query,
        status: filter === 'all' ? undefined : filter,
      });
      if (!result.ok) {
        setError(result.error);
        if (replace) setUsers(null);
        return;
      }
      setTotal(result.data.total);
      setUsers((current) =>
        replace || current === null ? result.data.users : [...current, ...result.data.users],
      );
      setPage(result.data.page);
    },
    [filter, query],
  );

  useEffect(() => {
    void load(1, true);
  }, [load]);

  const more = users !== null && users.length < total;

  return (
    <View style={styles.section}>
      <SectionHeader label="Accounts" detail={total > 0 ? `${total} in total` : undefined} />

      <TextField
        label="Search"
        value={query}
        onChangeText={setQuery}
        placeholder="Email or display name"
        hint="Searches accounts only. Message and recognition content is not searchable from here."
        autoCapitalize="none"
        autoCorrect={false}
      />

      <SegmentedControl
        options={[
          { value: 'all', label: 'All' },
          { value: 'active', label: 'Active' },
          { value: 'suspended', label: 'Suspended' },
        ]}
        value={filter}
        onChange={setFilter}
        accessibilityLabel="Filter accounts by status"
      />

      {error ? <Failure message={error} /> : null}
      {users === null && error === null ? <Loading label="Reading accounts" /> : null}

      {users !== null && users.length === 0 && error === null ? (
        <EmptyState
          icon="user"
          title="No accounts match"
          body="Either nothing matches the search, or no account has been created yet. Accounts created by signing up appear here; a purely local guest does not, because the server has never seen one."
        />
      ) : null}

      {users?.map((user) => (
        <UserCard
          key={user.id}
          user={user}
          isSelf={me?.id === user.id}
          expanded={openId === user.id}
          onToggle={() => setOpenId(openId === user.id ? null : user.id)}
          onChanged={() => {
              void load(1, true);
            }}
        />
      ))}

      {more ? (
        <ActionButton
          label="Load more"
          tone="ghost"
          onPress={() => {
            void load(page + 1, false);
          }}
        />
      ) : null}
      {users !== null && !more && users.length > 0 ? (
        <AppText variant="caption" color={palette.textMuted}>
          Showing all {users.length} of {total}.
        </AppText>
      ) : null}
    </View>
  );
}

function UserCard({
  user,
  isSelf,
  expanded,
  onToggle,
  onChanged,
}: {
  user: AdminUserSummary;
  isSelf: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const [message, setMessage] = useState<string | null>(null);

  const suspended = user.status === 'suspended';

  return (
    <Card style={styles.item}>
      <View style={styles.itemHead}>
        <View style={styles.itemText}>
          <AppText variant="label" numberOfLines={1}>
            {user.display_name || user.email || 'Unnamed account'}
          </AppText>
          {user.display_name && user.email ? (
            <AppText variant="caption" color={palette.textMuted} numberOfLines={1}>
              {user.email}
            </AppText>
          ) : null}
          <AppText variant="caption" color={palette.textMuted}>
            Joined {formatDate(user.created_at)}
          </AppText>
        </View>
        <View style={styles.itemBadges}>
          <Badge label={user.role} tone={user.role === 'admin' ? 'accent' : 'neutral'} />
          <Badge
            label={suspended ? 'Suspended' : 'Active'}
            tone={suspended ? 'warning' : 'success'}
            dot
          />
        </View>
      </View>

      <ActionButton
        label={expanded ? 'Close' : 'Manage'}
        tone="ghost"
        compact
        onPress={onToggle}
        hint={`Options for ${user.email ?? user.display_name ?? 'this account'}`}
      />

      {expanded ? (
        <View style={styles.actions}>
          {isSelf ? (
            <AppText variant="caption" color={palette.textMuted}>
              This is your own account. The backend refuses to suspend you or change your own role,
              and it says why: an administrator who locks themselves out cannot undo it, and
              recovering would need a database console. Ask another administrator.
            </AppText>
          ) : null}

          {!isSelf ? (
            <ReasonGate
              action={suspended ? 'Restore this account' : 'Suspend this account'}
              consequence={
                suspended
                  ? `The account will be able to sign in and use its own data again.`
                  : `The account will be unable to read or write its own data. It keeps the ability to see that it is suspended.`
              }
              destructive={!suspended}
              confirmLabel={suspended ? 'Restore' : 'Suspend'}
              run={async (reason) => {
                const result = await setSuspension({ userId: user.id, suspended: !suspended, reason });
                return result.ok ? null : result.error;
              }}
              onDone={onChanged}
            />
          ) : null}

          {!isSelf ? (
            <ReasonGate
              action={user.role === 'admin' ? 'Remove the administrator role' : 'Grant the administrator role'}
              consequence={
                user.role === 'admin'
                  ? 'The account will lose access to this console. The change takes effect on its next request, not when its current token expires.'
                  : 'The account will be able to reach every administration endpoint. This is the highest privilege the project has.'
              }
              destructive={user.role !== 'admin'}
              confirmLabel={user.role === 'admin' ? 'Remove role' : 'Grant role'}
              run={async (reason) => {
                const result = await setRole({
                  userId: user.id,
                  role: user.role === 'admin' ? 'user' : 'admin',
                  reason,
                });
                return result.ok ? null : result.error;
              }}
              onDone={onChanged}
            />
          ) : null}

          {/*
            No password field, anywhere. A reset is a request to the provider,
            and the account receives its own email. The wording below says
            "requested", not "sent", because delivery is not observable from here.
          */}
          <ReasonGate
            action="Request a password reset"
            consequence="The account's provider will be asked to email it a reset link. No password is shown or stored, and this app cannot read one."
            confirmLabel="Request reset"
            run={async (reason) => {
              const result = await requestPasswordReset({ userId: user.id, reason });
              if (!result.ok) return result.error;
              setMessage(
                'The reset was requested. Whether the email arrives depends on the account provider, and this app cannot see it.',
              );
              return null;
            }}
            onDone={onChanged}
          />

          {message ? (
            <AppText variant="caption" color={palette.textSecondary}>
              {message}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/* --------------------------------------------------------------------- audit */

function AuditSection(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [entries, setEntries] = useState<readonly AdminAuditRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextPage: number, replace: boolean) => {
    setError(null);
    const result = await listAudit(nextPage);
    if (!result.ok) {
      setError(result.error);
      if (replace) setEntries(null);
      return;
    }
    setTotal(result.data.total);
    setEntries((current) =>
      replace || current === null ? result.data.entries : [...current, ...result.data.entries],
    );
    setPage(result.data.page);
  }, []);

  useEffect(() => {
    void load(1, true);
  }, [load]);

  return (
    <View style={styles.section}>
      <SectionHeader
        label="Audit log"
        detail={total > 0 ? `${total} recorded` : undefined}
      />

      <Card sunken>
        <AppText variant="caption" color={palette.textMuted}>
          Append-only. The database has no grant that would let any client edit or remove a row, so
          a mistake in an administrative tool cannot rewrite history.
        </AppText>
      </Card>

      {error ? <Failure message={error} /> : null}
      {entries === null && error === null ? <Loading label="Reading the log" /> : null}

      {entries !== null && entries.length === 0 && error === null ? (
        <EmptyState
          icon="clock"
          title="Nothing recorded yet"
          body="The log is empty because no administrative action has been taken. It is not empty because loading failed."
        />
      ) : null}

      {entries?.map((entry) => (
        <Card key={entry.id} style={styles.item}>
          <View style={styles.itemHead}>
            <AppText variant="label">{humanAction(entry.action)}</AppText>
            <AppText variant="caption" color={palette.textMuted}>
              {formatStamp(entry.created_at)}
            </AppText>
          </View>
          <AppText variant="caption" color={palette.textSecondary}>
            by {entry.actor_email ?? entry.actor_id ?? 'an account that no longer exists'}
          </AppText>
          <AppText variant="caption" color={palette.textMuted}>
            target: {entry.target_type}
            {entry.target_id ? ` ${entry.target_id}` : ''}
          </AppText>
          <AppText variant="body" color={palette.textSecondary}>
            {entry.reason}
          </AppText>
        </Card>
      ))}

      {entries !== null && entries.length < total ? (
        <ActionButton label="Load more" tone="ghost" onPress={() => {
            void load(page + 1, false);
          }} />
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------- announcements */

function AnnouncementsSection(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [items, setItems] = useState<readonly AnnouncementRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<'info' | 'warning' | 'critical'>('info');
  const [publish, setPublish] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const result = await listAnnouncements();
    if (!result.ok) {
      setError(result.error);
      setItems(null);
      return;
    }
    setItems(result.data.announcements);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const invalid = title.trim().length === 0 || body.trim().length === 0 || reason.trim().length < 3;

  const submit = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    const result = await createAnnouncement({
      title: title.trim(),
      body: body.trim(),
      severity,
      published: publish,
      reason: reason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    setTitle('');
    setBody('');
    setReason('');
    setPublish(false);
    setSeverity('info');
    setStatus(
      publish
        ? 'Published. Everyone whose app checks the service will see it.'
        : 'Saved as a draft. Nobody can see it yet.',
    );
    await load();
  }, [body, load, publish, reason, severity, title]);

  return (
    <View style={styles.section}>
      <SectionHeader label="Announcements" detail={items ? `${items.length} total` : undefined} />

      <Card>
        <AppText variant="label">New announcement</AppText>

        <TextField
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="Shown as the heading"
          editable={!busy}
        />
        <TextField
          label="Body"
          value={body}
          onChangeText={setBody}
          placeholder="What the user needs to know"
          editable={!busy}
          multiline
        />

        <SegmentedControl
          options={[
            { value: 'info', label: 'Info' },
            { value: 'warning', label: 'Warning' },
            { value: 'critical', label: 'Critical' },
          ]}
          value={severity}
          onChange={setSeverity}
          accessibilityLabel="Announcement severity"
        />
        <AppText variant="caption" color={palette.textMuted}>
          Severity is a label the client decides how to present. It does not change who sees the
          announcement.
        </AppText>

        <View style={styles.toggleRow}>
          <View style={styles.toggleText}>
            <AppText variant="label">Publish now</AppText>
            <AppText variant="caption" color={palette.textMuted}>
              Off saves a draft, which only administrators can read.
            </AppText>
          </View>
          <Toggle
            value={publish}
            onValueChange={setPublish}
            disabled={busy}
            accessibilityLabel="Publish this announcement now"
          />
        </View>

        <TextField
          label="Reason"
          value={reason}
          onChangeText={setReason}
          placeholder="Why this announcement is being made"
          hint="Stored in the audit log."
          editable={!busy}
          multiline
        />

        <ActionButton
          label={publish ? 'Publish' : 'Save draft'}
          tone="primary"
          busy={busy}
          disabled={invalid}
          onPress={() => {
            void submit();
          }}
        />

        {status ? (
          <AppText variant="caption" color={palette.textSecondary}>
            {status}
          </AppText>
        ) : null}
      </Card>

      {error ? <Failure message={error} /> : null}
      {items === null && error === null ? <Loading label="Reading announcements" /> : null}

      {items?.map((item) => (
        <AnnouncementCard key={item.id} item={item} onChanged={() => {
            void load();
          }} />
      ))}
    </View>
  );
}

function AnnouncementCard({
  item,
  onChanged,
}: {
  item: AnnouncementRow;
  onChanged: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expired =
    item.expires_at !== null && new Date(item.expires_at).getTime() < Date.now();

  const flip = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await updateAnnouncement({
      id: item.id,
      patch: { published: !item.published },
      reason: reason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setReason('');
    onChanged();
  }, [item.id, item.published, onChanged, reason]);

  return (
    <Card style={styles.item}>
      <View style={styles.itemHead}>
        <AppText variant="label" numberOfLines={2} style={styles.grow}>
          {item.title}
        </AppText>
        <Badge
          label={item.published ? (expired ? 'Expired' : 'Live') : 'Draft'}
          tone={item.published ? (expired ? 'neutral' : 'success') : 'neutral'}
          dot
        />
      </View>
      <Badge label={item.severity} tone={item.severity === 'critical' ? 'danger' : 'neutral'} />
      <AppText variant="body" color={palette.textSecondary}>
        {item.body}
      </AppText>
      <AppText variant="caption" color={palette.textMuted}>
        {item.published_at
          ? `Published ${formatStamp(item.published_at)}`
          : `Created ${formatStamp(item.created_at)}`}
      </AppText>

      <TextField
        label="Reason"
        value={reason}
        onChangeText={setReason}
        placeholder={item.published ? 'Why this is being withdrawn' : 'Why this is being published'}
        editable={!busy}
      />
      <ActionButton
        label={item.published ? 'Withdraw' : 'Publish'}
        tone="ghost"
        compact
        busy={busy}
        disabled={reason.trim().length < 3}
        onPress={() => {
          void flip();
        }}
      />
      {error ? (
        <AppText variant="caption" color={palette.danger}>
          {error}
        </AppText>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------- service */

function ServiceSection(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await readMaintenance();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setEnabled(result.data.maintenance?.enabled ?? false);
    setMessage(result.data.maintenance?.message ?? '');
    setUpdatedAt(result.data.updatedAt);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const invalid =
    reason.trim().length < 3 || (enabled === true && message.trim().length === 0) || enabled === null;

  const apply = useCallback(async () => {
    if (enabled === null) return;
    setBusy(true);
    setStatus(null);
    const result = await setMaintenance({ enabled, message: message.trim(), reason: reason.trim() });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    setReason('');
    setUpdatedAt(result.data.updatedAt);
    setStatus(
      enabled
        ? 'Maintenance mode is on. Every app that checks the service will now be closed to ordinary users.'
        : 'Maintenance mode is off. Ordinary users can use the app again.',
    );
  }, [enabled, message, reason]);

  return (
    <View style={styles.section}>
      <SectionHeader label="Service availability" />

      {error ? <Failure message={error} /> : null}
      {enabled === null && error === null ? <Loading label="Reading the current setting" /> : null}

      {enabled !== null ? (
        <Card accentBorder={enabled}>
          <View style={styles.itemHead}>
            <StateChip state={enabled ? 'unavailable' : 'healthy'} />
            <AppText variant="caption" color={palette.textMuted}>
              {updatedAt ? `changed ${formatStamp(updatedAt)}` : 'never changed'}
            </AppText>
          </View>

          <AppText variant="body" color={palette.textSecondary}>
            {enabled
              ? 'The app is currently closed to everyone without the administrator role. A user who is offline is held to the last state their phone saw, so turning this off is not instant for them.'
              : 'The app is open. Turning this on closes it for every user without the administrator role, including on launch and when returning to the app.'}
          </AppText>

          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <AppText variant="label">Maintenance mode</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                Closing the app is the most disruptive thing this console can do. The reason below
                is required for that, not for opening it again.
              </AppText>
            </View>
            <Toggle
              value={enabled}
              onValueChange={setEnabled}
              disabled={busy}
              accessibilityLabel="Maintenance mode"
            />
          </View>

          <TextField
            label="Message shown to users"
            value={message}
            onChangeText={setMessage}
            placeholder="What is happening, and roughly how long"
            hint="Required while maintenance mode is on. A user locked out with no explanation will assume the app is broken."
            editable={!busy}
            multiline
          />

          <TextField
            label="Reason"
            value={reason}
            onChangeText={setReason}
            placeholder="Why the service is being closed, or reopened"
            hint="Stored in the audit log."
            editable={!busy}
            multiline
          />

          <ActionButton
            label={enabled ? 'Close the app' : 'Reopen the app'}
            tone={enabled ? 'danger' : 'primary'}
            busy={busy}
            disabled={invalid}
            onPress={() => {
            void apply();
          }}
          />

          {status ? (
            <AppText variant="caption" color={palette.textSecondary}>
              {status}
            </AppText>
          ) : null}
        </Card>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------- helpers */

/** `suspend_account` → `Suspend account`. */
function humanAction(action: string): string {
  const words = action.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString();
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

const stylesShared = StyleSheet.create({
  loading: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
});

const sharedStyles = StyleSheet.create({
  gate: {
    gap: spacing.sm,
  },
});

const makeStyles = (_palette: Palette) =>
  StyleSheet.create({
    notice: {
      gap: spacing.xs,
    },
    section: {
      gap: spacing.sm,
      paddingTop: spacing.md,
    },
    item: {
      gap: spacing.xs,
    },
    itemHead: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    itemText: {
      flex: 1,
      minWidth: 0,
      gap: 1,
    },
    itemBadges: {
      alignItems: 'flex-end',
      gap: spacing.xs,
    },
    grow: {
      flex: 1,
      minWidth: 0,
    },
    actions: {
      gap: spacing.md,
      paddingTop: spacing.sm,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    toggleText: {
      flex: 1,
      minWidth: 0,
      gap: 1,
    },
  });

/** Exported so a test can assert the page size matches what the client asks for. */
export { ADMIN_PAGE_SIZE };
