declare module '@env' {
  /**
   * Base URL of the Sanket Vaanni backend.
   *
   * Set in `apps/mobile/.env` (gitignored; see `.env.example`). Changing this
   * value is a configuration change, not a code change — no rebuild of the
   * TypeScript sources is required, only a Metro restart.
   */
  export const API_BASE_URL: string | undefined;
}
