import type { FastifyInstance } from 'fastify';

import { SERVICE_NAME, SERVICE_VERSION } from '../version.js';

export interface ServiceInfoResponse {
  service: string;
  version: string;
  status: 'foundation';
  message: string;
  endpoints: Record<string, string>;
}

export async function rootRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (): Promise<ServiceInfoResponse> => ({
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    status: 'foundation',
    message:
      'Sanket Vaanni API. Gesture recognition and glove BLE integration are not ' +
      'implemented yet — the firmware protocol is unverified. See docs/ble-protocol.md.',
    endpoints: {
      health: '/health',
    },
  }));
}
