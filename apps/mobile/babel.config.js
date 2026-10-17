module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module:react-native-dotenv',
      {
        // Virtual module name. Must match the import in src/config/env.ts.
        moduleName: '@env',
        path: '.env',
        // `safe: false` lets an entirely absent `.env` still build — the app
        // falls back to its development defaults in src/config/env.ts.
        safe: false,
        allowUndefined: true,
      },
    ],
  ],
  env: {
    /*
     * Tests read `.env.test`, not `.env`.
     *
     * `react-native-dotenv` inlines this file into the bundle at transform time,
     * which means a Jest run inherits whatever credentials the developer happens
     * to have on disk. That was not a theoretical problem: with a populated
     * `.env` every test that rendered the app issued real HTTPS requests to a
     * live Supabase project, and `API_BASE_URL` resolved to the deployed
     * backend. Tests must not talk to production, and a suite whose result
     * depends on a gitignored file is not reproducible.
     *
     * `.env.test` is deliberately absent and gitignored alongside `.env`, so the
     * test build resolves exactly what a fresh clone does — no Supabase project,
     * and the development fallback backend URL. `safe: false` and
     * `allowUndefined: true` make an absent file a valid, unconfigured build
     * rather than an error, which is the same arrangement the app already
     * supports in production.
     */
    test: {
      plugins: [
        [
          'module:react-native-dotenv',
          {
            moduleName: '@env',
            path: '.env.test',
            safe: false,
            allowUndefined: true,
          },
        ],
      ],
    },
    /*
     * A stack running on this machine, for device testing.
     *
     * Select with `BABEL_ENV=local npx react-native start --reset-cache`, and
     * create a `.env.local` holding this machine's values. It exists so that the
     * alternative — editing `.env` — is never necessary: `.env` is the normal
     * configuration, and a test build that overwrote it would leave a developer
     * pointing at localhost without knowing, or a debug APK aimed at an address
     * that only exists while a laptop is awake.
     *
     * ## This block is a convenience, not the mechanism, and not a protection
     *
     * Selecting it is redundant. `react-native-dotenv` derives its own
     * `path + '.local'` for *every* profile and merges that file over the base
     * one, so merely *having* a `.env.local` on disk is what points a build at
     * localhost — `BABEL_ENV=local` is not required for that to happen, and does
     * not cause it.
     *
     * That was measured, not reasoned about, on 2026-10-15: a debug APK built
     * with neither `BABEL_ENV` nor `NODE_ENV` set embedded
     * `http://127.0.0.1:54321` and `http://127.0.0.1:4000` and neither hosted
     * URL, because all three keys the app reads are set in both `.env` and
     * `.env.local`. On a phone `127.0.0.1` is the phone, so the artefact was
     * useless in a way that a green build hid completely.
     *
     * Two consequences worth keeping:
     *
     * 1. `.env.local` is not inert. Treat it as live configuration for every
     *    build on the machine where it exists, and hold it aside when building
     *    an artefact that must point at the hosted services.
     * 2. Changing which env file resolves does **not** make Gradle rebuild the
     *    bundle — the env files are Metro cache keys, not declared task inputs,
     *    and Gradle will report the bundle task `UP-TO-DATE` and reuse the old
     *    one. Delete the bundle intermediates to force it.
     *
     * The test suite is unaffected only because the `test` profile points at
     * `.env.test`, whose `.local` sibling does not exist.
     *
     * See docs/apk-verification-2026-10-15.md.
     */
    local: {
      plugins: [
        [
          'module:react-native-dotenv',
          {
            moduleName: '@env',
            path: '.env.local',
            safe: false,
            allowUndefined: true,
          },
        ],
      ],
    },
  },
};
