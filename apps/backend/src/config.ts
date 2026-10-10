/**
 * Environment configuration.
 *
 * Everything the service needs comes from the environment so that the same
 * build runs in development, test and production. There are currently no
 * secrets — see `.env.example`.
 *
 * `.env` is loaded by Node itself via `--env-file-if-exists=.env` (see the
 * `dev` and `start` scripts), so no dotenv dependency is required.
 */

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4000;
const DEFAULT_LOG_LEVEL = 'info';

const NODE_ENVS = ['development', 'test', 'production'] as const;

/** Thrown when the environment is present but not usable. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseNodeEnv(raw: string | undefined): NodeEnv {
  const value = (raw ?? 'development').trim();
  if ((NODE_ENVS as readonly string[]).includes(value)) {
    return value as NodeEnv;
  }
  throw new ConfigError(
    `NODE_ENV must be one of: ${NODE_ENVS.join(', ')} — received "${value}"`,
  );
}

function parsePort(raw: string | undefined): number {
  const value = (raw ?? String(DEFAULT_PORT)).trim();
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `PORT must be an integer between 1 and 65535 — received "${value}"`,
    );
  }
  return port;
}

function parseNonEmpty(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim();
  return value.length > 0 ? value : fallback;
}

/** Reads and validates configuration. Throws {@link ConfigError} if invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    nodeEnv: parseNodeEnv(env.NODE_ENV),
    host: parseNonEmpty(env.HOST, DEFAULT_HOST),
    port: parsePort(env.PORT),
    logLevel: parseNonEmpty(env.LOG_LEVEL, DEFAULT_LOG_LEVEL),
  };
}
