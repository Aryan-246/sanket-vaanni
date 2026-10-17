/**
 * What the notifications row in Settings says.
 *
 * ## Why this is a module rather than a `useMemo` in the screen
 *
 * The sentence answers a question with a wrong answer that costs somebody a
 * missed announcement: *will a notification reach me?* Four facts go into it —
 * whether the user switched notifications on, whether the phone would actually
 * deliver one, whether the plug-in was available, and whether the token was
 * recorded against an account — and each of them alone turns "yes" into a lie.
 *
 * In the screen this was an `if` chain in the middle of layout code, where
 * nothing could assert it. Here it is a function with one input and one output,
 * and the tests next to it can enumerate the combinations.
 *
 * ## The claim the phone makes is the one that was wrong
 *
 * Notifications can be on in this app while the operating system refuses to post
 * them: the user can turn them off in system settings, and Android withdraws the
 * permission on its own for an app it thinks is unused. The app cannot see that
 * unless it asks, and the previous version never asked after the first time the
 * switch was flipped — so the row could say notifications were on and linked to
 * an account on a phone that had stopped delivering them.
 *
 * Nothing here reports delivery. It reports what is known: an arrangement that
 * has been made, and — where the phone has been asked — whether the phone will
 * honour it.
 */
import type { PushState } from './controller';

/**
 * The sentence for the notifications row.
 *
 * Order matters, and it is the order of bad news: something the user must act
 * on comes before something they should merely know. A blocker that no setting
 * in this app can clear is worth more than the detail of why the account is not
 * reachable.
 */
export function describePushRow(state: PushState): string {
  if (state.status === 'enabling') return 'Asking your phone for permission…';

  // Any recorded failure is the most useful thing on this row, so it wins.
  if (state.error !== null) return state.error;

  if (!state.enabled) return 'Off. Nothing is delivered to this phone.';

  /*
   * The phone has been asked and said no. This is not a fault in the app and
   * cannot be fixed by pressing anything here, so the sentence says where it is
   * fixed rather than inviting a retry that will not help.
   */
  if (state.permission === 'denied' || state.permission === 'blocked') {
    return (
      'Switched on here, but your phone is not delivering notifications from Sanket Vaanni. ' +
      'Turn them on for this app in your phone’s settings.'
    );
  }

  if (state.registrationError !== null) return state.registrationError;

  if (state.registeredAccountId === null) {
    return 'On for this phone, but not linked to an account yet — so nothing can be addressed to you.';
  }

  /*
   * The last two sentences both assert that this phone can receive. That is only
   * known to be true after the platform has said so, so `unknown` — a read that
   * failed — falls through to its own wording instead of borrowing theirs.
   */
  if (state.permission !== 'granted') {
    return 'Switch is on, but whether this phone will deliver notifications could not be checked.';
  }

  return 'On, and linked to your account.';
}
