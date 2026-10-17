/**
 * The Admin team editor, rendered.
 *
 * ## What is asserted, and why it is in the tree rather than the client
 *
 * The client functions already take a required `reason` at the type level. What
 * the compiler cannot say is whether the screen asks for one *before* it writes,
 * whether a failed write leaves the form open with the server's sentence, and
 * whether a reorder that half-applies is reported as half-applied rather than
 * saved. Those live in the interaction, so they are asserted here.
 *
 * The admin client and the photo picker are mocked at their module boundaries, so
 * no test needs a token, a backend or a photo library.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import {
  flush,
  pressByLabel,
  pressByTestId,
  renderedText,
  renderThemed,
  teardown,
} from './support';
import { TeamEditor } from '../src/components/TeamEditor';

jest.mock('../src/admin/client', () => ({
  listTeam: jest.fn(),
  createTeamMember: jest.fn(),
  updateTeamMember: jest.fn(),
  deleteTeamMember: jest.fn(),
}));

jest.mock('../src/admin/teamMedia', () => ({
  pickTeamPhoto: jest.fn(),
  uploadTeamPhoto: jest.fn(),
  removeTeamPhoto: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = jest.requireMock('../src/admin/client') as {
  listTeam: jest.Mock;
  createTeamMember: jest.Mock;
  updateTeamMember: jest.Mock;
  deleteTeamMember: jest.Mock;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const media = jest.requireMock('../src/admin/teamMedia') as {
  pickTeamPhoto: jest.Mock;
  uploadTeamPhoto: jest.Mock;
  removeTeamPhoto: jest.Mock;
};

interface MemberOverrides {
  id?: string;
  name?: string;
  role?: string;
  bio?: string;
  photo_path?: string | null;
  sort_order?: number;
  published?: boolean;
}

function member(over: MemberOverrides = {}) {
  const id = over.id ?? 'a';
  return {
    id,
    name: over.name ?? 'Asha',
    role: over.role ?? 'Advisor',
    bio: over.bio ?? '',
    photo_path: over.photo_path ?? null,
    sort_order: over.sort_order ?? 0,
    published: over.published ?? true,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

const ASHA = member({ id: 'a', name: 'Asha', role: 'Advisor', sort_order: 0, published: true });
const MEERA = member({
  id: 'b',
  name: 'Meera',
  role: 'Engineer',
  sort_order: 1,
  published: false,
  bio: 'Builds the glove firmware.',
});

async function type(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
  value: string,
): Promise<void> {
  const node = renderer.root
    .findAllByProps({ testID })
    .find((candidate) => typeof candidate.props.onChangeText === 'function');
  if (node === undefined) throw new Error(`No text field found for ${testID}.`);
  await ReactTestRenderer.act(async () => {
    node.props.onChangeText(value);
  });
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  return renderThemed(<TeamEditor />);
}

describe('the team list', () => {
  beforeEach(() => {
    client.listTeam.mockReset();
    client.createTeamMember.mockReset();
    client.updateTeamMember.mockReset();
    client.deleteTeamMember.mockReset();
    media.pickTeamPhoto.mockReset();
    media.uploadTeamPhoto.mockReset();
    media.removeTeamPhoto.mockReset();
    media.removeTeamPhoto.mockResolvedValue(undefined);
  });

  it('shows published and draft people, named', async () => {
    client.listTeam.mockResolvedValue({ ok: true, data: { members: [ASHA, MEERA] } });

    const renderer = await render();
    const text = renderedText(renderer);

    expect(text).toContain('Asha');
    expect(text).toContain('Advisor');
    expect(text).toContain('Meera');
    expect(text).toContain('Published');
    expect(text).toContain('Draft');
    await teardown(renderer);
  });

  it('says nobody has been added rather than drawing an empty page', async () => {
    client.listTeam.mockResolvedValue({ ok: true, data: { members: [] } });

    const renderer = await render();

    expect(renderedText(renderer)).toContain('Nobody has been added yet');
    await teardown(renderer);
  });

  it('reports a failed read with a retry that reads again', async () => {
    client.listTeam
      .mockResolvedValueOnce({ ok: false, error: 'The backend could not be reached.' })
      .mockResolvedValueOnce({ ok: true, data: { members: [ASHA] } });

    const renderer = await render();
    expect(renderedText(renderer)).toContain('The backend could not be reached.');

    await pressByTestId(renderer, 'team-retry');
    await flush();

    expect(client.listTeam).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Asha');
    await teardown(renderer);
  });
});

describe('adding a person', () => {
  beforeEach(() => {
    client.listTeam.mockReset();
    client.listTeam.mockResolvedValue({ ok: true, data: { members: [] } });
    client.createTeamMember.mockReset();
    media.pickTeamPhoto.mockReset();
    media.uploadTeamPhoto.mockReset();
    media.removeTeamPhoto.mockReset();
    media.removeTeamPhoto.mockResolvedValue(undefined);
  });

  it('does not write without a reason, a name and a role', async () => {
    const renderer = await render();

    await pressByTestId(renderer, 'team-add');
    await pressByTestId(renderer, 'team-save');
    await flush();

    expect(client.createTeamMember).not.toHaveBeenCalled();
    expect(renderedText(renderer)).toContain('Write at least a few words');
    await teardown(renderer);
  });

  it('creates a draft with the values that were typed', async () => {
    client.createTeamMember.mockResolvedValue({ ok: true, data: { member: ASHA } });
    const renderer = await render();

    await pressByTestId(renderer, 'team-add');
    await type(renderer, 'team-name', 'Asha');
    await type(renderer, 'team-role', 'Advisor');
    await type(renderer, 'team-bio', 'Answers questions.');
    await type(renderer, 'team-reason', 'Added by the project owner.');
    await pressByTestId(renderer, 'team-save');
    await flush();

    expect(client.createTeamMember).toHaveBeenCalledWith({
      reason: 'Added by the project owner.',
      name: 'Asha',
      role: 'Advisor',
      bio: 'Answers questions.',
      photoPath: null,
      sortOrder: 0,
      published: false,
    });
    expect(renderedText(renderer)).toContain('saved as a draft');
    await teardown(renderer);
  });

  it('publishes only when the publish switch is on, and says so', async () => {
    client.createTeamMember.mockResolvedValue({ ok: true, data: { member: ASHA } });
    const renderer = await render();

    await pressByTestId(renderer, 'team-add');
    await type(renderer, 'team-name', 'Asha');
    await type(renderer, 'team-role', 'Advisor');
    await type(renderer, 'team-reason', 'Ready to publish.');
    await pressByLabel(renderer, 'Publish this person on the About screen');
    await pressByTestId(renderer, 'team-save');
    await flush();

    expect(client.createTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({ published: true }),
    );
    expect(renderedText(renderer)).toContain('added and published');
    await teardown(renderer);
  });

  it('keeps the form open with the server refusal when the write fails', async () => {
    client.createTeamMember.mockResolvedValue({
      ok: false,
      error: 'A reason of at least three characters is required.',
    });
    const renderer = await render();

    await pressByTestId(renderer, 'team-add');
    await type(renderer, 'team-name', 'Asha');
    await type(renderer, 'team-role', 'Advisor');
    await type(renderer, 'team-reason', 'Added.');
    await pressByTestId(renderer, 'team-save');
    await flush();

    expect(renderedText(renderer)).toContain('A reason of at least three characters is required.');
    // The sheet did not close, so the entered values are still there.
    expect(renderer.root.findAllByProps({ testID: 'team-name' }).length).toBeGreaterThan(0);
    await teardown(renderer);
  });

  it('removes a photo uploaded during a form that was then cancelled', async () => {
    media.pickTeamPhoto.mockResolvedValue({
      ok: true,
      photo: { base64: 'AAAA', mimeType: 'image/jpeg', extension: 'jpg' },
    });
    media.uploadTeamPhoto.mockResolvedValue({
      ok: true,
      path: 'team-media/team-1.jpg',
      url: 'https://project.supabase.co/storage/v1/object/public/team-media/team-media/team-1.jpg',
    });
    const renderer = await render();

    await pressByTestId(renderer, 'team-add');
    await pressByTestId(renderer, 'team-photo');
    await flush();

    await pressByLabel(renderer, 'Cancel');
    await flush();

    expect(media.removeTeamPhoto).toHaveBeenCalledWith('team-media/team-1.jpg');
    expect(client.createTeamMember).not.toHaveBeenCalled();
    await teardown(renderer);
  });
});

describe('editing a person', () => {
  beforeEach(() => {
    client.listTeam.mockReset();
    client.listTeam.mockResolvedValue({ ok: true, data: { members: [ASHA] } });
    client.updateTeamMember.mockReset();
    media.pickTeamPhoto.mockReset();
    media.uploadTeamPhoto.mockReset();
    media.removeTeamPhoto.mockReset();
    media.removeTeamPhoto.mockResolvedValue(undefined);
  });

  it('sends the edited fields to the row that was opened', async () => {
    client.updateTeamMember.mockResolvedValue({ ok: true, data: { member: ASHA, cleanup: null } });
    const renderer = await render();

    await pressByLabel(renderer, 'Edit Asha');
    await type(renderer, 'team-role', 'Senior Advisor');
    await type(renderer, 'team-reason', 'Role changed this week.');
    await pressByTestId(renderer, 'team-save');
    await flush();

    expect(client.updateTeamMember).toHaveBeenCalledWith({
      id: 'a',
      reason: 'Role changed this week.',
      patch: {
        name: 'Asha',
        role: 'Senior Advisor',
        bio: '',
        photoPath: null,
        sortOrder: 0,
        published: true,
      },
    });
    await teardown(renderer);
  });

  it('refuses to remove someone without a reason', async () => {
    const renderer = await render();

    await pressByLabel(renderer, 'Remove Asha');
    await pressByTestId(renderer, 'team-delete-confirm');
    await flush();

    expect(client.deleteTeamMember).not.toHaveBeenCalled();
    expect(renderedText(renderer)).toContain('explaining why this person is being removed');
    await teardown(renderer);
  });

  it('removes a person and closes the confirmation only after the server agrees', async () => {
    client.deleteTeamMember.mockResolvedValue({
      ok: true,
      data: { deleted: true, cleanup: null },
    });
    const renderer = await render();

    await pressByLabel(renderer, 'Remove Asha');
    await type(renderer, 'team-delete-reason', 'Left the project.');
    await pressByTestId(renderer, 'team-delete-confirm');
    await flush();

    expect(client.deleteTeamMember).toHaveBeenCalledWith({
      id: 'a',
      reason: 'Left the project.',
    });
    expect(renderedText(renderer)).toContain('Team member removed.');
    await teardown(renderer);
  });
});

describe('ordering', () => {
  beforeEach(() => {
    client.listTeam.mockReset();
    client.listTeam.mockResolvedValue({ ok: true, data: { members: [ASHA, MEERA] } });
    client.updateTeamMember.mockReset();
    media.removeTeamPhoto.mockReset();
    media.removeTeamPhoto.mockResolvedValue(undefined);
  });

  it('swaps two positions with two writes', async () => {
    client.updateTeamMember.mockResolvedValue({ ok: true, data: { member: ASHA, cleanup: null } });
    const renderer = await render();

    await pressByLabel(renderer, 'Move Meera up');
    await flush();

    expect(client.updateTeamMember).toHaveBeenNthCalledWith(1, {
      id: 'b',
      reason: 'Reorder team members on the About screen',
      patch: { sortOrder: 0 },
    });
    expect(client.updateTeamMember).toHaveBeenNthCalledWith(2, {
      id: 'a',
      reason: 'Reorder team members on the About screen',
      patch: { sortOrder: 1 },
    });
    expect(renderedText(renderer)).toContain('Order saved.');
    await teardown(renderer);
  });

  it('reports a half-applied swap instead of claiming it saved', async () => {
    client.updateTeamMember
      .mockResolvedValueOnce({ ok: true, data: { member: ASHA, cleanup: null } })
      .mockResolvedValueOnce({ ok: false, error: 'The second write was refused.' });
    const renderer = await render();

    await pressByLabel(renderer, 'Move Meera up');
    await flush();

    const text = renderedText(renderer);
    expect(text).toContain('The first position was changed but the second was not');
    expect(text).not.toContain('Order saved.');
    // The list is re-read, so the screen describes the server's actual state.
    expect(client.listTeam).toHaveBeenCalledTimes(2);
    await teardown(renderer);
  });

  it('offers no upward move for the first row and no downward move for the last', async () => {
    const renderer = await render();

    expect(isDisabledFor(renderer, 'Move Asha up')).toBe(true);
    expect(isDisabledFor(renderer, 'Move Asha down')).toBe(false);
    expect(isDisabledFor(renderer, 'Move Meera down')).toBe(true);
    await teardown(renderer);
  });
});

/** Whether the control announced by this label reports itself disabled. */
function isDisabledFor(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
): boolean {
  const nodes = renderer.root.findAllByProps({ accessibilityLabel: label });
  return nodes.some((node) => node.props.accessibilityState?.disabled === true);
}
