/**
 * The sentence the Settings row shows about notifications.
 *
 * ## Why this one is worth a suite of its own
 *
 * Every sentence here is a claim about whether an announcement will reach
 * somebody. The failure mode is not a crash — it is a user reading "on, and
 * linked to your account" on a phone that has stopped delivering, and
 * concluding that nothing was sent. That was observed on a real device: the
 * package record said `POST_NOTIFICATIONS: granted=false` while the row
 * described notifications as working.
 *
 * So each combination is enumerated, and the two facts most easily flattened
 * into one — "switched on here" and "the phone will deliver" — are asserted
 * separately.
 */
import { describePushRow } from '../src/notifications/pushRow';
import type { PushState } from '../src/notifications';

/** A state that says everything is working, for tests to spoil one field of. */
function working(overrides: Partial<PushState> = {}): PushState {
  return {
    available: true,
    unavailableReason: null,
    enabled: true,
    status: 'on',
    permission: 'granted',
    token: 'tok-1',
    registeredAccountId: 'user-a',
    registrationError: null,
    lastForegroundMessage: null,
    lastOpenedMessage: null,
    error: null,
    ...overrides,
  };
}

describe('what the notifications row says', () => {
  it('only says notifications are on when the phone agrees', () => {
    expect(describePushRow(working())).toBe('On, and linked to your account.');
  });

  it('does not claim delivery when the phone has been asked and said no', () => {
    // The defect this module was written for. The user has switched
    // notifications on in the app; the operating system will not post them.
    for (const permission of ['denied', 'blocked'] as const) {
      const line = describePushRow(working({ permission }));

      expect(line).not.toMatch(/linked to your account/i);
      expect(line).not.toMatch(/^On,/);
      // The fix is in system settings, so the sentence has to send them there
      // rather than invite a retry inside an app that cannot change it.
      expect(line).toMatch(/phone’s settings/i);
    }
  });

  it('does not claim delivery when the phone could not be asked', () => {
    /*
     * `unknown` is a failed read, and a failed read is not a yes. Borrowing the
     * confident wording for it would be the same mistake as the one above, made
     * one level further down.
     */
    const line = describePushRow(working({ permission: 'unknown' }));

    expect(line).not.toMatch(/linked to your account/i);
    expect(line).toMatch(/could not be checked/i);
  });

  it('says nothing is delivered when the switch is off, whatever else is true', () => {
    // Off is off. A token may still be held locally and the account may still
    // be recorded, and neither of those is delivery.
    const line = describePushRow(working({ enabled: false, status: 'off', token: null }));

    expect(line).toBe('Off. Nothing is delivered to this phone.');
  });

  it('separates a token registered to nobody from a working one', () => {
    const line = describePushRow(working({ registeredAccountId: null }));

    expect(line).not.toMatch(/linked to your account/i);
    expect(line).toMatch(/not linked to an account/i);
  });

  it('reports a failure ahead of everything it makes moot', () => {
    const line = describePushRow(working({ error: 'The notification permission was refused.' }));

    expect(line).toBe('The notification permission was refused.');
  });

  it('reports the account-registration failure in the words the controller wrote', () => {
    // That sentence is composed where the error is known, because only there is
    // the underlying reason available; the row must not paraphrase it — and it
    // is now only reachable once the phone has confirmed it would deliver.
    const registrationError = 'This phone can receive notifications, but the token could not be recorded against your account: 42501';
    const line = describePushRow(working({ registrationError, registeredAccountId: null }));

    expect(line).toBe(registrationError);
  });

  it('says a prompt is up while one is', () => {
    expect(describePushRow(working({ status: 'enabling' }))).toBe('Asking your phone for permission…');
  });
});

describe('the order the row reports bad news in', () => {
  /*
   * Someone reading this row has one question: will I get the announcement?
   * These assertions are about which obstacle gets named when several are true
   * at once, because naming the wrong one sends them to fix something that is
   * not what is stopping delivery.
   */
  it('names the phone’s refusal before the account problem', () => {
    // Both are true. The account cannot be fixed until the phone delivers at
    // all, so it is not the useful thing to lead with.
    const line = describePushRow(
      working({ permission: 'denied', registrationError: 'token could not be recorded' }),
    );

    expect(line).toMatch(/phone’s settings/i);
    expect(line).not.toMatch(/token could not be recorded/);
  });

  it('names a recorded failure even when the switch was left off', () => {
    // An error is about the last thing the user did, which is more current than
    // the switch position.
    const line = describePushRow(
      working({ enabled: false, status: 'off', error: 'Notifications were declined.' }),
    );

    expect(line).toBe('Notifications were declined.');
  });
});
