/**
 * Environment configuration.
 *
 * Everything the service needs comes from the environment so that the same
 * build runs in development, test and production.
 *
 * ## This service does hold secrets
 *
 * An earlier revision of this comment said the opposite — "there are currently
 * no secrets" — which was true when the service only sent mail with no
 * credentials. It is not true now. The environment carries the SMTP password,
 * the internal API secret, and the Supabase service-role key, which bypasses
 * every row-level security policy in the database.
 *
 * None of these are defaults, none are logged, and none are echoed in an error
 * message or a health check. Every one of them is optional: the services that
 * need them disable themselves and report that they are unavailable rather than
 * falling back to something weaker. See `.env.example` for the names, and
 * `docs/supabase-setup.md` for where each one goes. Never put any of them in
 * the mobile app.
 *
 * `.env` is loaded by Node itself via `--env-file-if-exists=.env` (see the
 * `dev` and `start` scripts), so no dotenv dependency is required. Node does
 * not override variables that are already set in the process environment, so
 * a deployed environment wins over the file.
 */

export type NodeEnv = 'development' | 'test' | 'production';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly pass?: string;
  readonly from: string;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly googleApplicationCredentials?: string;
  readonly smtp: SmtpConfig;
  readonly apiInternalSecret?: string;

  /**
   * Supabase project URL. Needed to validate access tokens and to reach the
   * administration tables.
   */
  readonly supabaseUrl?: string;
  /**
   * The anon key. Used only to build the client that *validates* tokens.
   * Never used to read data.
   */
  readonly supabaseAnonKey?: string;
  /**
   * The service-role key.
   *
   * ## Handle with care
   *
   * This key bypasses every row-level security policy in the database. It must
   * never be sent to a client, never logged, and never echoed in an error
   * message or a health check. Nothing in this project reads it except the
   * administration middleware, which uses it only after the caller has been
   * authenticated as an administrator.
   *
   * If it is absent, the administration API disables itself and says so. There
   * is no fallback, because the only weaker alternatives are unauthenticated
   * admin routes.
   */
  readonly supabaseServiceRoleKey?: string;
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

function parseOptionalPath(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  return value.length > 0 ? value : undefined;
}

function parseOptionalString(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  return value.length > 0 ? value : undefined;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  return fallback;
}

/** Reads and validates configuration. Throws {@link ConfigError} if invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const smtpPort = parsePort(env.SMTP_PORT || '465');
  const isDefaultSecure = smtpPort === 465;

  return {
    nodeEnv: parseNodeEnv(env.NODE_ENV),
    host: parseNonEmpty(env.HOST, DEFAULT_HOST),
    port: parsePort(env.PORT),
    logLevel: parseNonEmpty(env.LOG_LEVEL, DEFAULT_LOG_LEVEL),
    googleApplicationCredentials: parseOptionalPath(env.GOOGLE_APPLICATION_CREDENTIALS),
    smtp: {
      host: parseNonEmpty(env.SMTP_HOST, 'smtp.gmail.com'),
      port: smtpPort,
      secure: parseBoolean(env.SMTP_SECURE, isDefaultSecure),
      user: parseOptionalString(env.SMTP_USER) ?? 'sanketvaanni.auth@gmail.com',
      pass: parseOptionalString(env.SMTP_PASS),
      from: parseNonEmpty(env.SMTP_FROM, 'Sanket Vaanni <sanketvaanni.auth@gmail.com>'),
    },
    apiInternalSecret: parseOptionalString(env.API_INTERNAL_SECRET),
    supabaseUrl: parseOptionalString(env.SUPABASE_URL),
    supabaseAnonKey: parseOptionalString(env.SUPABASE_ANON_KEY),
    supabaseServiceRoleKey: parseOptionalString(env.SUPABASE_SERVICE_ROLE_KEY),
  };
}
