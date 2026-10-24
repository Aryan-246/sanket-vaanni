/**
 * Sanket Vaanni — mobile entry point.
 *
 * @format
 */

import React, { useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { App } from './src/app/RootNavigator';
import { createHardwareBleTransport } from './src/ble/bleTransport';

/**
 * Background for the frame before React has mounted anything.
 *
 * A literal, not a palette token, and it cannot be anything else: the theme
 * preference has not been read yet at this point, so there is no scheme to
 * resolve. Matching the dark palette's `background` means the default launch
 * (dark) shows no seam, and a light-theme user's single pre-mount frame is the
 * same near-black the splash screen already is — which is far less jarring than
 * a white flash before a dark UI.
 *
 * The status bar is not set here. It belongs to the theme, and the themed root
 * in `RootNavigator` owns it so that it changes when the theme does.
 */
const PRE_MOUNT_BACKGROUND = '#050506';

export default function Main(): React.JSX.Element {
  const transports = useMemo(() => {
    if (Platform.OS === 'android') {
      return {
        transport: createHardwareBleTransport('right'),
        leftTransport: createHardwareBleTransport('left'),
      };
    }
    return {};
  }, []);

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <App {...transports} />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: PRE_MOUNT_BACKGROUND,
  },
});
