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
};
