/**
 * Published team content, read from the public backend.
 *
 * ## Why this is not the bundled `team.ts`
 *
 * `team.ts` holds five empty slots so the About screen has something honest to
 * show before any content exists. Once administrators publish real people, the
 * screen must show those people — including their portraits — and it must show
 * *only* published rows. The public endpoint applies that filter; this module
 * only asks for it.
 *
 * ## Offline behaviour is a state, not a failure
 *
 * The rest of this app works without a network. About is not exempt: when the
 * list cannot be read it says so and offers a retry, and it never substitutes
 * invented names. A cached copy is deliberately not shown, because a team
 * member removed for a good reason must disappear when the server says so.
 */
import { config } from '../config/env';

export interface PublishedTeamMember {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly bio: string;
  readonly photo_path: string | null;
}

export type TeamContentResult =
  | { readonly ok: true; readonly members: PublishedTeamMember[] }
  | { readonly ok: false; readonly error: string };

/** Turns a stored path into the public URL the About screen displays. */
export function teamPhotoUrl(photoPath: string | null | undefined): string | null {
  if (!photoPath || config.supabaseUrl === null) return null;
  return `${config.supabaseUrl}/storage/v1/object/public/team-media/${photoPath}`;
}

function memberOf(raw: unknown): PublishedTeamMember | null {
  if (raw === null || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.role !== 'string') {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    bio: typeof row.bio === 'string' ? row.bio : '',
    photo_path: typeof row.photo_path === 'string' ? row.photo_path : null,
  };
}

export async function fetchTeamContent(signal?: AbortSignal): Promise<TeamContentResult> {
  const base = config.apiBaseUrl;
  if (base === null) {
    return {
      ok: false,
      error: 'This build has no backend address, so the team list cannot be loaded.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(`${base}/team`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return {
        ok: false,
        error:
          response.status === 503
            ? 'The team list is not available from this server yet.'
            : `The team list could not be loaded (${response.status}).`,
      };
    }

    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { members?: unknown }).members)) {
      return { ok: false, error: 'The server returned an unreadable team list.' };
    }

    const members = (payload as { members: unknown[] }).members
      .map(memberOf)
      .filter((member): member is PublishedTeamMember => member !== null);

    return { ok: true, members };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // A caller-initiated abort is not a failure to display. The empty error
      // tells the caller to stop without drawing a retry card.
      return { ok: false, error: '' };
    }
    return {
      ok: false,
      error: 'The team list could not be reached. Check the connection and try again.',
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
