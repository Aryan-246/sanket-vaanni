/**
 * Avatar validation and storage helpers.
 *
 * The rules tested here run before any network call, which is the point: a
 * 12 MB file, an animated GIF or a path outside the account's folder should be
 * refused with a sentence the user can act on, not by a Storage error.
 *
 * `react-native-image-picker` is mocked at the module boundary; nothing here
 * opens a system picker.
 */
jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

import {
  AVATAR_MAX_BYTES,
  avatarPathFor,
  pathFromAvatarUrl,
  removeAvatarByUrl,
  uploadAvatar,
  validateAvatarAsset,
} from '../src/account/avatar';
import {
  resetSupabaseClient,
  setCustomSupabaseClient,
} from '../src/supabase/client';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('validateAvatarAsset', () => {
  it('accepts the three formats the bucket allows', () => {
    for (const [type, extension] of [
      ['image/jpeg', 'jpg'],
      ['image/png', 'png'],
      ['image/webp', 'webp'],
    ] as const) {
      const result = validateAvatarAsset({ type, fileSize: 1024, base64: 'aGk=' });
      expect(result).toEqual({ ok: true, mimeType: type, extension });
    }
  });

  it('refuses a format the bucket would reject', () => {
    const result = validateAvatarAsset({ type: 'image/gif', fileSize: 1024, base64: 'aGk=' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/JPEG, PNG or WebP/);
  });

  it('refuses a file over the bucket limit and says how large it is', () => {
    const result = validateAvatarAsset({
      type: 'image/jpeg',
      fileSize: AVATAR_MAX_BYTES + 1,
      base64: 'aGk=',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/under 2 MB/);
  });

  it('refuses an image whose bytes could not be read', () => {
    const result = validateAvatarAsset({ type: 'image/jpeg', fileSize: 1024 });
    expect(result.ok).toBe(false);
  });
});

describe('avatarPathFor', () => {
  it('puts the object in the account’s own folder', () => {
    expect(avatarPathFor(USER_ID, 'jpg', 123)).toBe(`${USER_ID}/avatar-123.jpg`);
  });
});

describe('pathFromAvatarUrl', () => {
  it('recovers the object path from a public URL', () => {
    expect(
      pathFromAvatarUrl(
        `https://example.supabase.co/storage/v1/object/public/avatars/${USER_ID}/avatar-1.jpg`,
      ),
    ).toBe(`${USER_ID}/avatar-1.jpg`);
  });

  it('returns null for a URL that is not in the avatars bucket', () => {
    expect(pathFromAvatarUrl('https://evil.example/photo.jpg')).toBeNull();
    expect(pathFromAvatarUrl(null)).toBeNull();
  });
});

describe('upload and removal', () => {
  let mockUpload: jest.Mock;
  let mockRemove: jest.Mock;
  let mockPublicUrl: jest.Mock;

  beforeEach(() => {
    mockUpload = jest.fn().mockResolvedValue({ error: null });
    mockRemove = jest.fn().mockResolvedValue({ error: null });
    mockPublicUrl = jest.fn().mockImplementation((path: string) => ({
      data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/avatars/${path}` },
    }));

    setCustomSupabaseClient({
      storage: {
        from: () => ({
          upload: mockUpload,
          remove: mockRemove,
          getPublicUrl: mockPublicUrl,
        }),
      },
    } as never);
  });

  afterEach(() => {
    resetSupabaseClient();
    jest.clearAllMocks();
  });

  it('uploads the decoded bytes under a unique path', async () => {
    const result = await uploadAvatar(USER_ID, {
      base64: 'aGk=',
      mimeType: 'image/jpeg',
      extension: 'jpg',
    });

    expect(result.ok).toBe(true);
    expect(mockUpload).toHaveBeenCalledTimes(1);

    const [path, bytes, options] = mockUpload.mock.calls[0]!;
    expect(path).toMatch(new RegExp(`^${USER_ID}/avatar-\\d+\\.jpg$`));
    expect(Array.from(bytes as Uint8Array)).toEqual([104, 105]);
    expect(options).toMatchObject({ contentType: 'image/jpeg', upsert: false });
  });

  it('reports a storage refusal without inventing a URL', async () => {
    mockUpload.mockResolvedValue({ error: { message: 'exceeded the maximum allowed size' } });

    const result = await uploadAvatar(USER_ID, {
      base64: 'aGk=',
      mimeType: 'image/png',
      extension: 'png',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('exceeded the maximum allowed size');
  });

  it('removes exactly the referenced object', async () => {
    await removeAvatarByUrl(
      `https://example.supabase.co/storage/v1/object/public/avatars/${USER_ID}/avatar-1.jpg`,
    );
    expect(mockRemove).toHaveBeenCalledWith([`${USER_ID}/avatar-1.jpg`]);
  });

  it('does not remove an object for a URL it does not own', async () => {
    const result = await removeAvatarByUrl('https://evil.example/photo.jpg');
    expect(result.ok).toBe(true);
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
