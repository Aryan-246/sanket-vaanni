/**
 * Sanket Vaanni — mobile entry point.
 *
 * @format
 */

import React from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { App } from './src/app/RootNavigator';
import { colors } from './src/theme';

export default function Main(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        {/* Light content throughout: the entire app is a dark theme.
            RN 0.87 runs Android edge-to-edge, so StatusBar no longer takes a
            backgroundColor — the root view below supplies it instead. */}
        <StatusBar barStyle="light-content" />
        <App />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // Prevents a white flash between the native splash and the first frame.
    backgroundColor: colors.background,
  },
});
