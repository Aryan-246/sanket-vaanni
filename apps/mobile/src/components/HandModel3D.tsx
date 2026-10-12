import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { AppText } from './AppText';
import type { GloveSide } from '../ble/types';
import type { ViewerFrame } from '../hands/viewer';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { MIN_TOUCH_TARGET, radii, spacing } from '../theme';

/** How long to wait for the viewer to report itself ready before giving up. */
const READY_TIMEOUT_MS = 12000;

export interface HandModel3DProps {
  readonly side: GloveSide | 'both';
  readonly frame?: ViewerFrame;
  readonly frames?: Readonly<Record<GloveSide, ViewerFrame>>;
  readonly width: number;
  readonly height: number;
  readonly testID?: string;
  readonly onLoad?: () => void;
  /**
   * Paint the viewport with the surrounding card colour instead of leaving it
   * transparent. Only needed if a device will not composite a transparent
   * WebGL layer; the colour is derived from the theme, so it always matches the
   * card rather than becoming a black box.
   */
  readonly opaqueBackground?: boolean;
}

type ViewerStatus = 'loading' | 'ready' | 'error';

/** `#RRGGBB` -> `%23RRGGBB`, for use as a query value. */
function encodeColour(hex: string): string {
  return `%23${hex.replace('#', '')}`;
}

/**
 * 3D Hand Model Component.
 *
 * Renders the hardware-accelerated WebGL Three.js rigged hand viewer inside an
 * Android WebView, driven by real-time `HandPose` updates.
 *
 * The viewport is **transparent**: the renderer clears to zero alpha and the
 * page has no background, so the Dashboard card behind it is what the user
 * sees. The hand's own materials stay opaque, so only the background is
 * see-through.
 *
 * Assets are bundled offline, so the viewer needs no network and no glove to
 * appear. `src/webview/hands/` is the source of truth, and the Android build
 * registers `src/webview` as an assets source, which is what puts it in the APK
 * as `assets/hands/` — the path this WebView loads over `file:///android_asset/`.
 *
 * A failure is always visible: if the WebView cannot load, reports an error, or
 * simply never reports ready, this renders a diagnostic in place of the canvas
 * rather than an empty panel.
 */
export function HandModel3D({
  side,
  frame,
  frames,
  width,
  height,
  testID,
  onLoad,
  opaqueBackground = false,
}: HandModel3DProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const webViewRef = useRef<any>(null);
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [detail, setDetail] = useState<string | null>(null);
  const readyRef = useRef(false);

  // A side change re-navigates the same WebView (single-hand focus switches),
  // so the readiness of the previous document must not leak into the new one.
  useEffect(() => {
    readyRef.current = false;
    setStatus('loading');
    setDetail(null);
  }, [side]);

  // Never leave a blank panel: if nothing has reported ready in time, say so.
  useEffect(() => {
    if (status !== 'loading') return;
    const timer = setTimeout(() => {
      if (readyRef.current) return;
      setStatus('error');
      setDetail(`The 3D viewer did not start within ${READY_TIMEOUT_MS / 1000} seconds.`);
    }, READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status, side]);

  const source = useMemo(() => {
    const query = opaqueBackground
      ? `?bg=card&c=${encodeColour(palette.surface)}`
      : '';
    return { uri: `file:///android_asset/hands/viewer_${side}.html${query}` };
  }, [side, opaqueBackground, palette.surface]);

  // Send real-time pose updates directly to the running Three.js instance.
  useEffect(() => {
    if (status !== 'ready' || !webViewRef.current) return;

    let posePayload = '';
    if (side === 'both' && frames) {
      posePayload = JSON.stringify({
        left: { fingers: frames.left.pose.fingers, wrist: frames.left.pose.wrist },
        right: { fingers: frames.right.pose.fingers, wrist: frames.right.pose.wrist },
      });
    } else if (frame) {
      posePayload = JSON.stringify({
        fingers: frame.pose.fingers,
        wrist: frame.pose.wrist,
        side: frame.pose.side,
      });
    }

    if (posePayload) {
      // Guarded by the page's own `updatePose` check, so a document that has
      // not finished loading simply ignores this rather than throwing. The
      // ref check covers a host that has not attached its bridge yet.
      const script = `if (window.updatePose) { window.updatePose(${posePayload}); } true;`;
      const host = webViewRef.current;
      if (host && typeof host.injectJavaScript === 'function') {
        host.injectJavaScript(script);
      }
    }
  }, [frame, frames, side, status]);

  /** Whether the app itself is in the foreground, as far as the viewer cares. */
  const appActiveRef = useRef(true);

  /**
   * Tells the page whether it should be drawing.
   *
   * Gated on readiness: before the page reports `loaded` it has not defined
   * `setViewerActive` yet, so anything sent now would be discarded, and the
   * page starts its loop as soon as it initialises. `handleMessage` calls this
   * again the moment the page is ready, which is what makes the guarantee
   * real — a viewer that finished loading while the app was already in the
   * background is told to stop at the first moment it can hear it.
   */
  const sendActivity = useCallback(() => {
    if (!readyRef.current) return;
    const host = webViewRef.current;
    if (!host || typeof host.injectJavaScript !== 'function') return;
    host.injectJavaScript(
      `if (window.setViewerActive) { window.setViewerActive(${appActiveRef.current}); } true;`,
    );
  }, []);

  /**
   * Stops the viewer drawing while the app is in the background.
   *
   * The controller already suspends frame *production* when the app is not in
   * the foreground, but that leaves the page rendering the last pose it
   * received, sixty times a second, onto a surface nobody can see. Measured on
   * the real page in Chrome at 393x851, counting GPU draw calls: 60 a second
   * while visible and **60 a second with the document marked hidden**, for
   * identical work and nothing on screen to show for it. After the gate in
   * `hand_viewer.js` the hidden figure is 0 and the visible rate is unchanged.
   *
   * The page also watches the document's own visibility, which covers a system
   * dialog or the screen locking — states this side never hears about.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      appActiveRef.current = next === 'active';
      sendActivity();
    });
    return () => subscription.remove();
  }, [sendActivity]);

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let data: { type?: string; error?: string; side?: string };
      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch {
        return; // non-JSON bridge traffic is not ours
      }

      if (data.type === 'loaded') {
        readyRef.current = true;
        setStatus('ready');
        setDetail(null);
        onLoad?.();
        // The page can hear us now: state the current truth, in case the app
        // changed state while the model was still being parsed.
        sendActivity();
      } else if (data.type === 'error') {
        readyRef.current = false;
        setStatus('error');
        setDetail(data.error ?? 'The 3D viewer reported an error.');
      }
    },
    [onLoad, sendActivity],
  );

  return (
    <View
      testID={testID}
      style={[styles.container, { width, height }]}
      accessibilityLabel={`3D ${side} hand model viewer`}
    >
      <WebView
        ref={webViewRef}
        source={source}
        style={[styles.webView, { width, height }]}
        originWhitelist={['*']}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        allowContentAccess={true}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        // Lets the Android WebView composite over the card instead of painting
        // its own opaque backing behind the WebGL layer.
        androidLayerType="hardware"
        onError={(event) => {
          const message = event.nativeEvent?.description ?? 'WebView failed to load.';
          readyRef.current = false;
          setStatus('error');
          setDetail(message);
        }}
        onHttpError={(event) => {
          readyRef.current = false;
          setStatus('error');
          setDetail(`Asset request failed (HTTP ${event.nativeEvent?.statusCode ?? '?'}).`);
        }}
        onMessage={handleMessage}
      />

      {status !== 'ready' && (
        <View
          style={styles.overlay}
          pointerEvents="none"
          testID={testID ? `${testID}-status` : undefined}
          accessibilityRole="text"
          accessibilityLabel={
            status === 'loading'
              ? `Loading 3D ${side} hand`
              : `3D ${side} hand unavailable. ${detail ?? ''}`
          }
        >
          {status === 'loading' ? (
            <>
              <ActivityIndicator size="small" color={palette.accent} />
              <AppText variant="caption" color={palette.textMuted}>
                Loading 3D hand…
              </AppText>
            </>
          ) : (
            <>
              <AppText variant="label" color={palette.warning} style={styles.errorTitle}>
                3D hand unavailable
              </AppText>
              <AppText variant="caption" color={palette.textMuted} style={styles.errorBody}>
                {detail ?? 'The viewer did not start.'}
              </AppText>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    container: {
      // Transparent so the card surface behind the WebView shows through; the
      // hand is composited onto it rather than onto a panel of its own.
      backgroundColor: 'transparent',
      overflow: 'hidden',
      borderRadius: radii.md,
    },
    webView: {
      backgroundColor: 'transparent',
    },
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      // The card's own colour, so a loading or failed viewer is a seamless part
      // of the card rather than a panel — and never a black box. It is removed
      // entirely once the hand is ready, so it cannot affect transparency.
      backgroundColor: palette.surface,
    },
    errorTitle: {
      textAlign: 'center',
    },
    errorBody: {
      textAlign: 'center',
    },
  });

/** Kept exported so callers can size a touch target around the viewer. */
export const HAND_VIEWER_MIN_TOUCH = MIN_TOUCH_TARGET;
