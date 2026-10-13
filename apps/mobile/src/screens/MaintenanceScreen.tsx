import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { Orb } from '../components/orb/Orb';
import { Screen } from '../components/Screen';
import { PRODUCT_NAME, PRODUCT_NAME_DEVANAGARI } from '../config/app';
import { spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import type { MaintenanceState } from '../maintenance';

/** Seconds between automatic re-checks while the app is closed. */
const RECHECK_SECONDS = 10;

/**
 * How many taps on the wordmark reveal the administrator entry.
 *
 * Not a secret — the source is readable, and a number written here is a
 * deliberate speed bump rather than a security control. The real control is
 * that the backend reads the account's role from the database on every request
 * and refuses everyone else. This exists so that an ordinary user under
 * maintenance is not offered a sign-in form that would refuse them anyway, while
 * an administrator still has a way back in without a database console.
 */
const RECOVERY_TAPS = 7;

export interface MaintenanceScreenProps {
  state: MaintenanceState;
  /** Re-reads the setting. Called by the countdown and by the button. */
  onRecheck: () => void;
  /** Opens the sign-in sheet for an administrator. */
  onOpenAdminSignIn: () => void;
}

/**
 * The closed app.
 *
 * ## What this screen does not do
 *
 * It does not kill the process, and it does not restart the app. The brief is
 * explicit that a countdown should end by continuing to block rather than by
 * terminating — and the practical reason is the same: an app that exits is an
 * app whose behaviour the user cannot read, and one that stays says what is
 * happening and what will happen next.
 *
 * ## Why the countdown re-checks rather than counting down to an unlock
 *
 * Ten seconds is how long until the *question* is asked again, not how long
 * until the app opens. If maintenance is still on, the countdown restarts and
 * says so. Presenting the countdown as a door about to open would be a promise
 * this screen cannot keep.
 *
 * ## Offline
 *
 * When the last known answer came from the cache, the screen says so. A user
 * whose phone is offline should not be told that the service is definitely
 * closed on the strength of a reading taken an hour ago — they should be told
 * what is known and what is not.
 */
export function MaintenanceScreen({
  state,
  onRecheck,
  onOpenAdminSignIn,
}: MaintenanceScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [remaining, setRemaining] = useState(RECHECK_SECONDS);
  const [taps, setTaps] = useState(0);
  const recheckRef = useRef(onRecheck);
  recheckRef.current = onRecheck;

  /**
   * The countdown.
   *
   * Held in a ref so the interval is not rebuilt every time `remaining` changes
   * — a `setInterval` recreated once a second is a second's worth of drift every
   * second, and the number on screen would visibly lag the clock.
   */
  const remainingRef = useRef(RECHECK_SECONDS);
  remainingRef.current = remaining;

  useEffect(() => {
    const timer = setInterval(() => {
      const next = remainingRef.current - 1;
      if (next > 0) {
        setRemaining(next);
        return;
      }
      // At zero: ask again, and restart the countdown whatever the answer.
      // Resetting *before* the request means the screen never sits on a frozen
      // `0` while a slow network decides.
      setRemaining(RECHECK_SECONDS);
      recheckRef.current();
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  /**
   * A new reading restarts the countdown, so a re-check triggered by the
   * administrator path does not leave the user watching half a countdown from
   * the previous one.
   */
  useEffect(() => {
    setRemaining(RECHECK_SECONDS);
  }, [state.checkedAtMs]);

  const handleTitleTap = useCallback(() => {
    setTaps((current) => current + 1);
  }, []);

  const showRecovery = taps >= RECOVERY_TAPS;

  const message =
    state.setting?.message && state.setting.message.trim().length > 0
      ? state.setting.message
      : `${PRODUCT_NAME} is being updated and will be back shortly.`;

  return (
    <Screen scroll testID="maintenance-screen">
      <View style={styles.orb}>
        {/* `error` rather than a new state: the orb already has one meaning for
            "the app cannot proceed", and inventing a second would give two
            visuals for one situation. */}
        <Orb state="error" />
      </View>

      <Pressable
        onPress={handleTitleTap}
        accessibilityRole="header"
        accessibilityLabel={`${PRODUCT_NAME_DEVANAGARI}, ${PRODUCT_NAME}`}
      >
        <AppText variant="display">
          {PRODUCT_NAME_DEVANAGARI}
        </AppText>
        <AppText variant="caption" color={palette.textMuted}>
          {PRODUCT_NAME}
        </AppText>
      </Pressable>

      <Card style={styles.card} accentBorder>
        <View style={styles.row}>
          <Badge label="Maintenance" tone="warning" dot />
          {state.fromCache ? <Badge label="Last known" tone="neutral" /> : null}
        </View>

        <AppText variant="heading">
          Temporarily unavailable
        </AppText>

        <AppText variant="body" color={palette.textSecondary}>
          {message}
        </AppText>

        {state.setting?.expectedEndAt ? (
          <AppText variant="caption" color={palette.textMuted}>
            Expected to end around {formatWhen(state.setting.expectedEndAt)}.
          </AppText>
        ) : null}

        {state.setting?.enabledAt ? (
          <AppText variant="caption" color={palette.textMuted}>
            Closed since {formatWhen(state.setting.enabledAt)}.
          </AppText>
        ) : null}
      </Card>

      <Card sunken style={styles.card}>
        <View style={styles.row}>
          <Icon name="refresh" size={16} color={palette.textMuted} />
          <AppText variant="label" color={palette.textSecondary}>
            Checking again in {remaining}s
          </AppText>
        </View>

        <AppText variant="caption" color={palette.textMuted}>
          {state.fromCache
            ? 'The status below is the last one this phone was able to read. Without a connection the app cannot tell whether the service has reopened, so it is staying closed rather than guessing.'
            : 'This phone can reach the service, so this reading is current.'}
        </AppText>

        <ActionButton
          label="Check now"
          tone="secondary"
          icon="refresh"
          onPress={() => {
            setRemaining(RECHECK_SECONDS);
            onRecheck();
          }}
        />

        {/* The honest exit. Nothing is killed and nothing is restarted, so the
            button describes exactly what it does. */}
        <AppText variant="caption" color={palette.textMuted}>
          The app stays closed until the service reopens. Nothing is uninstalled, and no data on
          this phone is touched.
        </AppText>
      </Card>

      {showRecovery ? (
        <Card sunken style={styles.card}>
          <AppText variant="label">Administrator access</AppText>
          <AppText variant="caption" color={palette.textMuted}>
            Maintenance mode is meant to stop ordinary use, not to lock an administrator out of
            turning it off. Signing in here does not weaken the rule: the backend checks the
            account&apos;s role against the database on every administration request, so an
            account without the role is refused exactly as it would be at any other time.
          </AppText>
          <ActionButton label="Sign in as administrator" tone="secondary" onPress={onOpenAdminSignIn} />
        </Card>
      ) : null}

      {state.reason ? (
        <AppText variant="caption" color={palette.textMuted}>
          {state.reason}
        </AppText>
      ) : null}
    </Screen>
  );
}

/**
 * Formats an ISO instant for display.
 *
 * Returns the raw string when it cannot be parsed, rather than "Invalid Date":
 * a timestamp this app did not write is still information, and replacing it with
 * an error message would hide what the server actually said.
 */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

const makeStyles = (_palette: Palette) =>
  StyleSheet.create({
    orb: {
      alignItems: 'center',
      paddingTop: spacing.xl,
      paddingBottom: spacing.lg,
    },
    card: {
      gap: spacing.sm,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      flexWrap: 'wrap',
    },
  });
