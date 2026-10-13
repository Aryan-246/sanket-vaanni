/**
 * Maintenance mode.
 *
 * ## Why this reads the database directly instead of the backend
 *
 * Maintenance mode has to stop a user *signing in*, which means the check has to
 * run before there is any session. The backend's administration API requires a
 * bearer token, so a client that is signed out cannot call it — and a check that
 * only works once you are authenticated cannot prevent a sign-in.
 *
 * `app_settings` is therefore readable by `anon` as well as `authenticated`,
 * while writes are refused to both: only the service role, through the backend,
 * can change it. The read here is exactly the read the policy was written for.
 *
 * ## The failure this module exists to avoid
 *
 * The dangerous mistake is treating "I could not read it" as "it is off". A user
 * under maintenance who opens the app on a train would then get a normal app,
 * and the maintenance window would silently not apply to anyone offline — which
 * is the opposite of what an operator turning it on is trying to do.
 *
 * So the last known answer is cached on the device and kept. If maintenance was
 * last seen **on**, an unreadable check keeps the app blocked. If it was last
 * seen off, or has never been seen, an unreadable check lets the app work —
 * because the app is offline-first and locking every user out of a working
 * offline tool over a network hiccup would be worse than the problem — and the
 * screen says plainly that the state could not be checked rather than claiming
 * everything is fine.
 */
import type { Storage } from '../storage';
import { getSupabaseClient } from '../supabase/client';
import type { MaintenanceSetting } from '../supabase/types';

/** Where the last successfully read answer is kept, so an offline launch knows it. */
const CACHE_KEY = 'maintenance.lastKnown';

export type MaintenanceStatus =
  /** A check is in flight and no earlier answer is available. */
  | 'checking'
  /** Read successfully; the app is open. */
  | 'off'
  /** Read successfully; the app is closed. */
  | 'on'
  /** Could not be read. Falls back to the cached answer, or none. */
  | 'unreadable';

export interface MaintenanceState {
  readonly status: MaintenanceStatus;
  /** The setting as read, or the cached copy when the read failed. */
  readonly setting: MaintenanceSetting | null;
  readonly checkedAtMs: number | null;
  /** Why the check could not complete. Present only for `unreadable`. */
  readonly reason: string | null;
  /** True when the answer shown came from the cache rather than the network. */
  readonly fromCache: boolean;
}

export const INITIAL_MAINTENANCE_STATE: MaintenanceState = {
  status: 'checking',
  setting: null,
  checkedAtMs: null,
  reason: null,
  fromCache: false,
};

interface CachedMaintenance {
  readonly setting: MaintenanceSetting;
  readonly checkedAtMs: number;
}

/**
 * Reads the stored setting without trusting its shape.
 *
 * The value is JSON written by a previous version of this app, or by nobody. A
 * field that is the wrong type is treated as absent rather than coerced —
 * `Boolean("false")` is `true`, and a coercion here would turn "maintenance off"
 * into a locked app.
 */
function parseSetting(value: unknown): MaintenanceSetting | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== 'boolean') return null;

  return {
    enabled: raw.enabled,
    message: typeof raw.message === 'string' ? raw.message : '',
    enabledAt: typeof raw.enabledAt === 'string' ? raw.enabledAt : null,
    expectedEndAt: typeof raw.expectedEndAt === 'string' ? raw.expectedEndAt : null,
  };
}

export class MaintenanceController {
  private readonly storage: Storage;
  private readonly listeners = new Set<() => void>();
  private state: MaintenanceState = INITIAL_MAINTENANCE_STATE;
  /** Guards against two overlapping refreshes racing to write the state. */
  private inFlight = false;
  private disposed = false;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): MaintenanceState => this.state;

  private set(next: MaintenanceState): void {
    if (this.disposed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private async readCache(): Promise<CachedMaintenance | null> {
    const raw = await this.storage.getJson<CachedMaintenance>(CACHE_KEY);
    if (raw === null || typeof raw !== 'object') return null;
    const setting = parseSetting(raw.setting);
    if (setting === null) return null;
    return {
      setting,
      checkedAtMs: typeof raw.checkedAtMs === 'number' ? raw.checkedAtMs : 0,
    };
  }

  /**
   * Falls back to the cached answer and describes the situation honestly.
   *
   * A cached "on" keeps the app closed. A cached "off", or no cache at all,
   * opens the app and says the check failed.
   */
  private async fallback(reason: string): Promise<void> {
    const cached = await this.readCache();
    if (this.disposed) return;

    if (cached?.setting.enabled) {
      this.set({
        status: 'on',
        setting: cached.setting,
        checkedAtMs: cached.checkedAtMs,
        reason,
        fromCache: true,
      });
      return;
    }

    this.set({
      status: 'unreadable',
      setting: cached?.setting ?? null,
      checkedAtMs: cached?.checkedAtMs ?? null,
      reason,
      fromCache: cached !== null,
    });
  }

  /**
   * Asks the database.
   *
   * Safe to call often: overlapping calls are dropped rather than queued, and
   * the answer only ever replaces a previous one when it is a real answer.
   */
  async refresh(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    this.inFlight = true;

    try {
      const client = getSupabaseClient();
      if (client === null) {
        await this.fallback(
          'No Supabase project is configured in this build, so maintenance mode cannot be checked.',
        );
        return;
      }

      const { data, error } = await client
        .from('app_settings')
        .select('value')
        .eq('key', 'maintenance')
        .maybeSingle();

      if (this.disposed) return;

      if (error) {
        await this.fallback(`The maintenance check could not be completed (${error.message}).`);
        return;
      }

      const setting = parseSetting(data?.value ?? null);
      if (setting === null) {
        /*
         * Either the row is missing or its shape is not what this build expects.
         * Both mean the database is not in the state this app assumes, which is
         * worth saying rather than rounding to "off".
         */
        await this.fallback(
          'The maintenance setting is missing or is not in a recognised format. Its migration may not have been applied.',
        );
        return;
      }

      const checkedAtMs = Date.now();
      await this.storage
        .setJson<CachedMaintenance>(CACHE_KEY, { setting, checkedAtMs })
        .catch(() => undefined);

      this.set({
        status: setting.enabled ? 'on' : 'off',
        setting,
        checkedAtMs,
        reason: null,
        fromCache: false,
      });
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
