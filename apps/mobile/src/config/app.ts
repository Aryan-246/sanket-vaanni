/**
 * Facts about the build.
 *
 * ## Why the version is not a constant here
 *
 * The repository carries three different version strings: `0.0.1` in
 * `apps/mobile/package.json`, `"1.0"` as the Gradle `versionName`, and — until
 * this file existed — a `0.1.0` written by hand into the Settings screen. Only
 * the Gradle one describes the APK that is installed, and a fourth constant in
 * JavaScript would simply be a fourth string to drift.
 *
 * So the version is read at runtime from the Android package manager by
 * `nativeBuildInfo()`. What lives here is only what is true without asking the
 * device: the package id, the platform, and the wording used when the module
 * that reports the version is not present.
 */
import { Platform } from 'react-native';

/**
 * The application id.
 *
 * Kept in step with `applicationId` in `apps/mobile/android/app/build.gradle`.
 * Asserted against the installed package at runtime where possible, so a
 * mismatch is visible rather than assumed away.
 */
export const PACKAGE_ID = 'com.sanketvaani';

/** The human-facing product name, with the Devanagari wordmark. */
export const PRODUCT_NAME = 'Sanket Vaanni';
export const PRODUCT_NAME_DEVANAGARI = 'संकेत वाणी';

/**
 * What to show for "version" when the device cannot be asked.
 *
 * Deliberately not a version number. On the web target and in tests there is no
 * installed package to describe; printing a plausible-looking string there
 * would be inventing one.
 */
export const VERSION_UNKNOWN = 'Unknown on this platform';

export interface BuildFacts {
  readonly versionName: string;
  readonly versionCode: string;
  readonly packageLabel: string;
  readonly platformLabel: string;
  /** False when the values came from the fallbacks above rather than the device. */
  readonly fromDevice: boolean;
}

/** The package name to display when the real one cannot be read. */
export function fallbackPackageLabel(): string {
  return Platform.OS === 'android' ? PACKAGE_ID : `${Platform.OS} build`;
}

/** The platform line to display when the real one cannot be read. */
export function fallbackPlatformLabel(): string {
  return Platform.OS === 'android'
    ? 'Android'
    : Platform.OS === 'ios'
      ? 'iOS (not built in this project)'
      : Platform.OS;
}
