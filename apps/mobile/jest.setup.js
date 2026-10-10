/**
 * Jest setup.
 *
 * Native modules have no implementation under Jest, so the ones this app
 * imports are stubbed here. Keep this list to modules that are actually
 * imported — a blanket auto-mock hides real import errors.
 */

// The video player is a native view. Rendering it as a host component name is
// enough for the intro screen's logic (onEnd / onError / skip) to be tested.
jest.mock('react-native-video', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: React.forwardRef((props, ref) => React.createElement('Video', { ...props, ref })),
  };
});

// react-native-safe-area-context ships an official jest mock, but exposes it
// as a **default** export — so its named exports (useSafeAreaInsets, …) have to
// be lifted back onto the module for the component imports to resolve.
jest.mock('react-native-safe-area-context', () => {
  const official = require('react-native-safe-area-context/jest/mock');
  return { ...official, ...(official.default ?? {}) };
});

// AsyncStorage is a native module. This mock is a working in-memory store
// rather than a no-op, so storage behaviour is exercised, not bypassed.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
      setItem: jest.fn(async (key, value) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key) => {
        store.delete(key);
      }),
      clear: jest.fn(async () => {
        store.clear();
      }),
      getAllKeys: jest.fn(async () => Array.from(store.keys())),
    },
  };
});

// Timers used by the mock transport are disposed explicitly by each test
// (`transport.dispose()`), so no global cleanup hook is needed here — and
// `afterEach` is not defined at this point in Jest's lifecycle anyway
// (use `setupFilesAfterEnv` for that).
