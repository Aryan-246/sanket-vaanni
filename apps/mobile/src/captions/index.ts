/**
 * Live captions.
 *
 * See `controller.ts` for the behaviour and, more importantly, for what this
 * module refuses to claim about whether recognition ran on-device.
 *
 * There is no hook exported here. The React subscription is
 * `useCaptionsState()` in `../app/AppState`, alongside `useSpeechState` and
 * `useGlove` — one place that knows how the app's stores reach components.
 */
export {
  CaptionsController,
  MAX_CAPTION_LENGTH,
  MAX_CAPTION_LINES,
  POLL_INTERVAL_MS,
  type CaptionLine,
  type CaptionSource,
  type CaptionsListeningState,
  type CaptionsState,
  type MicrophonePermission,
} from './controller';

export { SOURCE_DESCRIPTION, SOURCE_LABEL, SOURCE_TONE } from './provenance';
