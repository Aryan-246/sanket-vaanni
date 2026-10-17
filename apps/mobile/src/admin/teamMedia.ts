/**
 * Team portrait uploads.
 *
 * The same picker, format list and base64 decoding as an avatar, with the
 * bucket and limit the `team-media` bucket actually enforces. The write policy
 * on that bucket accepts only an active administrator, so an ordinary account
 * that reached this code would be refused by Storage — this module does not
 * need to duplicate that check, and duplicating it would not make it stronger.
 */
import { launchImageLibrary } from 'react-native-image-picker';

import { base64ToBytes, extensionForMime } from '../account/avatar';
import { getSupabaseClient } from '../supabase/client';

/** Mirrors the `team-media` bucket's `file_size_limit`. */
export const TEAM_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export interface PickedTeamPhoto {
  readonly base64: string;
  readonly mimeType: string;
  readonly extension: string;
}

export type PickTeamPhotoResult =
  | { readonly ok: true; readonly photo: PickedTeamPhoto }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string | null };

export type UploadTeamPhotoResult =
  | { readonly ok: true; readonly path: string; readonly url: string }
  | { readonly ok: false; readonly error: string };

export async function pickTeamPhoto(): Promise<PickTeamPhotoResult> {
  const result = await launchImageLibrary({
    mediaType: 'photo',
    selectionLimit: 1,
    includeBase64: true,
    maxWidth: 1600,
    maxHeight: 1600,
    quality: 0.8,
  });

  if (result.didCancel) return { ok: false, cancelled: true, error: null };
  if (result.errorCode) {
    return {
      ok: false,
      cancelled: false,
      error:
        result.errorCode === 'permission'
          ? 'Access to photos was not granted. Allow photo access in system settings and try again.'
          : `The photo picker could not open: ${result.errorMessage ?? result.errorCode}.`,
    };
  }

  const asset = result.assets?.[0];
  if (!asset) return { ok: false, cancelled: false, error: 'No photo was selected.' };

  const extension = extensionForMime(asset.type);
  if (extension === null) {
    return { ok: false, cancelled: false, error: 'Choose a JPEG, PNG or WebP image.' };
  }
  if (typeof asset.fileSize === 'number' && asset.fileSize > TEAM_PHOTO_MAX_BYTES) {
    return {
      ok: false,
      cancelled: false,
      error: `That image is ${(asset.fileSize / (1024 * 1024)).toFixed(1)} MB. Choose one under 5 MB.`,
    };
  }
  if (!asset.base64) {
    return { ok: false, cancelled: false, error: 'The image could not be read. Try a different one.' };
  }

  return {
    ok: true,
    photo: { base64: asset.base64, mimeType: asset.type!, extension },
  };
}

/** Uploads a portrait and returns the path to store in `photo_path`. */
export async function uploadTeamPhoto(photo: PickedTeamPhoto): Promise<UploadTeamPhotoResult> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, error: 'Cloud storage is not configured in this build.' };

  const path = `team-media/team-${Date.now()}.${photo.extension}`;

  try {
    const { error } = await client.storage.from('team-media').upload(path, base64ToBytes(photo.base64), {
      contentType: photo.mimeType,
      upsert: false,
      cacheControl: '3600',
    });
    if (error) return { ok: false, error: `The photo could not be uploaded: ${error.message}` };

    const { data } = client.storage.from('team-media').getPublicUrl(path);
    if (!data?.publicUrl) {
      return { ok: false, error: 'The photo was uploaded but its address could not be read.' };
    }
    return { ok: true, path, url: data.publicUrl };
  } catch (error) {
    return { ok: false, error: `The photo could not be uploaded: ${(error as Error).message}` };
  }
}

/** Removes a portrait the row no longer references. Best effort. */
export async function removeTeamPhoto(path: string | null | undefined): Promise<void> {
  if (!path) return;
  const client = getSupabaseClient();
  if (!client) return;
  try {
    await client.storage.from('team-media').remove([path]);
  } catch {
    // The server performs the same cleanup after a successful edit and records
    // a failure in the audit row. A second best-effort attempt here cannot make
    // the outcome worse.
  }
}
