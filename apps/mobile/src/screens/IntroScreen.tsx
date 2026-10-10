import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import Video from 'react-native-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '../components/AppText';
import { colors, MIN_TOUCH_TARGET, radii, spacing } from '../theme';

// Bundled originals, copied unmodified from the supplied intro kit.
// Regenerating or re-encoding these is not permitted — see the kit README.
const INTRO_VIDEO = require('../assets/intro/sanket-vaani-intro.mp4');
const INTRO_POSTER = require('../assets/intro/sanket-vaani-intro-poster.png');

/**
 * Hard ceiling on the intro.
 *
 * The clip runs ~6.5s. This exists so that a playback stall — neither `onEnd`
 * nor `onError` firing — still releases the user into the app. Without it, a
 * codec or decoder hang would present as an app that never starts.
 */
const INTRO_MAX_MS = 15_000;

/** How long the branded fallback holds before continuing into the app. */
const FALLBACK_HOLD_MS = 1_400;

/** Skip becomes available shortly after playback starts, to avoid a flash. */
const SKIP_REVEAL_MS = 700;

export interface IntroScreenProps {
  /** Called exactly once, however playback ends. */
  onComplete: () => void;
}

/**
 * First-launch intro.
 *
 * Plays the supplied animation once, then hands off to the app. Every failure
 * path — decode error, missing asset, stall — resolves to `onComplete`, so the
 * intro can never strand the user.
 *
 * Web autoplay policy does not apply on native: audio is not blocked, so the
 * soundtrack plays from the first frame without a "tap for sound" affordance.
 */
export function IntroScreen({ onComplete }: IntroScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<'playing' | 'fallback'>('playing');
  const [showSkip, setShowSkip] = useState(false);

  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  /** Idempotent: whichever path fires first wins. */
  const finish = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onCompleteRef.current();
  }, []);

  // Watchdog. Cleared on unmount so a fast hand-off cannot fire late.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!completedRef.current) {
        // A stall is a real failure; degrade to the branded fallback rather
        // than showing a frozen first frame.
        setPhase('fallback');
        setTimeout(finish, FALLBACK_HOLD_MS);
      }
    }, INTRO_MAX_MS);
    return () => clearTimeout(timer);
  }, [finish]);

  useEffect(() => {
    const timer = setTimeout(() => setShowSkip(true), SKIP_REVEAL_MS);
    return () => clearTimeout(timer);
  }, []);

  const handleError = useCallback(() => {
    // Do not surface a dialog or a stack trace — the intro is decorative.
    // Show the still frame, then continue.
    setPhase('fallback');
    setTimeout(finish, FALLBACK_HOLD_MS);
  }, [finish]);

  return (
    <View style={styles.root}>
      {phase === 'playing' ? (
        <Video
          source={INTRO_VIDEO}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          poster={{ source: INTRO_POSTER, resizeMode: 'contain' }}
          // Native does not block audible autoplay, so the soundtrack plays.
          muted={false}
          volume={0.9}
          repeat={false}
          paused={false}
          playInBackground={false}
          progressUpdateInterval={250}
          onEnd={finish}
          onError={handleError}
          // A missing or unsupported asset does not reliably emit `onError` on
          // every platform; `onLoad` never arriving is covered by the watchdog.
          accessibilityLabel="Sanket Vaanni opening animation"
        />
      ) : (
        // Fallback: the supplied poster plus the wordmark, so a failed video
        // still reads as a deliberate branded moment rather than a black
        // screen or an error.
        <View style={styles.fallback} accessible accessibilityLabel="Sanket Vaanni">
          <Image source={INTRO_POSTER} style={styles.fallbackImage} resizeMode="contain" />
          <AppText variant="title" style={styles.fallbackWordmark}>
            संकेत वाणी
          </AppText>
        </View>
      )}

      {showSkip && (
        <View
          style={[
            styles.skipWrap,
            { bottom: insets.bottom + spacing.xl, right: insets.right + spacing.lg },
          ]}
        >
          <Pressable
            onPress={finish}
            accessibilityRole="button"
            accessibilityLabel="Skip intro"
            accessibilityHint="Continues straight into the app"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={({ pressed }) => [styles.skip, pressed && styles.skipPressed]}
          >
            <AppText variant="overline" color={colors.textPrimary} overline>
              Skip
            </AppText>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // Pure black matches the supplied clip's background, so `contain` letter-
    // boxing is invisible rather than a visible band.
    backgroundColor: '#000000',
  },
  fallback: {
    // Written out rather than using StyleSheet.absoluteFillObject, which RN
    // 0.87 no longer exposes in its public types.
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  fallbackImage: {
    width: '86%',
    height: '70%',
  },
  fallbackWordmark: {
    color: colors.textPrimary,
  },
  skipWrap: {
    position: 'absolute',
  },
  skip: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  skipPressed: {
    opacity: 0.7,
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
});
