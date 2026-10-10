/**
 * Single source of truth for service identity.
 *
 * Kept as a constant rather than imported from package.json so the compiled
 * output has no JSON-module or import-attribute requirements at runtime.
 */
export const SERVICE_NAME = 'sanket-vaanni-backend' as const;

/** Kept in sync with `package.json` "version" by hand. Bump both together. */
export const SERVICE_VERSION = '0.1.0' as const;
