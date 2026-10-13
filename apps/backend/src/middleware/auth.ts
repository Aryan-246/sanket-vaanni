import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';

/**
 * Creates an authorization preHandler hook to protect privileged dispatch routes
 * (push notifications, transactional emails) from unauthenticated external invocation.
 */
export function createAuthHook(config: AppConfig) {
  return async function requireInternalAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const internalSecret = config.apiInternalSecret;

    // In production, an internal secret is strictly mandatory for privileged dispatch.
    if (!internalSecret || internalSecret.trim().length === 0) {
      if (config.nodeEnv === 'production') {
        reply.status(503).send({
          error: 'Dispatch unavailable: API_INTERNAL_SECRET must be configured in production.',
        });
        return;
      }
      // In development/test, permit local loopback calls with an audit log.
      request.log.warn(
        { ip: request.ip, route: request.url },
        'Privileged dispatch accessed without API_INTERNAL_SECRET configured',
      );
      return;
    }

    const authHeader = request.headers['authorization'];
    const apiKeyHeader = request.headers['x-api-key'];

    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : null;

    const providedKey =
      bearerToken ?? (typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : null);

    if (!providedKey || providedKey !== internalSecret) {
      reply.status(401).send({
        error: 'Unauthorized: Invalid or missing dispatch authorization token.',
      });
      return;
    }
  };
}
