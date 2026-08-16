# 17. The `MeshRadio` seam is the test seam: prove bearer switching headlessly with a mock radio

- **Status:** accepted (harness built; bearer-switch proven on an emulator)
- **Date:** 2026-08-16
- **Relates to:** 0012 (BLE mesh bearer), 0016 (telemetry)

## Context

The load-bearing claim of the multi-bearer design (0012) is that **loam-transport switches bearers
seamlessly** — the sync layer above it neither knows nor cares whether a sealed frame rode Waku or BLE.
That claim was untested end-to-end, and testing it looked expensive: it needs *two* nodes actually
meshing, and **Android emulators have no Bluetooth** (you cannot emulate BLE central/peripheral). Testing
only on hardware is slow, manual, and can't run in CI.

But the bug the mesh could hide isn't in the radio — it's *above* it (broker route, fan-out, dedup, the
receive hand-off). And `BleMeshBearer` already runs over an abstract **`MeshRadio`** interface
(`start/stop/peers/sendTo/onReceiveFrom`); the native GATT radio is just one implementation.

## Decision

**Treat `MeshRadio` as the test seam.** Ship a mock radio, `WsMeshRadio`, that implements the exact same
interface over a **WebSocket** to a tiny host relay (`tools/mesh-relay.js`, the "ether"). Two nodes point
their mesh radios at one relay and form a mesh with **zero Bluetooth** — so the *entire* transport
(auto-arm on degrade, `MultiBearer` fan-out, cross-bearer dedup, broker route) runs unchanged while only
the RF layer is substituted. It is selected by a build/CI flag (`EXPO_PUBLIC_MESH_WS_URL`); unset in prod
→ the native GATT radio. A headless peer (`tools/fake-peer.ts`) speaks the **real wire codec**
(`encodeFrame`/`decodeFrame`), so one emulator + the peer proves both directions.

Uses `WebSocket` (built into React Native — no native module, no extra dep) and `ws` on the host.

## Consequences

- **Bearer switching is provable headlessly** — and was proven: on an x86_64 emulator with the native
  Waku lib absent (so the *fleet bearer is down*), the transport armed the mock bearer and ran entirely
  over it — sent, received, and routed frames (`tx/rx`, delivered-to-tenant), wire byte-parity confirmed
  by the peer decoding every frame. That is exactly the "Waku dead → mesh carries everything, sync layer
  none the wiser" scenario, on demand.
- **Validates the `MeshRadio` abstraction** by exercising a second, wholly different implementation.
- **CI-friendly:** no hardware, no Bluetooth, deterministic.
- Also the foundation for a two-node integration harness (a client app over the shared node → mock mesh →
  a second node), the same way `telemetry` (0016) is exercised by a Node companion + decoder.
- **Not a production path.** The mock radio and the flags are test-only; the native GATT radio remains the
  real bearer, and on-hardware BLE still needs a device.

## Alternatives considered

- **Two real emulators over TCP** — heavier (a native TCP radio module, two AVDs, RAM pressure) for no
  extra coverage over the WebSocket mock.
- **Only unit-test the broker/mesh in Node** — done too (pure `bearer`/`broker` tests), but it can't
  exercise the *transport's* arm/disarm + the cross-process receive; the mock radio can.
- **Hardware-only** — not repeatable, not CI-able, slow feedback.
