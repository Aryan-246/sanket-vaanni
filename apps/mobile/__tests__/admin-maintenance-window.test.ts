/**
 * The note that says when maintenance is expected to end.
 *
 * ## The failure this file exists to prevent
 *
 * There is no scheduler in the backend. `apps/backend/src/maintenance/gate.ts`
 * reads `enabled` and `message` from the setting and nothing else, and nothing
 * anywhere turns maintenance off at a stored time. So `expectedEndAt` is a note
 * shown to a locked-out user and nothing more.
 *
 * An administrator who sets "about an hour" and walks away has, on that reading,
 * scheduled a reopening that will not happen. The outage then continues past the
 * moment everyone was told it would end, with nobody watching. That is a worse
 * outcome than not showing a time at all.
 *
 * So the assertions below are less about arithmetic — the spans are simple — and
 * more about the sentence: whatever else it says, it must say that the app does
 * not reopen itself. The last test checks that for every preset, so the
 * qualification cannot be dropped from one of them by a later edit.
 *
 * The clock is pinned everywhere. No figure here is read from the machine.
 */
import {
  WINDOW_OPTIONS,
  expectedEndAt,
  windowNote,
} from '../src/admin/maintenanceWindow';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15T12:00:00Z
const HOUR = 60 * 60 * 1000;

describe('the instant a preset names', () => {
  it('clears the note rather than dating it to now', () => {
    // The server treats an explicit null as "clear it". If "Not saying" resolved
    // to the current instant instead, a note set last week would stay on the
    // setting and go on being shown to users while the console said otherwise.
    expect(expectedEndAt('', NOW)).toBeNull();
  });

  it('is exactly the span the label promises', () => {
    expect(expectedEndAt('hour', NOW)).toBe(new Date(NOW + HOUR).toISOString());
    expect(expectedEndAt('fourHours', NOW)).toBe(new Date(NOW + 4 * HOUR).toISOString());
    expect(expectedEndAt('day', NOW)).toBe(new Date(NOW + 24 * HOUR).toISOString());
  });

  it('uses fixed spans, so no label is a calendar unit in disguise', () => {
    // "24 hours" must be 24 hours in February too. A calendar-day reading would
    // make the note wrong by an hour twice a year in a country that observes
    // daylight saving, on the one screen a locked-out user is reading.
    const winter = expectedEndAt('day', Date.UTC(2026, 0, 15, 12))!;
    const summer = expectedEndAt('day', Date.UTC(2026, 6, 15, 12))!;

    expect(Date.parse(winter) - Date.UTC(2026, 0, 15, 12)).toBe(24 * HOUR);
    expect(Date.parse(summer) - Date.UTC(2026, 6, 15, 12)).toBe(24 * HOUR);
  });

  it('offers a preset for every span it can produce', () => {
    // A preset with no option is unreachable, and an option with no preset would
    // send an instant nothing can compute.
    for (const option of WINDOW_OPTIONS) {
      const value = expectedEndAt(option.value, NOW);
      if (option.value === '') expect(value).toBeNull();
      else expect(value).not.toBeNull();
    }
  });
});

describe('what the note tells the administrator', () => {
  it('says users are not told when, when the choice is not to say', () => {
    expect(windowNote('', NOW)).toMatch(/not told when/i);
  });

  it('gives a time when one was chosen', () => {
    // Local time, so it is compared as a time rather than as a fixed string — a
    // test that pinned the exact rendering would fail in another timezone while
    // the code was right.
    const note = windowNote('fourHours', NOW);
    const ends = new Date(NOW + 4 * HOUR);

    expect(note).toContain(
      ends.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
  });

  /*
   * The one that matters. Stated for every preset rather than for a single
   * example, because the qualification being present on three of four options is
   * the same bug as it being absent from all of them: the option that lost it is
   * the one an administrator will pick.
   */
  it('says, for every preset, that nothing reopens the app by itself', () => {
    for (const option of WINDOW_OPTIONS) {
      if (option.value === '') continue;
      const note = windowNote(option.value, NOW);

      expect(note).toMatch(/automatically/i);
      expect(note).toMatch(/reopen it yourself/i);
    }
  });

  it('never claims the app will reopen', () => {
    for (const option of WINDOW_OPTIONS) {
      const note = windowNote(option.value, NOW);
      expect(note).not.toMatch(/will reopen/i);
      expect(note).not.toMatch(/reopens automatically\./i);
    }
  });
});
