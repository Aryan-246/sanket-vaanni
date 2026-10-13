import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthHook } from '../middleware/auth.js';
import {
  initEmailService,
  isEmailConfigured,
  verifySmtpConnection,
  sendTransactionalEmail,
  sendSecurityAlertEmail,
  sendWelcomeOnboardingEmail,
} from '../services/email.js';

interface SecurityAlertBody {
  to: string;
  eventType: string;
  description: string;
  userAgentOrDevice?: string;
}

interface WelcomeEmailBody {
  to: string;
  userName?: string;
}

interface GenericEmailBody {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

export function createEmailRoutes(config: AppConfig) {
  const requireAuth = createAuthHook(config);

  return async function emailRoutes(app: FastifyInstance): Promise<void> {
    // Check SMTP service status and connectivity (never prints secrets)
    app.get('/email/status', async (_request: FastifyRequest, reply: FastifyReply) => {
      const configured = isEmailConfigured();
      let connectionStatus: { connected: boolean; error?: string } = { connected: false };

      if (configured) {
        connectionStatus = await verifySmtpConnection();
      }

      return reply.status(200).send({
        configured,
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        sender: config.smtp.from,
        connected: connectionStatus.connected,
        error: connectionStatus.error ?? null,
      });
    });

    // Send Security Alert Email (protected)
    app.post<{ Body: SecurityAlertBody }>(
      '/email/send-security-alert',
      {
        preHandler: requireAuth,
        schema: {
          body: {
            type: 'object',
            required: ['to', 'eventType', 'description'],
            properties: {
              to: { type: 'string', minLength: 3 },
              eventType: { type: 'string', minLength: 1 },
              description: { type: 'string', minLength: 1 },
              userAgentOrDevice: { type: 'string' },
            },
          },
        },
      },
      async (request, reply) => {
        const { to, eventType, description, userAgentOrDevice } = request.body;

        const result = await sendSecurityAlertEmail(to, {
          eventType,
          description,
          userAgentOrDevice,
        });

        if (!result.accepted) {
          app.log.error({ to, eventType, error: result.error }, 'Failed to send security alert email');
          return reply.status(502).send({
            success: false,
            error: result.error ?? 'Email delivery failed',
          });
        }

        return reply.status(200).send({
          success: true,
          messageId: result.messageId,
        });
      },
    );

    // Send Onboarding Welcome Email (protected)
    app.post<{ Body: WelcomeEmailBody }>(
      '/email/send-welcome',
      {
        preHandler: requireAuth,
        schema: {
          body: {
            type: 'object',
            required: ['to'],
            properties: {
              to: { type: 'string', minLength: 3 },
              userName: { type: 'string' },
            },
          },
        },
      },
      async (request, reply) => {
        const { to, userName } = request.body;

        const result = await sendWelcomeOnboardingEmail(to, userName);

        if (!result.accepted) {
          app.log.error({ to, error: result.error }, 'Failed to send welcome email');
          return reply.status(502).send({
            success: false,
            error: result.error ?? 'Email delivery failed',
          });
        }

        return reply.status(200).send({
          success: true,
          messageId: result.messageId,
        });
      },
    );

    // Send generic transactional email (protected)
    app.post<{ Body: GenericEmailBody }>(
      '/email/send',
      {
        preHandler: requireAuth,
        schema: {
          body: {
            type: 'object',
            required: ['to', 'subject', 'text', 'html'],
            properties: {
              to: { type: 'string', minLength: 3 },
              subject: { type: 'string', minLength: 1 },
              text: { type: 'string', minLength: 1 },
              html: { type: 'string', minLength: 1 },
              replyTo: { type: 'string' },
            },
          },
        },
      },
      async (request, reply) => {
        const result = await sendTransactionalEmail(request.body);

        if (!result.accepted) {
          app.log.error({ to: request.body.to, error: result.error }, 'Failed to deliver transactional email');
          return reply.status(502).send({
            success: false,
            error: result.error ?? 'Email delivery failed',
          });
        }

        return reply.status(200).send({
          success: true,
          messageId: result.messageId,
        });
      },
    );
  };
}
