/**
 * What the notices section may say about a recorded notification.
 *
 * ## The defect these defend against
 *
 * `AnnouncementRow` has no delivery field, so a notice card could describe a
 * publish and then forget, the moment the reader reopened the section, whether
 * the service had ever been asked to notify anybody. The only durable trace is
 * the `dispatch_announcement` audit row the backend already writes, so
 * `lastDispatch.ts` reads the log the console already fetches.
 *
 * That makes the log the *record* of delivery, and a record invites a claim
 * stronger than the data supports. `apps/backend/src/routes/admin.ts` audits a
 * dispatch as succeeded whenever its state was not `unavailable` — and a
 * `complete` dispatch with **zero registered devices** is exactly that, with
 * nothing sent to anyone. A "Sent" badge built on `succeeded` would therefore be
 * a confident lie on a notice no phone ever received.
 *
 * So most of what follows is about what the badge must *not* say. `succeeded`
 * means an attempt was recorded and the service did not call it a failure;
 * nothing here can say a device got it.
 *
 * ## The second defect: absence read as denial
 *
 * Only one page of the audit endpoint is read, newest first. A notice whose last
 * dispatch is older than that window has no entry — which is a different fact
 * from "nothing was ever sent", and the card has to say so. An implementation
 * that rendered a missing entry as an empty space, or as "No", would be
 * asserting the second from the first.
 */
import {
  DISPATCH_ACTION,
  NOT_IN_LOG_BADGE,
  NOT_IN_LOG_NOTE,
  latestDispatchPerAnnouncement,
  loggedDispatchBadge,
  loggedDispatchLine,
  loggedDispatchTone,
} from '../src/admin/lastDispatch';
import type { AuditOutcome } from '../src/admin/auditEntry';
import type { AdminAuditRow, Json } from '../src/supabase/types';

const OUTCOMES: readonly AuditOutcome[] = ['succeeded', 'failed', 'requested', 'unrecorded'];

function row(over: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: 'row-1',
    actor_id: 'admin-1',
    actor_email: 'admin@example.test',
    action: DISPATCH_ACTION,
    target_type: 'announcement',
    target_id: 'notice-1',
    reason: 'sent again',
    metadata: { outcome: 'succeeded', detail: 'Accepted by 3 of 3 devices.' },
    created_at: '2026-03-02T10:00:00.000Z',
    ...over,
  };
}

function meta(value: unknown): Json {
  return value as Json;
}

describe('finding the last attempt per notice', () => {
  it('keeps the newest row for a notice, because the endpoint lists newest first', () => {
    // The order matters and is not incidental: `GET /admin/audit` orders by
    // `created_at` descending, so the first row seen for an id is the latest.
    // Taking the last would show the oldest attempt as the current state.
    const found = latestDispatchPerAnnouncement([
      row({ id: 'newest', target_id: 'notice-1', created_at: '2026-03-03T10:00:00.000Z' }),
      row({ id: 'older', target_id: 'notice-1', created_at: '2026-03-01T10:00:00.000Z' }),
    ]);

    expect(found.get('notice-1')?.at).toBe('2026-03-03T10:00:00.000Z');
    expect(found.size).toBe(1);
  });

  it('keeps a separate entry for each notice', () => {
    const found = latestDispatchPerAnnouncement([
      row({ id: 'a', target_id: 'notice-1' }),
      row({ id: 'b', target_id: 'notice-2' }),
    ]);

    expect([...found.keys()].sort()).toEqual(['notice-1', 'notice-2']);
  });

  it('ignores rows that are not a dispatch', () => {
    // The log holds every administrative action. `publish_announcement` is
    // written for the same notice and would otherwise be read as a notification
    // attempt — so the two rows here carry *different* details, and the
    // assertion is on which one survived. An earlier version of this test gave
    // both rows the same outcome and passed even with the filter removed.
    const found = latestDispatchPerAnnouncement([
      row({
        id: 'publish',
        action: 'publish_announcement',
        target_id: 'notice-1',
        metadata: { outcome: 'succeeded', detail: 'This notice went live.' },
        created_at: '2026-03-04T10:00:00.000Z',
      }),
      row({
        id: 'dispatch',
        action: DISPATCH_ACTION,
        target_id: 'notice-1',
        metadata: { outcome: 'failed', detail: 'The notification service rejected the request.' },
        created_at: '2026-03-02T10:00:00.000Z',
      }),
    ]);

    expect(found.size).toBe(1);
    expect(found.get('notice-1')?.outcome).toBe('failed');
    expect(found.get('notice-1')?.detail).toBe('The notification service rejected the request.');
  });

  it('ignores a dispatch with no notice attached', () => {
    // `target_id` is nullable. A row without one cannot be attributed to a card,
    // and inventing a key for it would put the same attempt on every notice.
    const found = latestDispatchPerAnnouncement([
      row({ id: 'empty', target_id: '' }),
      row({ id: 'null', target_id: null }),
    ]);

    expect(found.size).toBe(0);
  });

  it('carries the outcome and the service’s own summary', () => {
    const found = latestDispatchPerAnnouncement([
      row({
        target_id: 'notice-1',
        metadata: { outcome: 'failed', detail: 'The notification service rejected the request.' },
      }),
    ]);

    expect(found.get('notice-1')).toEqual({
      announcementId: 'notice-1',
      outcome: 'failed',
      detail: 'The notification service rejected the request.',
      at: '2026-03-02T10:00:00.000Z',
    });
  });

  it('reports a row with no outcome as unrecorded rather than as a failure', () => {
    const found = latestDispatchPerAnnouncement([
      row({ target_id: 'notice-1', metadata: meta({ detail: 'anything' }) }),
    ]);

    expect(found.get('notice-1')?.outcome).toBe('unrecorded');
  });

  it('reads an unreadable metadata column without throwing', () => {
    // `metadata` is `jsonb` and untyped. A row written by an older version, or
    // one hand-edited, must not take the whole notices section down.
    const found = latestDispatchPerAnnouncement([
      row({ id: 'nullmeta', target_id: 'a', metadata: meta(null) }),
      row({ id: 'listmeta', target_id: 'b', metadata: meta([1, 2]) }),
      row({ id: 'stringmeta', target_id: 'c', metadata: meta('nope') }),
    ]);

    expect(found.size).toBe(3);
    expect(found.get('a')?.outcome).toBe('unrecorded');
    expect(found.get('c')?.detail).toBeNull();
  });

  it('returns nothing for an empty page', () => {
    expect(latestDispatchPerAnnouncement([]).size).toBe(0);
  });
});

describe('what the badge is allowed to claim', () => {
  /*
   * The load-bearing assertion of this file. A badge is scanned rather than
   * read, so the words that mean "a device received this" are the ones that
   * land — and the log cannot support any of them, because a `complete` dispatch
   * to zero registered devices is audited as a success. See the note at the top.
   */
  it('opens with no claim that anything reached a device', () => {
    for (const outcome of OUTCOMES) {
      expect(loggedDispatchBadge(outcome)).not.toMatch(/^\s*(sent|delivered|notified|received)\b/i);
    }
  });

  it('mentions sending only in order to deny it', () => {
    // "Not sent" is allowed and "Sent" is not, so the assertion cannot be that
    // the word is absent. It has to be that a delivery word is always under a
    // negation — which is exactly the property a future edit would break by
    // dropping the "Not".
    const DELIVERY_WORD = /\bsent\b|\bdeliver|\breceived\b|\bnotified\b/i;

    for (const outcome of OUTCOMES) {
      const label = loggedDispatchBadge(outcome);
      if (DELIVERY_WORD.test(label)) {
        expect(label).toMatch(/^not\b|not confirmed/i);
      }
    }
  });

  it('does not call a succeeded dispatch "Sent"', () => {
    expect(loggedDispatchBadge('succeeded')).not.toBe('Sent');
  });

  it('says what is missing from a success rather than what happened', () => {
    // The qualifier is the whole content of the claim: the service recorded an
    // attempt, and confirmation is not something this system has.
    const label = loggedDispatchBadge('succeeded');

    expect(label).toMatch(/not confirmed/i);
    expect(label).toMatch(/recorded/i);
  });

  it('says a failed dispatch did not go out, without naming a cause', () => {
    expect(loggedDispatchBadge('failed')).toBe('Not sent');
  });

  it('distinguishes an attempt that was never resolved', () => {
    // The `requested` row is the one written before the work happens. If only it
    // exists, the console knows an attempt was started and nothing about how it
    // ended — which is not a failure and not a success.
    const label = loggedDispatchBadge('requested');

    expect(label).not.toBe(loggedDispatchBadge('succeeded'));
    expect(label).not.toBe(loggedDispatchBadge('failed'));
    expect(label).toMatch(/unrecorded/i);
  });

  it('gives every outcome a distinct badge', () => {
    // Stated as a set so an outcome added later cannot quietly share another's
    // badge and inherit its meaning.
    const labels = OUTCOMES.map(loggedDispatchBadge);

    expect(new Set(labels).size).toBe(OUTCOMES.length);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });
});

describe('the tone that goes with the badge', () => {
  it('never uses the success colour for a recorded dispatch', () => {
    // Green beside a dispatch is read as "delivered", and nothing in this system
    // can report a delivery. The live badge in `dispatchReport.ts` avoids the
    // same tone for the same reason.
    for (const outcome of OUTCOMES) {
      expect(loggedDispatchTone(outcome)).not.toBe('success');
    }
  });

  it('marks a failed dispatch as needing attention', () => {
    expect(loggedDispatchTone('failed')).toBe('warning');
  });

  it('leaves a recorded attempt neutral', () => {
    expect(loggedDispatchTone('succeeded')).toBe('neutral');
  });
});

describe('the sentence beside the badge', () => {
  it('shows the service’s summary as it was written', () => {
    const line = loggedDispatchLine({
      announcementId: 'notice-1',
      outcome: 'succeeded',
      detail: 'Accepted by 3 of 3 devices. Acceptance is not delivery.',
      at: '2026-03-02T10:00:00.000Z',
    });

    expect(line).toContain('Accepted by 3 of 3 devices. Acceptance is not delivery.');
  });

  it('says a failure was recorded as a failure, with the reason', () => {
    const line = loggedDispatchLine({
      announcementId: 'notice-1',
      outcome: 'failed',
      detail: 'No notification service is configured.',
      at: '2026-03-02T10:00:00.000Z',
    });

    expect(line).toMatch(/failed/i);
    expect(line).toContain('No notification service is configured.');
  });

  it('says outright that an unresolved attempt never reported back', () => {
    const line = loggedDispatchLine({
      announcementId: 'notice-1',
      outcome: 'requested',
      detail: null,
      at: '2026-03-02T10:00:00.000Z',
    });

    expect(line).toMatch(/nothing was ever recorded about how it ended/i);
  });

  it('claims nothing either way for a row written before outcomes were recorded', () => {
    const line = loggedDispatchLine({
      announcementId: 'notice-1',
      outcome: 'unrecorded',
      detail: null,
      at: '2026-03-02T10:00:00.000Z',
    });

    expect(line).toMatch(/nothing is claimed about it either way/i);
    expect(line).not.toMatch(/failed/i);
  });

  it('keeps an unreadable timestamp visible instead of hiding which row it was', () => {
    // Substituting "unknown" would discard the only identifier the reader has
    // for a malformed row.
    const line = loggedDispatchLine({
      announcementId: 'notice-1',
      outcome: 'failed',
      detail: null,
      at: 'not-a-date',
    });

    expect(line).toContain('not-a-date');
  });

  it('never tells the reader a message was delivered', () => {
    for (const outcome of OUTCOMES) {
      const line = loggedDispatchLine({
        announcementId: 'notice-1',
        outcome,
        detail: 'Accepted by 3 of 3 devices.',
        at: '2026-03-02T10:00:00.000Z',
      });

      expect(line).not.toMatch(/\bwas delivered\b|\bwas received\b/i);
    }
  });
});

describe('a notice with no entry in the page that was read', () => {
  it('does not claim nothing was ever sent', () => {
    // The window is one page of the log. An older attempt simply is not in it.
    expect(NOT_IN_LOG_NOTE).toMatch(/not the same as never having sent one/i);
  });

  it('says the entry is absent from the log rather than that it does not exist', () => {
    expect(NOT_IN_LOG_BADGE).toMatch(/no recent/i);
    expect(NOT_IN_LOG_BADGE).not.toMatch(/\bnever\b|\bnone\b/i);
  });

  it('does not share its label with any recorded outcome', () => {
    for (const outcome of OUTCOMES) {
      expect(loggedDispatchBadge(outcome)).not.toBe(NOT_IN_LOG_BADGE);
    }
  });
});
