/**
 * Sending a published announcement to the devices that asked for it.
 *
 * ## What is being protected here
 *
 * Not the transport — nothing in this file contacts Firebase. What is tested is
 * every claim the dispatch makes *about* the transport, because those claims are
 * what an administrator will act on:
 *
 *   * that "accepted" is never presented as "delivered";
 *   * that a project with no credentials sends nothing at all, rather than
 *     reporting a wall of failures that reads like a delivery fault;
 *   * that a dead token is removed only when Firebase says it is dead;
 *   * that a token which failed transiently is tried again, and one that failed
 *     permanently is not;
 *   * that a dispatch which could not cover every device *says* so, instead of
 *     reporting a partial count as though it were the whole list.
 *
 * The last one is the quietest failure mode of all: "Attempted 12 devices" is
 * true and reads as complete. The flag exists so it cannot.
 *
 * ## The doubles are named as doubles
 *
 * `send` here is a function this file wrote. It is not Firebase and the tests do
 * not pretend otherwise: `accepted` counts calls *this double* accepted, and the
 * assertions are about the shape of the report, never about a real message
 * reaching a real phone. A real delivery can only be declared after a real
 * authorised send, which no unit test can perform.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  dispatchAnnouncement,
  pushUnavailableReason,
  type DispatchDeps,
  type PushTarget,
} from '../src/announcements/dispatch.js';
import type { AppConfig } from '../src/config.js';
import type { NotificationPayload } from '../src/services/firebase.js';

const CONFIG = { nodeEnv: 'test' } as unknown as AppConfig;

const NOTICE = { id: 'a1', title: 'Clinic closed', body: 'Reopens Monday.', severity: 'warning' };

/** A target list of `count` devices, served in the pages a real query would. */
function devices(count: number): NonNullable<DispatchDeps['listTargets']> {
  return async (limit: number, offset: number) => {
    const size = Math.max(0, Math.min(limit, count - offset));
    const targets: PushTarget[] = Array.from({ length: size }, (_unused, index) => ({
      token: `token-${offset + index}`,
      userId: `user-${offset + index}`,
    }));
    return { targets, error: null };
  };
}

/** Push that is configured, over a given number of devices. */
function configured(count: number, overrides: DispatchDeps = {}): DispatchDeps {
  return {
    pushStatus: () => ({ initialized: true }),
    listTargets: devices(count),
    send: async () => ({ messageId: 'm1' }),
    sleep: async () => {},
    ...overrides,
  };
}

/** An error shaped the way the Firebase client throws one. */
function firebaseError(code: string): Error & { code: string } {
  const error = new Error(`send failed: ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

describe('when push cannot run at all', () => {
  it('sends nothing and says so, rather than trying and reporting failures', () => {
    /*
     * This is the state the project is actually in. The tempting alternative —
     * attempt the sends anyway — produces a report full of refusals, and a
     * report full of refusals is read as "the pushes are failing" when the truth
     * is "push was never set up". The double proves no attempt is made.
     */
    const send = vi.fn(async () => ({ messageId: 'm1' }));

    return dispatchAnnouncement(CONFIG, NOTICE, {
      pushStatus: () => ({ initialized: false, error: 'GOOGLE_APPLICATION_CREDENTIALS is not set.' }),
      listTargets: devices(3),
      send,
    }).then((report) => {
      expect(report.state).toBe('unavailable');
      expect(report.targets).toBe(0);
      expect(report.accepted).toBe(0);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('tells the administrator what to configure', async () => {
    const report = await dispatchAnnouncement(CONFIG, NOTICE, {
      pushStatus: () => ({ initialized: false, error: 'GOOGLE_APPLICATION_CREDENTIALS is not set.' }),
    });

    expect(report.reason).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(report.deliveryConfirmed).toBe(false);
  });

  it('never repeats the service account path the initialisation error carries', () => {
    /*
     * `initFirebaseAdmin` builds its message around the path it looked for, and
     * the health screen already withholds `credentialsPath` on the grounds that
     * the layout of this server is no client's business. Forwarding the error
     * verbatim would hand back the same path inside a different string — which
     * is why the reason is classified rather than copied.
     */
    const leaky = [
      'Service account key file not found at: C:\\secrets\\sanket-service-account.json',
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Configure the path to the service account JSON key in .env.',
      'Failed to initialize Firebase Admin SDK: unable to read C:\\keys\\prod.json',
    ];

    for (const error of leaky) {
      const reason = pushUnavailableReason({ initialized: false, error });
      expect(reason).not.toContain('secrets');
      expect(reason).not.toContain('service-account');
      expect(reason).not.toContain('C:\\');
      expect(reason).not.toContain('.json');
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('has an answer even when the probe gave no reason at all', () => {
    const reason = pushUnavailableReason({ initialized: false });

    expect(reason).toMatch(/not configured/i);
    expect(reason).toMatch(/no push can be sent/i);
  });
});

describe('what the report says about a dispatch that ran', () => {
  it('counts what the transport accepted, and does not call it a delivery', async () => {
    const report = await dispatchAnnouncement(CONFIG, NOTICE, configured(3));

    expect(report.state).toBe('complete');
    expect(report.targets).toBe(3);
    expect(report.accepted).toBe(3);
    expect(report.failed).toBe(0);
    /*
     * The literal, not a variable. `deliveryConfirmed` is typed `false` so that
     * no caller can set it; this asserts the value the screen will read, and the
     * sentence that has to accompany it.
     */
    expect(report.deliveryConfirmed).toBe(false);
    expect(report.summary).toMatch(/not delivery/i);
    expect(report.summary).toMatch(/no message is confirmed to have reached a screen/i);
  });

  it('says plainly when no device is registered, instead of reporting a clean zero', async () => {
    // "Firebase accepted 0" and "there was nobody to send to" are different
    // facts, and only one of them means the announcement never left the server.
    const report = await dispatchAnnouncement(CONFIG, NOTICE, configured(0));

    expect(report.targets).toBe(0);
    expect(report.summary).toMatch(/no device is registered/i);
    expect(report.summary).not.toMatch(/accepted 0/);
  });

  it('carries the announcement id with the message', async () => {
    // A notification whose payload cannot name the notice it came from can only
    // be shown as a copy of it, which is what goes stale.
    const send = vi.fn(async (_token: string, _payload: NotificationPayload) => ({ messageId: 'm1' }));

    await dispatchAnnouncement(CONFIG, NOTICE, configured(1, { send }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      title: 'Clinic closed',
      body: 'Reopens Monday.',
      data: { announcementId: 'a1', severity: 'warning' },
    });
  });
});

describe('how a failing device is handled', () => {
  it('tries again when the transport was only temporarily unable', async () => {
    let attempts = 0;
    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(1, {
        send: async () => {
          attempts += 1;
          if (attempts === 1) throw firebaseError('messaging/server-unavailable');
          return { messageId: 'm1' };
        },
      }),
    );

    expect(attempts).toBe(2);
    expect(report.accepted).toBe(1);
    expect(report.retries).toBe(1);
    expect(report.failed).toBe(0);
  });

  it('gives up after the retries are spent, and counts the device as failed', async () => {
    let attempts = 0;
    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(1, {
        send: async () => {
          attempts += 1;
          throw firebaseError('messaging/internal-error');
        },
      }),
    );

    expect(attempts).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.accepted).toBe(0);
    expect(report.retries).toBe(2);
    expect(report.summary).toMatch(/refused 1/);
  });

  it('does not retry a failure that retrying cannot fix', async () => {
    /*
     * The transport threw for a reason that has nothing to do with the moment:
     * the payload was not one Firebase will accept. Retrying it three times per
     * device turns one malformed request into three times as many as there are
     * devices.
     */
    let attempts = 0;
    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(1, {
        send: async () => {
          attempts += 1;
          throw firebaseError('messaging/invalid-argument');
        },
      }),
    );

    expect(attempts).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.retries).toBe(0);
  });

  it('does not hammer a configuration error that reaches it anyway', async () => {
    // The client reports an uninitialised SDK without a code, which would
    // otherwise read as a network fault and be retried at every device.
    let attempts = 0;
    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(2, {
        send: async () => {
          attempts += 1;
          throw new Error('Firebase Admin SDK is not initialized.');
        },
      }),
    );

    expect(attempts).toBe(2);
    expect(report.failed).toBe(2);
    expect(report.retries).toBe(0);
  });

  it('does not delete a device over a failure that is not about the device', async () => {
    /*
     * The dangerous half of the cleanup. A token is the only way to reach a
     * phone, and deleting one is permanent from this side: the device will not
     * register again until its app next starts. `invalid-argument` can mean the
     * message was too long rather than the token being dead, and a transient
     * error says nothing about the device at all — so neither may cost a user
     * their notifications.
     */
    for (const code of ['messaging/invalid-argument', 'messaging/internal-error']) {
      const forgetToken = vi.fn(async () => {});
      const report = await dispatchAnnouncement(
        CONFIG,
        NOTICE,
        configured(1, {
          send: async () => {
            throw firebaseError(code);
          },
          forgetToken,
        }),
      );

      expect(forgetToken).not.toHaveBeenCalled();
      expect(report.removed).toBe(0);
      expect(report.failed).toBe(1);
    }
  });

  it('removes a token the transport says no longer belongs to a device', async () => {
    const forgetToken = vi.fn(async () => {});
    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(2, {
        send: async (token: string) => {
          if (token === 'token-0') throw firebaseError('messaging/registration-token-not-registered');
          return { messageId: 'm1' };
        },
        forgetToken,
      }),
    );

    expect(forgetToken).toHaveBeenCalledTimes(1);
    expect(forgetToken).toHaveBeenCalledWith('token-0');
    expect(report.removed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.accepted).toBe(1);
    expect(report.summary).toMatch(/no longer belonged to a device/i);
  });

  it('keeps a token whose removal failed, rather than losing it silently', async () => {
    /*
     * A deletion that fails leaves the row in place. Reporting it as removed
     * would make the count disagree with the table, and the next dispatch would
     * find a token this one claimed to have deleted.
     */
    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(1, {
        send: async () => {
          throw firebaseError('messaging/invalid-registration-token');
        },
        forgetToken: async () => {
          throw new Error('delete refused');
        },
      }),
    );

    expect(report.removed).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.targets).toBe(1);
  });

  it('keeps going after one device fails', async () => {
    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(3, {
        send: async (token: string) => {
          if (token === 'token-1') throw firebaseError('messaging/invalid-argument');
          return { messageId: 'm1' };
        },
      }),
    );

    expect(report.targets).toBe(3);
    expect(report.accepted).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.state).toBe('complete');
  });
});

describe('a dispatch that could not cover everyone', () => {
  it('reports that the ceiling stopped it, and says so in the sentence', async () => {
    /*
     * Six hundred devices, a ceiling of five hundred. The count is true and the
     * coverage is not, and an administrator who reads "attempted 500" as
     * "everyone was told" has been misled by an omission rather than by a lie.
     */
    const report = await dispatchAnnouncement(CONFIG, NOTICE, configured(600));

    expect(report.targets).toBe(500);
    expect(report.moreTargets).toBe(true);
    expect(report.state).toBe('partial');
    expect(report.summary).toMatch(/more devices are registered/i);
    expect(report.summary).toMatch(/were not tried/i);
  });

  it('does not raise the ceiling when the list ends exactly at it', async () => {
    // The boundary case: a full last page is not evidence of a further one, so
    // the flag must be decided by asking, not by arithmetic.
    const report = await dispatchAnnouncement(CONFIG, NOTICE, configured(500));

    expect(report.targets).toBe(500);
    expect(report.moreTargets).toBe(false);
    expect(report.state).toBe('complete');
  });

  it('starts the sentence with the reason, so a partial count cannot read as a whole one', async () => {
    const report = await dispatchAnnouncement(CONFIG, NOTICE, configured(600));

    expect(report.summary.startsWith('More devices are registered')).toBe(true);
  });

  it('stops when the list of devices cannot be read, and says that is why', async () => {
    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(4, {
        listTargets: async () => ({ targets: [], error: 'permission denied for table device_push_tokens' }),
      }),
    );

    expect(report.state).toBe('partial');
    expect(report.targets).toBe(0);
    expect(report.reason).toContain('permission denied');
    expect(report.summary).toContain('permission denied');
    // Not the ceiling: there are four devices, and the read is what failed.
    expect(report.moreTargets).toBe(false);
    expect(report.summary).not.toMatch(/more devices are registered/i);
  });

  it('stops when the time budget runs out, with devices still unvisited', async () => {
    let clock = 0;
    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(5, {
        now: () => (clock += 30_000),
        listTargets: devices(5),
      }),
    );

    expect(report.state).toBe('partial');
    expect(report.targets).toBeLessThan(5);
    expect(report.summary).toMatch(/budget/i);
    /*
     * And it must not fall back to the empty-list sentence. There are five
     * devices; the dispatch simply never reached the list. "No device is
     * registered" would be a claim about the table made from a read that never
     * happened, and it is the sentence a reader is most likely to believe.
     */
    expect(report.summary).not.toMatch(/no device is registered/i);
    expect(report.summary).toMatch(/no device was attempted/i);
  });
});

describe('reading the device list', () => {
  it('walks every page rather than stopping at the first', async () => {
    // Two hundred and one devices: one full page and one short one. A dispatch
    // that read only the first page would report 200 of 201 and call it complete.
    const report = await dispatchAnnouncement(CONFIG, NOTICE, configured(201));

    expect(report.targets).toBe(201);
    expect(report.accepted).toBe(201);
    expect(report.moreTargets).toBe(false);
  });

  it('never sends to a row whose token could not be read', async () => {
    // A last guard behind the column's own constraints: sending to `undefined`
    // would burn an attempt and, on a permanent failure, delete the row.
    const send = vi.fn(async () => ({ messageId: 'm1' }));

    const report = await dispatchAnnouncement(
      CONFIG,
      NOTICE,
      configured(1, {
        listTargets: async () => ({ targets: [], error: null }),
        send,
      }),
    );

    expect(send).not.toHaveBeenCalled();
    expect(report.targets).toBe(0);
  });
});
