/**
 * Registration, confirmation and Google sign-in, driven through the real sheet.
 *
 * ## What is asserted here rather than in `supabase-auth.test.ts`
 *
 * The module tests prove each call is shaped correctly. What they cannot show is
 * whether the screen tells the truth around it: that a pending account is not
 * treated as signed in, that the resend control is visibly rate-limited, that a
 * code confirms the *same* address, and that the old claim "Google Sign-In is not
 * enabled" is gone. Those are properties of the rendered sheet, so they are
 * asserted in the rendered sheet.
 *
 * The account provider and the storage plumbing are replaced at their
 * boundaries; the auth calls are mocked at the module the sheet imports. The
 * sheet's own state machine is real.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { AccountSheet } from '../src/components/AccountSheet';
import { createInMemoryStorage, type Storage } from '../src/storage';
import { ThemeProvider } from '../src/theme/ThemeProvider';

jest.mock('../src/app/AppState', () => {
  const holder: { storage: unknown } = { storage: null };
  return { useAppState: () => ({ storage: holder.storage }), __stateHolder: holder };
});

jest.mock('../src/account/AccountProvider', () => {
  const holder: { value: unknown } = { value: {} };
  return { useAccount: () => holder.value, __accountHolder: holder };
});

jest.mock('../src/supabase/auth', () => ({
  resendConfirmationEmail: jest.fn(),
  signInWithGoogle: jest.fn(),
  verifyEmailCode: jest.fn(),
}));

const { __stateHolder } = jest.requireMock('../src/app/AppState') as {
  __stateHolder: { storage: Storage };
};
const { __accountHolder } = jest.requireMock('../src/account/AccountProvider') as {
  __accountHolder: { value: Record<string, unknown> };
};
const auth = jest.requireMock('../src/supabase/auth') as {
  resendConfirmationEmail: jest.Mock;
  signInWithGoogle: jest.Mock;
  verifyEmailCode: jest.Mock;
};

/** Every text node in the tree, joined, so a split sentence can be found. */
function visibleText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') walk((node as { children?: unknown }).children);
  };
  walk(renderer.toJSON());
  return parts.join('');
}

async function flush(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
    });
  }
}

async function typeInto(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
  value: string,
): Promise<void> {
  const target = renderer.root
    .findAllByProps({ accessibilityLabel: label })
    .find((node) => typeof node.props.onChangeText === 'function');
  if (target === undefined) throw new Error(`No text field labelled "${label}".`);
  await ReactTestRenderer.act(async () => {
    target.props.onChangeText(value);
  });
  await flush(1);
}

async function pressByLabel(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
): Promise<void> {
  const target = renderer.root
    .findAllByProps({ accessibilityLabel: label })
    .find((node) => typeof node.props.onPress === 'function');
  if (target === undefined) throw new Error(`No pressable node labelled "${label}".`);
  await ReactTestRenderer.act(async () => {
    await target.props.onPress();
  });
  await flush();
}

async function pressByTestId(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  const target = renderer.root
    .findAllByProps({ testID })
    .find((node) => typeof node.props.onPress === 'function');
  if (target === undefined) throw new Error(`No pressable node with testID ${testID}.`);
  await ReactTestRenderer.act(async () => {
    await target.props.onPress();
  });
  await flush();
}

function isDisabled(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  return renderer.root
    .findAllByProps({ testID })
    .some((node) => node.props.accessibilityState?.disabled === true);
}

describe('AccountSheet registration and provider sign-in', () => {
  jest.setTimeout(30_000);

  let storage: Storage;
  let onClose: jest.Mock;
  let baseAccount: Record<string, unknown>;

  beforeEach(() => {
    storage = createInMemoryStorage();
    onClose = jest.fn();
    auth.resendConfirmationEmail.mockReset();
    auth.signInWithGoogle.mockReset();
    auth.verifyEmailCode.mockReset();

    baseAccount = {
      user: null,
      displayName: null,
      isGuest: true,
      isReady: true,
      isAdmin: false,
      cloudAvailable: true,
      signIn: async () => ({
        success: false,
        error: 'Please confirm your email address before signing in.',
      }),
      signUp: async () => ({
        success: true,
        needsEmailConfirmation: true,
        data: { user: { id: 'u-1', email: 'new@example.com' }, session: null },
      }),
      signOut: async () => undefined,
      completeAccountDeletion: () => undefined,
      requestPasswordReset: async () => ({ success: true }),
      updatePassword: async () => ({ success: true }),
      updateProfile: async () => ({ success: true }),
    };

    __stateHolder.storage = storage;
    __accountHolder.value = baseAccount;
  });

  async function render(
    props: Partial<React.ComponentProps<typeof AccountSheet>> = {},
  ): Promise<ReactTestRenderer.ReactTestRenderer> {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <ThemeProvider storage={storage} initialMode="dark">
          <AccountSheet visible onClose={onClose} {...props} />
        </ThemeProvider>,
      );
    });
    return renderer;
  }

  async function signUp(renderer: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    await pressByLabel(renderer, 'Create Account');
    await typeInto(renderer, 'Email address', 'new@example.com');
    await typeInto(renderer, 'Password', 'secret123');
    await typeInto(renderer, 'Confirm password', 'secret123');
    await pressByLabel(renderer, 'Create Account');
  }

  it('treats a pending account as pending, keeps the sheet open, and paces resend', async () => {
    const renderer = await render();
    await signUp(renderer);

    const text = visibleText(renderer);
    expect(text).toContain('Confirm Your Email');
    expect(text).toContain('new@example.com');
    expect(text).toContain('not active yet');
    expect(text).toContain('Nothing on this phone has been uploaded.');
    // Not a successful sign-in: the sheet is still asking for confirmation.
    expect(onClose).not.toHaveBeenCalled();
    expect(isDisabled(renderer, 'auth-resend')).toBe(true);
    expect(text).toContain('Send a new link in');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('moves an unconfirmed sign-in to the step that can finish it', async () => {
    const renderer = await render();
    await typeInto(renderer, 'Email address', 'waiting@example.com');
    await typeInto(renderer, 'Password', 'secret123');
    await pressByLabel(renderer, 'Sign In');

    expect(visibleText(renderer)).toContain('Confirm Your Email');
    expect(visibleText(renderer)).toContain('waiting@example.com');
    // No email was sent by this attempt, so resending is immediately available.
    expect(isDisabled(renderer, 'auth-resend')).toBe(false);

    auth.resendConfirmationEmail.mockResolvedValue({ success: true });
    await pressByTestId(renderer, 'auth-resend');

    expect(auth.resendConfirmationEmail).toHaveBeenCalledWith('waiting@example.com');
    expect(visibleText(renderer)).toContain('Only the newest message will work.');
    expect(isDisabled(renderer, 'auth-resend')).toBe(true);

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('confirms the same address with a six-digit code and closes only then', async () => {
    auth.verifyEmailCode.mockResolvedValue({
      success: true,
      data: { session: { access_token: 'tok' } },
    });
    const renderer = await render();
    await signUp(renderer);

    const field = renderer.root
      .findAllByProps({ testID: 'auth-verify-code' })
      .find((node) => typeof node.props.onChangeText === 'function');
    if (field === undefined) throw new Error('No code field.');
    await ReactTestRenderer.act(async () => {
      field.props.onChangeText('654321');
    });
    await flush(1);

    await pressByTestId(renderer, 'auth-verify-submit');

    expect(auth.verifyEmailCode).toHaveBeenCalledWith('new@example.com', '654321');
    expect(onClose).toHaveBeenCalled();

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('says what the browser hand-off can and cannot promise', async () => {
    auth.signInWithGoogle.mockResolvedValue({ success: true });
    const renderer = await render();

    await pressByTestId(renderer, 'auth-google');

    expect(auth.signInWithGoogle).toHaveBeenCalledTimes(1);
    const text = visibleText(renderer);
    expect(text).toContain('Continue in the browser window');
    expect(text).toContain('If you close the browser without finishing, nothing on this phone changes.');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('no longer claims Google sign-in is unavailable', async () => {
    const renderer = await render();

    expect(visibleText(renderer)).not.toContain('Google Sign-In is not enabled');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('offers local records to a session that arrived without the email form', async () => {
    /*
     * Google sign-in and a confirmation link establish the session through the
     * provider. If consent only existed on the email sign-in path, those users
     * could pull data down but would never be offered the move up.
     */
    await storage.setPreferences({
      signProfileId: 'isl',
      targetLanguageCode: 'en',
      voiceEnabled: true,
    });
    __accountHolder.value = {
      ...baseAccount,
      user: { id: 'u-9', email: 'google@example.com' },
      isGuest: false,
    };

    const renderer = await render();
    await flush(8);

    expect(
      renderer.root.findAllByProps({ testID: 'guest-migration-step' }).length,
    ).toBeGreaterThan(0);
    expect(visibleText(renderer)).toContain('Move this phone’s data?');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('shows a refused or expired link as an error the person can act on', async () => {
    const renderer = await render({
      authLinkNotice: {
        id: 1,
        tone: 'error',
        message: 'That link has expired or was already used. Request a new one and open the newest email.',
      },
    });

    expect(visibleText(renderer)).toContain('That link has expired or was already used.');

    await ReactTestRenderer.act(async () => renderer.unmount());
  });
});
