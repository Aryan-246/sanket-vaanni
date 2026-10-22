import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { SERVICE_NAME, SERVICE_VERSION } from '../src/version.js';

const testConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  // A complete `smtp` block, and deliberately a useless one. `AppConfig` requires
  // it, and the test suite must never be the thing that reaches a real mail
  // server: `buildApp` skips email initialisation entirely under `nodeEnv:
  // 'test'`, and these values would fail to connect anyway.
  smtp: {
    host: 'smtp.invalid',
    port: 465,
    secure: true,
    from: 'Sanket Vaanni <test@invalid>',
  },
  emailProvider: 'smtp',
  brevoEndpoint: 'https://api.brevo.com/v3',
};

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(testConfig);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responds 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('reports service identity and an ok status', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = response.json();

    expect(body.status).toBe('ok');
    expect(body.service).toBe(SERVICE_NAME);
    expect(body.version).toBe(SERVICE_VERSION);
  });

  it('reports a non-negative integer uptime', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const { uptimeSeconds } = response.json();

    expect(Number.isInteger(uptimeSeconds)).toBe(true);
    expect(uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports an ISO-8601 timestamp', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const { timestamp } = response.json();

    expect(typeof timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
    // Round-tripping proves it is a full ISO-8601 instant, not a partial date.
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  it('does not claim capabilities that do not exist yet', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = response.json();

    // Guards against a future contributor optimistically adding fields for
    // hardware that is not integrated. There is no BLE, database or model yet.
    expect(body).not.toHaveProperty('ble');
    expect(body).not.toHaveProperty('database');
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('gloves');
  });
});

describe('GET /', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(testConfig);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('describes the service and points at /health', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.service).toBe(SERVICE_NAME);
    expect(body.endpoints.health).toBe('/health');
  });
});

describe('unknown routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(testConfig);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 404 for a path that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });
});
