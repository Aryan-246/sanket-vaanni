# Glove input layer — what is built, and what is blocked

**Status: the app's half is finished and tested. The hardware's half is not started,
because the wire protocol is unverified.**

This document is about the layer between the phone and a real glove: the connection
manager, the contracts it speaks, the lifecycle it goes through, the screen that shows
its state, and the tests that hold all of that in place. It exists so that the answer to
"can the app talk to a real glove?" is written down in one place, with the evidence, and
with the exact list of what is missing.

It does **not** restate the protocol unknowns — those are in `ble-protocol.md`, which is
the checklist for whoever owns the firmware. Nothing here replaces it.

The one-line verdict: **the app cannot connect to a real glove today, and nothing in the
app pretends otherwise.**

---

## 1. What is built and verified

| Piece | Where | State |
|---|---|---|
| Transport contract | `src/ble/types.ts` | Complete. `GloveTransport` + `TransportStatus` + `SuspendableTransport`. |
| Connection state machine | `src/ble/link.ts` | Complete. Pure reducer over eight states, with health and label helpers. |
| Connection manager | `src/ble/controller.ts` | Complete. `GloveController`: scan, connect, disconnect, retry, pause/resume, dispose, staleness, throttled snapshot **and** an unthrottled frame stream. |
| Real transport | `src/ble/bleTransport.ts` | **Deliberately inert.** Every method refuses with the reason. |
| Simulated transport | `src/ble/mockTransport.ts` | Complete. Deterministic 20 Hz frame source, labelled synthetic. |
| Error / status UI | `src/components/GloveConnectionBar.tsx`, `GloveCard.tsx`, `GloveStatusStrip.tsx` | Complete. Renders every state with its reason; no state is invented at display time. |
| Tests — through the UI | `__tests__/device-state.test.tsx` | 15 cases: the connection card in each state, and the two controller cases that matter to a person. |
| Tests — the contract | `__tests__/ble-input-layer.test.ts` | 35 cases: the state machine, the inert transport, the simulated transport's lifecycle, and the controller's own guarantees. |

Verified with:

```
npx jest __tests__/ble-input-layer.test.ts   ->  35 passed
npx jest                                     ->  48 suites, 886 tests, all passing
npx tsc --noEmit                             ->  clean
npx eslint src/ble/controller.ts __tests__/ble-input-layer.test.ts  ->  0 errors, 0 warnings
```

### The four guarantees the tests actually pin

1. **A connection cannot be fabricated.** `connected` is reachable by exactly one
   action, dispatched by exactly one caller, and only after the transport reports it.
   The suite enumerates every other action from every reachable state and asserts none
   of them lands there. The inert transport cannot be left looking connected even after
   a failed `scan`/`connect`/`disconnect`.
2. **A recorder sees every frame; the UI does not have to.** `subscribe` is throttled to
   12 Hz so a sample does not re-render the dashboard, but `onFrame` is not throttled at
   all. A window built from the throttled stream would be missing roughly two frames in
   five, and `ml/window.ts` would then interpolate across gaps the glove never had.
3. **One hand cannot be cross-fed with the other's motion.** A frame whose `side` does
   not match the controller's is dropped. How the two gloves are told apart on the wire
   is unknown, so no code may infer it.
4. **Pausing does not drop the link, and disposing does.** A paused glove stops
   producing frames while the connection stays up, so the user does not come back to a
   glove the app silently let go of. `dispose` detaches both subscriptions and is
   idempotent.

## 2. What is blocked, and by what

`BleTransport` refuses every operation with:

> Glove BLE is not implemented: the firmware protocol (service/characteristic UUIDs,
> frame layout, sample rate) has not been verified. See docs/ble-protocol.md.

The blocker is **external and single**: the glove firmware's BLE protocol has not been
read from a source of truth. `ble-protocol.md` lists the twelve questions; the first
seven block any implementation. No answer to any of them exists in this repository, and
none may be inferred — a plausible-looking UUID is worse than no UUID, because it looks
finished.

## 3. What the swap actually needs

`bleTransport.ts` says "swapping it in later touches one file, not the UI". That is
**half true**, and the missing half matters for planning:

- **The UI is untouched.** True, and that is what the interface was for.
- **One file changes.** True: `bleTransport.ts` is replaced with a real implementation
  speaking the verified protocol; `AppState` still receives it as an injected
  `GloveTransport`.
- **The build does not stay untouched.** React Native has no built-in BLE, so a native
  dependency has to be installed and autolinked, and the app has to be rebuilt. This is
  a native change, not a JavaScript one.
- **The manifest has nothing to work with.** The app declares no Bluetooth permission at
  all today. With `minSdkVersion 24` and `targetSdkVersion 36`, both eras are needed:

  | Permission | Era | Why |
  |---|---|---|
  | `BLUETOOTH_SCAN` | API 31+ | Discovering gloves. |
  | `BLUETOOTH_CONNECT` | API 31+ | Connecting, and reading the device name. |
  | `BLUETOOTH`, `BLUETOOTH_ADMIN` (`maxSdkVersion="30"`) | API ≤30 | The same two capabilities before they were split. |
  | `ACCESS_FINE_LOCATION` (`maxSdkVersion="30"`) | API ≤30 | The platform requires it to return scan results on those versions. |
  | `uses-feature android:hardware.bluetooth_le` `required="false"` | — | Keeps the app installable on a phone without BLE. |

  These are deliberately **not declared yet.** Declaring a permission the app cannot use
  would tell a reviewer (and, on older versions, an installer) that this app does
  something with Bluetooth, which today it does not. They are written down here so that
  the change is a known, reviewed list rather than a discovery at swap time.

Two further consequences worth stating before anyone starts:

- **The protocol version has to travel with the frame.** `ml/` records which calibration
  produced a window; a real transport has to record which protocol revision did, or a
  model trained on one firmware revision cannot be told apart from one trained on another.
- **`sourceFor` keys off the transport, not the user.** A session records `simulated` for
  the Demo Mode producer and `glove` for anything else. If a real transport were ever to
  report itself as non-synthetic while producing synthetic frames, the dataset would
  silently mislabel its own provenance. The guard is that `isSynthetic` is a property of
  the transport implementation, not a setting.

## 4. A real defect found while writing these tests

`GloveController.#emit` used to return **before** rebuilding the snapshot when no
component was subscribed to the throttled channel — it only rebuilt when it was about to
notify. That is a reasonable optimisation for notification, but it makes the public
`getSnapshot()` stale for readers that are not React components.

There is exactly such a reader, and it gates a user-visible action. `AppState`'s
`gloveInfo` calls `controllers[side].getSnapshot()` to decide whether a glove is
delivering data, and that is what lets the learning centre open a recording session. A
glove can be streaming while nothing is subscribed to the throttled channel, because the
dashboard unmounts when a detail screen is pushed — and the learning centre *is* a detail
screen. In that state the snapshot still held `source: 'none'` from the last status
change, so "Start a recording session" would have refused against a working glove with
the message *"No glove is connected on the right hand, so there is nothing to record
from."*

Fixed by rebuilding the snapshot unconditionally and skipping only the notification. The
throttle is unchanged, because the gate lives in `#handleSample` before `#emit` is
called, so the rebuild still happens at most `uiHz` times a second and the snapshot stays
referentially stable between notifications — which `useSyncExternalStore` requires.

Falsified rather than assumed: with the old ordering restored, four tests in
`ble-input-layer.test.ts` fail, including `source` reading `"none"` where `"simulated"`
is expected and `packetCount` reading `0` where `1` is expected.

## 5. What the app does today

- **Demo Mode only.** The glove the app can actually connect to is `MockTransport`,
  whose device name is the sentinel `__demo__`, translated to *Demo glove (simulated)*
  wherever it is shown. Its frames are sine waves, not measurements, and every screen
  that displays them says so.
- **Nothing claims a real glove.** `BleTransport.isSynthetic` is `false` (it produces
  nothing at all — claiming `true` would put a Demo Mode badge over an empty screen), and
  the controls for it are unavailable rather than merely empty.
- **Windows recorded today are recorded as `simulated`.** A session records the transport
  that produced it, so nothing recorded through Demo Mode can be mistaken for real
  hardware data later. That is why the ML screens can be used end to end without
  overstating what they were fitted on.

## 6. What is needed to unblock this

Externally, in order:

1. The firmware's BLE protocol: the first seven items of `ble-protocol.md`, read from the
   firmware source or a live scan with `nRF Connect`. No inference.
2. One recorded frame capture from a real glove, so `BleTransport` can be tested offline
   against a fixture instead of against hardware in the room.
3. A decision on a BLE library for React Native (not currently a dependency), since the
   swap is a native change and therefore a rebuild.
4. The permission set in §3 added to the manifest and reviewed at the same time.

Until 1 arrives, the honest state of this layer is: **complete, tested, and connected to
nothing but a simulator.**
