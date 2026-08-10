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
