/**
 * The "expected to end" note that travels with maintenance mode.
 *
 * ## What this field is, and what it is not
 *
 * `expectedEndAt` is stored by `POST /admin/maintenance`
 * (`apps/backend/src/routes/admin.ts`) and shown to a locked-out user by
 * `MaintenanceScreen`, as "Expected to end around …". It is a **note to the
 * user**, and it is nothing more than that.
 *
 * Nothing enforces it. `apps/backend/src/maintenance/gate.ts` reads only
 * `enabled` and `message` from the row, and there is no scheduler anywhere in
 * the backend that turns maintenance off at a stored time. So an app left in
 * maintenance does not reopen when the note says it will: an administrator has
 * to come back and reopen it by hand.
 *
 * That is why every label below says "expected" and why the screen repeats it.
 * A console that let an administrator write "back at 09:00" and believe the
 * service would reopen itself would produce exactly the outage it was trying to
 * announce — with nobody watching for it. Whether the gate *should* honour this
 * field is a change to how the service behaves under failure, so it is a
 * decision for the owner rather than one this module makes.
 *
 * ## Why presets rather than a date field
 *
 * There is no date picker in this app, and a free-text date would be parsed on
 * one device and read on another. A short list of fixed spans is what an
 * administrator actually knows at the moment they close the app — "about an
 * hour" — and it cannot be mistyped. The spans are fixed rather than calendar
 * units, so "4 hours" is always four hours.
 */

/** How long the note says the closure is expected to last. */
export type WindowPreset = '' | 'hour' | 'fourHours' | 'day';

/** In shown order, shortest first. `''` clears the note. */
export const WINDOW_OPTIONS: readonly { value: WindowPreset; label: string }[] = [
  { value: '', label: 'Not saying' },
  { value: 'hour', label: '1 hour' },
  { value: 'fourHours', label: '4 hours' },
  { value: 'day', label: '24 hours' },
];

const PRESET_MS: Record<Exclude<WindowPreset, ''>, number> = {
  hour: 60 * 60 * 1000,
  fourHours: 4 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

/**
 * The instant a preset names, or null for "not saying".
 *
 * `nowMs` is a parameter rather than a call to `Date.now()` so a test can pin
 * the answer. Null is the same value the server stores for an absent note, so
 * choosing "Not saying" clears a note that was set before rather than leaving
 * the old one in place — which is the only reading of "not saying" that does
 * what it appears to.
 */
export function expectedEndAt(preset: WindowPreset, nowMs: number): string | null {
  if (preset === '') return null;
  return new Date(nowMs + PRESET_MS[preset]).toISOString();
}

/**
 * What the note means for the person reading it, and what it does not.
 *
 * Returned as a sentence rather than left to the screen so the same qualification
 * appears wherever this field is described, including the confirmation dialog —
 * the one place an administrator is most likely to be reading quickly.
 */
export function windowNote(preset: WindowPreset, nowMs: number): string {
  if (preset === '') {
    return 'Users will be told the app is closed and not told when it will be back.';
  }

  const ends = new Date(nowMs + PRESET_MS[preset]);
  return `Users will be told to expect the app back around ${ends.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}. Nothing reopens it automatically — come back and reopen it yourself.`;
}
