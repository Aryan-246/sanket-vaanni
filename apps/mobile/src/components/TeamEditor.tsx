/**
 * The Admin team editor.
 *
 * ## Every write carries a reason
 *
 * The backend refuses a team write without one and writes it into the audit
 * pair. This form asks for it beside the save button so the reason is recorded
 * while the administrator still knows it, rather than being reconstructed
 * later.
 *
 * ## Ordering is two writes, and says so
 *
 * There is no reorder endpoint. Moving a person swaps `sort_order` with their
 * neighbour in two calls. If the first succeeds and the second fails, the list
 * reloads from the server and the failure is reported — the screen never
 * pretends a half-applied order is the saved one.
 *
 * ## Photos
 *
 * Picking uploads immediately so the preview is the object that will be saved.
 * Cancelling the form removes an upload made during that session; saving
 * leaves the old photo to the server, which removes it only after the row
 * points at the new one.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ActionButton } from './ActionButton';
import { AppText } from './AppText';
import { Avatar } from './Avatar';
import { Badge } from './Badge';
import { Card } from './Card';
import { Sheet } from './Sheet';
import { TextField } from './TextField';
import { Toggle } from './Toggle';
import {
  createTeamMember,
  deleteTeamMember,
  listTeam,
  updateTeamMember,
  type AdminTeamMember,
} from '../admin/client';
import { pickTeamPhoto, removeTeamPhoto, uploadTeamPhoto } from '../admin/teamMedia';
import { teamPhotoUrl } from '../about/teamContent';
import { spacing } from '../theme';
import { useStyles, useTheme } from '../theme/ThemeProvider';

interface Draft {
  readonly id: string | null;
  name: string;
  role: string;
  bio: string;
  photoPath: string | null;
  /** The URL to preview. Derived from `photoPath` for an existing row. */
  photoUrl: string | null;
  sortOrder: number;
  published: boolean;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  role: '',
  bio: '',
  photoPath: null,
  photoUrl: null,
  sortOrder: 0,
  published: false,
};

function draftOf(member: AdminTeamMember): Draft {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    bio: member.bio,
    photoPath: member.photo_path,
    photoUrl: teamPhotoUrl(member.photo_path),
    sortOrder: member.sort_order,
    published: member.published,
  };
}

export function TeamEditor(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();

  const [members, setMembers] = useState<AdminTeamMember[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** An object uploaded while this form has been open and not yet saved. */
  const [pendingUpload, setPendingUpload] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<AdminTeamMember | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const result = await listTeam(signal);
    if (signal?.aborted) return;
    setLoading(false);
    if (!result.ok) {
      if (result.error === 'cancelled') return;
      setError(result.error);
      return;
    }
    setError(null);
    setMembers(result.data.members);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const openNew = useCallback(() => {
    const nextOrder = members && members.length > 0
      ? Math.max(...members.map((member) => member.sort_order)) + 1
      : 0;
    setDraft({ ...EMPTY_DRAFT, sortOrder: nextOrder });
    setReason('');
    setFormError(null);
    setPendingUpload(null);
  }, [members]);

  const openEdit = useCallback((member: AdminTeamMember) => {
    setDraft(draftOf(member));
    setReason('');
    setFormError(null);
    setPendingUpload(null);
  }, []);

  const closeForm = useCallback(() => {
    if (pendingUpload) void removeTeamPhoto(pendingUpload);
    setPendingUpload(null);
    setDraft(null);
    setFormError(null);
  }, [pendingUpload]);

  const choosePhoto = useCallback(async () => {
    setFormError(null);
    const picked = await pickTeamPhoto();
    if (!picked.ok) {
      if (!picked.cancelled && picked.error !== null) setFormError(picked.error);
      return;
    }

    setBusy(true);
    const uploaded = await uploadTeamPhoto(picked.photo);
    setBusy(false);
    if (!uploaded.ok) {
      setFormError(uploaded.error);
      return;
    }

    // A second pick in the same form leaves the first upload orphaned.
    if (pendingUpload) void removeTeamPhoto(pendingUpload);
    setPendingUpload(uploaded.path);
    setDraft((current) =>
      current === null
        ? current
        : { ...current, photoPath: uploaded.path, photoUrl: uploaded.url },
    );
  }, [pendingUpload]);

  const removePhotoFromDraft = useCallback(() => {
    if (pendingUpload) void removeTeamPhoto(pendingUpload);
    setPendingUpload(null);
    setDraft((current) => (current === null ? current : { ...current, photoPath: null, photoUrl: null }));
  }, [pendingUpload]);

  const save = useCallback(async () => {
    if (draft === null) return;
    if (reason.trim().length < 3) {
      setFormError('Write at least a few words explaining this change.');
      return;
    }
    if (draft.name.trim().length === 0 || draft.role.trim().length === 0) {
      setFormError('A name and a role are both required.');
      return;
    }

    setBusy(true);
    setFormError(null);

    const result =
      draft.id === null
        ? await createTeamMember({
            reason: reason.trim(),
            name: draft.name.trim(),
            role: draft.role.trim(),
            bio: draft.bio.trim(),
            photoPath: draft.photoPath,
            sortOrder: draft.sortOrder,
            published: draft.published,
          })
        : await updateTeamMember({
            id: draft.id,
            reason: reason.trim(),
            patch: {
              name: draft.name.trim(),
              role: draft.role.trim(),
              bio: draft.bio.trim(),
              photoPath: draft.photoPath,
              sortOrder: draft.sortOrder,
              published: draft.published,
            },
          });

    setBusy(false);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }

    setPendingUpload(null);
    setDraft(null);
    setStatus(
      draft.id === null
        ? draft.published
          ? 'Team member added and published.'
          : 'Team member saved as a draft. It is not visible on About yet.'
        : draft.published
          ? 'Team member saved. The About screen will show the change on its next load.'
          : 'Team member saved as a draft. It is hidden from About.',
    );
    void load();
  }, [draft, reason, load]);

  const move = useCallback(
    async (index: number, direction: -1 | 1) => {
      if (!members) return;
      const target = members[index];
      const neighbour = members[index + direction];
      if (!target || !neighbour) return;

      setBusy(true);
      setStatus(null);

      /*
       * Sequential, not parallel. If the first write fails, the second must not
       * run, or two rows would briefly hold the same order and the list would
       * no longer have a stable sequence.
       */
      const first = await updateTeamMember({
        id: target.id,
        reason: 'Reorder team members on the About screen',
        patch: { sortOrder: neighbour.sort_order },
      });
      const second = first.ok
        ? await updateTeamMember({
            id: neighbour.id,
            reason: 'Reorder team members on the About screen',
            patch: { sortOrder: target.sort_order },
          })
        : first;

      setBusy(false);
      if (!second.ok) {
        setStatus(
          first.ok
            ? 'The first position was changed but the second was not. The list has been reloaded from the server; reorder again if needed.'
            : second.error,
        );
      } else {
        setStatus('Order saved.');
      }
      void load();
    },
    [members, load],
  );

  const confirmDelete = useCallback(async () => {
    if (deleting === null) return;
    if (deleteReason.trim().length < 3) {
      setFormError('Write at least a few words explaining why this person is being removed.');
      return;
    }

    setBusy(true);
    setFormError(null);
    const result = await deleteTeamMember({ id: deleting.id, reason: deleteReason.trim() });
    setBusy(false);

    if (!result.ok) {
      setFormError(result.error);
      return;
    }

    setDeleting(null);
    setDeleteReason('');
    setStatus('Team member removed.');
    void load();
  }, [deleting, deleteReason, load]);

  const sorted = useMemo(() => members ?? [], [members]);

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <AppText variant="body" color={palette.textSecondary} style={styles.intro}>
          People shown on About. Drafts are visible only here.
        </AppText>
        <ActionButton
          label="Add person"
          tone="primary"
          compact
          onPress={openNew}
          testID="team-add"
        />
      </View>

      {status !== null && (
        <AppText variant="caption" color={palette.textSecondary}>
          {status}
        </AppText>
      )}

      {loading && members === null && error === null ? (
        <AppText variant="caption" color={palette.textMuted}>
          Loading the team list…
        </AppText>
      ) : null}

      {error !== null ? (
        <Card style={styles.errorCard}>
          <AppText variant="caption" color={palette.danger}>
            {error}
          </AppText>
          <ActionButton
            label="Try again"
            tone="secondary"
            compact
            onPress={() => void load()}
            testID="team-retry"
          />
        </Card>
      ) : null}

      {members !== null && sorted.length === 0 ? (
        <Card sunken style={styles.empty}>
          <AppText variant="caption" color={palette.textMuted}>
            Nobody has been added yet. The About screen shows five unfilled slots rather than
            invented names until a person is published here.
          </AppText>
        </Card>
      ) : null}

      {sorted.map((member, index) => (
        <Card key={member.id} style={styles.memberCard}>
          <View style={styles.memberRow}>
            <Avatar name={member.name} uri={teamPhotoUrl(member.photo_path)} size={44} />
            <View style={styles.memberText}>
              <View style={styles.memberTitle}>
                <AppText variant="label">{member.name}</AppText>
                <Badge
                  label={member.published ? 'Published' : 'Draft'}
                  tone={member.published ? 'success' : 'demo'}
                />
              </View>
              <AppText variant="caption" color={palette.textMuted}>
                {member.role}
                {member.bio.length > 0 ? ` · ${member.bio}` : ''}
              </AppText>
            </View>
          </View>

          <View style={styles.actions}>
            <ActionButton
              label="Up"
              tone="secondary"
              compact
              disabled={index === 0 || busy}
              onPress={() => void move(index, -1)}
              accessibilityLabel={`Move ${member.name} up`}
              style={styles.action}
            />
            <ActionButton
              label="Down"
              tone="secondary"
              compact
              disabled={index === sorted.length - 1 || busy}
              onPress={() => void move(index, 1)}
              accessibilityLabel={`Move ${member.name} down`}
              style={styles.action}
            />
            <ActionButton
              label="Edit"
              tone="secondary"
              compact
              disabled={busy}
              onPress={() => openEdit(member)}
              accessibilityLabel={`Edit ${member.name}`}
              style={styles.action}
            />
            <ActionButton
              label="Remove"
              tone="danger"
              compact
              disabled={busy}
              onPress={() => {
                setDeleting(member);
                setDeleteReason('');
                setFormError(null);
              }}
              accessibilityLabel={`Remove ${member.name}`}
              style={styles.action}
            />
          </View>
        </Card>
      ))}

      {/* ------------------------------------------------------- edit form */}

      <Sheet
        visible={draft !== null}
        onClose={closeForm}
        title={draft !== null && draft.id === null ? 'Add a team member' : 'Edit team member'}
        description="The About screen shows only published people."
        footer={
          <View style={styles.actions}>
            <ActionButton label="Cancel" tone="secondary" onPress={closeForm} style={styles.action} />
            <ActionButton
              label={draft?.published ? 'Save and publish' : 'Save draft'}
              tone="primary"
              onPress={() => void save()}
              busy={busy}
              style={styles.action}
              testID="team-save"
            />
          </View>
        }
      >
        {draft !== null && (
          <View style={styles.form}>
            <View style={styles.photoRow}>
              <Avatar name={draft.name || null} uri={draft.photoUrl} size={56} />
              <View style={styles.photoActions}>
                <ActionButton
                  label={draft.photoUrl === null ? 'Choose photo' : 'Change photo'}
                  tone="secondary"
                  compact
                  onPress={() => void choosePhoto()}
                  disabled={busy}
                  testID="team-photo"
                />
                {draft.photoUrl !== null && (
                  <ActionButton
                    label="Remove photo"
                    tone="ghost"
                    compact
                    onPress={removePhotoFromDraft}
                    disabled={busy}
                  />
                )}
              </View>
            </View>

            <TextField
              label="Name"
              value={draft.name}
              onChangeText={(name) => setDraft({ ...draft, name })}
              autoCapitalize="words"
              maxLength={120}
              testID="team-name"
            />
            <TextField
              label="Role"
              value={draft.role}
              onChangeText={(role) => setDraft({ ...draft, role })}
              maxLength={120}
              testID="team-role"
            />
            <TextField
              label="Short biography"
              value={draft.bio}
              onChangeText={(bio) => setDraft({ ...draft, bio })}
              multiline
              numberOfLines={4}
              maxLength={2000}
              hint="Up to 2000 characters. Leave empty if there is nothing to say."
              testID="team-bio"
            />

            <View style={styles.publishRow}>
              <Toggle
                value={draft.published}
                onValueChange={(published) => setDraft({ ...draft, published })}
                accessibilityLabel="Publish this person on the About screen"
              />
              <AppText variant="caption" color={palette.textSecondary} style={styles.intro}>
                Show this person on About. Unpublished rows are drafts.
              </AppText>
            </View>

            <TextField
              label="Reason for this change"
              value={reason}
              onChangeText={setReason}
              placeholder="Recorded in the audit log"
              maxLength={500}
              testID="team-reason"
            />

            {formError !== null && (
              <AppText variant="caption" color={palette.danger}>
                {formError}
              </AppText>
            )}
          </View>
        )}
      </Sheet>

      {/* --------------------------------------------------------- deletion */}

      <Sheet
        visible={deleting !== null}
        onClose={() => {
          setDeleting(null);
          setDeleteReason('');
          setFormError(null);
        }}
        title="Remove this person?"
        description={deleting === null ? undefined : `${deleting.name} will disappear from About.`}
        footer={
          <View style={styles.actions}>
            <ActionButton
              label="Cancel"
              tone="secondary"
              onPress={() => {
                setDeleting(null);
                setDeleteReason('');
                setFormError(null);
              }}
              style={styles.action}
            />
            <ActionButton
              label="Remove"
              tone="danger"
              onPress={() => void confirmDelete()}
              busy={busy}
              style={styles.action}
              testID="team-delete-confirm"
            />
          </View>
        }
      >
        <View style={styles.form}>
          <AppText variant="caption" color={palette.textSecondary}>
            Their photo is removed from storage too. This cannot be undone from this screen.
          </AppText>
          <TextField
            label="Reason for removing them"
            value={deleteReason}
            onChangeText={setDeleteReason}
            maxLength={500}
            testID="team-delete-reason"
          />
          {formError !== null && (
            <AppText variant="caption" color={palette.danger}>
              {formError}
            </AppText>
          )}
        </View>
      </Sheet>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    section: {
      gap: spacing.md,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
    },
    intro: {
      flex: 1,
    },
    errorCard: {
      gap: spacing.sm,
    },
    empty: {
      gap: spacing.xs,
    },
    memberCard: {
      gap: spacing.sm,
    },
    memberRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
    },
    memberText: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    memberTitle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      flexWrap: 'wrap',
    },
    actions: {
      flexDirection: 'row',
      gap: spacing.xs,
      flexWrap: 'wrap',
    },
    action: {
      flexGrow: 1,
    },
    form: {
      gap: spacing.md,
    },
    photoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    photoActions: {
      flex: 1,
      gap: spacing.xs,
    },
    publishRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
    },
  });
