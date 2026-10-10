import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when the environment is empty', () => {
    const config = loadConfig({});

    expect(config.nodeEnv).toBe('development');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4000);
    expect(config.logLevel).toBe('info');
  });

  it('reads values from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '8080',
      LOG_LEVEL: 'warn',
    });

    expect(config.nodeEnv).toBe('production');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('warn');
  });

  it('trims surrounding whitespace', () => {
    const config = loadConfig({ HOST: '  0.0.0.0  ', PORT: ' 5000 ' });

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(5000);
  });

  it('treats blank values as absent', () => {
    const config = loadConfig({ HOST: '   ', LOG_LEVEL: '' });

    expect(config.host).toBe('127.0.0.1');
    expect(config.logLevel).toBe('info');
  });

  describe('rejects invalid input', () => {
    it.each([
      ['non-numeric port', { PORT: 'not-a-number' }],
      ['port below range', { PORT: '0' }],
      ['port above range', { PORT: '70000' }],
      ['fractional port', { PORT: '40.5' }],
      ['unknown NODE_ENV', { NODE_ENV: 'staging' }],
    ])('%s', (_label, env) => {
      expect(() => loadConfig(env)).toThrow(ConfigError);
    });
  });

  it('does not fall back to a default port on invalid input', () => {
    // A silent fallback would start the service on a port the operator did not
    // ask for, which is worse than refusing to start.
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });

  it('never reads from process.env when an environment is supplied', () => {
    const config = loadConfig({ PORT: '1234' });
    expect(config.port).toBe(1234);
  });
});
