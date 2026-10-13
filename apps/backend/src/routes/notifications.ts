import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthHook } from '../middleware/auth.js';
import {
  initFirebaseAdmin,
  sendPushNotification,
  sendTopicNotification,
  type NotificationPayload,
} from '../services/firebase.js';

interface SendToTokenBody {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

interface SendToTopicBody {
  topic: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export function createNotificationRoutes(config: AppConfig) {
  const requireAuth = createAuthHook(config);

  return async function notificationRoutes(app: FastifyInstance): Promise<void> {
    // Status check endpoint (monitoring/health)
    app.get('/notifications/status', async (_request: FastifyRequest, reply: FastifyReply) => {
      const status = initFirebaseAdmin(config);
      return reply.status(200).send({
        configured: status.initialized,
        projectId: status.projectId ?? null,
        error: status.error ?? null,
      });
    });

    // Send push notification to a device token (protected)
    app.post<{ Body: SendToTokenBody }>(
      '/notifications/send',
      {
        preHandler: requireAuth,
        schema: {
          body: {
            type: 'object',
            required: ['token', 'title', 'body'],
            properties: {
              token: { type: 'string', minLength: 1 },
              title: { type: 'string', minLength: 1 },
              body: { type: 'string', minLength: 1 },
              data: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
        },
      },
      async (request, reply) => {
        const { token, title, body, data } = request.body;

        try {
          const payload: NotificationPayload = { title, body, data };
          const result = await sendPushNotification(token, payload);
          return reply.status(200).send({
            success: true,
            messageId: result.messageId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          app.log.error({ err }, 'Failed to dispatch push notification');
          return reply.status(502).send({
            success: false,
            error: message,
          });
        }
      },
    );

    // Send push notification to a topic (protected)
    app.post<{ Body: SendToTopicBody }>(
      '/notifications/send-topic',
      {
        preHandler: requireAuth,
        schema: {
          body: {
            type: 'object',
            required: ['topic', 'title', 'body'],
            properties: {
              topic: { type: 'string', minLength: 1 },
              title: { type: 'string', minLength: 1 },
              body: { type: 'string', minLength: 1 },
              data: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
        },
      },
      async (request, reply) => {
        const { topic, title, body, data } = request.body;

        try {
          const payload: NotificationPayload = { title, body, data };
          const result = await sendTopicNotification(topic, payload);
          return reply.status(200).send({
            success: true,
            messageId: result.messageId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          app.log.error({ err }, 'Failed to dispatch topic push notification');
          return reply.status(502).send({
            success: false,
            error: message,
          });
        }
      },
    );
  };
}
