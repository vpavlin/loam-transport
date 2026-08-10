# Changelog

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

## 0.3.0
- Multi-tenant API for the shared-delivery SERVICE: `registerClient`/`clientSubscribe`/
  `unregisterClient` + `Tenant.close()`. Single-app consumers (qaku/kym) unchanged.

## 0.4.0
- `ServiceNode` (AIDL-client UnderlyingNode) + lazy backend selection: `preferServiceBackend(true, appId)`
  makes a client route through the device-wide Logos Delivery service; default stays RealNode.
  Fixed the tenant/adopt id mismatch (now consistently "app").

## 0.5.0
- ServiceNode proxies the shared node peers/mesh (via a new `metrics()` AIDL call) into
  `counters`, so a client using the shared node shows real status + the optimistic
  publish-confirmation works. Service caches metrics natively (pushed by its JS timer).

## 0.6.0
- Default node mode is now **Edge** (mobile-safe: works on cellular + WiFi, lighter).
  Core is the opt-in "stable WiFi, relay for the network" mode.

## 0.7.0
- Client is now an SDK: the AIDL + bind module + `withDeliveryClient` plugin ship IN the
  package (native/deliveryclient + plugins/), resolving native from the package itself. A
  consuming app just enables the plugin + calls preferServiceBackend() — no vendored files.
- ServiceNode gains reconnect (re-bind + re-register + re-subscribe on service restart, grant
  persists so no re-prompt), node-down detection, and launchService().

## 0.7.1
- Import sha256 from `@noble/hashes/sha2` (works across @noble 1.4+ AND 2.x) instead of the
  removed `/sha256` subpath — so consumers on any recent @noble version build.

## 0.7.2
- Fallback: if the shared service is selected but not bindable (Logos Delivery not
  installed), start() falls back to an embedded node instead of throwing.
- Expose usingServiceBackend()/serviceNodeDown()/launchSharedService() so an app can show a
  "Logos Delivery not running — Open" prompt.

## 0.8.0
- Health/metrics gated behind approval: an unapproved client gets {authorized:false} (no
  peers/mesh) and its read re-surfaces the "Allow?" request. ServiceNode exposes
  isAwaitingApproval()/serviceAwaitingApproval() so the app shows "waiting for approval".
