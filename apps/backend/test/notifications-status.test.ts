/**
 * What the public notification-status route is allowed to say.
 *
 * ## Why this file exists
 *
 * `GET /notifications/status` needs no credentials to call, and it used to
 * return `initFirebaseAdmin(config).error` verbatim. On a server where the
 * service-account file is missing, that error reads:
 *
 *     Service account key file not found at: <absolute path>
 *
 * so the route published the layout of the host's filesystem to anyone who
 * asked. `/admin/health` already refuses to forward the same field for the same
 * reason — its comment even notes that a test asserting only on
 * `credentialsPath` would not catch the leak by the other door. This is the
 * other door, and it was open.
 *
 * ## What is asserted
 *
 * Not "the response is shaped as expected" but "no path appears in it". The
 * assertion is on the serialised body, so a future field that happens to carry
 * the path is caught too, rather than only the one known field.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from '../src/config.js';
import { createNotificationRoutes } from '../src/routes/notifications.js';

/**
 * A path that does not exist, so initialisation fails and produces the error
 * this route used to forward. Deliberately a recognisable, absolute path: the
 * assertion looks for this exact string, so a leak cannot pass by reformatting.
 */
const MISSING_CREDENTIALS_PATH = '/tmp/sanket-vaanni-does-not-exist-service-account.json';

function configWith(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    smtp: {
      host: 'smtp.invalid',
      port: 465,
      secure: true,
      from: 'Sanket Vaanni <test@invalid>',
    },
    ...overrides,
  } as AppConfig;
}

describe('GET /notifications/status', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(createNotificationRoutes(configWith()));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 without credentials, which is why the disclosure mattered', async () => {
    const response = await app.inject({ method: 'GET', url: '/notifications/status' });
    expect(response.statusCode).toBe(200);
  });

  it('reports configuration state without claiming delivery', async () => {
    const body = (await app.inject({ method: 'GET', url: '/notifications/status' })).json();

    expect(typeof body.configured).toBe('boolean');
    // A credentials-loaded answer is still not a delivery answer, and the
    // sentence handed back says so in words a reader cannot mistake.
    expect(body.reason).toMatch(/no message has been sent|no push can be sent|not configured/i);
  });

  it('never returns a raw error field', async () => {
    const body = (await app.inject({ method: 'GET', url: '/notifications/status' })).json();
    expect(body).not.toHaveProperty('error');
  });
});

describe('GET /notifications/status when the service-account file is absent', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(
      createNotificationRoutes(
        configWith({ googleApplicationCredentials: MISSING_CREDENTIALS_PATH } as Partial<AppConfig>),
      ),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not disclose the filesystem path it looked in', async () => {
    const response = await app.inject({ method: 'GET', url: '/notifications/status' });
    const raw = response.body;

    expect(raw).not.toContain(MISSING_CREDENTIALS_PATH);
    // The directory is enough on its own to place the deployment, so the check
    // is not limited to the full path.
    expect(raw).not.toContain('/tmp/');
    expect(raw).not.toContain('sanket-vaanni-does-not-exist');
  });

  it('says the file is missing, in a sentence a reader can act on', async () => {
    const body = (await app.inject({ method: 'GET', url: '/notifications/status' })).json();

    expect(body.configured).toBe(false);
    /*
     * The sentence identifies the missing service-account file without naming
     * where the server looked for it, which is the whole point of classifying
     * rather than forwarding. The unconfigured branch names the environment
     * variable; this branch does not, because by the time it is reached the
     * variable is set and the file is what is absent.
     */
    expect(body.reason).toBe(
      'The Firebase service account file named in the configuration is not present on this server, so no push can be sent.',
    );
  });
});
