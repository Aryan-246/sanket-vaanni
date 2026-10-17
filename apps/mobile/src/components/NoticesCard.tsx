/**
 * The notices card.
 *
 * ## What this is for, and what it is not
 *
 * An administrator can publish an announcement; this is where a user reads one.
 * It is deliberately a *card on Settings* rather than a banner across the top of
 * the app. The dashboard is a screen this task was told not to redesign, and a
 * global overlay would change the layout every other screen is built against —
 * so the reach of a notice is exactly "a user who opens Settings", and the
 * documentation says so rather than implying wider delivery.
 *
 * ## The sentence at the bottom is the point
 *
 * "Shown in the app only; nothing is sent to your phone for these" is not filler.
 * The natural assumption on seeing a critical notice is that it also arrived as a
 * notification, or that dismissing it removes it for everyone. Neither is true:
 * nothing dispatches an announcement, and dismissal is recorded on this device
 * alone. The card states both, because a user who believed they had suppressed a
 * warning for their whole team would be wrong in a way that matters.
 *
 * ## Why it sometimes renders nothing
 *
 * A successful read with no notices renders nothing — there is genuinely nothing
 * to say, and an empty card on every visit to Settings is noise. Every other
 * state renders, including "could not check", because a card that is absent and a
 * card that says "no notices" look identical to a user, and a failed read must
 * not be able to impersonate "nothing is happening".
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Badge, type BadgeTone } from './Badge';
import { Card } from './Card';
import { Icon } from './Icon';
import { SectionHeader } from './SectionHeader';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import { spacing } from '../theme';
import type { Palette } from '../theme/palette';
import type { AnnouncementSeverity } from '../supabase/types';
import {
  shouldShowNotices,
  type AnnouncementsState,
  type Notice,
} from '../announcements/reader';

/**
 * How each severity is labelled.
 *
 * The label carries the meaning and the tone only reinforces it, so a user who
 * cannot separate the colours still reads "Critical".
 */
const SEVERITY_LABEL: Record<AnnouncementSeverity, string> = {
  info: 'Information',
  warning: 'Warning',
  critical: 'Critical',
};

const SEVERITY_TONE: Record<AnnouncementSeverity, BadgeTone> = {
  info: 'accent',
  warning: 'warning',
  critical: 'danger',
};

export interface NoticesCardProps {
  readonly state: AnnouncementsState;
  /** Hides a notice on this device. Nothing is sent to the service. */
  readonly onDismiss: (id: string) => void;
  /** Asks again. Drawn only in the failure state. */
  readonly onRetry: () => void;
}

export function NoticesCard({
  state,
  onDismiss,
  onRetry,
}: NoticesCardProps): React.JSX.Element | null {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  if (!shouldShowNotices(state)) return null;

  return (
    <View testID="notices-card">
      <SectionHeader
        label="Notices"
        detail={
          state.status === 'unreadable'
            ? 'Could not be checked just now.'
            : 'Messages published to everyone using the app.'
        }
      />
      <Card style={styles.card} accentBorder={state.status === 'unreadable'}>
        {state.status === 'loading' && (
          <AppText variant="body" color={palette.textMuted}>
            Checking for notices…
          </AppText>
        )}

        {state.status === 'unreadable' && (
          <View style={styles.alert}>
            <Icon name="warning" size={16} color={palette.warning} />
            <AppText variant="body" style={styles.alertText}>
              {unreadableLead(state.fromCache, state.notices.length)}
            </AppText>
          </View>
        )}

        {/*
         * The service's own message, not a replacement for it. A policy refusal
         * reads as `permission denied for table announcements`, which tells an
         * operator exactly which grant is missing.
         */}
        {state.status === 'unreadable' && state.reason !== null && (
          <AppText variant="caption" color={palette.textMuted}>
            {state.reason}
          </AppText>
        )}

        {state.notices.map((notice) => (
          <NoticeItem key={notice.id} notice={notice} onDismiss={onDismiss} />
        ))}

        {state.status === 'unreadable' && (
          <View style={styles.actions}>
            <ActionButton
              label="Try again"
              icon="refresh"
              tone="secondary"
              compact
              onPress={onRetry}
              testID="notices-retry"
            />
          </View>
        )}

        {state.status === 'ready' && state.notices.length > 0 && (
          <AppText variant="caption" color={palette.textMuted}>
            Shown in the app only; nothing is sent to your phone for these. Dismissing hides one on
            this device, for you alone.
          </AppText>
        )}

        {state.status === 'unreadable' && state.fromCache && state.notices.length > 0 && (
          <AppText variant="caption" color={palette.textMuted}>
            Dismissing hides one on this device, for you alone.
          </AppText>
        )}
      </Card>
    </View>
  );
}

/**
 * The sentence for a read that failed, which depends on what survived it.
 *
 * Three states, and the third is the one a device found. `fromCache` is true
 * only when a list was genuinely read at some earlier point — the reader writes
 * the cache after a successful read and never on a failure — so "the last list
 * this phone read" is a true statement whenever it appears. What it does not
 * cover is a cached list that has since emptied: notices expire, and dismissing
 * one removes it from this device's view, so a stale cache can legitimately hold
 * nothing. Saying "this is the last list" above an empty card reads as an
 * introduction to items that do not follow, and the person reading it will wait
 * for a list rather than retry.
 */
function unreadableLead(fromCache: boolean, visibleCount: number): string {
  if (!fromCache) return 'Notices could not be checked.';
  if (visibleCount === 0) {
    return 'The latest notices could not be checked, and nothing from the last list is still live.';
  }
  return 'The latest notices could not be checked, so this is the last list this phone read.';
}

function NoticeItem({
  notice,
  onDismiss,
}: {
  readonly notice: Notice;
  readonly onDismiss: (id: string) => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  /*
   * A notice with no `published_at` is live as soon as it is published, so there
   * is no date to show. "Published just now" would be inventing a time the row
   * does not carry.
   */
  const when =
    notice.publishedAt === null
      ? 'Published'
      : `Published ${new Date(notice.publishedAt).toLocaleDateString()}`;

  return (
    <View style={styles.notice}>
      <View style={styles.noticeHead}>
        <Badge label={SEVERITY_LABEL[notice.severity]} tone={SEVERITY_TONE[notice.severity]} dot />
        <AppText variant="caption" color={palette.textMuted}>
          {when}
        </AppText>
      </View>
      <AppText variant="heading">{notice.title}</AppText>
      <AppText variant="body">{notice.body}</AppText>
      <View style={styles.actions}>
        <ActionButton
          label="Dismiss"
          icon="close"
          tone="ghost"
          compact
          onPress={() => onDismiss(notice.id)}
          accessibilityLabel={`Dismiss notice ${notice.title}`}
        />
      </View>
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    card: {
      gap: spacing.md,
    },
    alert: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    alertText: {
      flex: 1,
    },
    notice: {
      gap: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      paddingTop: spacing.sm,
    },
    noticeHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    actions: {
      flexDirection: 'row',
    },
  });
