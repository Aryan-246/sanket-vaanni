import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { rootRoutes } from './routes/root.js';

/**
 * Builds a configured Fastify instance without starting it.
 *
 * Separated from `server.ts` so tests can drive the app via `app.inject()`
 * without binding a port.
 */
export function buildApp(config: AppConfig): FastifyInstance {
  const isTest = config.nodeEnv === 'test';

  const app = Fastify({
    // `logger: false` already suppresses request logging, so the deprecated
    // top-level `disableRequestLogging` option is not needed (Fastify 5.12
    // warns about it; it is removed in v6).
    logger: isTest ? false : { level: config.logLevel },
  });

  app.register(healthRoutes);
  app.register(rootRoutes);

  return app;
}
