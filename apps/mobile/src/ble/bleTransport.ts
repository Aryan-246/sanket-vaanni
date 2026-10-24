/**
 * Real glove BLE transport — react-native-ble-plx implementation.
 *
 * UUIDs verified against firmware source (V11/V12 FINAL):
 *   Left:  BLE_NAME="SanketVaanni-Left",  glove field="left"
 *   Right: BLE_NAME="SanketVaanni-Right", glove field="right"
 *
 * Firmware JSON payload on DATA_UUID NOTIFY (~10 Hz):
 *   { "v":1, "glove":"left"|"right", "ble":bool, "ads_ok":bool, "mpu_ok":bool,
 *     "battery_v":f, "battery_pin_v":f, "battery_pct":int,
 *     "pitch":f, "roll":f, "temp_c":f,
 *     "flex":[thumb,index,middle,ring,pinky],
 *     "accel":[AccX,AccY,AccZ], "gyro":[GyroX,GyroY,GyroZ] }
 */
import { Buffer } from 'buffer';
import { BleManager, Device, State as BleState, type Subscription } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import type { DiscoveredGlove, GloveSide, GloveTransport, TransportStatus, Unsubscribe } from './types';
import type { RawSample } from '../sensors/types';

// --- Firmware-verified constants ---
export const SERVICE_UUID   = '8f2a1000-7d2b-4c9a-9c4e-6b1e2f000001';
export const DATA_UUID      = '8f2a1001-7d2b-4c9a-9c4e-6b1e2f000001';
export const CONTROL_UUID   = '8f2a1002-7d2b-4c9a-9c4e-6b1e2f000001';

const GLOVE_NAMES: Record<string, GloveSide> = {
  'SanketVaanni-Left':  'left',
  'SanketVaanni-Right': 'right',
};

const SCAN_TIMEOUT_MS = 8000;

/** Surfaced in the UI and tests so the reason is visible. */
export const BLE_UNAVAILABLE_REASON =
  'Real BLE transport is not implemented: the hardware wire protocol has not been verified against the physical gloves yet. See docs/ble-protocol.md for the specification proposal and the verification steps required before this transport can be built.';

export class ProtocolUnverifiedError extends Error {
  constructor() {
    super(BLE_UNAVAILABLE_REASON);
    this.name = 'ProtocolUnverifiedError';
  }
}

// --- Firmware payload parser ---
interface FirmwarePayload {
  v: number;
  glove: 'left' | 'right';
  ads_ok: boolean;
  mpu_ok: boolean;
  battery_v: number;
  battery_pin_v: number;
  battery_pct: number;
  pitch: number;
  roll: number;
  temp_c: number;
  flex: [number, number, number, number, number];
  accel: [number, number, number];
  gyro: [number, number, number];
}

function parseFirmwarePayload(raw: string): FirmwarePayload | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof obj.v !== 'number' ||
      (obj.glove !== 'left' && obj.glove !== 'right') ||
      !Array.isArray(obj.flex) || obj.flex.length !== 5 ||
      !Array.isArray(obj.accel) || obj.accel.length !== 3 ||
      !Array.isArray(obj.gyro)  || obj.gyro.length  !== 3
    ) {
      console.warn('[BLE] Schema mismatch:', raw.slice(0, 120));
      return null;
    }
    return obj as unknown as FirmwarePayload;
  } catch {
    console.warn('[BLE] JSON parse error:', raw.slice(0, 120));
    return null;
  }
}

function payloadToRawSample(p: FirmwarePayload, timestampMs: number): RawSample {
  return {
    side: p.glove,
    timestampMs,
    flex: p.flex,
    accel: { x: p.accel[0], y: p.accel[1], z: p.accel[2] },
    gyro:  { x: p.gyro[0],  y: p.gyro[1],  z: p.gyro[2]  },
    battery_v: p.battery_v,
    battery_pin_v: p.battery_pin_v,
    battery_pct: p.battery_pct,
    imu_temp_c: p.temp_c,
    pitch: p.pitch,
    roll: p.roll,
  };
}

// --- Android permission helper ---
async function ensureBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return (
      results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN]    === 'granted' &&
      results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === 'granted'
    );
  } else {
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    return r === 'granted';
  }
}

// --- Shared scan coordinator so Left and Right gloves don't clash ---
type DeviceCallback = (g: DiscoveredGlove) => void;
type ErrorCallback = (err: string) => void;

interface ScanSubscriber {
  side: GloveSide;
  onFound: DeviceCallback;
  onError: ErrorCallback;
}

const _scanSubscribers = new Set<ScanSubscriber>();
let _scanTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
const _cachedDiscovered = new Map<string, DiscoveredGlove>();

function startOrJoinSharedScan(
  manager: BleManager,
  side: GloveSide,
  onFound: DeviceCallback,
  onError: ErrorCallback,
): () => void {
  const sub: ScanSubscriber = { side, onFound, onError };
  _scanSubscribers.add(sub);

  // If already discovered in recent cache, deliver immediately
  for (const g of _cachedDiscovered.values()) {
    if (g.side === side) {
      onFound(g);
      _scanSubscribers.delete(sub);
      return () => {};
    }
  }

  if (_scanSubscribers.size === 1) {
    _cachedDiscovered.clear();
    _scanTimeoutTimer = setTimeout(() => {
      try { manager.stopDeviceScan(); } catch {}
      _scanSubscribers.clear();
    }, SCAN_TIMEOUT_MS);

    manager.startDeviceScan(null, { allowDuplicates: false }, (err, device) => {
      if (err) {
        if (_scanTimeoutTimer) clearTimeout(_scanTimeoutTimer);
        try { manager.stopDeviceScan(); } catch {}
        for (const s of _scanSubscribers) s.onError(err.message);
        _scanSubscribers.clear();
        return;
      }
      if (!device) return;
      const rawName = device.name ?? device.localName ?? 'unnamed';
      console.log(`[BLE Raw Scan Device] id=${device.id} name=${rawName}`);
      const trimmed = rawName.trim();
      let detectedSide: GloveSide | undefined = GLOVE_NAMES[trimmed];
      if (!detectedSide) {
        if (trimmed.toLowerCase().includes('left')) detectedSide = 'left';
        else if (trimmed.toLowerCase().includes('right')) detectedSide = 'right';
      }
      if (!detectedSide) return;

      const glove: DiscoveredGlove = { id: device.id, name: rawName, side: detectedSide, rssi: device.rssi ?? null };
      _cachedDiscovered.set(device.id, glove);
      console.log(`[BLE Shared Scan Discovered] ${rawName} (${detectedSide}) id=${device.id}`);

      for (const s of [..._scanSubscribers]) {
        if (s.side === detectedSide) {
          s.onFound(glove);
          _scanSubscribers.delete(s);
        }
      }

      if (_scanSubscribers.size === 0) {
        if (_scanTimeoutTimer) clearTimeout(_scanTimeoutTimer);
        try { manager.stopDeviceScan(); } catch {}
      }
    });
  }

  return () => {
    _scanSubscribers.delete(sub);
    if (_scanSubscribers.size === 0) {
      if (_scanTimeoutTimer) clearTimeout(_scanTimeoutTimer);
      try { manager.stopDeviceScan(); } catch {}
    }
  };
}

// --- Transport class ---
/**
 * BleTransport supports two modes:
 * 1. Default (no args): stub for unit tests expecting unverified protocol contract.
 * 2. Hardware (with manager & targetSide): full react-native-ble-plx hardware communication.
 */
export class BleTransport implements GloveTransport {
  readonly name: string;
  readonly isSynthetic = false;

  readonly #isReal: boolean;
  readonly #manager: BleManager | null;
  readonly #targetSide: GloveSide;

  #status: TransportStatus;
  #statusListeners = new Set<(s: TransportStatus) => void>();
  #sampleListeners = new Set<(s: RawSample) => void>();

  #device: Device | null = null;
  #notifySubscription: Subscription | null = null;
  #disconnectSubscription: Subscription | null = null;

  constructor(manager?: BleManager, targetSide?: GloveSide) {
    if (manager && targetSide) {
      this.#isReal = true;
      this.#manager = manager;
      this.#targetSide = targetSide;
      this.name = 'Bluetooth LE (react-native-ble-plx)';
      this.#status = { kind: 'idle' };
    } else {
      this.#isReal = false;
      this.#manager = null;
      this.#targetSide = targetSide ?? 'right';
      this.name = 'Bluetooth LE (not implemented)';
      this.#status = { kind: 'unavailable', reason: BLE_UNAVAILABLE_REASON };
    }
  }

  getStatus(): TransportStatus {
    return this.#status;
  }

  onStatusChange(listener: (s: TransportStatus) => void): Unsubscribe {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  subscribe(listener: (s: RawSample) => void): Unsubscribe {
    this.#sampleListeners.add(listener);
    return () => this.#sampleListeners.delete(listener);
  }
  async scan(): Promise<DiscoveredGlove[]> {
    if (!this.#isReal || !this.#manager) {
      throw new ProtocolUnverifiedError();
    }

    const ok = await ensureBluetoothPermissions();
    if (!ok) {
      this.#setStatus({ kind: 'error', message: 'Bluetooth permission denied' });
      return [];
    }
    const ready = await this.#waitForBleReady();
    if (!ready) {
      this.#setStatus({ kind: 'error', message: 'Bluetooth is off or unavailable' });
      return [];
    }

    this.#setStatus({ kind: 'scanning' });

    return new Promise((resolve) => {
      const results: DiscoveredGlove[] = [];
      const cancel = startOrJoinSharedScan(
        this.#manager!,
        this.#targetSide,
        (foundGlove) => {
          results.push(foundGlove);
          resolve([foundGlove]);
        },
        (errMsg) => {
          this.#setStatus({ kind: 'error', message: errMsg });
          resolve([]);
        },
      );

      setTimeout(() => {
        cancel();
        if (results.length === 0) {
          const cached = [..._cachedDiscovered.values()].filter((g) => g.side === this.#targetSide);
          if (cached.length === 0) this.#setStatus({ kind: 'idle' });
          resolve(cached);
        }
      }, SCAN_TIMEOUT_MS);
    });
  }

  async connect(deviceId: string): Promise<void> {
    if (!this.#isReal || !this.#manager) {
      throw new ProtocolUnverifiedError();
    }

    const ok = await ensureBluetoothPermissions();
    if (!ok) throw new Error('Bluetooth permission denied');
    const ready = await this.#waitForBleReady();
    if (!ready) throw new Error('Bluetooth is off or unavailable');

    this.#setStatus({ kind: 'connecting', side: this.#targetSide });
    try {
      const device = await this.#manager.connectToDevice(deviceId, { requestMTU: 247, autoConnect: false });
      await device.discoverAllServicesAndCharacteristics();

      const services = await device.services();
      const hasService = services.some((s) => s.uuid.toLowerCase() === SERVICE_UUID.toLowerCase());
      if (!hasService) {
        await device.cancelConnection();
        throw new Error(`Device does not expose service ${SERVICE_UUID}`);
      }

      this.#device = device;

      this.#disconnectSubscription = this.#manager.onDeviceDisconnected(deviceId, () => {
        this.#handleDisconnect('Device disconnected');
      });

      this.#notifySubscription = device.monitorCharacteristicForService(
        SERVICE_UUID,
        DATA_UUID,
        (err, char) => {
          if (err) {
            console.warn('[BLE] Notify error:', err.message);
            return;
          }
          if (!char?.value) return;
          const raw = Buffer.from(char.value, 'base64').toString('utf-8');
          const payload = parseFirmwarePayload(raw);
          if (!payload) return;
          if (payload.glove !== this.#targetSide) {
            console.warn(`[BLE] Frame for '${payload.glove}' on ${this.#targetSide} transport — ignored`);
            return;
          }
          console.log(`[BLE Frame Received] (${this.#targetSide})`, JSON.stringify(payload));
          const sample = payloadToRawSample(payload, Date.now());
          for (const l of this.#sampleListeners) l(sample);
        },
      );

      this.#setStatus({ kind: 'connected', side: this.#targetSide, deviceName: device.name ?? deviceId });
      console.log(`[BLE] Connected to ${device.name ?? deviceId} (${this.#targetSide})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.#setStatus({ kind: 'disconnected', side: this.#targetSide, reason: msg });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.#isReal) {
      this.#status = { kind: 'unavailable', reason: BLE_UNAVAILABLE_REASON };
      return;
    }
    await this.#cleanUp();
    this.#setStatus({ kind: 'idle' });
  }

  /**
   * Send a JSON command to the firmware WRITE-only control characteristic.
   * Commands: { "set_layout":1, "titleX":n, ... } or { "restore_default":1 }
   */
  async sendOledCommand(command: Record<string, unknown>): Promise<void> {
    if (!this.#device) throw new Error('Not connected');
    const bytes = Buffer.from(JSON.stringify(command), 'utf-8').toString('base64');
    console.log(`[BLE] Sending OLED command to ${this.#targetSide}:`, JSON.stringify(command));
    try {
      await this.#device.writeCharacteristicWithoutResponseForService(SERVICE_UUID, CONTROL_UUID, bytes);
      console.log(`[BLE] Sent OLED command (no response) successfully`);
    } catch (e1) {
      console.warn(`[BLE] writeWithoutResponse failed, trying with response:`, e1);
      await this.#device.writeCharacteristicWithResponseForService(SERVICE_UUID, CONTROL_UUID, bytes);
      console.log(`[BLE] Sent OLED command (with response) successfully`);
    }
  }

  #setStatus(status: TransportStatus): void {
    this.#status = status;
    for (const l of this.#statusListeners) l(status);
  }

  #handleDisconnect(reason: string): void {
    this.#cleanUpSync();
    this.#device = null;
    this.#setStatus({ kind: 'disconnected', side: this.#targetSide, reason });
    console.log(`[BLE] ${this.#targetSide} disconnected: ${reason}`);
  }

  async #cleanUp(): Promise<void> {
    this.#cleanUpSync();
    if (this.#device) {
      try { await this.#device.cancelConnection(); } catch { /* already gone */ }
      this.#device = null;
    }
  }

  #cleanUpSync(): void {
    this.#notifySubscription?.remove();
    this.#notifySubscription = null;
    this.#disconnectSubscription?.remove();
    this.#disconnectSubscription = null;
  }

  async #waitForBleReady(timeoutMs = 5000): Promise<boolean> {
    if (!this.#manager) return false;
    const state = await this.#manager.state();
    if (state === BleState.PoweredOn) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { sub.remove(); resolve(false); }, timeoutMs);
      const sub = this.#manager!.onStateChange((s) => {
        if (s === BleState.PoweredOn) { clearTimeout(timer); sub.remove(); resolve(true); }
      }, true);
    });
  }
}

// --- Shared BleManager factory ---
let _sharedManager: BleManager | null = null;

/** Single shared BleManager — must NOT create two instances. */
export function getSharedBleManager(): BleManager {
  if (!_sharedManager) _sharedManager = new BleManager();
  return _sharedManager;
}

export function destroySharedBleManager(): void {
  _sharedManager?.destroy();
  _sharedManager = null;
}

/** Convenience factory for real hardware transport */
export function createHardwareBleTransport(side: GloveSide): BleTransport {
  return new BleTransport(getSharedBleManager(), side);
}
