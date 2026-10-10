module.exports = {
  root: true,
  extends: '@react-native',
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
