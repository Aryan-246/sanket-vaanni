import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DetailHeader } from '../components/DetailHeader';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { ListRow } from '../components/ListRow';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { SegmentedControl, type SegmentedOption } from '../components/SegmentedControl';
import { StateChip } from '../components/StateChip';
import { TeamEditor } from '../components/TeamEditor';
import { TextField } from '../components/TextField';
import { Toggle } from '../components/Toggle';
import { useAccount } from '../account/AccountProvider';
import {
  ADMIN_PAGE_SIZE,
  createAnnouncement,
  listAnnouncements,
  listAudit,
  listUsers,
  readHealth,
  readMaintenance,
  readUser,
  readOverview,
  redispatchAnnouncement,
  requestPasswordReset,
  setMaintenance,
  setRole,
  setSuspension,
  setBulkSuspension,
  updateAnnouncement,
  type AdminAuditFilters,
  type AdminUserSummary,
  type MaintenanceChangedBy,
} from '../admin/client';
import { dispatchLine } from '../admin/dispatchReport';
import {
  DISPATCH_ACTION,
  NOT_IN_LOG_BADGE,
  NOT_IN_LOG_NOTE,
  latestDispatchPerAnnouncement,
  loggedDispatchBadge,
  loggedDispatchLine,
  loggedDispatchTone,
  type LoggedDispatch,
} from '../admin/lastDispatch';
import {
  AUDIT_ACTIONS,
  PERIOD_OPTIONS,
  SUBJECT_OPTIONS,
  describeAuditFilters,
  humanToken,
  periodWindow,
  type PeriodFilter,
  type SubjectFilter,
} from '../admin/auditFilters';
import {
  WINDOW_OPTIONS,
  expectedEndAt,
  windowNote,
  type WindowPreset,
} from '../admin/maintenanceWindow';
import {
  asFailure,
  describeAdminFailure,
  type AdminFailure,
  type AdminFailureDescription,
} from '../admin/failureState';
import {
  actorLine,
  detailOf,
  outcomeOf,
  recordedActorOf,
  requestIdOf,
  type AuditOutcome,
} from '../admin/auditEntry';
import {
  bulkOutcome,
  describeSelection,
  parseBulkReport,
  selectionProblem,
  UNREADABLE_BULK_ANSWER,
  type BulkAction,
  type BulkFailure,
} from '../admin/bulkEntry';
import {
  healthDetail,
  healthStateLabel,
  healthSummary,
  healthTone,
  parseHealth,
  parseOverview,
  type HealthCheck,
  type OverviewFigures,
} from '../admin/overviewFigures';
import { config } from '../config/env';
import { useMlData, useMlSnapshot } from './ml/hooks';
import { spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import type { AdminAuditRow, AnnouncementRow, ProfileRow } from '../supabase/types';

type AdminSection = 'overview' | 'people' | 'audit' | 'announcements' | 'team' | 'ml' | 'service';

/**
 * How a failed card asks for a fresh sign-in.
 *
 * ## Why this is a context and not a prop
 *
 * Every section of the console owns its own error state, and the action a 401
 * needs — opening the account sheet — belongs to `RootNavigator`, three levels
 * up. Passing it down as a prop would mean six components that do not otherwise
 * care about accounts each have to accept and forward it, and any one of them
 * forgetting to is a failure card that offers nothing to do.
 *
 * A context lets the one component that draws the failure read it directly, so
 * there is exactly one place the wiring can be wrong instead of eight.
 *
 * Undefined is the honest default: when the console is drawn without a way to
 * reach the account sheet, the card simply does not offer the button, rather
 * than offering one that does nothing.
 */
const SignInContext = React.createContext<(() => void) | undefined>(undefined);

const SECTIONS: readonly { value: AdminSection; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'people', label: 'People' },
  { value: 'audit', label: 'Audit' },
  { value: 'announcements', label: 'Notices' },
  { value: 'team', label: 'Team' },
  { value: 'ml', label: 'Learning' },
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
export function AdminScreen({
  onClose,
  onOpenMl,
  onOpenAccount,
}: {
  onClose: () => void;
  /**
   * Opens the learning centre.
   *
   * Omitted rather than disabled when the account's role is not yet known, for
   * the same reason `MoreScreen` omits the console entry: a control that is
   * drawn and then refuses is worse than one that is not drawn. The learning
   * centre is an administration surface — see the `ml` route in
   * `RootNavigator.tsx`, which is the gate that actually stops it rendering.
   */
  onOpenMl?: () => void;
  /**
   * Opens the account sheet, so a failure card can offer a way back in.
   *
   * Optional, and omitted where the console is drawn outside the tab shell.
   * When it is omitted the cards simply do not offer the button — see
   * `SignInContext`.
   */
  onOpenAccount?: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [section, setSection] = useState<AdminSection>('overview');

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
    <SignInContext.Provider value={onOpenAccount}>
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
        dense
      />

      <Card sunken style={styles.notice}>
        <AppText variant="caption" color={palette.textMuted}>
          Every action is recorded with your account, timestamp and reason. Audit log cannot be edited or deleted.
        </AppText>
      </Card>

      {section === 'overview' ? <OverviewSection onOpen={setSection} /> : null}
      {section === 'people' ? <PeopleSection /> : null}
      {section === 'audit' ? <AuditSection /> : null}
      {section === 'announcements' ? <AnnouncementsSection /> : null}
      {section === 'team' ? (
        <View style={styles.section}>
          <SectionHeader
            label="Team and About"
            detail="Who the About screen names, in the order it shows them."
          />
          <TeamEditor />
        </View>
      ) : null}
      {section === 'ml' ? <MlSection onOpenMl={onOpenMl} /> : null}
      {section === 'service' ? <ServiceSection /> : null}
      </Screen>
    </SignInContext.Provider>
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

/**
 * A read that failed, with the way out of it.
 *
 * ## Why the retry belongs on the card
 *
 * The failure state used to be a sentence and nothing else, so the only way to
 * try again was to change a filter or leave the section and come back. That
 * reads as "this is broken" rather than "this attempt was", and the two are
 * different claims: a request that timed out on a cold free-tier backend is
 * exactly the failure where pressing again works.
 *
 * The retry is optional rather than mandatory, because a caller that has no
 * re-read to offer would otherwise be forced to invent one.
 *
 * ## Why the status changes what is offered
 *
 * A retry is only honest where repeating the request could plausibly work. In
 * front of a 401 it is the opposite: the screen offers the one action that
 * cannot succeed, and an administrator presses it, watches it fail identically
 * and concludes the console is broken rather than that their session ended. So
 * when a status is known, `canRetry` decides whether the button appears at all,
 * and an authentication failure offers the action that does help instead.
 *
 * The server's own sentence is always shown. This adds to it; it never replaces
 * it, because the service writes those sentences to be read.
 */
function Failure({
  failure,
  onRetry,
  onSignIn,
  retryLabel = 'Try again',
}: {
  failure: AdminFailure;
  onRetry?: () => void;
  onSignIn?: () => void;
  retryLabel?: string;
}): React.JSX.Element {
  const { palette } = useTheme();
  /*
   * Read here rather than passed in, so every failure card in the console picks
   * it up without its section knowing anything about accounts.
   */
  const fromContext = React.useContext(SignInContext);
  const signIn = onSignIn ?? fromContext;
  const described =
    failure.status === undefined ? null : describeAdminFailure(failure.status);
  const canRetry = described === null ? onRetry !== undefined : described.canRetry && onRetry !== undefined;

  return (
    <Card sunken>
      <Badge label={failureBadge(described)} tone="danger" dot />
      {described ? (
        <AppText variant="label">{described.headline}</AppText>
      ) : null}
      <AppText variant="body" color={palette.textSecondary}>
        {failure.message}
      </AppText>
      {described ? (
        <AppText variant="caption" color={palette.textMuted}>
          {described.advice}
        </AppText>
      ) : null}
      {canRetry ? (
        <ActionButton label={retryLabel} tone="secondary" compact onPress={onRetry!} />
      ) : null}
      {described?.canSignIn && signIn !== undefined ? (
        <ActionButton label="Sign in again" tone="secondary" compact onPress={signIn} />
      ) : null}
    </Card>
  );
}

/**
 * The badge on a failed card.
 *
 * "Could not load" is wrong for a request that was answered and refused: the
 * console loaded perfectly well and was told no. The distinction is the whole
 * reason this card has more than one word.
 */
function failureBadge(described: AdminFailureDescription | null): string {
  switch (described?.kind) {
    case 'sign-in':
      return 'Signed out';
    case 'refused':
      return 'Refused';
    case 'unconfigured':
      return 'Not set up';
    case 'request':
      return 'Not accepted';
    default:
      return 'Could not load';
  }
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
  const [error, setError] = useState<AdminFailure | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [bulkReason, setBulkReason] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [bulkFailures, setBulkFailures] = useState<readonly BulkFailure[]>([]);
  const [bulkError, setBulkError] = useState<AdminFailure | null>(null);
  /** Which bulk action is waiting on confirmation, if any. */
  const [confirmingBulk, setConfirmingBulk] = useState<BulkAction | null>(null);

  const load = useCallback(
    async (nextPage: number, replace: boolean) => {
      setError(null);
      const result = await listUsers({
        page: nextPage,
        q: query,
        status: filter === 'all' ? undefined : filter,
      });
      if (!result.ok) {
        setError(asFailure(result));
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

  /*
   * Refuses to grow the selection past what one action may carry.
   *
   * Deselecting is always allowed, so a selection that somehow arrived over the
   * cap can still be brought back under it one row at a time.
   */
  const toggleSelected = useCallback((id: string) => {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (selectionProblem(current.length + 1) !== null) return current;
      return [...current, id];
    });
  }, []);

  /** The ids' names, as far as the loaded rows can supply them. */
  const labelFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const user of users ?? []) map.set(user.id, user.email ?? user.display_name ?? user.id);
    return map;
  }, [users]);

  const selectionNote = describeSelection(selected, labelFor);
  const overCap = selectionProblem(selected.length);

  /*
   * Runs the action and then says what actually happened.
   *
   * The answer is read per account rather than from the service's own tally, and
   * the list is reloaded whatever the answer said. That reload is what makes the
   * screen truthful after a partial result: the rows below then show the state
   * the database is really in, not the state the request hoped for.
   */
  const runBulk = useCallback(
    async (suspended: boolean) => {
      setBulkBusy(true);
      setBulkError(null);
      setBulkMessage(null);
      setBulkFailures([]);

      const result = await setBulkSuspension({
        userIds: selected,
        suspended,
        reason: bulkReason.trim(),
      });
      setBulkBusy(false);

      if (!result.ok) {
        setBulkError(asFailure(result));
        return;
      }

      const report = parseBulkReport(result.data);
      if (report === null) {
        setBulkError({ message: UNREADABLE_BULK_ANSWER });
      } else {
        const outcome = bulkOutcome(report, suspended ? 'suspend' : 'restore');
        setBulkMessage(outcome.headline);
        setBulkFailures(outcome.failures);
      }

      // Cleared even on an unreadable answer: the action has been sent, and a
      // selection left standing beside a "reload to see the state" notice is an
      // invitation to send it a second time.
      setSelected([]);
      setBulkReason('');
      void load(1, true);
    },
    [bulkReason, load, selected],
  );

  return (
    <View style={styles.section}>
      <SectionHeader label="Accounts" detail={total > 0 ? `${total} total` : undefined} />

      <TextField
        label="Search"
        value={query}
        onChangeText={setQuery}
        placeholder="Email or name"
        hint="Accounts only"
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

      {error ? <Failure failure={error} onRetry={() => { void load(1, true); }} /> : null}
      {users === null && error === null ? <Loading label="Loading accounts..." /> : null}

      {selected.length > 0 ? (
        <Card sunken>
          <SectionHeader
            label={`${selected.length} selected`}
            detail={`Suspend or restore. Each recorded separately.`}
          />

          <AppText variant="caption" color={palette.textMuted} testID="bulk-selection-names">
            {selectionNote}
          </AppText>

          <TextField
            label="Reason"
            value={bulkReason}
            onChangeText={setBulkReason}
            placeholder="Why"
            hint="Required for audit"
            multiline
          />
          {overCap ? (
            <AppText variant="caption" color={palette.danger}>
              {overCap}
            </AppText>
          ) : null}
          {bulkError ? (
            <Failure failure={bulkError} onRetry={() => { void load(1, true); }} />
          ) : null}
          {bulkMessage ? (
            <View style={styles.actions}>
              <AppText variant="body" color={palette.textSecondary}>
                {bulkMessage}
              </AppText>
              {bulkFailures.map((failure) => (
                <AppText key={failure.id} variant="caption" color={palette.warning}>
                  {labelFor.get(failure.id) ?? failure.id}: {failure.error}
                </AppText>
              ))}
            </View>
          ) : null}
          <View style={styles.actions}>
            <ActionButton
              label="Suspend"
              tone="danger"
              busy={bulkBusy}
              disabled={bulkReason.trim().length < 3 || overCap !== null}
              hint="Accounts locked out. Not deleted."
              onPress={() => setConfirmingBulk('suspend')}
            />
            <ActionButton
              label="Restore"
              tone="secondary"
              busy={bulkBusy}
              disabled={bulkReason.trim().length < 3 || overCap !== null}
              onPress={() => setConfirmingBulk('restore')}
            />
            <ActionButton
              label="Clear"
              tone="ghost"
              disabled={bulkBusy}
              onPress={() => setSelected([])}
            />
          </View>

          {/*
           * Confirmation is the last thing between a ticked box and a change to
           * somebody's account, and the dialog names the accounts rather than
           * counting them — the count is already on the button that was pressed.
           */}
          <ConfirmDialog
            visible={confirmingBulk !== null}
            title={confirmingBulk === 'restore' ? 'Restore these accounts?' : 'Suspend these accounts?'}
            message={`${selectionNote} ${
              confirmingBulk === 'restore'
                ? 'They will be able to sign in again.'
                : 'They will not be able to sign in. Nothing is deleted, and this can be undone one account at a time.'
            }`}
            confirmLabel={confirmingBulk === 'restore' ? 'Restore' : 'Suspend'}
            destructive={confirmingBulk !== 'restore'}
            onConfirm={() => {
              const action = confirmingBulk;
              setConfirmingBulk(null);
              if (action !== null) void runBulk(action === 'suspend');
            }}
            onCancel={() => setConfirmingBulk(null)}
          />
        </Card>
      ) : null}

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
          selected={selected.includes(user.id)}
          onSelect={() => toggleSelected(user.id)}
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
  selected,
  onSelect,
  onChanged,
}: {
  user: AdminUserSummary;
  isSelf: boolean;
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const [message, setMessage] = useState<string | null>(null);

  /*
   * This account's own administrative history.
   *
   * Read when the card is opened, and only once: the guard on `history === null`
   * is what stops collapsing and re-opening the same card from firing a second
   * read whose late answer would race the first. Nothing here is a separate
   * endpoint — it is the audit log filtered by target, which is the same query the
   * Audit tab makes and the record that answers "what has been done to this
   * person", a different question from "what has this administrator done".
   */
  const [history, setHistory] = useState<readonly AdminAuditRow[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || history !== null || historyError !== null) return;

    let cancelled = false;
    void (async () => {
      const result = await listAudit(1, { targetId: user.id });
      if (cancelled) return;
      if (!result.ok) {
        setHistoryError(result.error);
        return;
      }
      setHistory(result.data.entries);
      setHistoryTotal(result.data.total);
    })();

    return () => {
      cancelled = true;
    };
  }, [expanded, history, historyError, user.id]);

  /*
   * The account, re-read from the database when the card is opened.
   *
   * The row above came from a page of results that may be minutes old — an
   * administrator can hold this list open while somebody else suspends the
   * account, or while their own earlier action is still settling. `GET
   * /admin/users/:id` reads the single row by id, so the expanded card is a
   * statement about now rather than about the moment the page was fetched, and
   * the disagreement case is reported rather than hidden.
   *
   * Read once per card, guarded the same way the history read is, so collapsing
   * and re-opening cannot fire a second request whose late answer races the
   * first.
   */
  const [fresh, setFresh] = useState<ProfileRow | null>(null);
  const [freshError, setFreshError] = useState<string | null>(null);
  const [freshRead, setFreshRead] = useState(false);

  useEffect(() => {
    if (!expanded || freshRead) return;

    let cancelled = false;
    void (async () => {
      const result = await readUser(user.id);
      if (cancelled) return;
      setFreshRead(true);
      if (!result.ok) {
        setFreshError(result.error);
        return;
      }
      setFresh(result.data.user);
    })();

    return () => {
      cancelled = true;
    };
  }, [expanded, freshRead, user.id]);

  const suspended = user.status === 'suspended';

  /*
   * Whether the page and the fresh read disagree.
   *
   * Compared on the two fields the console can act on. A difference is worth
   * saying out loud: it means an action taken from this card is being applied to
   * an account whose state this screen has not been showing correctly.
   */
  const drifted =
    fresh !== null && (fresh.role !== user.role || fresh.status !== user.status);

  /*
   * After an action this card performed, read the account and its history
   * again.
   *
   * Both reads are deliberately once-per-open, so without this the expanded
   * card would keep showing the state it read when it opened: the action
   * button would flip to "Restore this account" (it reads the reloaded list)
   * while the line above it still said "status active", and the action just
   * taken would be missing from the history beneath it. Re-arming the guards
   * and reloading the list together is what makes the card describe one state.
   */
  const refreshAfterAction = useCallback(() => {
    setFresh(null);
    setFreshError(null);
    setFreshRead(false);
    setHistory(null);
    setHistoryError(null);
    setHistoryTotal(0);
    onChanged();
  }, [onChanged]);

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

      {/*
        The administrator's own account offers no selection control, because the
        backend refuses to suspend it. Showing a tick box that always ends in a
        400 would be a control that cannot do what it says.
      */}
      <View style={styles.selectRow}>
        {isSelf ? null : (
          <ActionButton
            label={selected ? 'Deselect' : 'Select'}
            tone="ghost"
            compact
            onPress={onSelect}
            accessibilityLabel={
              selected
                ? `Deselect ${user.email ?? user.display_name ?? 'this account'}`
                : `Select ${user.email ?? user.display_name ?? 'this account'} for a bulk action`
            }
          />
        )}
        <ActionButton
          label={expanded ? 'Close' : 'Manage'}
          tone="ghost"
          compact
          onPress={onToggle}
          hint={`Options for ${user.email ?? user.display_name ?? 'this account'}`}
        />
      </View>

      {expanded ? (
        <View style={styles.actions}>
          <View style={styles.history}>
            <AppText variant="label">This account, read from the database now</AppText>

            {fresh === null && freshError === null ? (
              <AppText variant="caption" color={palette.textMuted}>
                Re-reading this account by id…
              </AppText>
            ) : null}

            {freshError !== null ? (
              <>
                <AppText variant="caption" color={palette.textMuted}>
                  {freshError}
                </AppText>
                <AppText variant="caption" color={palette.textMuted}>
                  The row above is what the last page of results said. It may be out of date.
                </AppText>
              </>
            ) : null}

            {fresh !== null ? (
              <>
                <AppText variant="caption" color={palette.textMuted}>
                  {`Account id ${fresh.id}`}
                </AppText>
                <AppText variant="caption" color={palette.textMuted}>
                  {`Email ${fresh.email ?? 'not recorded on this profile'} · role ${fresh.role} · status ${fresh.status}`}
                </AppText>
                <AppText variant="caption" color={palette.textMuted}>
                  {`Joined ${formatStamp(fresh.created_at)}`}
                </AppText>
                <AppText variant="caption" color={palette.textMuted}>
                  {fresh.avatar_url
                    ? 'This account has an avatar image stored against its profile.'
                    : 'No avatar image is stored against this profile.'}
                </AppText>
                {drifted ? (
                  <Badge
                    label="The list above is out of date"
                    tone="warning"
                    dot
                  />
                ) : null}
              </>
            ) : null}
          </View>

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
              onDone={refreshAfterAction}
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
              onDone={refreshAfterAction}
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
            onDone={refreshAfterAction}
          />

          {message ? (
            <AppText variant="caption" color={palette.textSecondary}>
              {message}
            </AppText>
          ) : null}

          <View style={styles.history}>
            <AppText variant="label">History for this account</AppText>
            <AppText variant="caption" color={palette.textMuted}>
              Every administrative action recorded against this account, whoever made it.
            </AppText>

            {history === null && historyError === null ? (
              <AppText variant="caption" color={palette.textMuted}>
                Reading…
              </AppText>
            ) : null}

            {historyError !== null ? (
              <AppText variant="caption" color={palette.warning}>
                {historyError}
              </AppText>
            ) : null}

            {history !== null && history.length === 0 ? (
              // An empty history is a fact worth stating: no action has ever been
              // taken against this account, which is not the same as a log that
              // failed to load.
              <AppText variant="caption" color={palette.textMuted}>
                No administrative action has ever been taken against this account.
              </AppText>
            ) : null}

            {history?.map((entry) => <AuditEntryCard key={entry.id} entry={entry} />)}

            {history !== null && historyTotal > history.length ? (
              <AppText variant="caption" color={palette.textMuted}>
                Showing the {history.length} most recent of {historyTotal}. The Audit tab can show
                the rest.
              </AppText>
            ) : null}
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/* --------------------------------------------------------------------- audit */

/** How the outcome of an action is labelled, and in which tone. */
const OUTCOME_DISPLAY: Record<
  AuditOutcome,
  { readonly label: string; readonly tone: 'neutral' | 'success' | 'danger' | 'accent'; readonly help: string }
> = {
  requested: {
    label: 'Attempted',
    tone: 'accent',
    help: 'Recorded before the action ran. If no outcome follows, it never resolved.',
  },
  succeeded: { label: 'Succeeded', tone: 'success', help: 'The action ran.' },
  failed: { label: 'Failed', tone: 'danger', help: 'The action did not run.' },
  unrecorded: {
    label: 'Not recorded',
    tone: 'neutral',
    help: 'Written before outcomes were recorded, so nothing is claimed about it either way.',
  },
};

/** The outcome filter's own type, so `''` means "everything" without widening. */
type OutcomeFilter = '' | 'requested' | 'succeeded' | 'failed';

/** The filters the log offers, in the order they are shown. */
const OUTCOME_FILTERS: readonly SegmentedOption<OutcomeFilter>[] = [
  { value: '', label: 'Everything' },
  { value: 'requested', label: 'Attempted' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
];

function AuditSection(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [entries, setEntries] = useState<readonly AdminAuditRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<AdminFailure | null>(null);

  const [outcome, setOutcome] = useState<OutcomeFilter>('');
  const [actor, setActor] = useState('');
  const [subject, setSubject] = useState<SubjectFilter>('');
  const [period, setPeriod] = useState<PeriodFilter>('');
  const [action, setAction] = useState('');

  /*
   * The filters that are actually applied, held apart from the controls.
   *
   * A free-text actor is only sent on submit. Filtering the log as somebody
   * types would re-read the whole table per keystroke, and — worse — would leave
   * the list showing the results of a half-typed address while the field above
   * it reads as though it had not been applied yet.
   */
  const [appliedActor, setAppliedActor] = useState('');

  const filters = useMemo<AdminAuditFilters>(
    () => ({
      ...(outcome ? { outcome } : {}),
      ...(subject ? { targetType: subject } : {}),
      ...(action ? { action } : {}),
      ...(appliedActor ? { actor: appliedActor } : {}),
      /*
       * Resolved here rather than in the control's `onChange`, and read from
       * the clock at the moment this memo recomputes.
       *
       * `Date.now()` inside a memo whose dependencies are the pickers means the
       * window is fixed when the picker is touched, not on every render — which
       * matters, because a `filters` object of a new identity on every render
       * would re-run the effect below and re-read the log forever. Holding the
       * window still for as long as the picker is untouched is the price of
       * that, and it is the right price: a reader who asks for "24 hours" and
       * then sits on the screen for ten minutes is reading the 24 hours they
       * asked for, not a window that crept forward under them.
       */
      ...periodWindow(period, Date.now()),
    }),
    [outcome, subject, action, appliedActor, period],
  );

  const activeFilters = useMemo(() => describeAuditFilters(filters), [filters]);

  const load = useCallback(
    async (nextPage: number, replace: boolean) => {
      setError(null);
      const result = await listAudit(nextPage, filters);
      if (!result.ok) {
        setError(asFailure(result));
        if (replace) setEntries(null);
        return;
      }
      setTotal(result.data.total);
      setEntries((current) =>
        replace || current === null ? result.data.entries : [...current, ...result.data.entries],
      );
      setPage(result.data.page);
    },
    [filters],
  );

  /*
   * Re-reads from the first page whenever the filters change, rather than
   * appending: page 3 of "everything" has no relationship to page 3 of
   * "failed", and continuing from the old offset would silently skip rows that
   * match the new filter.
   */
  useEffect(() => {
    void load(1, true);
  }, [load]);

  /*
   * Asked of the filters that were sent, not of the controls that produced
   * them: a half-typed address sitting in the field above has changed nothing
   * about what is on screen, and a "clear filters" button that appeared for it
   * would be offering to undo something that never happened.
   */
  const filtered = activeFilters.length > 0;

  return (
    <View style={styles.section}>
      <SectionHeader label="Audit log" detail={total > 0 ? `${total} matching` : undefined} />

      <Card sunken>
        <AppText variant="caption" color={palette.textMuted}>
          Append-only. The database has no grant that would let any client edit or remove a row, so
          a mistake in an administrative tool cannot rewrite history.
        </AppText>
        <AppText variant="caption" color={palette.textMuted}>
          Every action is recorded twice: once when it is attempted, and again when it resolves.
          Both rows carry the same request id, so one action reads as one action rather than as two
          entries that look alike.
        </AppText>
      </Card>

      <Card style={styles.item}>
        <AppText variant="label">Filter</AppText>

        {/*
         * The whole filter set in words, above the controls.
         *
         * Four segmented rows in a column are easy to misread as one control,
         * and the heading above the log reports a total without saying what it
         * is a total *of*. This line closes both gaps: it names every filter
         * that is actually in force, in the same words the controls use.
         */}
        <AppText variant="caption" color={palette.textMuted} testID="audit-filter-summary">
          {activeFilters.length === 0
            ? 'Showing every entry, newest first.'
            : `Showing ${activeFilters.join(', ')}.`}
        </AppText>

        <FilterLabel text="Outcome" />
        <SegmentedControl
          options={OUTCOME_FILTERS}
          value={outcome}
          onChange={setOutcome}
          accessibilityLabel="Filter the audit log by outcome"
        />

        <FilterLabel text="What it was about" />
        <SegmentedControl
          options={SUBJECT_OPTIONS}
          value={subject}
          onChange={setSubject}
          accessibilityLabel="Filter the audit log by what the entry is about"
        />

        <FilterLabel text="When" />
        <SegmentedControl
          options={PERIOD_OPTIONS}
          value={period}
          onChange={setPeriod}
          accessibilityLabel="Filter the audit log by how long ago it happened"
        />

        <TextField
          label="Acted by"
          value={actor}
          onChangeText={setActor}
          placeholder="part of an administrator's address"
          hint="Matches the address recorded on the entry. Case is ignored by the server."
          autoCapitalize="none"
          onSubmitEditing={() => setAppliedActor(actor.trim())}
          returnKeyType="search"
        />

        <ActionButton
          label="Apply"
          tone="secondary"
          disabled={actor.trim() === appliedActor}
          onPress={() => setAppliedActor(actor.trim())}
        />

        {filtered ? (
          <ActionButton
            label="Clear filters"
            tone="ghost"
            onPress={() => {
              setOutcome('');
              setSubject('');
              setPeriod('');
              setAction('');
              setActor('');
              setAppliedActor('');
            }}
          />
        ) : null}
      </Card>

      {/*
       * The picker is its own card rather than an eleventh row inside the one
       * above. Thirteen actions cannot be a segmented control — the row would be
       * unreadable at that width — so it is a folded list, and a folded list
       * inside a padded card puts a bordered surface inside a bordered surface
       * for no reason. As a sibling it keeps the header, the surface and the
       * divider inset that `CollapsibleSection` already gets right.
       */}
      <ActionFilterPicker value={action} onChange={setAction} />

      {error ? <Failure failure={error} onRetry={() => { void load(1, true); }} /> : null}
      {entries === null && error === null ? <Loading label="Reading the log" /> : null}

      {entries !== null && entries.length === 0 && error === null ? (
        <EmptyState
          icon="clock"
          title={filtered ? 'Nothing matches those filters' : 'Nothing recorded yet'}
          body={
            filtered
              ? /*
                 * The filters are named back. "Nothing matches" on its own
                 * leaves an administrator staring at four controls trying to
                 * work out which of them emptied the list — and on a log this
                 * long, the answer is usually the one they set and forgot.
                 */
                `The log has entries, but none of them match: ${activeFilters.join(', ')}. This is not the same as an empty log, and the filters above can be cleared.`
              : 'The log is empty because no administrative action has been taken. It is not empty because loading failed.'
          }
        />
      ) : null}

      {entries?.map((entry) => (
        <AuditEntryCard key={entry.id} entry={entry} />
      ))}

      {entries !== null && entries.length < total ? (
        <ActionButton label="Load more" tone="ghost" onPress={() => {
            void load(page + 1, false);
          }} />
      ) : null}
    </View>
  );
}

/**
 * The caption above one filter control.
 *
 * Four segmented rows stacked in a column read as one long control unless each
 * one is named, and an `accessibilityLabel` names a group to a screen reader
 * without putting anything on the screen. This is the visible half of the same
 * statement, so a sighted user and a screen-reader user are told the same thing.
 */
function FilterLabel({ text }: { readonly text: string }): React.JSX.Element {
  const { palette } = useTheme();

  return (
    <AppText variant="caption" color={palette.textSecondary}>
      {text}
    </AppText>
  );
}

/**
 * The action filter: a folded list of every action the log can hold.
 *
 * ## Why a picker and not a text field
 *
 * The server validates `action` against `^[a-z][a-z0-9_]{0,40}$` and, on a value
 * that does not match, refuses it by matching *nothing* — the query is left
 * unfiltered. A text field would therefore let an administrator type "Suspend
 * Account", see the whole log come back, and reasonably conclude that no account
 * had ever been suspended. The filter would be reported as working while doing
 * the opposite of what it said.
 *
 * A list cannot be typed wrongly. Its cost is that it can only offer actions
 * this build knows about, which is why `AUDIT_ACTIONS` is documented as a
 * convenience rather than a whitelist: an action the backend gained later still
 * shows up in the log and on its own entry card, it just is not one-tap
 * filterable until this list gains it.
 */
function ActionFilterPicker({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
}): React.JSX.Element {
  const { palette } = useTheme();

  return (
    <CollapsibleSection
      label="Which action"
      // The current choice belongs on the collapsed header: a filter set three
      // scrolls ago and folded away is exactly the filter a reader forgets, and
      // then wonders why the log looks empty.
      detail={
        value === '' ? 'No action filter.' : `Only “${humanToken(value)}”, the action and its result.`
      }
      accessory={
        value === '' ? undefined : <Icon name="check" size={16} color={palette.textSecondary} />
      }
      defaultOpen={false}
    >
      <ListRow
        label="Any action"
        description="Every action the log holds."
        onPress={() => onChange('')}
        accessory={value === '' ? <Icon name="check" size={16} color={palette.accent} /> : undefined}
      />
      {AUDIT_ACTIONS.map((action, index) => (
        <ListRow
          key={action}
          label={humanAction(action)}
          onPress={() => onChange(action)}
          last={index === AUDIT_ACTIONS.length - 1}
          accessory={
            value === action ? <Icon name="check" size={16} color={palette.accent} /> : undefined
          }
        />
      ))}
    </CollapsibleSection>
  );
}

/** One audit row, with what is known about how it resolved. */
function AuditEntryCard({ entry }: { readonly entry: AdminAuditRow }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const outcome = outcomeOf(entry);
  const display = OUTCOME_DISPLAY[outcome];
  const requestId = requestIdOf(entry);
  const detail = detailOf(entry);

  return (
    <Card style={styles.item}>
      <View style={styles.itemHead}>
        <AppText variant="label">{humanAction(entry.action)}</AppText>
        <Badge label={display.label} tone={display.tone} dot />
      </View>

      <AppText variant="caption" color={palette.textMuted}>
        {formatStamp(entry.created_at)}
      </AppText>

      <AppText variant="caption" color={palette.textSecondary}>
        by {entry.actor_email ?? entry.actor_id ?? actorLine(recordedActorOf(entry))}
      </AppText>

      <AppText variant="caption" color={palette.textMuted}>
        target: {entry.target_type}
        {entry.target_id ? ` ${entry.target_id}` : ''}
      </AppText>

      <AppText variant="body" color={palette.textSecondary}>
        {entry.reason}
      </AppText>

      {detail ? (
        <AppText variant="caption" color={palette.textMuted}>
          {detail}
        </AppText>
      ) : null}

      {requestId ? (
        /*
         * The pairing id is shown, truncated, and only as a monospace tail. It is
         * what lets a reader tie an "Attempted" row to its outcome by eye, and
         * `requestIdOf` is what a future grouping pass would use to join them.
         */
        <AppText variant="caption" color={palette.textMuted}>
          request {requestId.length > 12 ? `…${requestId.slice(-12)}` : requestId}
        </AppText>
      ) : null}

      <AppText variant="caption" color={palette.textMuted}>
        {display.help}
      </AppText>
    </Card>
  );
}

/* ------------------------------------------------------------- announcements */

function AnnouncementsSection(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [items, setItems] = useState<readonly AnnouncementRow[] | null>(null);
  const [error, setError] = useState<AdminFailure | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<'info' | 'warning' | 'critical'>('info');
  const [publish, setPublish] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** The last recorded notification attempt per notice, from the audit log. */
  const [dispatches, setDispatches] = useState<ReadonlyMap<string, LoggedDispatch>>(new Map());
  /**
   * Whether the log read that fills `dispatches` succeeded.
   *
   * Held apart from `error`, which is about the notices themselves. A log that
   * cannot be read means the notices are still listed and only their delivery
   * history is missing, and those two failures need different sentences: one
   * says the notices could not be read, the other says they were read but their
   * notification history was not.
   */
  const [dispatchLogRead, setDispatchLogRead] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    const result = await listAnnouncements();
    if (!result.ok) {
      setError(asFailure(result));
      setItems(null);
      return;
    }
    setItems(result.data.announcements);

    /*
     * The delivery history, read separately and never fatally.
     *
     * One page of the log, filtered to the one action that records a dispatch.
     * If this fails the notices are still shown — losing a badge is not a reason
     * to withhold the list — and the cards say the history could not be read
     * rather than showing nothing, which would read as "nothing was sent".
     */
    const log = await listAudit(1, { action: DISPATCH_ACTION });
    if (!log.ok) {
      setDispatches(new Map());
      setDispatchLogRead(false);
      return;
    }
    setDispatches(latestDispatchPerAnnouncement(log.data.entries));
    setDispatchLogRead(true);
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
      // Sent as typed. The server decides whether the date is readable and
      // whether it has already passed, so the rule is the same for every client
      // and there is no second copy of it to drift.
      expiresAt: expiresAt.trim().length > 0 ? expiresAt.trim() : null,
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
    setExpiresAt('');
    setStatus(
      publish
        ? /*
           * What the service said about the notification, when it said anything.
           *
           * The fallback sentence is about the app, which is the part that is
           * certainly true: a published notice is readable by every user. It
           * deliberately says nothing about a phone, because a message that
           * reached one cannot be confirmed from here and an announcement being
           * live is not evidence that anyone was notified.
           */
          (dispatchLine(result.data.dispatch) ??
          'Published. Every app that reads the notices list will now see it — an app that cannot reach the service keeps showing the last list it successfully read.')
        : 'Saved as a draft. Nobody can see it yet.',
    );
    await load();
  }, [body, expiresAt, load, publish, reason, severity, title]);

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
          label="Expires (optional)"
          value={expiresAt}
          onChangeText={setExpiresAt}
          placeholder="2026-11-01T18:00:00Z"
          hint="When to stop showing it. Empty means it does not expire. A date that has already passed cannot be published — the server refuses it rather than creating a notice nobody will ever see."
          editable={!busy}
        />

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

      {error ? <Failure failure={error} onRetry={() => { void load(); }} /> : null}
      {items === null && error === null ? <Loading label="Reading announcements" /> : null}

      {/*
        An empty list is an answer, and it was previously drawn as nothing at
        all — which is indistinguishable from a page that has not finished
        loading. The distinction matters here more than on most screens: a draft
        is only visible to an administrator, so "no notices" and "the read
        failed" are two different facts about the same blank area.
      */}
      {items !== null && items.length === 0 && error === null ? (
        <EmptyState
          icon="bell"
          title="No notices have been written"
          body={
            'The read succeeded and there are no announcements yet, draft or published. ' +
            'Anyone using the app sees the notices area as empty for the same reason.'
          }
        />
      ) : null}

      {items?.map((item) => (
        <AnnouncementCard
          key={item.id}
          item={item}
          dispatch={dispatches.get(item.id)}
          logRead={dispatchLogRead}
          onChanged={() => {
            void load();
          }}
        />
      ))}
    </View>
  );
}

function AnnouncementCard({
  item,
  dispatch,
  logRead,
  onChanged,
}: {
  item: AnnouncementRow;
  /** The last recorded notification attempt for this notice, when the log had one. */
  dispatch: LoggedDispatch | undefined;
  /** Whether the log was read at all, so "absent" is never read as "never sent". */
  logRead: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdminFailure | null>(null);
  /**
   * What the service said about the notification, kept apart from `error`.
   *
   * A publish that reaches no phone is not a failed action — the announcement is
   * live and users can read it — so it must not be shown in the error colour,
   * which would read as "this did not work" and invite a retry of something that
   * already did.
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Which of the card's two writes failed, so the retry repeats that one.
   *
   * A single "try again" in front of a card that can publish, withdraw and
   * re-send is ambiguous about which of the three it means, and the wrong guess
   * is not harmless: retrying a publish after a failed withdraw would take the
   * notice live again rather than taking it down.
   */
  const [failed, setFailed] = useState<'flip' | 'resend' | null>(null);

  const expired =
    item.expires_at !== null && new Date(item.expires_at).getTime() < Date.now();

  const flip = useCallback(async () => {
    setBusy(true);
    setError(null);
    setFailed(null);
    setNotice(null);
    const result = await updateAnnouncement({
      id: item.id,
      patch: { published: !item.published },
      reason: reason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setError(asFailure(result));
      setFailed('flip');
      return;
    }
    setReason('');
    setNotice(dispatchLine(result.data.dispatch));
    onChanged();
  }, [item.id, item.published, onChanged, reason]);

  /**
   * Sends a live announcement to the registered devices again.
   *
   * Only offered for something already published: a draft is invisible to users,
   * so a notification about it would point at a notice the app will not show,
   * and the service refuses it for the same reason.
   */
  const resend = useCallback(async () => {
    setBusy(true);
    setError(null);
    setFailed(null);
    setNotice(null);
    const result = await redispatchAnnouncement({ id: item.id, reason: reason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(asFailure(result));
      setFailed('resend');
      return;
    }
    setReason('');
    setNotice(dispatchLine(result.data.dispatch));
  }, [item.id, reason]);

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

      {/*
        What the log recorded about the last time this notice was sent to
        devices. It is the only durable answer — the notice row itself has no
        delivery field, and the sentence under the buttons describes the write
        that just happened, which the reader loses as soon as they open another
        section.

        Three states, kept apart on purpose:

          - the log names an attempt, so its outcome and the service's own
            summary are shown;
          - the log was read and does not name one, which is a fact about the
            page of the log that was read, not a claim that nothing was ever
            sent;
          - the log could not be read, which says nothing either way and must
            not be drawn as the middle case.
      */}
      {notice === null ? (
        dispatch !== undefined ? (
          <>
            <Badge label={loggedDispatchBadge(dispatch.outcome)} tone={loggedDispatchTone(dispatch.outcome)} />
            <AppText variant="caption" color={palette.textSecondary}>
              {loggedDispatchLine(dispatch)}
            </AppText>
          </>
        ) : (
          <>
            <Badge label={logRead ? NOT_IN_LOG_BADGE : 'History unread'} tone="neutral" />
            <AppText variant="caption" color={palette.textMuted}>
              {logRead
                ? NOT_IN_LOG_NOTE
                : 'The audit log could not be read, so recent notification attempts for this notice are unknown here. That is not the same as none having been made.'}
            </AppText>
          </>
        )
      ) : null}

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
      {item.published ? (
        <ActionButton
          label="Send to devices"
          tone="ghost"
          compact
          busy={busy}
          disabled={reason.trim().length < 3}
          onPress={() => {
            void resend();
          }}
        />
      ) : null}
      {notice ? (
        <AppText variant="caption" color={palette.textSecondary}>
          {notice}
        </AppText>
      ) : null}
      {error ? (
        <Failure
          failure={error}
          /*
           * The retry is narrowed to the write that actually failed. Offering
           * one button for a card that can publish, withdraw and re-send would
           * make the wrong action the likely one, and the wrong action here
           * changes whether the notice is visible.
           */
          onRetry={
            failed === 'flip'
              ? () => {
                  void flip();
                }
              : failed === 'resend'
                ? () => {
                    void resend();
                  }
                : undefined
          }
        />
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------- service */

/* ------------------------------------------------------------------ overview */

/**
 * One figure, with the thing it counted named underneath it.
 *
 * The note is not decoration. "12" above "Suspended" is a claim about the
 * database, and a reader is entitled to know which rows produced it — especially
 * here, where the same word appears in two tiles with two different filters.
 */
function Figure({
  value,
  label,
  note,
}: {
  value: number;
  label: string;
  note: string;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  return (
    <View style={styles.tile}>
      <AppText variant="title">{String(value)}</AppText>
      <AppText variant="label">{label}</AppText>
      <AppText variant="caption" color={palette.textMuted}>
        {note}
      </AppText>
    </View>
  );
}

/**
 * The console's first screen: what the project currently contains.
 *
 * ## What it will not do
 *
 * It will not draw a tile it could not measure. Every number here was counted
 * by the backend in one of eleven queries, and if any of them failed the whole
 * endpoint answers 502 — so this screen either shows eleven real figures or it
 * shows an error. It never fills a gap with a zero, which is what would make
 * "0 suspended accounts" indistinguishable from "the count did not run".
 *
 * It also draws no chart. There is no history in the API to plot, and a
 * sparkline drawn from one reading is a decoration that reads as a trend.
 *
 * ## Why every tile links somewhere
 *
 * A number an administrator cannot act on is trivia. Each group opens the
 * section that can change it, so the count and the control are one tap apart.
 */
function OverviewSection({
  onOpen,
}: {
  onOpen: (section: AdminSection) => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [figures, setFigures] = useState<OverviewFigures | null>(null);
  const [error, setError] = useState<AdminFailure | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [loading, setLoading] = useState(true);

  /*
   * Aborted on unmount, and a cancelled request is not an error to show. Moving
   * to another section of the console, or closing it, must not leave a reply in
   * flight that then writes state onto a screen nobody is looking at — and a
   * refresh pressed twice must not have the slower of the two win.
   */
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setUnreadable(false);

    const result = await readOverview(signal);
    if (signal?.aborted) return;

    setLoading(false);
    if (!result.ok) {
      if (result.error === 'cancelled') return;
      setFigures(null);
      setError(asFailure(result));
      return;
    }

    const parsed = parseOverview(result.data);
    if (parsed === null) {
      setFigures(null);
      setUnreadable(true);
      return;
    }
    setFigures(parsed);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const nothingYet =
    figures !== null &&
    figures.users.total === 0 &&
    figures.announcements.live === 0 &&
    figures.announcements.drafts === 0 &&
    figures.audit.recent.length === 0 &&
    figures.audit.succeeded24h === 0 &&
    figures.audit.failed24h === 0;

  return (
    <View style={styles.section}>
      <SectionHeader
        label="At a glance"
        accessory={
          <ActionButton
            label="Refresh"
            tone="ghost"
            compact
            busy={loading}
            onPress={refresh}
            accessibilityLabel="Re-read the overview"
          />
        }
        detail="Real-time counts from backend"
      />

      {error ? <Failure failure={error} onRetry={refresh} /> : null}

      {loading && figures === null && error === null && !unreadable ? (
        <Loading label="Counting accounts, notices and recent activity" />
      ) : null}

      {unreadable ? (
        <EmptyState
          icon="warning"
          title="The service answered, but not with figures"
          body={
            'The overview came back without every count this screen needs, so none of it is shown. ' +
            'A missing count drawn as a zero would read as "none of those", which is a claim nothing made.'
          }
          action={<ActionButton label="Try again" onPress={refresh} />}
        />
      ) : null}

      {figures !== null && nothingYet ? (
        <EmptyState
          icon="info"
          title="Nothing to summarise yet"
          body={
            'The project has no accounts, no notices and no recorded actions. That is the state a ' +
            'fresh deployment is in, and these tiles will fill in as it is used.'
          }
        />
      ) : null}

      {figures !== null && !nothingYet ? (
        <>
          <Card>
            <View style={styles.itemHead}>
              <AppText variant="label">Accounts</AppText>
              <ActionButton
                label="Manage"
                tone="ghost"
                compact
                onPress={() => onOpen('people')}
                accessibilityLabel="Open the accounts list"
              />
            </View>
            <View style={styles.tiles}>
              <Figure
                value={figures.users.total}
                label="Total"
                note="All profiles"
              />
              <Figure
                value={figures.users.active}
                label="Active"
                note="Can sign in"
              />
              <Figure
                value={figures.users.suspended}
                label="Suspended"
                note="Locked out"
              />
              <Figure
                value={figures.users.admins}
                label="Admins"
                note="Any status"
              />
              <Figure
                value={figures.users.activeAdmins}
                label="Active admins"
                note="Can access console"
              />
            </View>
          </Card>

          <Card>
            <View style={styles.itemHead}>
              <AppText variant="label">Announcements</AppText>
              <ActionButton
                label="Manage"
                tone="ghost"
                compact
                onPress={() => onOpen('announcements')}
                accessibilityLabel="Open the announcements list"
              />
            </View>
            <View style={styles.tiles}>
              <Figure
                value={figures.announcements.live}
                label="Live"
                note="Visible to users"
              />
              <Figure
                value={figures.announcements.drafts}
                label="Drafts"
                note="Not published"
              />
              <Figure
                value={figures.announcements.expired}
                label="Expired"
                note="Past end date"
              />
            </View>
          </Card>

          <Card>
            <View style={styles.itemHead}>
              <AppText variant="label">Actions (24h)</AppText>
              <ActionButton
                label="View log"
                tone="ghost"
                compact
                onPress={() => onOpen('audit')}
                accessibilityLabel="Open the audit log"
              />
            </View>
            <View style={styles.tiles}>
              <Figure
                value={figures.audit.succeeded24h}
                label="Succeeded"
                note="Completed"
              />
              <Figure
                value={figures.audit.failed24h}
                label="Failed"
                note="Refused"
              />
            </View>
          </Card>

          <Card>
            <AppText variant="label">Most recent actions</AppText>
            {figures.audit.recent.length === 0 ? (
              <AppText variant="caption" color={palette.textMuted}>
                Nothing has been recorded yet. The first administrator action will appear here.
              </AppText>
            ) : (
              figures.audit.recent.map((entry) => (
                <View key={entry.id} style={styles.item}>
                  <View style={styles.itemHead}>
                    <AppText variant="body">{humanAction(entry.action)}</AppText>
                    <AppText variant="caption" color={palette.textMuted}>
                      {formatStamp(entry.createdAt)}
                    </AppText>
                  </View>
                  <AppText variant="caption" color={palette.textMuted}>
                    {entry.actorEmail ?? 'an account with no address'}
                    {entry.outcome ? ` · ${entry.outcome}` : ''}
                  </AppText>
                </View>
              ))
            )}
          </Card>

          <AppText variant="caption" color={palette.textMuted}>
            Read from the backend at {formatStamp(figures.generatedAt)}. The screen holds no counts
            of its own: press Refresh to read them again.
          </AppText>
        </>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------- service */

/**
 * What each configured component is, and what has actually been proved.
 *
 * ## Why this is not a set of ticks
 *
 * "Configured" and "working" are different facts, and the gap between them is
 * where a notification system quietly does nothing. So each component reports
 * one of four states, and the two that matter most are worded at length:
 * settings present but nothing ever sent (`untested`), and an attempt that was
 * refused (`failed`).
 *
 * Nothing here is a delivery claim. A probe that opens an SMTP connection
 * proves the server answers on that port; it does not prove an inbox received
 * a message. Until a real send is confirmed, every check reports
 * `deliveryTested: false` and the summary says so in words — a green tick
 * beside "Email" would be read as "email works" by anyone who has ever seen a
 * status page.
 */
function HealthCard(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [checks, setChecks] = useState<readonly HealthCheck[] | null>(null);
  const [error, setError] = useState<AdminFailure | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const result = await readHealth(signal);
    if (signal?.aborted) return;
    setLoading(false);
    if (!result.ok) {
      if (result.error === 'cancelled') return;
      setChecks(null);
      setError(asFailure(result));
      return;
    }
    const parsed = parseHealth(result.data);
    setChecks(parsed);
    if (parsed === null) {
      setError({ message: 'The service answered without a readable list of components.' });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const recheck = useCallback(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.section}>
      <SectionHeader
        label="Configuration health"
        accessory={
          <ActionButton
            label="Re-check"
            tone="ghost"
            compact
            busy={loading}
            onPress={recheck}
            accessibilityLabel="Check every component again"
          />
        }
        detail="Whether each part of the service is configured, and whether it has ever been proved to work."
      />

      {loading && checks === null && error === null ? (
        <Loading label="Checking the service and its configured components" />
      ) : null}

      {error ? <Failure failure={error} onRetry={recheck} /> : null}

      {checks !== null ? (
        <Card>
          <AppText variant="body" color={palette.textSecondary}>
            {healthSummary(checks)}
          </AppText>

          {checks.map((check) => (
            <View key={check.key} style={styles.item}>
              <View style={styles.itemHead}>
                <AppText variant="body">{check.label}</AppText>
                <Badge label={healthStateLabel(check)} tone={healthTone(check)} dot />
              </View>
              <AppText variant="caption" color={palette.textMuted}>
                {healthDetail(check)}
              </AppText>
              {check.delivers ? (
                <AppText variant="caption" color={palette.textMuted}>
                  {check.deliveryTested
                    ? 'A real message has been sent and confirmed.'
                    : 'No message has been sent and confirmed, so delivery is not claimed.'}
                </AppText>
              ) : null}
            </View>
          ))}

          <AppText variant="caption" color={palette.textMuted}>
            This reads configuration and connection state only. It never reports the values of any
            setting, key or credential.
          </AppText>
        </Card>
      ) : null}
    </View>
  );
}

/**
 * How the administrator role is provisioned, and where this project stands.
 *
 * ## Why this screen exists at all
 *
 * The first administrator cannot be created from the app: whoever could promote
 * themselves would make the role meaningless. So it is done out of band, by one
 * CLI command run against the database, and the console has never said so
 * anywhere. An operator reading this screen had no way to learn how the account
 * they are signed in as came to exist, whether a second one can be made the same
 * way, or what to do if the last administrator is lost.
 *
 * ## What it may and may not claim
 *
 * Every figure is read from `GET /admin/overview`, which counts the `profiles`
 * rows. Nothing here is inferred from the fact that this screen is rendering —
 * being signed in says this account holds the role, not how many others do.
 *
 * The statements about the bootstrap command are statements about code that is
 * in this repository and covered by `apps/backend/test/admin-bootstrap.test.ts`.
 * They are not a claim that the command has been run against the live project:
 * that cannot be observed from here, and the hosted database currently refuses
 * the write anyway.
 */
function ProvisioningCard(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [figures, setFigures] = useState<OverviewFigures | null>(null);
  const [error, setError] = useState<AdminFailure | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const result = await readOverview(signal);
    if (signal?.aborted) return;
    setLoading(false);
    if (!result.ok) {
      if (result.error === 'cancelled') return;
      setFigures(null);
      setError(asFailure(result));
      return;
    }
    const parsed = parseOverview(result.data);
    setFigures(parsed);
    if (parsed === null) {
      setError({ message: 'The service answered without a readable set of counts.' });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const recheck = useCallback(() => {
    void load();
  }, [load]);

  /*
   * Whether one-time provisioning is still available.
   *
   * It is available exactly while no active administrator exists, because that
   * is the condition the command itself checks before promoting anyone. Reading
   * it from the count rather than from a stored flag means this sentence cannot
   * drift from what the command would actually do.
   */
  const promotionAvailable = figures !== null && figures.users.activeAdmins === 0;

  return (
    <>
      <SectionHeader
        label="Administrator provisioning"
        detail="How the first administrator is created, and who holds the role now."
      />

      {loading && figures === null && error === null ? (
        <Loading label="Counting the accounts that hold the administrator role" />
      ) : null}

      {error !== null ? <Failure failure={error} onRetry={recheck} /> : null}

      {figures !== null ? (
        <Card>
          <View style={styles.tiles}>
            <View style={styles.tile}>
              <AppText variant="caption" color={palette.textMuted}>
                Accounts with the role
              </AppText>
              <AppText variant="title">{figures.users.admins}</AppText>
            </View>
            <View style={styles.tile}>
              <AppText variant="caption" color={palette.textMuted}>
                Of those, active
              </AppText>
              <AppText variant="title">{figures.users.activeAdmins}</AppText>
            </View>
          </View>

          <AppText variant="caption" color={palette.textSecondary}>
            {promotionAvailable
              ? 'No active account holds the administrator role. The one-time bootstrap would still promote an existing account, because it refuses only when an active administrator already exists.'
              : 'One-time provisioning is closed: an active administrator already exists, and the bootstrap command refuses to promote a second one. Further administrators are made from the People section, one account at a time, and every grant is recorded.'}
          </AppText>

          <AppText variant="caption" color={palette.textMuted}>
            The first administrator is created out of band, by running the bootstrap command once
            against the database with a service key. It promotes an account that already exists — it
            never creates one and never sets a password — and it refuses whenever an active
            administrator is already present. There is no HTTP route for it, no master password, and
            no separate set of administrator credentials: this console signs in with the same
            Supabase Auth identity as everything else, and the role is read from the database on
            every request.
          </AppText>

          <AppText variant="caption" color={palette.textMuted}>
            Losing the last active administrator cannot be undone from this app. The escape hatch is
            the same command with its recovery flag, which restores a row that already carries the
            role; it cannot grant the role to a new account. Removing the last one is refused here
            and refused by the backend, so the state is reachable only by changing the database
            directly.
          </AppText>
        </Card>
      ) : null}
    </>
  );
}

function ServiceSection(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedBy, setUpdatedBy] = useState<MaintenanceChangedBy | null>(null);
  const [error, setError] = useState<AdminFailure | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [windowPreset, setWindowPreset] = useState<WindowPreset>('');
  /** True while the close-the-app dialog is open. */
  const [confirmingClose, setConfirmingClose] = useState(false);

  const load = useCallback(async () => {
    const result = await readMaintenance();
    if (!result.ok) {
      setError(asFailure(result));
      return;
    }
    setError(null);
    setEnabled(result.data.maintenance?.enabled ?? false);
    setMessage(result.data.maintenance?.message ?? '');
    setUpdatedAt(result.data.updatedAt);
    setUpdatedBy(result.data.updatedBy);
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
    const result = await setMaintenance({
      enabled,
      message: message.trim(),
      reason: reason.trim(),
      /*
       * Sent only when there is something to say, and sent as an explicit null
       * when the preset is "Not saying" — the service treats null as "clear the
       * note", which is a different request from omitting the field.
       */
      expectedEndAt: expectedEndAt(windowPreset, Date.now()),
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    setReason('');
    setWindowPreset('');
    setUpdatedAt(result.data.updatedAt);
    /*
     * The write does not return who changed it, so the name is re-read rather
     * than assumed to be the signed-in administrator. It usually is — but this
     * is the one field on this screen whose whole purpose is to record a fact
     * about a person, and filling it in from an assumption is how such a field
     * ends up wrong without anybody noticing.
     */
    void load();
    setStatus(
      enabled
        ? 'Maintenance mode is on. Every app that checks the service will now be closed to ordinary users. It stays closed until somebody reopens it here.'
        : 'Maintenance mode is off. Ordinary users can use the app again.',
    );
  }, [enabled, message, reason, load, windowPreset]);

  return (
    <View style={styles.section}>
      {/*
        Health first: whether the service can be reached at all, and what is
        configured, decides how the maintenance controls below should be read.
      */}
      <HealthCard />

      <ProvisioningCard />

      <SectionHeader label="Service availability" />

      {error ? <Failure failure={error} onRetry={() => { void load(); }} retryLabel="Re-read the setting" /> : null}
      {enabled === null && error === null ? <Loading label="Reading the current setting" /> : null}

      {enabled !== null ? (
        <Card accentBorder={enabled}>
          <View style={styles.itemHead}>
            <StateChip state={enabled ? 'unavailable' : 'healthy'} />
            <AppText variant="caption" color={palette.textMuted}>
              {updatedAt ? `changed ${formatStamp(updatedAt)}` : 'never changed'}
            </AppText>
          </View>

          {/*
            Who, and honestly when nobody is recorded. `updatedAt` and `updatedBy`
            are separate facts: the row is seeded with neither, and the backend
            resolves the id the row does carry against `profiles` on every read,
            reporting a lookup that fails as unresolved rather than failing the
            whole read. So a missing name means the profile is gone *or* could not
            be read, and this line says neither more nor less than that while
            showing the id, which is the part a reader can check.
          */}
          <AppText variant="caption" color={palette.textMuted}>
            {updatedBy
              ? `Last changed by ${
                  updatedBy.email ?? `an account that could not be read (${updatedBy.id})`
                }`
              : 'No administrator is recorded against this setting. It is still at its seeded value.'}
          </AppText>

          <AppText variant="body" color={palette.textSecondary}>
            {enabled
              ? 'The app is currently closed to everyone without the administrator role. A user who is offline is held to the last state their phone saw, so turning this off is not instant for them.'
              : 'The app is open. Turning this on closes it for every user without the administrator role, including on launch and when returning to the app.'}
          </AppText>

          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <AppText variant="label">Maintenance mode</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                Closing the app is the most disruptive thing this console can do. A reason is
                required either way, so the reopening is attributable as well as the closure.
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

          {/*
            Only while the app is being closed. The note is what a locked-out
            user is shown and nothing acts on it, so offering it beside "Reopen"
            would be offering to set a field that no longer has a reader.
          */}
          {enabled ? (
            <>
              <AppText variant="label">Expected to end</AppText>
              <SegmentedControl
                options={WINDOW_OPTIONS}
                value={windowPreset}
                onChange={setWindowPreset}
                accessibilityLabel="How long the closure is expected to last"
              />
              <AppText variant="caption" color={palette.textMuted}>
                {windowNote(windowPreset, Date.now())}
              </AppText>
            </>
          ) : null}

          <ActionButton
            label={enabled ? 'Close the app' : 'Reopen the app'}
            tone={enabled ? 'danger' : 'primary'}
            busy={busy}
            disabled={invalid}
            onPress={() => {
              if (enabled) setConfirmingClose(true);
              else void apply();
            }}
          />

          {status ? (
            <AppText variant="caption" color={palette.textSecondary}>
              {status}
            </AppText>
          ) : null}

          {/*
            Reopening gets no dialog: it restores access rather than removing it,
            and a confirmation in front of the safe direction only teaches people
            to dismiss confirmations. Closing gets one, and the message names what
            is actually affected — every user of the app, including those who are
            offline and will keep the last state their phone saw.
          */}
          <ConfirmDialog
            visible={confirmingClose}
            title="Close the app for every user?"
            message={`${
              message.trim().length > 0
                ? `They will see: “${message.trim()}”. `
                : ''
            }Anyone without the administrator role will be locked out, on launch and whenever they return to the app. Users who are offline stay on the last state their phone saw, so this does not reach them instantly. It stays closed until somebody reopens it here.`}
            confirmLabel="Close the app"
            destructive
            onConfirm={() => {
              setConfirmingClose(false);
              void apply();
            }}
            onCancel={() => setConfirmingClose(false)}
          />
        </Card>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ learning */

/**
 * The learning centre, viewed from the console that owns it.
 *
 * ## Why the controls are not here
 *
 * This section deliberately does not re-implement recording, training or
 * activation. Those already exist, with their own consent gates, refuse-early
 * messages and honest reporting, and a second copy behind a different layout is
 * how two screens come to disagree about what was trained. What this section
 * does is what the console is for: report the true state from the store, and
 * open the one screen that changes it.
 *
 * ## What it reports, and what it refuses to report
 *
 * Every number below is counted from the stored index rather than asserted, so
 * a fresh install reads zero and a fresh install with no consent reads zero for
 * a reason the text names. There is no accuracy figure here, because an
 * accuracy figure belongs to a model and this section may be drawn while none
 * exists. The active model's own evaluation numbers are on its card in the
 * learning centre, where the set it was measured on is shown next to it.
 *
 * The algorithm is described as what it is — a fitted linear classifier, not a
 * neural network — because the phrase "trained model" would otherwise let a
 * reader assume more than the pipeline does.
 */
function MlSection({ onOpenMl }: { onOpenMl?: () => void }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const data = useMlData();
  const live = useMlSnapshot();

  const approved = data.headers.filter((header) => header.approval === 'approved').length;
  const pending = data.headers.filter((header) => header.approval === 'pending').length;
  const active = live.activeModel;

  const consent = data.settings.allowCollectedDataForTraining;

  return (
    <View style={styles.section}>
      <SectionHeader
        label="Learning centre"
        detail="Private to this phone. Nothing here is uploaded."
      />

      {/*
        Readiness first, because it is the question an administrator actually
        has when visiting this section: is there anything to train on, and is
        the phone permitted to train on it.
      */}
      <Card style={styles.item}>
        <View style={styles.itemHead}>
          <AppText variant="label">Where this install stands</AppText>
          <Badge
            label={data.ready ? 'Read' : 'Reading'}
            tone={data.ready ? 'neutral' : 'warning'}
            dot
          />
        </View>

        <View style={styles.tiles}>
          <View style={styles.tile}>
            <AppText variant="caption" color={palette.textMuted}>
              Signs defined
            </AppText>
            <AppText variant="title">{data.labels.length}</AppText>
          </View>
          <View style={styles.tile}>
            <AppText variant="caption" color={palette.textMuted}>
              Confirmed windows
            </AppText>
            <AppText variant="title">{approved}</AppText>
          </View>
          <View style={styles.tile}>
            <AppText variant="caption" color={palette.textMuted}>
              Awaiting review
            </AppText>
            <AppText variant="title">{pending}</AppText>
          </View>
          <View style={styles.tile}>
            <AppText variant="caption" color={palette.textMuted}>
              Versions fitted
            </AppText>
            <AppText variant="title">{data.models.length}</AppText>
          </View>
        </View>

        <AppText variant="caption" color={palette.textMuted}>
          {consent
            ? 'Training on collected recordings is permitted on this install. Recording and training are separate permissions, and this one is recorded with the time it was granted.'
            : 'Training on collected recordings is not permitted, so nothing recorded here can be fitted yet. Recording and training are separate permissions — agreeing to record is not agreeing to train.'}
          {pending > 0
            ? ` ${pending} recorded window${pending === 1 ? '' : 's'} ${pending === 1 ? 'is' : 'are'} still waiting to be confirmed by hand, and the trainer refuses them until they are.`
            : ''}
        </AppText>

        {data.damaged.length > 0 ? (
          <AppText variant="caption" color={palette.textMuted}>
            {`${data.damaged.length} stored window${data.damaged.length === 1 ? '' : 's'} could not be read back. Their labels and dates survive; their frames do not, so they cannot be trained on.`}
          </AppText>
        ) : null}

        {data.error !== null ? (
          <AppText variant="caption" color={palette.textMuted}>
            {data.error}
          </AppText>
        ) : null}
      </Card>

      {/* ------------------------------------------------------- active model */}

      <SectionHeader label="In use now" />

      {active === null ? (
        <Card style={styles.item}>
          <Badge label="Nothing activated" tone="neutral" dot />
          <AppText variant="body" color={palette.textSecondary}>
            No version has been activated, so the glove is not read against anything. Recording,
            labelling and fitting are all possible without this; only recognition needs it.
          </AppText>
        </Card>
      ) : (
        <Card style={styles.item}>
          <View style={styles.itemHead}>
            <AppText variant="label">{`Version ${active.version}`}</AppText>
            <Badge
              label={active.status === 'active' ? 'Active' : humanAction(active.status)}
              tone={active.status === 'active' ? 'success' : 'neutral'}
              dot
            />
          </View>

          {/*
            The algorithm, in the words the model record already uses for it.
            Drawn from the record rather than written here, so a future pipeline
            change cannot leave this card describing the old one.
          */}
          <AppText variant="caption" color={palette.textSecondary}>
            {active.algorithmDetail}
          </AppText>

          <AppText variant="caption" color={palette.textMuted}>
            {`Fitted on ${active.sampleCount} window${active.sampleCount === 1 ? '' : 's'} from ${active.sessionCount} capture session${active.sessionCount === 1 ? '' : 's'}, naming ${active.labelIds.length} sign${active.labelIds.length === 1 ? '' : 's'}.`}
            {` Recorded ${formatDate(new Date(active.trainedAtMs).toISOString())}.`}
          </AppText>

          <AppText variant="caption" color={palette.textMuted}>
            {active.trainedOn.includes('simulated')
              ? 'Part of its training data was Demo Mode motion, which is a simulated waveform. A model fitted on that recognises that waveform — a real test of the pipeline, and not evidence of recognising signing.'
              : 'It was fitted only on windows captured from the glove.'}
          </AppText>

          {active.evaluation === null ? (
            <AppText variant="caption" color={palette.textMuted}>
              No held-back evaluation was recorded for this version.
            </AppText>
          ) : active.evaluation.accuracy === null ? (
            /*
             * `accuracy` is null when the held-back split was empty, which
             * happens on a set too small to split. Reporting the null as "0%"
             * would be a claim about the model rather than about the split.
             */
            <AppText variant="caption" color={palette.textMuted}>
              Nothing was held back from this version, so no accuracy figure exists for it. That
              is a statement about the size of the set, not about the model.
            </AppText>
          ) : (
            <AppText variant="caption" color={palette.textMuted}>
              {`Measured on the sessions held back from it: ${Math.round(active.evaluation.accuracy * 100)}% over ${active.evaluation.counts.test} window${active.evaluation.counts.test === 1 ? '' : 's'} across ${active.evaluation.counts.testSessions} session${active.evaluation.counts.testSessions === 1 ? '' : 's'}. That is a measurement of this phone's own recordings, not a published benchmark.`}
            </AppText>
          )}

          {active.statusReason !== null ? (
            <AppText variant="caption" color={palette.textMuted}>
              {active.statusReason}
            </AppText>
          ) : null}
        </Card>
      )}

      {/* --------------------------------------------------------- the studio */}

      <SectionHeader
        label="Open the learning centre"
        detail="Record, label, fit, evaluate and activate."
      />

      <Card style={styles.item}>
        {onOpenMl === undefined ? (
          <AppText variant="body" color={palette.textSecondary}>
            The learning centre is not reachable from this session. It opens from the
            administration console once the account's role has been read from the server.
          </AppText>
        ) : (
          <>
            <AppText variant="body" color={palette.textSecondary}>
              Everything that changes what the glove is read against is behind that screen, and so
              is the consent it needs. Nothing on it reaches a server: recordings, labels and
              fitted versions live on this phone, and can be exported only by hand.
            </AppText>
            <ActionButton
              label="Open the learning centre"
              icon="scan"
              onPress={onOpenMl}
              testID="admin-open-ml"
            />
          </>
        )}
      </Card>
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

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    notice: {
      gap: spacing.xs,
    },
    section: {
      gap: spacing.md,
      paddingTop: spacing.lg,
    },
    /**
     * The overview's figures.
     *
     * Wrapped rather than in a fixed grid, because a count of accounts and a
     * count of expired notices have nothing in common except being numbers, and
     * a three-column lattice makes them look like parts of one total.
     */
    tiles: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.lg,
    },
    tile: {
      flexGrow: 1,
      flexBasis: 132,
      gap: spacing.sm,
    },
    item: {
      gap: spacing.sm,
    },
    /**
     * One account's audit history, inside the card it belongs to.
     *
     * Separated by a rule rather than just spacing: the actions above it are
     * things an administrator can do now, and everything below is a record of
     * what has already been done — which no control in this card can change.
     */
    history: {
      gap: spacing.md,
      marginTop: spacing.md,
      paddingTop: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    itemHead: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    itemText: {
      flex: 1,
      minWidth: 0,
      gap: spacing.xs,
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
      gap: spacing.lg,
      paddingTop: spacing.md,
    },
    selectRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.md,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.lg,
    },
    toggleText: {
      flex: 1,
      minWidth: 0,
      gap: spacing.xs,
    },
  });

/** Exported so a test can assert the page size matches what the client asks for. */
export { ADMIN_PAGE_SIZE };
