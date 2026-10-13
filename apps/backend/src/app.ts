import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { rootRoutes } from './routes/root.js';
import { createNotificationRoutes } from './routes/notifications.js';
import { createEmailRoutes } from './routes/email.js';
import { createAdminRoutes } from './routes/admin.js';
import { adminApiAvailability } from './middleware/requireAdmin.js';
import { initFirebaseAdmin } from './services/firebase.js';
import { initEmailService, isEmailConfigured } from './services/email.js';

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

  if (!isTest) {
    // Safe one-time initialization attempt of Firebase Admin
    const fbStatus = initFirebaseAdmin(config);
    if (fbStatus.initialized) {
      app.log.info({ projectId: fbStatus.projectId }, 'Firebase Admin SDK initialized successfully');
    } else {
      app.log.warn({ reason: fbStatus.error }, 'Firebase Admin SDK running in unconfigured mode');
    }

    // Safe initialization of Nodemailer SMTP service
    initEmailService(config.smtp);
    if (isEmailConfigured()) {
      app.log.info({ sender: config.smtp.from }, 'Nodemailer Gmail SMTP service initialized');
    } else {
      app.log.warn('Nodemailer SMTP running in unconfigured mode (SMTP_PASS not provided)');
    }
  }

  app.register(healthRoutes);
  app.register(rootRoutes);
  app.register(createNotificationRoutes(config));
  app.register(createEmailRoutes(config));

  /*
   * The administration API.
   *
   * It registers unconditionally and decides per request whether it can run:
   * with no Supabase credentials `createRequireAdmin` answers 503 and names the
   * missing variables. Registering it only when configured would make a
   * misconfigured deployment return "404 no such route" — which reads as a
   * missing feature rather than a missing setting, and sends whoever is
   * debugging it in the wrong direction.
   */
  app.register(createAdminRoutes(config));

  const adminStatus = adminApiAvailability(config);
  if (!isTest) {
    if (adminStatus.available) {
      app.log.info('Administration API enabled');
    } else {
      // The reason names variables, never values. See `adminApiAvailability`.
      app.log.warn(adminStatus.reason, 'Administration API disabled');
    }
  }

  return app;
}
