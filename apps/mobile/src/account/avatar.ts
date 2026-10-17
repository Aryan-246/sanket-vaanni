/**
 * Choosing and uploading a profile photo.
 *
 * ## The bucket and the path
 *
 * Photos live in the public `avatars` bucket under a folder named after the
 * account id. The storage policy allows an authenticated user to write only
 * inside `avatars/<their own id>/`, so the path built here is not trust — it is
 * a shape the server independently enforces.
 *
 * ## Why `base64` rather than a file URI
 *
 * React Native's `fetch` cannot be assumed to read a `file://` URI on every
 * platform, and a photo that fails to upload on one Android version is a
 * support problem with no useful error. `react-native-image-picker` can return
 * the bytes inline; decoding them here keeps the upload path identical
 * everywhere.
 *
 * ## What is refused before the network
 *
 * Type and size are checked against the bucket's own limits first. Sending a
 * 12 MB photo to be rejected by Storage wastes the user's data and produces a
 * less useful message than saying so immediately.
 */
import { launchImageLibrary, type Asset } from 'react-native-image-picker';

import { getSupabaseClient } from '../supabase/client';

/** Mirrors the `avatars` bucket's `file_size_limit`. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * The extension for a MIME type this project accepts, or null.
 *
 * Exported because the team-photo uploader has the same format rules and a
 * different size limit. Two copies of this table would eventually disagree
 * about `image/jpg`, which the picker does emit on some devices.
 */
export function extensionForMime(type: string | null | undefined): string | null {
  return MIME_EXTENSIONS[(type ?? '').toLowerCase()] ?? null;
}

export interface PickedAvatar {
  readonly base64: string;
  readonly mimeType: string;
  readonly extension: string;
}

export type PickAvatarResult =
  | { readonly ok: true; readonly avatar: PickedAvatar }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string | null };

export type UploadAvatarResult =
  | { readonly ok: true; readonly url: string; readonly path: string }
  | { readonly ok: false; readonly error: string };

/**
 * Decides whether an asset may be uploaded.
 *
 * Pure and exported so the rules can be tested without a picker, a network or
 * a Supabase client.
 */
export function validateAvatarAsset(asset: Pick<Asset, 'type' | 'fileSize' | 'base64'>):
  | { ok: true; mimeType: string; extension: string }
  | { ok: false; message: string } {
  const mimeType = (asset.type ?? '').toLowerCase();
  const extension = extensionForMime(mimeType);
  if (!extension) {
    return { ok: false, message: 'Choose a JPEG, PNG or WebP image.' };
  }
  if (typeof asset.fileSize === 'number' && asset.fileSize > AVATAR_MAX_BYTES) {
    return {
      ok: false,
      message: `That image is ${formatSize(asset.fileSize)}. Choose one under 2 MB.`,
    };
  }
  if (!asset.base64) {
    return { ok: false, message: 'The image could not be read. Try a different one.' };
  }
  return { ok: true, mimeType, extension };
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The storage path for one upload. Never contains anything but the account id. */
export function avatarPathFor(userId: string, extension: string, stamp: number): string {
  return `${userId}/avatar-${stamp}.${extension}`;
}

/** Opens the system photo picker. */
export async function pickAvatar(): Promise<PickAvatarResult> {
  const result = await launchImageLibrary({
    mediaType: 'photo',
    selectionLimit: 1,
    includeBase64: true,
    maxWidth: 1024,
    maxHeight: 1024,
    quality: 0.8,
  });

  if (result.didCancel) {
    return { ok: false, cancelled: true, error: null };
  }
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
  if (!asset) {
    return { ok: false, cancelled: false, error: 'No photo was selected.' };
  }

  const checked = validateAvatarAsset(asset);
  if (!checked.ok) {
    return { ok: false, cancelled: false, error: checked.message };
  }

  return {
    ok: true,
    avatar: {
      base64: asset.base64!,
      mimeType: checked.mimeType,
      extension: checked.extension,
    },
  };
}

/** Decodes picker base64 output into the bytes Storage expects. */
export function base64ToBytes(value: string): Uint8Array {
  /*
   * Hermes exposes `atob` globally (React Native 0.74+), but it is not in the
   * TypeScript DOM library this project compiles against. Reading it off
   * `globalThis` with a runtime check keeps the type honest and produces a
   * clear failure rather than a `ReferenceError` if a future runtime drops it.
   */
  const decode = (globalThis as { atob?: (input: string) => string }).atob;
  if (typeof decode !== 'function') {
    throw new Error('This runtime cannot decode the selected image.');
  }

  const binary = decode(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Uploads a picked photo and returns its public URL. */
export async function uploadAvatar(
  userId: string,
  avatar: PickedAvatar,
): Promise<UploadAvatarResult> {
  const client = getSupabaseClient();
  if (!client) {
    return { ok: false, error: 'Cloud storage is not configured in this build.' };
  }

  const path = avatarPathFor(userId, avatar.extension, Date.now());

  try {
    const { error } = await client.storage.from('avatars').upload(path, base64ToBytes(avatar.base64), {
      contentType: avatar.mimeType,
      // A unique name is used for every upload, so an existing object must never
      // be silently replaced — that would overwrite a *different* photo if the
      // timestamp ever repeated.
      upsert: false,
      cacheControl: '3600',
    });

    if (error) {
      return { ok: false, error: `The photo could not be uploaded: ${error.message}` };
    }

    const { data } = client.storage.from('avatars').getPublicUrl(path);
    if (!data?.publicUrl) {
      return { ok: false, error: 'The photo was uploaded but its address could not be read.' };
    }

    return { ok: true, url: data.publicUrl, path };
  } catch (error) {
    return {
      ok: false,
      error: `The photo could not be uploaded: ${(error as Error).message}`,
    };
  }
}

/**
 * Recovers the object path from a public URL previously stored in
 * `profiles.avatar_url`.
 *
 * Returns null for anything that is not an avatar URL, so a hand-edited row
 * that points elsewhere cannot cause this code to delete an unrelated object.
 */
export function pathFromAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = '/storage/v1/object/public/avatars/';
  const index = url.indexOf(marker);
  if (index < 0) return null;
  const path = decodeURIComponent(url.slice(index + marker.length).split('?')[0] ?? '');
  return path.length > 0 ? path : null;
}

/** Removes a photo that is no longer referenced. Failures are reported, not thrown. */
export async function removeAvatarByUrl(
  url: string | null | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const path = pathFromAvatarUrl(url);
  if (path === null) return { ok: true };

  const client = getSupabaseClient();
  if (!client) return { ok: false, error: 'Cloud storage is not configured in this build.' };

  const { error } = await client.storage.from('avatars').remove([path]);
  return error ? { ok: false, error: error.message } : { ok: true };
}
