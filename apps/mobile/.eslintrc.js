module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    /*
     * `void promise` as a statement is how this codebase marks a promise whose
     * result is deliberately discarded — a fire-and-forget storage write or a
     * best-effort status read. The default rule flags that pattern, which pushes
     * authors towards either an unmarked floating promise or a pointless
     * try/catch. `allowAsStatement` permits exactly the marked form and still
     * flags `void` used in expression position, where it is a genuine mistake.
     */
    'no-void': ['warn', { allowAsStatement: true }],
  },
  overrides: [
    {
      // Jest globals (describe/it/expect/jest) and the Node built-ins used by
      // config files are not part of the React Native runtime environment.
      files: ['jest.setup.js', 'jest.config.js', '__tests__/**/*.{js,ts,tsx}'],
      env: { jest: true, node: true },
    },
  ],
  ignorePatterns: ['node_modules/', 'android/', 'ios/', 'coverage/'],
};
