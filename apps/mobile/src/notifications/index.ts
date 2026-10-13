/**
 * Push notifications.
 *
 * See `controller.ts` for the behaviour and, in particular, for why this module
 * can register a device but can never send a notification to one.
 *
 * There is no hook exported here, for the same reason there is none in
 * `../captions`: the React subscription is `usePushState()` in `../app/AppState`,
 * which is the one place that knows how the app's stores reach components.
 */
export {
  PushController,
  PUSH_STORAGE_KEY,
  type PushBridge,
  type PushControllerDeps,
  type PushPermission,
  type PushState,
  type PushStatus,
} from './controller';

export { createSupabasePushRegistrar, type PushRegistrar } from './register';

export type { PushMessage } from './messaging';
