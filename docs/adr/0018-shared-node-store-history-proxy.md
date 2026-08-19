# 18. Shared-node cold-start history — proxy storeSync over AIDL

- **Status:** implemented (code, both repos); NOT device-verified — needs two phones on Loam
- **Date:** 2026-08-19

## Context

`RealNode.storeSync` does a cursor-paged `waku_store_query` over every joined topic — the reliable
cold-start history pull a freshly-joined app needs (SYNC_REQ only re-serves from a *live* peer, which
a phone often can't reach). On the **embedded** node this works. On the **shared** node (Loam, over
AIDL) `ServiceNode.storeSync` was a stub, so an app on Loam got live messages but never history — the
"joined but no history" bug. The AIDL surface only had `subscribe` / `send` / `metrics`; there was no
way to reach the service node's store.

## Decision

Proxy it as a **fire-and-forget trigger**, with results returned through the **existing receive
callback** — no synchronous cross-process response channel. The store query runs where the node lives
(the Loam service), and each stored message is dispatched to the requesting client exactly like a live
message, so the app folds it through its normal receive path.

Flow: `app → Client.requestStoreSync() → AIDL requestStoreSync(appId) → LogosDeliveryService →
DeliveryHub.requestStoreSync → toJs("storeSync") → service-bridge → transport.clientStoreSync(tenant)
→ SharedDeliveryNode.clientStoreSync → node.storeSync((topic,cands)=> deliver to that tenant)`.

### Changes
**loam-transport**
- `native/.../aidl/ILogosDelivery.aidl` — `void requestStoreSync(String appId)`.
- `src/broker.ts` — `UnderlyingNode.storeSync?` (optional; real node has it), and
  `SharedDeliveryNode.clientStoreSync(tenantId)` — run `node.storeSync`, deliver each candidate to the
  owning tenant via `_deliver` (the live-receive path).
- `src/logos-transport.ts` — `clientStoreSync(appId)` passthrough to the broker.
- `src/service-node.ts` — `storeSync()` now triggers `Client.requestStoreSync()` (results arrive on
  receive) instead of returning empty; graceful "update Loam" when the method is absent.
- `native/.../deliveryclient/LogosDeliveryClientModule.kt` — `@ReactMethod requestStoreSync()`.

**loam app (logos-shared-delivery)**
- `LogosDeliveryService.kt` — `override requestStoreSync → DeliveryHub.requestStoreSync`.
- `DeliveryHub.kt` — `requestStoreSync(callerKey) → toJs("storeSync", {callerKey})`.
- `service-bridge.ts` — `r.kind === "storeSync" → transport.clientStoreSync(ck)` (granted clients only).

## Consequences
- Reuses the receive path — no new IPC response channel; the app's existing fold handles it.
- The Loam app must bump its `loam-transport` submodule to include `clientStoreSync`, then rebuild.
- Consumers (scala etc.) already call `transport.storeSync(...)` in their catch-up — no app change
  needed beyond shipping the updated `loam-transport`.

## Verify (two phones on Loam)
1. Phone A creates a shared calendar + a few events (they reach the fleet store).
2. Phone B (on Loam) joins the invite, opens the app → within a few seconds the history appears.
3. `getStoreInfo()` on B reads "requested via shared node (history arrives on receive)".
4. Kill/reopen B → history still folds (idempotent by event id).
