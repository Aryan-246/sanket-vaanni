/**
 * Maintenance mode.
 *
 * `controller.ts` holds the state machine and says why it reads the database
 * directly rather than going through the backend. The React binding lives in
 * `app/AppState.tsx`, beside the other store hooks, so that every
 * `useSyncExternalStore` binding in the app is in one place.
 */
export { MaintenanceController, INITIAL_MAINTENANCE_STATE } from './controller';
export type { MaintenanceState, MaintenanceStatus } from './controller';
