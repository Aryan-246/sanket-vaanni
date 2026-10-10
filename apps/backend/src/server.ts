/**
 * Server entry point.
 *
 * This is the only file that binds a port, which is what makes the app
 * independently startable (`npm run dev` / `npm start`).
 */
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Logging is not available yet because the app was never constructed.
      process.stderr.write(`[config] ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const app = buildApp(config);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      `Sanket Vaanni backend ready on http://${config.host}:${config.port} (${config.nodeEnv})`,
    );
  } catch (error) {
    app.log.error({ error }, 'failed to start server');
    process.exit(1);
  }
}

void main();
