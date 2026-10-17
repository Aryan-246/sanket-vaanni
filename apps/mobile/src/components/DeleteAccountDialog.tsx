/**
 * The warning and code entry for permanent account deletion.
 *
 * ## Why this is not a `ConfirmDialog`
 *
 * A confirm dialog asks one question and takes one answer. This flow asks two —
 * "do you understand what will be destroyed?" and then "here is the code from
 * your email" — and the second only exists after the server has sent it. That
 * state, plus the resend clock, does not fit a component whose contract is
 * `onConfirm`/`onCancel`.
 *
 * ## What the warning says
 *
 * It names the things that are deleted rather than saying "all data". A user
 * deciding whether to delete an account needs to know that lessons practiced as
 * a guest on this phone are *not* part of it, because the opposite belief is
 * the one that would make someone hesitate unnecessarily — or delete in the
 * wrong direction.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Sheet } from './Sheet';
import { TextField } from './TextField';
import { Toggle } from './Toggle';
import { confirmDeletion, requestDeletionCode } from '../account/deletion';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { spacing } from '../theme';

export interface DeleteAccountDialogProps {
  visible: boolean;
  /** Shown so the user knows where to look. Never sent anywhere. */
  email: string | null;
  /** Called after the server has deleted the account. */
  onDeleted: () => void;
  onCancel: () => void;
}

type Step = 'warning' | 'code';

const RESEND_SECONDS = 60;

/**
 * A local countdown, restarted whenever the server accepts a send.
 *
 * It is a convenience, not a rate limit: the backend enforces the real one and
 * answers 429 with its own remaining seconds. If the two disagree, the server
 * wins and its message replaces this one.
 */
function useCountdown(): [number, () => void] {
  const [remaining, setRemaining] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(() => {
    setRemaining(RESEND_SECONDS);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      setRemaining((value) => {
        if (value <= 1) {
          if (timer.current) clearInterval(timer.current);
          timer.current = null;
          return 0;
        }
        return value - 1;
      });
    }, 1000);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  return [remaining, start];
}

export function DeleteAccountDialog({
  visible,
  email,
  onDeleted,
  onCancel,
}: DeleteAccountDialogProps): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);
  const [acknowledged, setAcknowledged] = useState(false);
  const [step, setStep] = useState<Step>('warning');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, startCountdown] = useCountdown();

  const reset = useCallback(() => {
    setAcknowledged(false);
    setStep('warning');
    setCode('');
    setBusy(false);
    setError(null);
  }, []);

  const close = useCallback(() => {
    reset();
    onCancel();
  }, [onCancel, reset]);

  /* A reopened dialog starts at the warning again. Keeping the previous step
     would mean the warning could be skipped on a second visit. */
  useEffect(() => {
    if (!visible) reset();
  }, [visible, reset]);

  const sendCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await requestDeletionCode();
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      if (result.retryAfterSeconds !== undefined && result.retryAfterSeconds > 0) {
        setStep('code');
      }
      return;
    }

    setStep('code');
    startCountdown();
  }, [startCountdown]);

  const resend = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await requestDeletionCode();
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    startCountdown();
  }, [startCountdown]);

  const confirm = useCallback(async () => {
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError('Enter the six-digit code from the email.');
      return;
    }

    setBusy(true);
    setError(null);
    const result = await confirmDeletion(trimmed);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    reset();
    onDeleted();
  }, [code, onDeleted, reset]);

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="Delete account permanently"
      description={
        step === 'warning'
          ? 'This is the last step before anything is removed.'
          : `A code was sent to ${email ?? 'your verified email address'}.`
      }
      dismissible
      footer={
        step === 'warning' ? (
          <View style={styles.actions}>
            <ActionButton
              label="Cancel"
              tone="secondary"
              onPress={close}
              style={styles.action}
            />
            <ActionButton
              label="Send code"
              tone="danger"
              onPress={() => void sendCode()}
              busy={busy}
              disabled={!acknowledged}
              style={styles.action}
              testID="delete-send-code"
            />
          </View>
        ) : (
          <View style={styles.actions}>
            <ActionButton
              label="Cancel"
              tone="secondary"
              onPress={close}
              style={styles.action}
            />
            <ActionButton
              label="Delete forever"
              tone="danger"
              onPress={() => void confirm()}
              busy={busy}
              disabled={code.trim().length !== 6}
              style={styles.action}
              testID="delete-confirm"
            />
          </View>
        )
      }
    >
      {step === 'warning' ? (
        <View style={styles.body}>
          <AppText variant="body" color={palette.textSecondary}>
            Deleting the account removes it at the authentication provider and permanently
            deletes:
          </AppText>
          <View style={styles.list}>
            <AppText variant="body" color={palette.textSecondary}>
              • your profile, display name and photo
            </AppText>
            <AppText variant="body" color={palette.textSecondary}>
              • preferences, calibration and OLED profiles synced to the account
            </AppText>
            <AppText variant="body" color={palette.textSecondary}>
              • recognition history and glove records synced to the account
            </AppText>
            <AppText variant="body" color={palette.textSecondary}>
              • push notification registration for this account
            </AppText>
          </View>
          <AppText variant="body" color={palette.textSecondary}>
            Data that exists only on this phone — including lessons practiced as a guest before
            signing in — is not deleted by this action. To remove it as well, clear the app's
            storage on this device.
          </AppText>

          <View style={styles.acknowledge}>
            <Toggle
              value={acknowledged}
              onValueChange={setAcknowledged}
              accessibilityLabel="I understand this permanently deletes my account"
              accessibilityHint="Required before a confirmation code can be sent."
            />
            <AppText variant="body" color={palette.textPrimary} style={styles.acknowledgeText}>
              I understand that this permanently deletes my account and cannot be undone.
            </AppText>
          </View>

          {error !== null && (
            <AppText variant="caption" color={palette.danger}>
              {error}
            </AppText>
          )}
        </View>
      ) : (
        <View style={styles.body}>
          <AppText variant="body" color={palette.textSecondary}>
            Enter the six-digit code from the email. It expires in ten minutes and works once.
          </AppText>

          <TextField
            label="Confirmation code"
            value={code}
            onChangeText={(value) => setCode(value.replace(/[^0-9]/g, '').slice(0, 6))}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={6}
            invalid={error !== null}
            hint={error ?? 'Check your inbox and spam folder.'}
            editable={!busy}
            testID="delete-code-input"
          />

          <ActionButton
            label={
              remaining > 0 ? `Send a new code in ${remaining}s` : 'Send a new code'
            }
            tone="secondary"
            onPress={() => void resend()}
            disabled={remaining > 0 || busy}
            busy={busy && remaining === 0}
            testID="delete-resend"
          />
        </View>
      )}
    </Sheet>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    body: {
      gap: spacing.md,
    },
    list: {
      gap: spacing.xs,
      paddingLeft: spacing.sm,
    },
    acknowledge: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: 12,
      backgroundColor: palette.surfaceSunken,
    },
    acknowledgeText: {
      flex: 1,
    },
    actions: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    action: {
      flex: 1,
    },
  });
