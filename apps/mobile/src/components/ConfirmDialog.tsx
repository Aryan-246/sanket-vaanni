import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { radii, spacing } from '../theme';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  /** Say what will be lost. "This cannot be undone" is rarely enough on its own. */
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * Marks the action as destroying user data. Changes the icon and the confirm
   * button tone, and is deliberately *not* the default.
   */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A confirmation dialog.
 *
 * `dismissible` is false: tapping the scrim or pressing back cancels rather
 * than confirming, but the sheet will not vanish without an answer, which for
 * a destructive action is the difference between a clear decision and an
 * accidental one.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  const { palette } = useTheme();
  const styles = useStyles(makeStyles);

  // Back, scrim and the close affordance all resolve to "no".
  return (
    <Sheet
      visible={visible}
      onClose={onCancel}
      title={title}
      dismissible
      footer={
        <View style={styles.actions}>
          <ActionButton
            label={cancelLabel}
            tone="secondary"
            onPress={onCancel}
            style={styles.action}
          />
          <ActionButton
            label={confirmLabel}
            tone={destructive ? 'danger' : 'primary'}
            onPress={onConfirm}
            style={styles.action}
          />
        </View>
      }
    >
      <View style={styles.body}>
        <View style={[styles.iconWell, destructive && styles.iconWellDanger]}>
          <Icon
            name={destructive ? 'warning' : 'info'}
            size={20}
            color={destructive ? palette.danger : palette.accent}
          />
        </View>
        <AppText variant="body" color={palette.textSecondary} style={styles.message}>
          {message}
        </AppText>
      </View>
    </Sheet>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    body: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
    },
    iconWell: {
      width: 40,
      height: 40,
      borderRadius: radii.md,
      backgroundColor: palette.accentSurface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconWellDanger: {
      backgroundColor: palette.dangerSurface,
    },
    message: {
      flex: 1,
      paddingTop: spacing.xs,
    },
    actions: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    action: {
      flex: 1,
    },
  });
