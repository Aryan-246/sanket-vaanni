/**
 * Maintenance mode as a gate, not a display choice.
 *
 * The property under test is not "the setting can be read" — it is that a
 * request reaching this service while the app is closed is *refused*, and that
 * the refusals stop at the paths which must keep working. Both halves matter:
 * a gate with no exemptions cannot be turned off, and a gate that exempts too
 * much is not a gate.
 *
 * The reader is injected rather than mocked, so each case states the stored
 * setting exactly, including the states that are easy to get wrong — a
 * malformed row, and a row that cannot be read at all.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import {
  createMaintenanceGate,
  parseMaintenanceRow,
  type MaintenanceReader,
} from '../src/maintenance/gate.js';

/** An app with one gated route and the exempt ones the gate must recognise. */
async function appWith(read: MaintenanceReader) {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', createMaintenanceGate(read));

  app.get('/email/status', async () => ({ ok: 'status' }));
  app.get('/notifications/status', async () => ({ ok: 'status' }));
  app.get('/health', async () => ({ ok: 'health' }));
  app.get('/', async () => ({ ok: 'root' }));
  app.post('/email/welcome', async () => ({ ok: 'welcome' }));
  app.post('/notifications/send-to-token', async () => ({ ok: 'push' }));
  app.get('/admin/users', async () => ({ ok: 'admin' }));
  app.post('/admin/maintenance', async () => ({ ok: 'recovery' }));

  await app.ready();
  return app;
}

const closed = (message = 'A database migration is running.'): MaintenanceReader => async () => ({
  enabled: true,
  message,
});

const open: MaintenanceReader = async () => ({ enabled: false, message: '' });

describe('while maintenance mode is on', () => {
  it('refuses a protected request with the administrator’s own words', async () => {
    const app = await appWith(closed());
    const response = await app.inject({ method: 'POST', url: '/notifications/send-to-token' });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    // The message is passed through, not replaced with a generic one: it is the
    // only explanation the user will get.
    expect(body.error).toBe('A database migration is running.');
    expect(body.maintenance).toBe(true);

    await app.close();
  });

  it('still refuses a request that carries a valid internal secret', async () => {
    /*
     * The gate runs before authentication and does not care who is calling.
     * Maintenance is a property of the service, not of the caller, so a correct
     * shared secret must not be a way past it.
     */
    const app = await appWith(closed());
    const response = await app.inject({
      method: 'POST',
      url: '/email/welcome',
      headers: { authorization: 'Bearer internal-secret-that-would-otherwise-work' },
    });

    expect(response.statusCode).toBe(503);

    await app.close();
  });

  it('falls back to a stated reason when the administrator left the message empty', async () => {
    // A blank message must not produce a blank error: an unexplained refusal
    // reads as a broken service.
    const app = await appWith(async () => ({ enabled: true, message: '' }));
    const response = await app.inject({ method: 'POST', url: '/email/welcome' });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('Sanket Vaanni is briefly unavailable.');

    await app.close();
  });

  it('lets the administration API through, so it can be turned off again', async () => {
    /*
     * The single most important exemption. If maintenance blocked the admin API,
     * the only way out would be editing the database by hand, and a mode that
     * cannot be exited from the product is a trap rather than a feature.
     */
    const app = await appWith(closed());
    const write = await app.inject({ method: 'POST', url: '/admin/maintenance' });
    const read = await app.inject({ method: 'GET', url: '/admin/users' });

    expect(write.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);

    await app.close();
  });

  it('keeps the health and status endpoints answering', async () => {
    // Whoever is debugging a closed app must be able to ask whether the service
    // itself is up, and must not be answered by the maintenance refusal.
    const app = await appWith(closed());

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/email/status' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/notifications/status' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);

    await app.close();
  });
});

describe('while maintenance mode is off', () => {
  it('lets everything through', async () => {
    const app = await appWith(open);

    expect((await app.inject({ method: 'POST', url: '/email/welcome' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/notifications/send-to-token' })).statusCode).toBe(200);

    await app.close();
  });
});

describe('when the setting cannot be read', () => {
  it('allows the request rather than reporting an outage nobody declared', async () => {
    /*
     * The deliberate failure direction. Answering 503 here would announce a
     * maintenance window that may not exist — inventing operational status — and
     * turn a transient read failure into a self-inflicted outage. Allowing it
     * means a real window can leak a request; that is the lesser cost, and it is
     * logged.
     */
    const app = await appWith(async () => null);
    const response = await app.inject({ method: 'POST', url: '/email/welcome' });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it('treats a reader that throws the same way, and says so loudly', async () => {
    const logged: unknown[] = [];
    const app = Fastify({ logger: false });
    /*
     * The capture hook is registered first, because hooks run in the order they
     * are added. Registering it second would mean it replaced `request.log`
     * after the gate had already logged through the original — a spy that
     * observes nothing while appearing to work.
     */
    app.addHook('onRequest', async (request) => {
      request.log.error = (...args: unknown[]) => logged.push(args);
      request.log.warn = (...args: unknown[]) => logged.push(args);
    });
    app.addHook(
      'onRequest',
      createMaintenanceGate(async () => {
        throw new Error('connection refused');
      }),
    );
    app.post('/email/welcome', async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/email/welcome' });

    expect(response.statusCode).toBe(200);
    // Allowed, but not silently: an unenforced window must be visible.
    expect(logged.length).toBeGreaterThan(0);

    await app.close();
  });

  it('does not treat a row that is not a setting as a closed app', async () => {
    /*
     * A stored string "false" is truthy in JavaScript. Reading it as "closed"
     * would take the whole service down over one bad row, so `enabled` is
     * compared to `true` rather than coerced.
     */
    const app = await appWith(async () => parseMaintenanceRow({ enabled: 'false', message: '' }));
    expect((await app.inject({ method: 'POST', url: '/email/welcome' })).statusCode).toBe(200);

    await app.close();
  });
});

/**
 * How a stored row becomes a setting.
 *
 * Tested directly, because it is the part an injected reader hides: a test that
 * hands the gate `{enabled: false}` is describing its own object rather than the
 * conversion, and would keep passing if the coercion were wrong.
 */
describe('reading a stored maintenance row', () => {
  it('reads the enabled flag as a boolean, not as whatever was stored', () => {
    // The one that matters. `'false'` is truthy; a truthy check here reports the
    // whole service closed because of one malformed value.
    expect(parseMaintenanceRow({ enabled: 'false', message: '' })).toEqual({
      enabled: false,
      message: '',
    });
    expect(parseMaintenanceRow({ enabled: 'true', message: '' })).toEqual({
      enabled: false,
      message: '',
    });
    expect(parseMaintenanceRow({ enabled: 1, message: '' })).toEqual({ enabled: false, message: '' });
    expect(parseMaintenanceRow({ enabled: true, message: '' })).toEqual({ enabled: true, message: '' });
  });

  it('treats anything that is not an object as no setting at all', () => {
    expect(parseMaintenanceRow(null)).toBeNull();
    expect(parseMaintenanceRow(undefined)).toBeNull();
    expect(parseMaintenanceRow('closed')).toBeNull();
    expect(parseMaintenanceRow([])).not.toBeNull();
  });

  it('replaces a message that is not a string with an empty one', () => {
    // The gate already substitutes a fallback for an empty message, so an
    // object here would otherwise reach the client as a JSON blob.
    expect(parseMaintenanceRow({ enabled: true, message: 42 })?.message).toBe('');
    expect(parseMaintenanceRow({ enabled: true })?.message).toBe('');
  });
});

/**
 * The tests above build their own app, so on their own they prove the gate works
 * and say nothing about whether the service installs it. A gate that is
 * registered nowhere passes every one of them.
 *
 * These cases drive the real `buildApp`, with the reader injected as the only
 * substitution. The routes and their paths are the ones the service actually
 * serves, so a rename or a re-registration that drops the hook is caught here.
 */
const testConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  smtp: { host: 'smtp.invalid', port: 465, secure: true, from: 'Sanket Vaanni <test@invalid>' },
  emailProvider: 'smtp',
  brevoEndpoint: 'https://api.brevo.com/v3',
};

describe('in the service that is actually started', () => {
  it('refuses a real protected route while maintenance mode is on', async () => {
    const app = buildApp(testConfig, { maintenanceReader: closed() });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/notifications/send' });

    expect(response.statusCode).toBe(503);
    expect(response.json().maintenance).toBe(true);
    expect(response.json().error).toBe('A database migration is running.');

    await app.close();
  });

  it('leaves the admin API reachable so the mode can be turned off', async () => {
    /*
     * The admin API refuses here too — it has no Supabase credentials in this
     * configuration and fails closed — but for its own reason. What is asserted
     * is that the refusal did not come from the gate: `maintenance` is the
     * marker the gate adds, and its absence is what distinguishes "the admin API
     * says it is unconfigured" from "the admin API is behind the closed door".
     */
    const app = buildApp(testConfig, { maintenanceReader: closed() });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/admin/maintenance' });

    expect(response.json().maintenance).toBeUndefined();
    expect(response.json().error).toMatch(/configured/i);

    await app.close();
  });

  it('lets protected routes through when the setting says the app is open', async () => {
    const app = buildApp(testConfig, { maintenanceReader: open });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/notifications/send' });

    // Not a success — there is no internal secret configured — but whatever it
    // is, it is not the maintenance refusal.
    expect(response.json().maintenance).toBeUndefined();

    await app.close();
  });
});
