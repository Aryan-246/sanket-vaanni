declare module '@env' {
  /**
   * Base URL of the Sanket Vaanni backend.
   *
   * Set in `apps/mobile/.env` (gitignored; see `.env.example`). Changing it is a
   * configuration change, not a code change — but it is not free either:
   * `react-native-dotenv` substitutes these values into the bundle at **build**
   * time, so a running app keeps the values it was compiled with. Development
   * needs a Metro restart with `--reset-cache`; a shipped APK needs rebuilding.
   *
   * Nothing read through this module is secret for the same reason. The value
   * ends up in the bundle, where anyone can read it.
   */
  export const API_BASE_URL: string | undefined;

  /**
   * Supabase Project URL.
   */
  export const SUPABASE_URL: string | undefined;

  /**
   * Supabase Publishable Key (safe for client-side bundle).
   */
  export const SUPABASE_PUBLISHABLE_KEY: string | undefined;
}
