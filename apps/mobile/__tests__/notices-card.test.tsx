/**
 * The notices card, rendered.
 *
 * ## What only a render can check
 *
 * The reader's tests pin down which notices exist and what the state means. What
 * they cannot check is the two things this card is *for*: that a failure is
 * visible, and that the sentence stating the limits of a notice is actually on
 * screen. Both are claims the interface makes to a user, so both are asserted
 * against the rendered tree rather than against the data behind it.
 *
 * `renderThemed` is used rather than the whole app: this component's content is
 * decided entirely by its props, and rendering the app would put a live Supabase
 * read between the test and the thing it is testing.
 */
import React from 'react';

import { pressByLabel, renderedText, renderThemed, teardown } from './support';
import { NoticesCard } from '../src/components/NoticesCard';
import type { AnnouncementsState, Notice } from '../src/announcements';

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
    id: 'n1',
    title: 'Service window tonight',
    body: 'Recognition will be paused from 22:00 while the database is upgraded.',
    severity: 'critical',
    publishedAt: '2026-06-01T09:00:00.000Z',
    expiresAt: null,
    ...over,
  };
}

describe('the notices card', () => {
  it('draws nothing at all when a completed read found nothing', async () => {
    const renderer = await renderThemed(
      <NoticesCard state={state()} onDismiss={() => undefined} onRetry={() => undefined} />,
    );

    // Not an empty card: on Settings, a card that says nothing and no card at all
    // are the same to a reader, and an empty one on every visit is noise.
    expect(renderer.toJSON()).toBeNull();
    await teardown(renderer);
  });

  it('renders a notice with its severity, its text and a dismiss control', async () => {
    const dismissed: string[] = [];
    const renderer = await renderThemed(
      <NoticesCard
        state={state({ notices: [notice()] })}
        onDismiss={(id) => dismissed.push(id)}
        onRetry={() => undefined}
      />,
    );

    const text = renderedText(renderer);
    expect(text).toContain('Notices');
    expect(text).toContain('Critical');
    expect(text).toContain('Service window tonight');
    expect(text).toContain('Recognition will be paused from 22:00');

    await pressByLabel(renderer, 'Dismiss notice Service window tonight');
    expect(dismissed).toEqual(['n1']);

    await teardown(renderer);
  });

  it('states that nothing is pushed and that dismissing is local', async () => {
    /*
     * The two things a user would otherwise assume wrongly: that a critical
     * notice also arrived as a notification, and that dismissing it removes it
     * for everyone. Neither is true, so neither may be left to inference.
     */
    const renderer = await renderThemed(
      <NoticesCard
        state={state({ notices: [notice()] })}
        onDismiss={() => undefined}
        onRetry={() => undefined}
      />,
    );

    const text = renderedText(renderer);
    expect(text).toContain('Shown in the app only');
    expect(text).toContain('nothing is sent to your phone');
    expect(text).toContain('for you alone');

    await teardown(renderer);
  });

  it('shows a failed check even with nothing cached, and offers a retry', async () => {
    let retries = 0;
    const renderer = await renderThemed(
      <NoticesCard
        state={state({
          status: 'unreadable',
          reason: 'permission denied for table announcements',
          notices: [],
          fromCache: false,
        })}
        onDismiss={() => undefined}
        onRetry={() => {
          retries += 1;
        }}
      />,
    );

    const text = renderedText(renderer);
    // The failure is visible, and carries the service's own words: they name the
    // grant that is missing.
    expect(text).toContain('could not be checked');
    expect(text).toContain('permission denied for table announcements');
    // It must not read as "there are no notices".
    expect(text).not.toContain('Shown in the app only');

    await pressByLabel(renderer, 'Try again');
    expect(retries).toBe(1);

    await teardown(renderer);
  });

  it('says the list is stale when it is showing the last cached copy', async () => {
    const renderer = await renderThemed(
      <NoticesCard
        state={state({
          status: 'unreadable',
          reason: 'offline',
          notices: [notice()],
          fromCache: true,
        })}
        onDismiss={() => undefined}
        onRetry={() => undefined}
      />,
    );

    const text = renderedText(renderer);
    expect(text).toContain('the last list this phone read');
    // Still shows the notice it has, rather than dropping to an error screen.
    expect(text).toContain('Service window tonight');

    await teardown(renderer);
  });

  it('does not promise a list when the cached one has nothing left in it', async () => {
    /*
     * Observed on a real device against a project whose schema lacks the
     * announcements table: the first failure had no cache and said "Notices
     * could not be checked", and the retry — by then holding a cached list whose
     * entries had all expired — said "so this is the last list this phone read"
     * above an empty card. True, and still an introduction to a list that never
     * arrives.
     */
    const renderer = await renderThemed(
      <NoticesCard
        state={state({
          status: 'unreadable',
          reason: 'Could not find the table public.announcements',
          notices: [],
          fromCache: true,
        })}
        onDismiss={() => undefined}
        onRetry={() => undefined}
      />,
    );

    const text = renderedText(renderer);
    expect(text).not.toContain('this is the last list this phone read');
    expect(text).toContain('nothing from the last list is still live');
    // The retry still has to be there: the failure is the same either way.
    expect(text).toContain('Try again');

    await teardown(renderer);
  });

  it('says it is checking without claiming there is nothing', async () => {
    const renderer = await renderThemed(
      <NoticesCard
        state={state({ status: 'loading' })}
        onDismiss={() => undefined}
        onRetry={() => undefined}
      />,
    );

    const text = renderedText(renderer);
    expect(text).toContain('Checking for notices');

    await teardown(renderer);
  });
});
