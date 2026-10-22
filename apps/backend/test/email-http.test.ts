import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
  emailProviderInUse,
  initEmailService,
  isEmailConfigured,
  parseSender,
  sendTransactionalEmail,
  verifyEmailConnection,
} from '../src/services/email.js';

/**
 * These tests exercise the Brevo transport against a real local HTTP server.
 * Nothing here mocks the service under test: the code makes the same fetch
 * calls it makes in production, and the assertions are on the bytes that
 * arrive at the other end.
 */

interface Captured {
  method: string;
  url: string;
  apiKey: string | undefined;
  body: string;
}

let server: Server;
let endpoint: string;
let captured: Captured[] = [];
let respond: (request: Captured, response: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      const record: Captured = {
        method: request.method ?? '',
        url: request.url ?? '',
        apiKey: typeof request.headers['api-key'] === 'string' ? request.headers['api-key'] : undefined,
        body,
      };
      captured.push(record);
      respond(record, response);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${port}/v3`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  captured = [];
  respond = (_request, response) => {
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ messageId: 'brevo-message-1' }));
  };

  initEmailService({
    smtp: {
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      user: 'sanketvaanni.auth@gmail.com',
      pass: 'unused-for-this-path',
      from: 'Sanket Vaanni <sanketvaanni.auth@gmail.com>',
    },
    provider: 'brevo',
    brevoApiKey: 'test-key-not-a-real-secret',
    brevoEndpoint: endpoint,
  });
});

describe('Brevo HTTP delivery', () => {
  it('posts the message to /smtp/email with the key header and provider fields', async () => {
    const result = await sendTransactionalEmail({
      to: 'person@example.test',
      subject: 'Hello',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      replyTo: 'support@example.test',
    });

    expect(result.accepted).toBe(true);
    expect(result.messageId).toBe('brevo-message-1');
    expect(captured).toHaveLength(1);

    const request = captured[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v3/smtp/email');
    expect(request.apiKey).toBe('test-key-not-a-real-secret');

    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.sender).toEqual({
      name: 'Sanket Vaanni',
      email: 'sanketvaanni.auth@gmail.com',
    });
    expect(body.to).toEqual([{ email: 'person@example.test' }]);
    expect(body.subject).toBe('Hello');
    expect(body.textContent).toBe('Plain body');
    expect(body.htmlContent).toBe('<p>HTML body</p>');
    expect(body.replyTo).toEqual({ email: 'support@example.test' });
  });

  it('reports a provider refusal without leaking the API key', async () => {
    respond = (_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'invalid_parameter', message: 'Sender is not verified' }));
    };

    const result = await sendTransactionalEmail({
      to: 'person@example.test',
      subject: 'Hello',
      text: 'Plain body',
      html: '<p>HTML body</p>',
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('HTTP 400');
    expect(result.error).toContain('Sender is not verified');
    expect(result.error).not.toContain('test-key-not-a-real-secret');
  });

  it('treats a network failure as a failed send, not a success', async () => {
    initEmailService({
      smtp: {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        from: 'Sanket Vaanni <sanketvaanni.auth@gmail.com>',
      },
      provider: 'brevo',
      brevoApiKey: 'test-key-not-a-real-secret',
      // Port 1 on loopback refuses immediately.
      brevoEndpoint: 'http://127.0.0.1:1/v3',
    });

    const result = await sendTransactionalEmail({
      to: 'person@example.test',
      subject: 'Hello',
      text: 'Plain body',
      html: '<p>HTML body</p>',
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain('test-key-not-a-real-secret');
  });
});

describe('Brevo connectivity check', () => {
  it('proves the key with a read-only account call', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ email: 'sanketvaanni.auth@gmail.com' }));
    };

    await expect(verifyEmailConnection()).resolves.toEqual({ connected: true });
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.url).toBe('/v3/account');
    expect(captured[0]!.apiKey).toBe('test-key-not-a-real-secret');
  });

  it('reports a rejected key without echoing it', async () => {
    respond = (_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Key not found' }));
    };

    const status = await verifyEmailConnection();

    expect(status.connected).toBe(false);
    expect(status.error).toContain('HTTP 401');
    expect(status.error).not.toContain('test-key-not-a-real-secret');
  });
});

describe('provider selection', () => {
  it('is explicitly unconfigured when Brevo is selected without a key', async () => {
    initEmailService({
      smtp: {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        pass: 'a-working-smtp-password',
        from: 'Sanket Vaanni <sanketvaanni.auth@gmail.com>',
      },
      provider: 'brevo',
      brevoApiKey: undefined,
      brevoEndpoint: endpoint,
    });

    expect(isEmailConfigured()).toBe(false);
    expect(emailProviderInUse()).toBeNull();

    const result = await sendTransactionalEmail({
      to: 'person@example.test',
      subject: 'Hello',
      text: 'Plain body',
      html: '<p>HTML body</p>',
    });

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('BREVO_API_KEY');
    // The SMTP password in the same environment must not be used silently.
    expect(captured).toHaveLength(0);
  });
});

describe('parseSender', () => {
  it('splits a display name from an address', () => {
    expect(parseSender('Sanket Vaanni <sanketvaanni.auth@gmail.com>')).toEqual({
      name: 'Sanket Vaanni',
      email: 'sanketvaanni.auth@gmail.com',
    });
  });

  it('accepts a bare address', () => {
    expect(parseSender('sanketvaanni@gmail.com')).toEqual({ email: 'sanketvaanni@gmail.com' });
  });
});

describe('configuration', () => {
  it('defaults to SMTP so an existing deployment keeps its behaviour', () => {
    const config = loadConfig({});
    expect(config.emailProvider).toBe('smtp');
    expect(config.brevoApiKey).toBeUndefined();
    expect(config.brevoEndpoint).toBe('https://api.brevo.com/v3');
  });

  it('accepts the Brevo selector', () => {
    const config = loadConfig({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: '  ' });
    expect(config.emailProvider).toBe('brevo');
    expect(config.brevoApiKey).toBeUndefined();
  });

  it('refuses an unknown provider instead of guessing', () => {
    expect(() => loadConfig({ EMAIL_PROVIDER: 'sendgrid' })).toThrow(/EMAIL_PROVIDER/);
  });
});
