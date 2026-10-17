/**
 * Notices: what is shown, and what a failure is allowed to look like.
 *
 * ## Why the interesting tests here are about refusals
 *
 * A notices list that shows too much is a draft leaking to every user; one that
 * shows too little is a warning nobody reads. Both are covered below, and so is
 * the state that a boolean cannot express: a read that **failed** must never be
 * renderable as "there are no notices". `shouldShowNotices` is the single line
 * that keeps those apart, so it is asserted directly rather than through a
 * screen.
 *
 * The read itself is injected. The default reaches a live Supabase, and a test
 * that went through it would either need credentials (and fail on a fresh clone)
 * or assert nothing at all — the trap `admin-audit.test.ts` documents at length.
 * Injecting it means the real code paths — cache, dismissal, fallback, pruning —
 * are exercised here in full.
 */
import { createInMemoryStorage } from '../src/storage';
import {
  AnnouncementsReader,
  type AnnouncementsRead,
  dedupeById,
  isLive,
  parseNotice,
  selectVisible,
  shouldShowNotices,
  sortNotices,
  type AnnouncementsState,
  type Notice,
} from '../src/announcements';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

/** A row as the database would return one. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a',
    title: 'Glove service window',
    body: 'The recognition service will be paused for maintenance.',
    severity: 'info',
    published: true,
    published_at: null,
    expires_at: null,
    ...over,
  };
}

function state(over: Partial<AnnouncementsState> = {}): AnnouncementsState {
  return {
    status: 'ready',
    notices: [],
    checkedAtMs: null,
    reason: null,
    fromCache: false,
    dismissedCount: 0,
    ...over,
  };
}

function notice(over: Partial<Notice> = {}): Notice {
  return {
    id: 'a',
    title: 'T',
    body: 'B',
    severity: 'info',
    publishedAt: null,
    expiresAt: null,
    ...over,
  };
}

describe('a row becomes a notice, or it does not', () => {
  it('reads a well-formed published row', () => {
    const parsed = parseNotice(row({ id: 'n1', severity: 'critical' }), NOW);

    expect(parsed).toEqual({
      id: 'n1',
      title: 'Glove service window',
      body: 'The recognition service will be paused for maintenance.',
      severity: 'critical',
      publishedAt: null,
      expiresAt: null,
    });
  });

  it('refuses an unpublished row even though the policy should have hidden it', () => {
    /*
     * The check that has to survive someone else's mistake. The policy filters
     * on `published = true`, and if it were ever dropped the row that would leak
     * is a draft — the one row an operator expects to be keeping to themselves.
     */
    expect(parseNotice(row({ published: false }), NOW)).toBeNull();
    expect(parseNotice(row({ published: undefined }), NOW)).toBeNull();
    // Not truthy-checked: a string is a row this build does not understand, and
    // reading it as published would be a guess about a draft.
    expect(parseNotice(row({ published: 'true' }), NOW)).toBeNull();
    expect(parseNotice(row({ published: 1 }), NOW)).toBeNull();
  });

  it('refuses a row whose window has not opened or has closed', () => {
    expect(parseNotice(row({ published_at: FUTURE }), NOW)).toBeNull();
    expect(parseNotice(row({ expires_at: PAST }), NOW)).toBeNull();
    // A published row inside its window, and one with no expiry at all.
    expect(parseNotice(row({ published_at: PAST, expires_at: FUTURE }), NOW)).not.toBeNull();
    expect(parseNotice(row({ published_at: PAST }), NOW)).not.toBeNull();
  });

  it('treats the window edges as closed', () => {
    // Exactly now: a notice that expires this instant is over, and one that
    // publishes this instant is live. Anything else makes the two columns mean
    // different things at the same timestamp.
    const at = new Date(NOW).toISOString();
    expect(isLive(notice({ expiresAt: at }), NOW)).toBe(false);
    expect(isLive(notice({ publishedAt: at }), NOW)).toBe(true);
  });

  it('refuses a date it cannot read rather than guessing at the window', () => {
    /*
     * The same refusal to coerce that the maintenance setting applies to
     * `enabled`. Rendering a notice whose validity could not be checked is
     * exactly the claim an expiry date exists to make, so an unreadable one
     * makes the notice unshowable.
     */
    expect(parseNotice(row({ expires_at: 'not a date' }), NOW)).toBeNull();
    expect(parseNotice(row({ published_at: 'soon' }), NOW)).toBeNull();
    // Absent is not unreadable: no `published_at` means live immediately.
    expect(parseNotice(row({ published_at: null }), NOW)).not.toBeNull();
  });

  it('refuses a row that is missing what it takes to render one', () => {
    expect(parseNotice(row({ id: '' }), NOW)).toBeNull();
    expect(parseNotice(row({ id: undefined }), NOW)).toBeNull();
    expect(parseNotice(row({ title: '   ' }), NOW)).toBeNull();
    expect(parseNotice(row({ body: '' }), NOW)).toBeNull();
    expect(parseNotice(row({ severity: 'urgent' }), NOW)).toBeNull();
    expect(parseNotice(row({ severity: undefined }), NOW)).toBeNull();
    expect(parseNotice(null, NOW)).toBeNull();
    expect(parseNotice('a notice', NOW)).toBeNull();
    // An array is also an object, and would otherwise pass the object check.
    expect(parseNotice([row()], NOW)).toBeNull();
  });
});

describe('ordering and deduplication', () => {
  it('puts the most important first, then the most recent', () => {
    const order = sortNotices([
      notice({ id: 'info-new', severity: 'info', publishedAt: FUTURE }),
      notice({ id: 'info-old', severity: 'info', publishedAt: PAST }),
      notice({ id: 'critical', severity: 'critical' }),
      notice({ id: 'warning', severity: 'warning' }),
    ]).map((n) => n.id);

    // Severity outranks recency: a critical notice from last week still comes
    // before this morning's information, and a list sorted by date alone would
    // bury it.
    expect(order).toEqual(['critical', 'warning', 'info-new', 'info-old']);
  });

  it('keeps one notice per id', () => {
    const deduped = dedupeById([
      notice({ id: 'a', title: 'first' }),
      notice({ id: 'b' }),
      notice({ id: 'a', title: 'second' }),
    ]);

    expect(deduped.map((n) => n.id)).toEqual(['a', 'b']);
    expect(deduped[0]?.title).toBe('first');
  });

  it('hides exactly the dismissed ones', () => {
    const visible = selectVisible([notice({ id: 'a' }), notice({ id: 'b' })], ['a']);

    expect(visible.map((n) => n.id)).toEqual(['b']);
  });
});

describe('whether there is anything to draw', () => {
  it('says nothing only when a completed read found nothing', () => {
    // The one state that means "there are no notices".
    expect(shouldShowNotices(state({ status: 'ready', notices: [] }))).toBe(false);
    expect(shouldShowNotices(state({ status: 'ready', notices: [notice()] }))).toBe(true);
  });

  it('draws a failed read even when it has nothing cached', () => {
    /*
     * The line that keeps a failed read from impersonating "nothing is
     * happening". On a settings screen a card that is absent and a card saying
     * "no notices" are indistinguishable, so the failure has to render.
     */
    expect(shouldShowNotices(state({ status: 'unreadable', notices: [] }))).toBe(true);
    expect(shouldShowNotices(state({ status: 'loading', notices: [] }))).toBe(true);
  });
});

/* --------------------------------------------------- the reader, end to end */

/** A read that resolves the way a test tells it to. */
function readsOnce(result: AnnouncementsRead) {
  const calls: AbortSignal[] = [];
  const read = jest.fn((signal: AbortSignal) => {
    calls.push(signal);
    return Promise.resolve(result);
  });
  return { read, calls };
}

async function readerWith(
  options: {
    result?: AnnouncementsRead;
    seed?: (storage: ReturnType<typeof createInMemoryStorage>) => Promise<void>;
  } = {},
) {
  const storage = createInMemoryStorage();
  if (options.seed) await options.seed(storage);
  const { read, calls } = readsOnce(options.result ?? { ok: true, rows: [] });
  const reader = new AnnouncementsReader({ storage, read });
  return { reader, storage, read, calls };
}

describe('reading notices', () => {
  it('publishes what it read, in order, and caches it', async () => {
    const { reader, storage } = await readerWith({
      result: {
        ok: true,
        rows: [
          row({ id: 'info', severity: 'info' }),
          row({ id: 'critical', severity: 'critical' }),
        ],
      },
    });

    await reader.refresh();

    const snapshot = reader.getSnapshot();
    expect(snapshot.status).toBe('ready');
    expect(snapshot.notices.map((n) => n.id)).toEqual(['critical', 'info']);
    expect(snapshot.reason).toBeNull();
    expect(snapshot.fromCache).toBe(false);
    expect(snapshot.checkedAtMs).not.toBeNull();

    const cached = await storage.getJson<{ notices: Notice[] }>('sv/v1/notices/lastKnown');
    expect(cached?.notices.map((n) => n.id)).toEqual(['critical', 'info']);
  });

  it('reports a failure instead of an empty list', async () => {
    const { reader } = await readerWith({
      result: { ok: false, reason: 'permission denied for table announcements' },
    });

    await reader.refresh();

    const snapshot = reader.getSnapshot();
    expect(snapshot.status).toBe('unreadable');
    // The service's own words, kept: they name the missing grant, where
    // "could not load notices" would send an operator to the network.
    expect(snapshot.reason).toBe('permission denied for table announcements');
    expect(snapshot.fromCache).toBe(false);
  });

  it('keeps showing the last good list when a later read fails', async () => {
    const storage = createInMemoryStorage();
    const good = jest.fn(() => Promise.resolve<AnnouncementsRead>({ ok: true, rows: [row({ id: 'kept' })] }));
    const reader = new AnnouncementsReader({ storage, read: good });
    await reader.refresh();

    const failing = jest.fn(() =>
      Promise.resolve<AnnouncementsRead>({ ok: false, reason: 'offline' }),
    );
    const second = new AnnouncementsReader({ storage, read: failing });
    await second.refresh();

    const snapshot = second.getSnapshot();
    expect(snapshot.status).toBe('unreadable');
    expect(snapshot.notices.map((n) => n.id)).toEqual(['kept']);
    // Marked as cached, so the card can say the list is not current rather than
    // presenting it as the answer.
    expect(snapshot.fromCache).toBe(true);
  });

  it('drops a cached notice that has expired since it was cached', async () => {
    const { reader } = await readerWith({
      result: { ok: false, reason: 'offline' },
      seed: async (storage) => {
        await storage.setJson('sv/v1/notices/lastKnown', {
          checkedAtMs: NOW,
          notices: [
            { id: 'stale', title: 'T', body: 'B', severity: 'info', publishedAt: PAST, expiresAt: PAST },
            { id: 'live', title: 'T', body: 'B', severity: 'info', publishedAt: PAST, expiresAt: FUTURE },
          ],
        });
      },
    });

    await reader.refresh();

    // Rendering the stale one from the cache would be how a notice outlives the
    // expiry set to stop it.
    expect(reader.getSnapshot().notices.map((n) => n.id)).toEqual(['live']);
  });

  it('treats a cache it cannot read as no cache rather than crashing', async () => {
    const { reader } = await readerWith({
      result: { ok: false, reason: 'offline' },
      seed: async (storage) => {
        await storage.setJson('sv/v1/notices/lastKnown', { notices: 'all of them' });
      },
    });

    await reader.refresh();

    expect(reader.getSnapshot().status).toBe('unreadable');
    expect(reader.getSnapshot().fromCache).toBe(false);
  });

  it('drops a second read that arrives while the first is in flight', async () => {
    let release: ((value: AnnouncementsRead) => void) | undefined;
    const read = jest.fn(
      () =>
        new Promise<AnnouncementsRead>((resolve) => {
          release = resolve;
        }),
    );
    const reader = new AnnouncementsReader({ storage: createInMemoryStorage(), read });

    /*
     * The first call does not reach `read` until it has read local storage, so
     * there is a turn of the event loop before the deferred exists. Yielding to
     * the macrotask queue — not just the microtask queue — is what lets storage
     * finish; spinning on `Promise.resolve()` would deadlock if the storage
     * implementation used a timer.
     */
    const first = reader.refresh();
    for (let i = 0; i < 50 && release === undefined; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 0);
      });
    }

    // The second call is the one under test: it must return without reading.
    await reader.refresh();
    release?.({ ok: true, rows: [row({ id: 'once' })] });
    await first;

    expect(read).toHaveBeenCalledTimes(1);
    expect(reader.getSnapshot().notices.map((n) => n.id)).toEqual(['once']);
  });
});

describe('dismissing a notice', () => {
  it('hides it now and remembers it for the next launch', async () => {
    const { reader, storage } = await readerWith({
      result: { ok: true, rows: [row({ id: 'a' }), row({ id: 'b' })] },
    });
    await reader.refresh();

    reader.dismiss('a');

    expect(reader.getSnapshot().notices.map((n) => n.id)).toEqual(['b']);
    expect(reader.getSnapshot().dismissedCount).toBe(1);

    const stored = await storage.getJson<string[]>('sv/v1/notices/dismissed');
    expect(stored).toEqual(['a']);
  });

  it('keeps its dismissals when a read fails before anything was ever cached', async () => {
    /*
     * The falsifiable half of the pruning rule, and the reason this test exists
     * separately from the one below.
     *
     * Dismissals are only pruned on a **successful** read. The failure path has
     * no list to prune against — `known` is empty on a device that has never
     * completed a read — so pruning there would release every dismissal at once
     * and bring every dismissed notice back. Running the prune against a stale
     * cached list instead would hide the bug, because a non-empty `known` keeps
     * the ids; this device has no cache, which is what makes the difference
     * visible.
     */
    const storage = createInMemoryStorage();
    await storage.setJson('sv/v1/notices/dismissed', ['a']);

    const { read } = readsOnce({ ok: false, reason: 'offline' });
    const reader = new AnnouncementsReader({ storage, read });
    await reader.refresh();

    expect(reader.getSnapshot().dismissedCount).toBe(1);
    expect(await storage.getJson<string[]>('sv/v1/notices/dismissed')).toEqual(['a']);
  });

  it('still hides a dismissed notice when the read that follows fails', async () => {
    const storage = createInMemoryStorage();
    await storage.setJson('sv/v1/notices/dismissed', ['a']);

    const live = jest.fn(() => Promise.resolve<AnnouncementsRead>({ ok: true, rows: [row({ id: 'a' }), row({ id: 'b' })] }));
    const first = new AnnouncementsReader({ storage, read: live });
    await first.refresh();
    expect(first.getSnapshot().notices.map((n) => n.id)).toEqual(['b']);

    const down = jest.fn(() => Promise.resolve<AnnouncementsRead>({ ok: false, reason: 'offline' }));
    const second = new AnnouncementsReader({ storage, read: down });
    await second.refresh();

    // The user's view: the dismissed notice does not reappear, and the list they
    // had keeps working while the service is unreachable.
    expect(second.getSnapshot().notices.map((n) => n.id)).toEqual(['b']);
    expect(await storage.getJson<string[]>('sv/v1/notices/dismissed')).toEqual(['a']);
  });

  it('releases a dismissal for a notice the service no longer returns', async () => {
    const storage = createInMemoryStorage();
    await storage.setJson('sv/v1/notices/dismissed', ['gone', 'kept']);

    const { read } = readsOnce({ ok: true, rows: [row({ id: 'kept' })] });
    const reader = new AnnouncementsReader({ storage, read });
    await reader.refresh();

    // Released while the read succeeded, so the set cannot grow forever. Ids are
    // never reused, so nothing comes back from this.
    expect(await storage.getJson<string[]>('sv/v1/notices/dismissed')).toEqual(['kept']);
  });

  it('ignores an empty id rather than recording a blank dismissal', async () => {
    const { reader, storage } = await readerWith();
    await reader.refresh();

    reader.dismiss('');

    expect(reader.getSnapshot().dismissedCount).toBe(0);
    expect(await storage.getJson<string[]>('sv/v1/notices/dismissed')).toEqual([]);
  });

  it('discards a dismissal list it cannot read', async () => {
    const { reader } = await readerWith({
      result: { ok: true, rows: [row({ id: 'a' })] },
      seed: async (storage) => {
        await storage.setJson('sv/v1/notices/dismissed', { ids: ['a'] });
      },
    });

    await reader.refresh();

    // An unrecognised shape is absent, not coerced: treating the object as a
    // list would hide nothing, and guessing at one would hide the wrong notice.
    expect(reader.getSnapshot().notices.map((n) => n.id)).toEqual(['a']);
  });
});

describe('once it is disposed', () => {
  it('writes no state after the provider is gone', async () => {
    const { reader } = await readerWith({
      result: { ok: true, rows: [row({ id: 'late' })] },
    });

    const before = reader.getSnapshot();
    reader.dispose();
    await reader.refresh();

    // A read that resolves after unmount must not resurrect the screen's list.
    expect(reader.getSnapshot()).toBe(before);
  });
});
