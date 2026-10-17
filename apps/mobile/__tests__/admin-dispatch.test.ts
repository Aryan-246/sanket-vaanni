/**
 * What the announcements screen may say about a notification.
 *
 * The whole value of this module is in what it refuses. Every failure mode here
 * produces a sentence that reads as *good news*: a payload claiming a confirmed
 * delivery would render as one, a missing count renders as nothing beside real
 * numbers, and a report with no summary leaves the counts to speak for
 * themselves — and counts of accepted messages are read as counts of people
 * notified. So the refusals are tested harder than the successes.
 */
import {
  NOT_DELIVERED,
  dispatchBadgeLabel,
  dispatchLine,
  dispatchMessage,
  dispatchTone,
  parseDispatchReport,
} from '../src/admin/dispatchReport';

/** A report as the service sends it, so each test can spoil one field. */
function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'complete',
    reason: null,
    targets: 12,
    accepted: 12,
    failed: 0,
    removed: 0,
    retries: 0,
    moreTargets: false,
    deliveryConfirmed: false,
    summary: 'Attempted 12 devices. Firebase accepted 12 and refused 0.',
    ...overrides,
  };
}

describe('reading a dispatch report', () => {
  it('reads every figure the service reported', () => {
    const parsed = parseDispatchReport(report());

    expect(parsed).toMatchObject({
      state: 'complete',
      targets: 12,
      accepted: 12,
      failed: 0,
      removed: 0,
      retries: 0,
      moreTargets: false,
    });
  });

  it('refuses a report that claims the delivery was confirmed', () => {
    /*
     * The one claim this system cannot make. `deliveryConfirmed` is a literal
     * false in the service because nothing here can observe a phone displaying
     * anything — so a payload asserting otherwise is not a delivery that
     * happened, it is a payload this screen does not understand.
     */
    expect(parseDispatchReport(report({ deliveryConfirmed: true }))).toBeNull();
  });

  it('refuses a report that does not say either way', () => {
    // An absent field is not a false one. The safe reading of an unknown is not
    // "it was delivered", so a payload that omits the field is dropped.
    const without = report();
    delete without.deliveryConfirmed;

    expect('deliveryConfirmed' in without).toBe(false);
    expect(parseDispatchReport(without)).toBeNull();
    expect(parseDispatchReport(report({ deliveryConfirmed: 'false' }))).toBeNull();
    expect(parseDispatchReport(report({ deliveryConfirmed: 0 }))).toBeNull();
  });

  it('refuses a state word it does not know', () => {
    // 'sent' is the word that would arrive if someone added a state to the
    // service meaning "we handed it over" — and rendered here, a badge saying
    // "sent" beside a notice reads as "people were told".
    for (const bad of ['sent', 'ok', 'COMPLETE', 1, null]) {
      expect(parseDispatchReport(report({ state: bad }))).toBeNull();
    }
  });

  it('refuses a payload missing a count rather than reading it as zero', () => {
    for (const field of ['targets', 'accepted', 'failed', 'removed', 'retries']) {
      const payload = report();
      delete payload[field];
      expect(parseDispatchReport(payload)).toBeNull();
    }
  });

  it('refuses a count that cannot be a count of devices', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '12', null, true]) {
      expect(parseDispatchReport(report({ accepted: bad }))).toBeNull();
    }
  });

  it('refuses a report with no sentence, because the figures would speak alone', () => {
    // The summary is where the service says that acceptance is not delivery.
    // Without it the screen would draw the numbers, and numbers are what get
    // read as deliveries.
    for (const bad of ['', null, undefined, 42]) {
      expect(parseDispatchReport(report({ summary: bad }))).toBeNull();
    }
  });

  it('refuses shapes that are not a report at all', () => {
    for (const bad of [null, undefined, 'sent', 7, [], { state: 'complete' }]) {
      expect(parseDispatchReport(bad)).toBeNull();
    }
  });

  it('keeps a missing reason as nothing, which is not an error', () => {
    // A dispatch that covered everything it tried has no reason to give, and
    // that is the ordinary case rather than a malformed one.
    expect(parseDispatchReport(report({ reason: undefined }))?.reason).toBeNull();
  });
});

describe('the sentence shown after a publish', () => {
  const parsed = (overrides: Record<string, unknown> = {}) => parseDispatchReport(report(overrides))!;

  it('never claims a message was delivered, in any state', () => {
    const cases = [
      parsed(),
      parsed({ state: 'partial', moreTargets: true, reason: 'More devices are registered.' }),
      parsed({ state: 'unavailable', reason: 'No Firebase service account is configured.' }),
      parsed({ targets: 0, accepted: 0 }),
    ];

    for (const one of cases) {
      expect(dispatchMessage(one)).not.toMatch(/delivered|reached a phone|notified/i);
    }
  });

  it('says nothing was sent when push is not configured, and why', () => {
    const message = dispatchMessage(
      parsed({ state: 'unavailable', reason: 'No Firebase service account is configured.' }),
    );

    expect(message).toMatch(/no notification was sent/i);
    expect(message).toContain('No Firebase service account is configured.');
    // The caveat about acceptance would be nonsense here: nothing was accepted.
    expect(message).not.toContain(NOT_DELIVERED);
  });

  it('says so when there is no phone to send to', () => {
    // "Firebase accepted 0" invites the reader to look for a fault in the send.
    // The actual situation is that nobody has registered a device yet.
    const message = dispatchMessage(parsed({ targets: 0, accepted: 0, failed: 0 }));

    expect(message).toMatch(/no phone is registered/i);
    expect(message).toMatch(/still live in the app/i);
  });

  it('separates what was accepted from what that proves', () => {
    const message = dispatchMessage(parsed());

    expect(message).toContain('Firebase accepted 12 of 12 devices');
    expect(message).toContain(NOT_DELIVERED);
  });

  it('names the refusals when there were any', () => {
    expect(dispatchMessage(parsed({ accepted: 10, failed: 2 }))).toMatch(/refused 2/);
  });

  it('carries the reason a partial send gives', () => {
    const message = dispatchMessage(
      parsed({ state: 'partial', reason: 'More devices are registered than one dispatch may attempt.' }),
    );

    expect(message).toContain('More devices are registered than one dispatch may attempt.');
    expect(message).toContain(NOT_DELIVERED);
  });

  it('counts one device in the singular', () => {
    expect(dispatchMessage(parsed({ targets: 1, accepted: 1 }))).toContain('1 of 1 device.');
  });
});

describe('the badge beside an announcement', () => {
  const parsed = (overrides: Record<string, unknown> = {}) => parseDispatchReport(report(overrides))!;

  it('never uses the success colour, because green reads as delivered', () => {
    const cases = [
      parsed(),
      parsed({ state: 'partial' }),
      parsed({ state: 'unavailable' }),
      parsed({ targets: 0 }),
      parsed({ failed: 1 }),
    ];

    for (const one of cases) {
      expect(dispatchTone(one)).not.toBe('success');
    }
  });

  it('reserves the calm tone for a send where nothing failed, and the other for the rest', () => {
    expect(dispatchTone(parsed())).toBe('neutral');
    expect(dispatchTone(parsed({ failed: 1 }))).toBe('warning');
    expect(dispatchTone(parsed({ state: 'partial' }))).toBe('warning');
    expect(dispatchTone(parsed({ state: 'unavailable' }))).toBe('warning');
  });

  it('words the badge so it cannot be read as a delivery', () => {
    expect(dispatchBadgeLabel(parsed())).toBe('Sent, not confirmed');
    expect(dispatchBadgeLabel(parsed({ state: 'unavailable' }))).toBe('Not sent');
    expect(dispatchBadgeLabel(parsed({ state: 'partial' }))).toBe('Partly sent');
  });
});

describe('what the screen shows for what the service returned', () => {
  it('says nothing at all when there was no dispatch', () => {
    // A saved draft. Nothing was ever going to be sent, so there is nothing to
    // explain — and a sentence here would imply an attempt was made.
    expect(dispatchLine(null)).toBeNull();
    expect(dispatchLine(undefined)).toBeNull();
  });

  it('admits when the service said something it cannot interpret', () => {
    // Silence would be indistinguishable from "no dispatch happened", and the
    // two mean different things to the person who just pressed Publish.
    const line = dispatchLine({ state: 'sent-to-everyone' });

    expect(line).toMatch(/cannot read/i);
    expect(line).toMatch(/nothing is claimed about it/i);
  });

  it('passes a readable report through to the sentence', () => {
    expect(dispatchLine(report())).toContain(NOT_DELIVERED);
  });
});
