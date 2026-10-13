const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * ## Why this is the default configuration again
 *
 * This file used to add the repository root's `node_modules` to `watchFolders`
 * and to `resolver.nodeModulesPaths`, because `@supabase/supabase-js` was
 * declared in this app's `package.json` but had only ever been installed at the
 * repository root. Metro only searches inside the project, so it could not
 * resolve the import and every release build failed.
 *
 * That workaround was treating a symptom. The cause was that no `npm install`
 * had ever succeeded in this directory: `package.json` carried a malformed
 * dependency name (`@react-native-babel-preset`, a scope with no package after
 * it), so npm aborted before it resolved anything. With that name corrected,
 * `@supabase/supabase-js` installs here like any other dependency and Metro
 * finds it in this app's own `node_modules`.
 *
 * The root copy is therefore no longer on the resolution path. It has not been
 * deleted — it was not created by this project's build and deleting it is the
 * repository owner's call — but nothing depends on it any more.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
module.exports = mergeConfig(getDefaultConfig(__dirname), {});
