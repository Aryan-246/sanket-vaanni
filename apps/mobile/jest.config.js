module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/__tests__/**/*.test.{ts,tsx,js}'],
  /*
   * The preset's default is 5000 ms, and the tests that render the whole app
   * regularly need more than that when the full suite runs in parallel. Measured
   * with `--verbose --testTimeout=30000` on the full suite, the slowest tests
   * that *complete* take 2.3–5.6 s (`does not re-render the screen for samples
   * below the UI rate` 5.6 s, `reports the account state honestly…` 3.7 s,
   * `labels itself a Demo Preview…` 3.6 s, `starts dark…` 3.3 s). Anything near
   * 5 s was therefore being cancelled while it was still making progress, which
   * is why a run could report anywhere between one and seven failures on
   * unchanged code.
   *
   * 15 s leaves room for that work to finish on a loaded machine while still
   * failing a test that is genuinely stuck well inside a CI budget. It is a
   * harness budget, not a relaxation of any assertion: no expectation is
   * weakened, and a test that hangs is still reported as a failure.
   */
  testTimeout: 15000,
  /*
   * `react-native-image-picker` ships TypeScript source rather than compiled
   * CommonJS, and the preset's default allowlist does not include it. Adding it
   * here is what lets any suite that imports the account or team editor parse —
   * without this, importing `ProfileScreen` through the app harness fails with
   * "Cannot use import statement outside a module" before a single assertion
   * runs. The rest of the pattern is the preset's own list, kept intact.
   */
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-image-picker)/)',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/assets/**',
  ],
};
