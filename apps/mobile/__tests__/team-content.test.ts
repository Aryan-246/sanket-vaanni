/**
 * Reading published team content.
 *
 * ## What these tests are protecting
 *
 * The About screen used to show five empty slots and nothing else. It now shows
 * whatever the backend says has been published — which means the failure modes
 * matter: a malformed row must not render as a half-person, a refused read must
 * not render as "nobody has been added", and a caller that leaves the screen must
 * not leave a retry card behind.
 *
 * The network is mocked at `global.fetch`, so no test needs a backend or a real
 * Supabase project.
 */
import {
  fetchTeamContent,
  teamPhotoUrl,
} from '../src/about/teamContent';

jest.mock('../src/config/env', () => ({
  config: {
    apiBaseUrl: 'https://backend.example.test',
    apiTimeoutMs: 8000,
    supabaseUrl: 'https://project.supabase.co',
  },
}));

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

function mockFetch(implementation: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = jest.fn(implementation);
  (globalThis as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('team photo addresses', () => {
  it('turns a stored path into the public bucket URL', () => {
    expect(teamPhotoUrl('team-media/team-1.jpg')).toBe(
      'https://project.supabase.co/storage/v1/object/public/team-media/team-media/team-1.jpg',
    );
  });

  it('returns null when there is no path', () => {
    expect(teamPhotoUrl(null)).toBeNull();
    expect(teamPhotoUrl(undefined)).toBeNull();
    expect(teamPhotoUrl('')).toBeNull();
  });
});

describe('reading the published list', () => {
  it('asks the public endpoint and keeps the rows in the order served', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse(200, {
        members: [
          { id: 'b', name: 'Meera', role: 'Engineer', bio: 'Builds things.', photo_path: null },
          { id: 'a', name: 'Asha', role: 'Advisor', bio: '', photo_path: 'team-media/asha.png' },
        ],
      }),
    );

    const result = await fetchTeamContent();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.example.test/team',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(result).toEqual({
      ok: true,
      members: [
        { id: 'b', name: 'Meera', role: 'Engineer', bio: 'Builds things.', photo_path: null },
        { id: 'a', name: 'Asha', role: 'Advisor', bio: '', photo_path: 'team-media/asha.png' },
      ],
    });
  });

  it('drops a row that could not be rendered instead of filling in a guess', async () => {
    mockFetch(async () =>
      jsonResponse(200, {
        members: [
          { id: 'good', name: 'Asha', role: 'Advisor', bio: '', photo_path: null },
          { id: 'no-name', role: 'Advisor' },
          { id: 'no-role', name: 'Meera' },
          null,
          'a person',
        ],
      }),
    );

    const result = await fetchTeamContent();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.members.map((member) => member.id)).toEqual(['good']);
  });

  it('reads an absent biography as empty rather than inventing one', async () => {
    mockFetch(async () =>
      jsonResponse(200, {
        members: [{ id: 'a', name: 'Asha', role: 'Advisor', photo_path: 7 }],
      }),
    );

    const result = await fetchTeamContent();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members[0]?.bio).toBe('');
      expect(result.members[0]?.photo_path).toBeNull();
    }
  });

  it('reports a refused read as a failure, never as an empty team', async () => {
    mockFetch(async () => jsonResponse(500, { error: 'boom' }));

    const result = await fetchTeamContent();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('could not be loaded (500)');
  });

  it('says plainly when the service has no team list configured', async () => {
    mockFetch(async () => jsonResponse(503, { error: 'not configured' }));

    const result = await fetchTeamContent();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not available from this server yet');
  });

  it('rejects a payload that is not a list', async () => {
    mockFetch(async () => jsonResponse(200, { members: 'everyone' }));

    const result = await fetchTeamContent();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unreadable team list');
  });

  it('reports an unreachable service in words a reader can act on', async () => {
    mockFetch(async () => {
      throw new Error('offline');
    });

    const result = await fetchTeamContent();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('could not be reached');
  });

  it('treats a caller abort as leaving rather than as a failure to show', async () => {
    const controller = new AbortController();
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        }),
    );

    const pending = fetchTeamContent(controller.signal);
    controller.abort();
    const result = await pending;

    expect(result).toEqual({ ok: false, error: '' });
  });
});
