/**
 * The installed build's identity, for display.
 *
 * Reads from the Android package manager through `nativeBuildInfo()`, so the
 * Settings and About screens report the APK that is actually on the phone. On a
 * platform where the module does not exist — iOS, Jest, web — it resolves to
 * `fromDevice: false` and callers must render the "unknown" wording instead of
 * a version number.
 *
 * ## Why this is a hook and not a constant
 *
 * The value is not known until the bridge answers, and answering takes a
 * round trip. A constant would be available immediately and wrong; this is
 * briefly `null` and then correct. The screens that use it show their
 * placeholder rather than blocking, because a version line is not worth a
 * spinner.
 */
import { useEffect, useState } from 'react';

import {
  fallbackPackageLabel,
  fallbackPlatformLabel,
  VERSION_UNKNOWN,
  type BuildFacts,
} from '../config/app';
import { nativeBuildInfo, type BuildInfo } from '../native/SanketVaanniNative';

/**
 * What we can say before — or without — asking the device.
 *
 * Exported because it is also the honest rendering in a test or on iOS, and
 * duplicating it would let the two drift.
 */
export const UNKNOWN_BUILD_FACTS: BuildFacts = {
  versionName: VERSION_UNKNOWN,
  versionCode: '—',
  packageLabel: fallbackPackageLabel(),
  platformLabel: fallbackPlatformLabel(),
  fromDevice: false,
};

export function buildFactsFrom(info: BuildInfo): BuildFacts {
  return {
    versionName: info.versionName,
    versionCode: String(info.versionCode),
    packageLabel: info.packageName,
    platformLabel: `${info.manufacturer} ${info.model} · Android ${info.androidRelease}`,
    fromDevice: true,
  };
}

/**
 * `null` while the read is in flight.
 *
 * Null rather than `UNKNOWN_BUILD_FACTS` so a caller can distinguish "not asked
 * yet" from "asked and there is no answer", and can hold the line blank for the
 * few frames before the bridge replies instead of flashing a placeholder that
 * is about to change.
 */
export function useBuildFacts(): BuildFacts | null {
  const [facts, setFacts] = useState<BuildFacts | null>(null);

  useEffect(() => {
    let cancelled = false;

    nativeBuildInfo()
      .then((info) => {
        if (cancelled) return;
        setFacts(info === null ? UNKNOWN_BUILD_FACTS : buildFactsFrom(info));
      })
      .catch(() => {
        if (!cancelled) setFacts(UNKNOWN_BUILD_FACTS);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return facts;
}
