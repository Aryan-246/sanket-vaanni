import type { FastifyInstance } from 'fastify';

import { SERVICE_NAME, SERVICE_VERSION } from '../version.js';

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

/**
 * Liveness endpoint.
 *
 * Intentionally reports only process facts. There is no database, no BLE
 * connection and no model loaded, so this endpoint must NOT claim any of them.
 * When those dependencies exist, add explicit readiness checks rather than
 * widening this response with optimistic fields.
 */
export const healthResponseSchema = {
  type: 'object',
  required: ['status', 'service', 'version', 'uptimeSeconds', 'timestamp'],
  properties: {
    status: { type: 'string', enum: ['ok'] },
    service: { type: 'string' },
    version: { type: 'string' },
    uptimeSeconds: { type: 'number' },
    timestamp: { type: 'string' },
  },
} as const;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema } } },
    async (): Promise<HealthResponse> => ({
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );
}
