/**
 * Chooses the speech implementation for this device.
 *
 * The decision is made once per process and is deliberately *not* a build-time
 * constant: whether a phone can speak depends on whether it has a text-to-speech
 * engine and voice data installed, which varies between devices running the same
 * APK. So the honest answer is computed at runtime, and the resulting object
 * reports what it found.
 *
 * On Android with the app's native module present, `DeviceSpeaker` is used and
 * probes the platform engine. Everywhere else — iOS in this build, and any
 * environment without the module such as Jest — `UnavailableSpeaker` is used,
 * which states plainly that speech cannot run here.
 */
import { DeviceSpeaker } from './nativeSpeaker';
import { UnavailableSpeaker, type Speaker } from './index';
import { isNativeModuleAvailable } from '../native/SanketVaanniNative';

export function createSpeaker(): Speaker {
  if (isNativeModuleAvailable) return new DeviceSpeaker();
  return new UnavailableSpeaker();
}
