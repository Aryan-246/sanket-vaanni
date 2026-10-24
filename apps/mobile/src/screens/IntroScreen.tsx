import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Image, Pressable, StatusBar, StyleSheet, View } from 'react-native';
import Video, {
  type OnLoadData,
  type OnProgressData,
  type OnVideoErrorData,
} from 'react-native-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '../components/AppText';
import { MIN_TOUCH_TARGET, radii, spacing } from '../theme';

// Bundled originals, copied unmodified from the supplied intro kit.
// Regenerating or re-encoding these is not permitted — see the kit README.
const INTRO_VIDEO = require('../assets/intro/sanket-vaani-intro.mp4');
const INTRO_POSTER = require('../assets/intro/sanket-vaani-intro-poster.png');

/**
 * The intro's own text colour.
 *
 * Deliberately a literal, and deliberately not a palette token. The intro is a
 * full-screen cinematic on the clip's own black background, in both themes; the
 * app's theme has no bearing on it. Reading `palette.textPrimary` here would
 * turn the skip label near-black on black the moment the user selected the light
 * theme — which the light theme is perfectly entitled to do, and which would
 * leave an invisible control over an opaque video.
 */
const INTRO_TEXT = '#F5F5F7';

/**
 * Ceiling on how long the *player* is given to begin.
 *
 * Counted from mount, because a load that never reports back emits neither
 * `onLoad` nor `onError`, and without this the intro would wait forever.
 */
const LOAD_DEADLINE_MS = 12_000;

/**
 * Ceiling on how long playback is given to *start* once the clip is loaded.
 *
 * Counted from `onLoad`, not from mount, which is what makes it safe to use a
 * short value: `onLoad` is only emitted after the asset has been read, so on a
 * debug build the ~8 s Metro fetch is already behind us by the time this is
 * armed.
 *
 * This exists because "loaded" and "playing" are different things, and the gap
 * between them is not always a fault of ours. Measured on the target device with
 * a call active, ExoPlayer prepared the clip and then sat at frame 0
 * indefinitely — react-native-video pauses on audio-focus loss, and Android was
 * holding `GAIN_TRANSIENT` for the ringtone with `Audio mode: MODE_IN_CALL`.
 * Without a bound here the user would stare at a still poster until the 12 s
 * load deadline, which is not a crash but is not acceptable either. The clip's
 * own audio renderer drives the progress clock, so silence for this long after
 * a successful load means it is not playing; showing the branded still frame and
 * moving on is the right answer.
 */
const PLAYBACK_START_DEADLINE_MS = 2_500;

/**
 * Margin added to the clip's own reported length once playback has begun.
 *
 * This is deliberately not a fixed guess at the clip's duration. Measured on
 * the target device, a flat 15 s ceiling fired at 16:00:56.373 while `onEnd` was
 * ~0.2 s behind it — the intro was playing correctly and the watchdog cut it
 * off. The cause was that the ceiling counted from mount, but playback does not
 * begin at mount: on a debug build React Native fetches the asset from Metro
 * over HTTP (confirmed in `AssetSourceResolver.isLoadedFromServer`), and that
 * download took ~8 s of the 15. Arming the stall timer from the duration the
 * player itself reports in `onLoad` removes the guesswork entirely.
 */
const PLAYBACK_MARGIN_MS = 4_000;

/** Used only if `onLoad` reports no usable duration. */
const ASSUMED_CLIP_MS = 8_000;

/** How long the branded fallback holds before continuing into the app. */
const FALLBACK_HOLD_MS = 1_400;

/** Skip becomes available shortly after playback starts, to avoid a flash. */
const SKIP_REVEAL_MS = 700;

/**
 * Warm-up budget the decoder and its surface get once the player is prepared,
 * before the poster is allowed to move.
 *
 * This exists because react-native-video 6.19.3 exposes **no** first-frame
 * callback — `grep -ri firstframe` across its Android sources returns nothing.
 * Both events it does emit are misleading here:
 *
 *  - `onReadyForDisplay` is ExoPlayer's `STATE_READY`
 *    (`ReactExoplayerView.java:1525-1528`): the player is *prepared*.
 *  - `onProgress` reports `player.getCurrentPosition()`
 *    (`ReactExoplayerView.java:296`) from the media clock, and
 *    `startProgressHandler()` is called at that same `STATE_READY` (line 1531).
 *    The clip carries an audio track, so ExoPlayer's audio renderer drives that
 *    clock: the playhead moves while the video renderer may have painted
 *    nothing.
 *
 * Measured on the target device, revealing on the first moving playhead report
 * left a ~700 ms black gap. The Android surface is a `SurfaceView`, which is
 * opaque black until a frame is presented, and `viewType` cannot change that —
 * `ExoPlayerView.kt:143` is an unimplemented `TODO`. So the poster is held for a
 * warm-up budget rather than released on a signal, and the limitation is
 * documented rather than hidden.
 */
const REVEAL_SETTLE_MS = 500;

/**
 * How long the poster takes to dissolve once it is allowed to move.
 *
 * This is the real safety margin, and it is deliberately long. The library
 * gives no way to know when the decoder's first frame lands, so instead of
 * betting on a number, the crossfade is made long enough to straddle the
 * warm-up: the poster only reaches alpha 0 a full second after it starts to
 * move, so a first frame that arrives late still arrives *while the poster is
 * partly opaque*. The worst case is then a crossfade from the splash artwork
 * into the animation — dimmer, never black.
 *
 * The two constants together bound the exposure at 1500 ms. Anything longer
 * than that and the SurfaceView's black really is on screen, at which point the
 * poster is no longer the problem and the honest move is to say so.
 */
const POSTER_FADE_MS = 1_000;

/**
 * Playback telemetry for the runtime smoke test.
 *
 * Dev builds only. Read it on device with:
 *
 * ```powershell
 * adb logcat -s ReactNativeJS:V | Select-String "intro"
 * ```
 *
 * Kept in the shipping component rather than added temporarily, because player
 * state transitions are otherwise invisible on real hardware — and this is how
 * the "is it actually playing" question gets answered with evidence instead of
 * inference. It costs nothing in release: `__DEV__` is `false`, so the body is
 * dead code.
 */
function logPlayback(event: string, detail?: unknown): void {
  if (!__DEV__) return;
  if (detail === undefined) {
    console.log(`[intro] ${event}`);
  } else {
    console.log(`[intro] ${event}`, detail);
  }
}

interface IntroVideoProps {
  onEnd: () => void;
  onError: (error: OnVideoErrorData) => void;
  onLoad: (data: OnLoadData) => void;
  onProgress: (data: OnProgressData) => void;
  onReadyForDisplay: () => void;
}

/**
 * The player, isolated behind `React.memo`.
 *
 * This is the performance fix for the rough playback. The parent re-renders
 * when the skip control is revealed at 700 ms — right in the middle of the most
 * animation-sensitive part of the clip. Without memoisation that re-render
 * walked into the video subtree; every prop below is a module constant or a
 * `useCallback` with stable deps, so the memo actually holds and the player is
 * left alone.
 *
 * Two props are absent on purpose:
 *
 *  - **No `progressUpdateInterval`.** It only has meaning alongside
 *    `onProgress`, and at its default it avoids waking the JS thread four times
 *    a second during playback. Passing it was pure overhead.
 *  - **No `poster`.** The poster is rendered by the parent instead, so that the
 *    hand-off from splash to video is ours to control — the library's own
 *    handling hides it on `STATE_READY`, which is exactly the too-early
 *    trigger this screen exists to avoid. See `tryReveal`.
 */
const IntroVideo = React.memo(function IntroVideoView({
  onEnd,
  onError,
  onLoad,
  onProgress,
  onReadyForDisplay,
}: IntroVideoProps): React.JSX.Element {
  return (
    <Video
      source={INTRO_VIDEO}
      style={styles.video}
      resizeMode="contain"
      // Native does not block audible autoplay, so the soundtrack plays.
      muted={false}
      volume={0.9}
      repeat={false}
      paused={false}
      playInBackground={false}
      onLoad={onLoad}
      onProgress={onProgress}
      onEnd={onEnd}
      onError={onError}
      onReadyForDisplay={onReadyForDisplay}
      // A missing or unsupported asset does not reliably emit `onError` on
      // every platform; `onLoad` never arriving is covered by the watchdog.
      accessibilityLabel="Sanket Vaanni opening animation"
    />
  );
});

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
 * ## Why the poster is a separate layer
 *
 * The kit README describes the supplied PNG as the **splash poster**, and that
 * is what it is: the composed artwork — hands, broken ring arcs, the संकेत वाणी
 * wordmark and the loading dots. It is deliberately *not* the clip's frame 0.
 * The kit's own timeline montage shows frame 0 as bare hands with no ring and no
 * wordmark, and the wordmark only arrives at ~2.3 s.
 *
 * Painting it immediately and holding it over the player means there is no black
 * frame between "React Native has mounted" and "the decoder has produced a
 * picture". When to release it is the whole problem; see `REVEAL_SETTLE_MS`.
 *
 * The dissolve is applied to the *poster*, never to the video. react-native-video
 * renders into a `SurfaceView` on Android by default (`viewType` defaults to
 * `SURFACE`), and a SurfaceView is composited as its own layer behind the
 * window — it does not honour an alpha applied to it. Fading the video would
 * silently do nothing on this platform; fading the ordinary `Image` above it
 * gives the identical result and works.
 */
export function IntroScreen({ onComplete }: IntroScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<'playing' | 'fallback'>('playing');
  const [showSkip, setShowSkip] = useState(false);

  const completedRef = useRef(false);
  const revealedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const posterOpacity = useRef(new Animated.Value(1)).current;
  /** Tracks the post-load stall timer so it is cleared on unmount. */
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The two gates the reveal waits on. Neither is sufficient alone, and neither
   * is a first-frame signal — see `REVEAL_SETTLE_MS` for why none exists.
   */
  const settledRef = useRef(false);
  const playheadMovingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The `onLoad`-armed deadline for playback to actually begin. Distinct from
   * the load deadline: this one is cleared the moment the playhead moves.
   */
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  /** Idempotent: whichever path fires first wins. */
  const finish = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onCompleteRef.current();
  }, []);

  /** Show the branded still frame, then release the user into the app. */
  const fallBack = useCallback(
    (reason: string) => {
      if (completedRef.current) return;
      logPlayback(`falling back — ${reason}`);
      if (stallTimerRef.current !== null) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      if (startTimerRef.current !== null) {
        clearTimeout(startTimerRef.current);
        startTimerRef.current = null;
      }
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      setPhase('fallback');
      setTimeout(finish, FALLBACK_HOLD_MS);
    },
    [finish],
  );

  /**
   * Deadline for playback to *begin*.
   *
   * A load that never reports back emits neither `onLoad` nor `onError`, so
   * this is what stops the intro waiting forever. It deliberately covers only
   * the start: once `onLoad` has reported a duration, the stall timer below
   * takes over with a bound derived from the real clip length.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!completedRef.current) fallBack('playback never began');
    }, LOAD_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [fallBack]);

  // Nothing may fire after unmount.
  useEffect(
    () => () => {
      if (stallTimerRef.current !== null) clearTimeout(stallTimerRef.current);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      if (startTimerRef.current !== null) clearTimeout(startTimerRef.current);
    },
    [],
  );

  /**
   * Reveal the video, but only with both gates satisfied.
   *
   * `settled` is the warm-up budget; `playheadMoving` proves the clip is
   * actually playing rather than merely loaded. Latches, so the first
   * qualifying caller wins. Called from both paths because they complete in
   * either order.
   */
  const tryReveal = useCallback(() => {
    if (revealedRef.current) return;
    if (!settledRef.current) return;
    if (!playheadMovingRef.current) return;

    revealedRef.current = true;
    logPlayback('revealing video');
    Animated.timing(posterOpacity, {
      toValue: 0,
      duration: POSTER_FADE_MS,
      useNativeDriver: true,
    }).start();
  }, [posterOpacity]);

  /**
   * Start the warm-up budget the first time the player reports prepared.
   *
   * `onLoad` and `onReadyForDisplay` are both emitted from the same
   * `STATE_READY` branch, so this is armed from either — whichever arrives
   * first — and is idempotent.
   */
  const armSettle = useCallback(() => {
    if (settledRef.current || settleTimerRef.current !== null) return;
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      settledRef.current = true;
      tryReveal();
    }, REVEAL_SETTLE_MS);
  }, [tryReveal]);

  /** Playback has begun: bound it by the clip's own reported length. */
  const handleLoad = useCallback(
    (data: OnLoadData) => {
      logPlayback('load', {
        durationSec: data?.duration,
        naturalWidth: data?.naturalSize?.width,
        naturalHeight: data?.naturalSize?.height,
        videoTracks: data?.videoTracks?.length,
        audioTracks: data?.audioTracks?.length,
      });
      armSettle();

      const reportedMs =
        typeof data?.duration === 'number' && data.duration > 0
          ? data.duration * 1000
          : ASSUMED_CLIP_MS;

      if (stallTimerRef.current !== null) clearTimeout(stallTimerRef.current);
      stallTimerRef.current = setTimeout(() => {
        if (!completedRef.current) fallBack('playback did not end');
      }, reportedMs + PLAYBACK_MARGIN_MS);

      // Loaded is not the same as playing — see PLAYBACK_START_DEADLINE_MS.
      // Cleared by `handleProgress` the moment the playhead moves.
      if (startTimerRef.current !== null) clearTimeout(startTimerRef.current);
      startTimerRef.current = setTimeout(() => {
        startTimerRef.current = null;
        if (!completedRef.current) fallBack('playback did not start');
      }, PLAYBACK_START_DEADLINE_MS);
    },
    [armSettle, fallBack],
  );

  useEffect(() => {
    const timer = setTimeout(() => setShowSkip(true), SKIP_REVEAL_MS);
    return () => clearTimeout(timer);
  }, []);

  /**
   * Arm the warm-up budget. This deliberately does **not** reveal the video.
   *
   * `onReadyForDisplay` is emitted from the Android source on ExoPlayer's
   * `STATE_READY` (`ReactExoplayerView.java:1525-1528`), which means the player
   * is *prepared* — not that a frame has been composited. Fading here produced a
   * visible black flash on the target device: the poster was up at t+3.3 s and
   * the screen was black by t+3.9 s with no video frame drawn.
   */
  const handleReadyForDisplay = useCallback(() => {
    logPlayback('readyForDisplay');
    armSettle();
  }, [armSettle]);

  /**
   * Note that the playhead is moving — the second of the two reveal gates.
   *
   * A `currentTime` past zero proves the *clip* is playing; it does **not** prove
   * a frame is on screen, because that clock is driven by the audio renderer
   * (see `REVEAL_SETTLE_MS`). So this opens a gate rather than dissolving the
   * poster itself. The handler writes to a ref, so the ~4 reports a second it
   * receives cost no React renders.
   */
  const handleProgress = useCallback(
    (data: OnProgressData) => {
      const currentTime = typeof data?.currentTime === 'number' ? data.currentTime : 0;
      if (currentTime <= 0) return;

      if (!playheadMovingRef.current) {
        playheadMovingRef.current = true;
        logPlayback('playback started', { currentTime });
        // Playing, so the start deadline has done its job.
        if (startTimerRef.current !== null) {
          clearTimeout(startTimerRef.current);
          startTimerRef.current = null;
        }
      }
      tryReveal();
    },
    [tryReveal],
  );

  const handleError = useCallback(
    (error: OnVideoErrorData) => {
      // Do not surface a dialog or a stack trace — the intro is decorative.
      // Show the still frame, then continue.
      logPlayback('error', error?.error ?? error);
      fallBack('player reported an error');
    },
    [fallBack],
  );

  return (
    <Pressable style={styles.root} onPress={finish}>
      {/*
        Hidden for the length of the cinematic, restored the moment this screen
        unmounts. `StatusBar` is a stack: this entry is pushed over the one in
        `App.tsx` and popped on unmount, which re-applies `light-content`. No
        native code and nothing to clean up by hand.
      */}
      <StatusBar hidden />

      {phase === 'playing' ? (
        <>
          <IntroVideo
            onEnd={finish}
            onError={handleError}
            onLoad={handleLoad}
            onProgress={handleProgress}
            onReadyForDisplay={handleReadyForDisplay}
          />
          {/*
            Sits above the player, so it covers the black before the first frame
            and dissolves to reveal it. `pointerEvents="none"` keeps the skip
            control beneath it tappable while it is still opaque.
          */}
          <Animated.View
            testID="intro-poster"
            style={[styles.poster, { opacity: posterOpacity }]}
            pointerEvents="none"
            accessible={false}
          >
            <Image source={INTRO_POSTER} style={styles.posterImage} resizeMode="contain" />
          </Animated.View>
        </>
      ) : (
        /*
          Fallback: the supplied poster, which already carries the hands, the
          ring, the संकेत वाणी wordmark and the loading dots in the artwork
          itself. Shown at the same size and position as the video frame so the
          failure is invisible rather than a visible jump — and with no second
          copy of the wordmark drawn over it.
        */
        <View
          testID="intro-fallback"
          style={styles.fallback}
          accessible
          accessibilityRole="image"
          accessibilityLabel="Sanket Vaanni"
        >
          <Image source={INTRO_POSTER} style={styles.posterImage} resizeMode="contain" />
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
            <AppText variant="overline" color={INTRO_TEXT} overline>
              Skip
            </AppText>
          </Pressable>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // Pure black matches the supplied clip's background, so `contain` letter-
    // boxing is invisible rather than a visible band.
    backgroundColor: '#000000',
  },
  video: {
    // Written out rather than using StyleSheet.absoluteFillObject, which RN
    // 0.87 no longer exposes in its public types.
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  poster: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  posterImage: {
    width: '100%',
    height: '100%',
  },
  fallback: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
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
