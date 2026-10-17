/**
 * The account-deletion dialog, rendered.
 *
 * ## The properties under test are the ones a user could be hurt by
 *
 * That the code is requested before anything is deleted, that the confirm
 * button cannot be reached without reading and acknowledging the warning, that
 * an error from the server is shown rather than swallowed, and that
 * `onDeleted` fires only after the server says the account is gone. Those are
 * not visible in the API module's return values; they only exist in the tree.
 *
 * The network is mocked at the `account/deletion` boundary, so no test here
 * needs a backend, a session or an email.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import {
  isDisabled,
  pressByLabel,
  pressByTestId,
  renderedText,
  renderThemed,
  teardown,
} from './support';
import { DeleteAccountDialog } from '../src/components/DeleteAccountDialog';

jest.mock('../src/account/deletion', () => ({
  requestDeletionCode: jest.fn(),
  confirmDeletion: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const deletion = jest.requireMock('../src/account/deletion') as {
  requestDeletionCode: jest.Mock;
  confirmDeletion: jest.Mock;
};

const ACKNOWLEDGE = 'I understand this permanently deletes my account';

async function render(
  onDeleted: jest.Mock = jest.fn(),
  onCancel: jest.Mock = jest.fn(),
): Promise<ReactTestRenderer.ReactTestRenderer> {
  return renderThemed(
    <DeleteAccountDialog
      visible
      email="person@example.com"
      onDeleted={onDeleted}
      onCancel={onCancel}
    />,
  );
}

describe('deleting an account from the dialog', () => {
  beforeEach(() => {
    deletion.requestDeletionCode.mockReset();
    deletion.confirmDeletion.mockReset();
  });

  it('names what is deleted before offering to send anything', async () => {
    const renderer = await render();
    const text = renderedText(renderer);

    expect(text).toContain('profile, display name and photo');
    expect(text).toContain('recognition history');
    // The limit is stated, not implied: guest-only data is not part of this.
    expect(text).toContain('Data that exists only on this phone');
    await teardown(renderer);
  });

  it('keeps the send button disabled until the warning is acknowledged', async () => {
    const renderer = await render();

    expect(isDisabled(renderer, 'delete-send-code')).toBe(true);

    await pressByLabel(renderer, ACKNOWLEDGE);

    expect(isDisabled(renderer, 'delete-send-code')).toBe(false);
    await teardown(renderer);
  });

  it('requests a code and moves to code entry without deleting anything', async () => {
    deletion.requestDeletionCode.mockResolvedValue({
      ok: true,
      data: { expiresAt: '2026-10-17T12:10:00.000Z' },
    });
    const onDeleted = jest.fn();
    const renderer = await render(onDeleted);

    await pressByLabel(renderer, ACKNOWLEDGE);
    await pressByTestId(renderer, 'delete-send-code');

    expect(deletion.requestDeletionCode).toHaveBeenCalledTimes(1);
    expect(deletion.confirmDeletion).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(renderedText(renderer)).toContain('person@example.com');
    await teardown(renderer);
  });

  it('shows the server refusal and stays on the warning step', async () => {
    deletion.requestDeletionCode.mockResolvedValue({
      ok: false,
      error: 'This is the permanent owner account. It cannot be deleted.',
      status: 409,
    });
    const renderer = await render();

    await pressByLabel(renderer, ACKNOWLEDGE);
    await pressByTestId(renderer, 'delete-send-code');

    expect(renderedText(renderer)).toContain('permanent owner account');
    // Still the warning step: no code field exists yet.
    expect(renderer.root.findAllByProps({ testID: 'delete-code-input' })).toHaveLength(0);
    await teardown(renderer);
  });

  it('does not offer deletion for a code that is not six digits', async () => {
    deletion.requestDeletionCode.mockResolvedValue({
      ok: true,
      data: { expiresAt: '2026-10-17T12:10:00.000Z' },
    });
    const renderer = await render();

    await pressByLabel(renderer, ACKNOWLEDGE);
    await pressByTestId(renderer, 'delete-send-code');

    expect(isDisabled(renderer, 'delete-confirm')).toBe(true);
    await teardown(renderer);
  });

  it('calls onDeleted only after the server confirms deletion', async () => {
    deletion.requestDeletionCode.mockResolvedValue({
      ok: true,
      data: { expiresAt: '2026-10-17T12:10:00.000Z' },
    });
    deletion.confirmDeletion.mockResolvedValue({ ok: true, data: { status: 'deleted' } });
    const onDeleted = jest.fn();
    const renderer = await render(onDeleted);

    await pressByLabel(renderer, ACKNOWLEDGE);
    await pressByTestId(renderer, 'delete-send-code');

    const input = renderer.root.findAllByProps({ testID: 'delete-code-input' })[0]!;
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText('123456');
    });

    await pressByTestId(renderer, 'delete-confirm');

    expect(deletion.confirmDeletion).toHaveBeenCalledWith('123456');
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await teardown(renderer);
  });

  it('reports a rejected code and never calls onDeleted', async () => {
    deletion.requestDeletionCode.mockResolvedValue({
      ok: true,
      data: { expiresAt: '2026-10-17T12:10:00.000Z' },
    });
    deletion.confirmDeletion.mockResolvedValue({
      ok: false,
      error: 'That code has expired. Ask for a new one.',
      status: 400,
    });
    const onDeleted = jest.fn();
    const renderer = await render(onDeleted);

    await pressByLabel(renderer, ACKNOWLEDGE);
    await pressByTestId(renderer, 'delete-send-code');

    const input = renderer.root.findAllByProps({ testID: 'delete-code-input' })[0]!;
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText('123456');
    });
    await pressByTestId(renderer, 'delete-confirm');

    expect(onDeleted).not.toHaveBeenCalled();
    expect(renderedText(renderer)).toContain('That code has expired');
    await teardown(renderer);
  });
});
