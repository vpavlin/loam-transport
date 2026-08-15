# Changelog

## 0.10.0 — 2026-08-15
- **Renamed `logos-transport` → `loam-transport`.** Package name, README/HANDOVER
  titles, and repo URL (`github.com/vpavlin/loam-transport`) now use the Loam brand.
  The SDK entry file `src/logos-transport.ts`, the re-export shim, the C++ umbrella
  `basecamp/logos_transport.hpp`, and the JNI names (`withLogosDelivery.js`,
  `LogosMessagingModule`, `com.receiverandroid`, `native/logosdelivery/`) are
  **deliberately kept** under the old name — renaming them would break the prebuilt
  `.so` link and the shared IPC contract.
- **BLE offline mesh as a second bearer (ADR 0012).** `src/bearer.ts` adds a
  `Bearer` abstraction with a `BleMeshBearer` (hop-limited flood/relay + seen-set) and
  a `MultiBearer` that fans one publish to every bearer and dedupes receives. Same
  sealed bytes ride BLE when there's no fleet/internet. Register a native GATT radio
  once with `setMeshRadio(factory)`; the transport auto-arms the mesh when peers
  appear. `forceMesh(on)` pins it; `meshPeers()` reports reachable peers.
- **Desktop BLE relay gateway (ADR 0013)** and **identity-first BLE connections
  (ADR 0014).**
- **Shared-node UI components.** `SharedNodeBanner`, `SharedNodeStatus`, and
  `LoamDebug` ship in the package so consuming apps drop in status/approval UI instead
  of hand-rolling it.
- **`preferServiceBackend` re-wire fix** (commits `eac97b1`/`3e75fb1`). Selecting the
  shared backend after the embedded node was already wired (e.g. a status widget's
  `refreshPeerInfo()` ran first) left the app on its own node with no approval prompt;
  the fix re-wires the backend cleanly so the switch takes effect.
- App-side **`preloadGrants`** eager-paint: known grants load up front so the shared
  status renders immediately instead of flashing "awaiting approval".
- docs: ADR log now spans 0000–0014.

## 0.9.0 — 2026-08-13
- **Per-tenant offline cache (ADR 0011).** The shared node keeps a backgrounded app's
  subscription alive and buffers its (opaque, sealed) messages instead of dropping
  them; on reopen the app drains the buffer in order, then reconciles only the
  remainder. Opt-in per approved app (`cacheLimit`); bounded ring; `dropped > 0`
  signals the app to still run catch-up. New broker API: `Tenant.detach()`/
  `reattach()`/`cacheLimit`/`lastReplay`; `registerTenant(id,{cacheLimit})`;
  `registerClient(...,{cacheLimit})` (re-register reattaches) / `unregisterClient(id,
  {hard?})`. Test: `test/broker-cache.test.ts`.
- docs: ADR log gained 0000–0014 (the "why" behind the spec).

## 0.8.0
- Health/metrics gated behind approval: an unapproved client gets {authorized:false} (no
  peers/mesh) and its read re-surfaces the "Allow?" request. ServiceNode exposes
  isAwaitingApproval()/serviceAwaitingApproval() so the app shows "waiting for approval".

## 0.7.2
- Fallback: if the shared service is selected but not bindable (Logos Delivery not
  installed), start() falls back to an embedded node instead of throwing.
- Expose usingServiceBackend()/serviceNodeDown()/launchSharedService() so an app can show a
  "Logos Delivery not running — Open" prompt.

## 0.7.1
- Import sha256 from `@noble/hashes/sha2` (works across @noble 1.4+ AND 2.x) instead of the
  removed `/sha256` subpath — so consumers on any recent @noble version build.

## 0.7.0
- Client is now an SDK: the AIDL + bind module + `withDeliveryClient` plugin ship IN the
  package (native/deliveryclient + plugins/), resolving native from the package itself. A
  consuming app just enables the plugin + calls preferServiceBackend() — no vendored files.
- ServiceNode gains reconnect (re-bind + re-register + re-subscribe on service restart, grant
  persists so no re-prompt), node-down detection, and launchService().

## 0.6.0
- Default node mode is now **Edge** (mobile-safe: works on cellular + WiFi, lighter).
  Core is the opt-in "stable WiFi, relay for the network" mode.

## 0.5.0
- ServiceNode proxies the shared node peers/mesh (via a new `metrics()` AIDL call) into
  `counters`, so a client using the shared node shows real status + the optimistic
  publish-confirmation works. Service caches metrics natively (pushed by its JS timer).

## 0.4.0
- `ServiceNode` (AIDL-client UnderlyingNode) + lazy backend selection: `preferServiceBackend(true, appId)`
  makes a client route through the device-wide Logos Delivery service; default stays RealNode.
  Fixed the tenant/adopt id mismatch (now consistently "app").

## 0.3.0
- Multi-tenant API for the shared-delivery SERVICE: `registerClient`/`clientSubscribe`/
  `unregisterClient` + `Tenant.close()`. Single-app consumers (qaku/kym) unchanged.

## 0.2.0
- Mobile transport now runs over a multi-tenant **broker seam** (`src/broker.ts`
  `SharedDeliveryNode`+`Tenant`+`UnderlyingNode`, `src/real-node.ts` `RealNode`).
  The single liblogosdelivery node lives behind an `UnderlyingNode`; receives are
  demuxed by content topic. `src/logos-transport.ts` keeps its exact public API.
  Proven on-device in qaku 0.1.53 (behaviour-identical to the pre-broker transport).
  This is the seam a future device-wide shared delivery service plugs into —
  swap `RealNode` for an IPC-backed node and the app side is unchanged.

## 0.1.0
- Initial extraction from KYM + qaku (mobile `src/`/`native/`/`plugins/`, C++ `basecamp/`).
