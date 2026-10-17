/**
 * What a suspended account reads.
 *
 * The failure this guards against is not a crash. It is a sentence: an account
 * told it has been "deleted", "terminated" or "permanently removed" will not ask
 * to be restored, and suspension is reversible by design. So the assertions that
 * carry the weight here are the negative ones — the words that must never
 * appear — and the positive statements of what is retained.
 *
 * The second half is about a notice that appears when it should not. A guest has
 * no `status` column to read, and a client that rendered an empty-string status
 * as "suspended" would accuse a healthy account of something nobody did.
 */
import { suspensionNotice } from '../src/account/suspension';

/** Every word the notice puts in front of the reader, as one block of text. */
function text(body: ReturnType<typeof suspensionNotice>): string {
  if (body === null) throw new Error('expected a notice');
  return [body.title, body.summary, ...body.points].join('\n');
}

describe('who is shown a suspension notice', () => {
  it('shows one to a suspended account', () => {
    const notice = suspensionNotice({ status: 'suspended' });

    expect(notice).not.toBeNull();
    expect(notice?.title).toBe('Account suspended');
  });

  it('shows nothing to an active account', () => {
    // The overwhelmingly common case. A notice here would be a false accusation
    // on every healthy account in the app.
    expect(suspensionNotice({ status: 'active' })).toBeNull();
  });

  it('shows nothing when there is no profile to read', () => {
    // A guest, or a profile fetch that has not answered yet. Neither has been
    // suspended, and silence is the only honest thing to render.
    expect(suspensionNotice(null)).toBeNull();
    expect(suspensionNotice(undefined)).toBeNull();
  });

  it('does not treat an unreadable status as a suspension', () => {
    /*
     * The hosted project has no `status` column until the admin migration is
     * applied, so a row read from it carries `undefined`. That is a missing
     * column, not a suspended account — and it is the one input most likely to
     * be misread, since it is neither of the two values the type allows.
     */
    for (const bad of [{}, { status: undefined }, { status: '' }, { status: 'ACTIVE' }]) {
      expect(suspensionNotice(bad as unknown as { status: 'suspended' })).toBeNull();
    }
  });
});

describe('what the notice is allowed to claim', () => {
  const notice = suspensionNotice({ status: 'suspended' });

  it('never reads as an ending', () => {
    /*
     * The client cannot see whether an account was deleted — it sees one column,
     * and that column says 'suspended'. These are the words that would turn a
     * reversible measure into an irreversible one in the reader's mind.
     *
     * The one line allowed to use them is the line that denies them, so the
     * check is per line: exactly one sentence may contain "deleted", and it must
     * be the reassurance. A blanket search would fail the reassurance and pass a
     * notice that said "your account was deleted" in the same breath — the
     * pattern cannot tell the two apart, and a test that cannot tell them apart
     * is not testing the thing that matters.
     */
    const lines = text(notice).split('\n');
    const reassurance = lines.filter((line) => /nothing has been deleted/i.test(line));
    const rest = lines.filter((line) => !reassurance.includes(line)).join('\n');

    expect(reassurance).toHaveLength(1);
    expect(rest).not.toMatch(/terminat|permanent|delet|remov|eras|\bclos/i);
  });

  it('says what is kept, not only what is refused', () => {
    const body = text(notice);

    expect(body).toMatch(/nothing has been deleted/i);
    expect(body).toMatch(/stay on it/i);
    expect(body).toMatch(/records synced to the account are kept/i);
  });

  it('says who can undo it, so the reader has somewhere to go', () => {
    expect(text(notice)).toMatch(/only an administrator can restore/i);
  });

  it('says what will not work, which is the thing they came to find out', () => {
    const body = text(notice);

    expect(body).toMatch(/will not read or write/i);
    expect(body).toMatch(/cloud sync cannot run/i);
  });

  it('keeps sign-in, because being able to read this is the point', () => {
    // The design deliberately leaves the profile row readable to its owner so
    // this explanation can be shown. An account told it is signed out would
    // close the app before reading the rest.
    expect(text(notice)).toMatch(/still sign in/i);
  });

  it('does not guess why, or quote a reason it never read', () => {
    /*
     * The reason lives in the audit log, which administrators read. A plausible
     * invented cause is the most damaging thing this text could contain, because
     * it would be believed.
     */
    const body = text(notice);

    expect(body).toMatch(/reason .*not shown here/i);
    expect(body).not.toMatch(/violat|abuse|policy|terms|reported|suspicious/i);
  });

  it('does not promise a duration or a review it cannot schedule', () => {
    const body = text(notice);

    expect(body).not.toMatch(/\b(24|48|72) hours\b/i);
    expect(body).not.toMatch(/will be reviewed|under review|temporarily for \d/i);
  });

  it('is one notice, worded the same way every time', () => {
    // The text is built once and returned, so a screen rendered twice cannot
    // show two different accounts two different explanations.
    expect(suspensionNotice({ status: 'suspended' })).toEqual(notice);
    expect(notice?.points.length).toBeGreaterThan(0);
  });
});
