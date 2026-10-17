import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { rootRoutes } from './routes/root.js';
import { createNotificationRoutes } from './routes/notifications.js';
import { createEmailRoutes } from './routes/email.js';
import { createAdminRoutes } from './routes/admin.js';
import { createAccountRoutes, type AccountRouteDeps } from './routes/account.js';
import { createTeamRoutes, type TeamRouteDeps } from './routes/team.js';
import { adminApiAvailability } from './middleware/requireAdmin.js';
import {
  createMaintenanceGate,
  createMaintenanceReader,
  type MaintenanceReader,
} from './maintenance/gate.js';
import { initFirebaseAdmin } from './services/firebase.js';
import { initEmailService, isEmailConfigured } from './services/email.js';

/**
 * Builds a configured Fastify instance without starting it.
 *
 * Separated from `server.ts` so tests can drive the app via `app.inject()`
 * without binding a port.
 *
 * `deps.maintenanceReader` exists so a test can put the real app into
 * maintenance mode without a database. Without it, the only way to test that
 * this file installs the gate at all would be to reach a live Supabase, and the
 * wiring would in practice go untested — which is how a gate ends up registered
 * nowhere while its own unit tests stay green.
 */
export function buildApp(
  config: AppConfig,
  deps: {
    maintenanceReader?: MaintenanceReader;
    account?: AccountRouteDeps;
    team?: TeamRouteDeps;
  } = {},
): FastifyInstance {
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

  /*
   * Maintenance mode, checked before anything else.
   *
   * A root hook rather than a per-route one, because a gate that has to be
   * remembered on each new route is a gate that will eventually be forgotten on
   * one. It carries its own explicit exemption list — admin recovery, health and
   * the status endpoints — because the alternative, exempting by failing to
   * register the hook, is the same forgetting problem in a different costume.
   *
   * What this can and cannot cover, and why an unreadable setting does not close
   * the service, is documented in `./maintenance/gate.ts`.
   */
  app.addHook(
    'onRequest',
    createMaintenanceGate(deps.maintenanceReader ?? createMaintenanceReader(config)),
  );

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

  /*
   * Ordinary-account routes. Like the admin API they register unconditionally
   * and answer 503 when Supabase is not configured, so a missing setting is
   * distinguishable from a missing route.
   *
   * The OTP-confirmed deletion flow lives here; the database side is
   * `20261017000000_account_security_team.sql`.
   */
  app.register(createAccountRoutes(config, deps.account));

  /*
   * Team / About content: a public read plus administrator writes. Registered
   * separately from the admin plugin because it is self-contained; it still
   * uses the same `requireAdmin` guard and audit pair.
   */
  app.register(createTeamRoutes(config, deps.team));

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
