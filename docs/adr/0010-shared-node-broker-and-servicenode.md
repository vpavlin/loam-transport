# 10. One node per phone: the broker + ServiceNode seam

- **Status:** accepted
- **Date:** 2026-08 (commits `2841e08`, `8f85b72`, `621d0d2`, `490e365`)

## Context

`liblogosdelivery` is **process-global**: one Waku node per process. If every Logos app
on a phone embeds its own node, they multiply battery, data, and connections — and can't
all bind the shard cleanly. We want **one node shared** across apps.

## Decision

Split the transport behind a **broker seam** with two backends, selected lazily
(`preferServiceBackend()`):

- **RealNode** — an in-process embedded node (the fallback when no shared service is
  installed).
- **ServiceNode** — an AIDL client to a **shared Android foreground service** that owns
  the single node; apps bind as **multi-tenant** clients (`registerClient` /
  `clientSubscribe` / `unregisterClient`), and the service proxies peers/mesh metrics and
  publish confirmations back.

Access is **consent-gated**: an app's tenancy is approved by package+cert; unapproved
apps reveal nothing and are re-prompted (`serviceAwaitingApproval()`). If the service is
down, apps fall back to an embedded node (`serviceNodeDown()` / `launchSharedService()`).

## Rejected

- **A node per app** — the battery/data/shard multiplication above.
- **A shared node with no consent** — one app could sniff another's traffic; the tenancy
  approval is the privacy boundary.

## Consequences

- Multiple apps share one node with per-tenant isolation and a graceful embedded
  fallback.
- Chat apps (liblogoschat) can't join this seam — they run a *different* node/protocol;
  true convergence there is a separate, lib-level effort.

## Amendment (2026-09-29)

- **Subscribe order.** The broker records a topic's owner **before** calling `node.subscribe`, and a failed
  node subscribe is retried (`nodeSubPending`). Before this, an offline join left the topic with no owner,
  so every BLE frame for it was dropped as "unowned".
- **Known gap: a service with no node.** When Loam dies (a crash, or Android killing it), a client's bind
  restarts the Loam *process* and the service answers, but the node lives in `App.tsx` and only starts
  when the Loam UI opens. Clients look connected, their requests are buffered until `jsReady`, and nothing
  syncs until someone opens Loam. The planned fix is to boot the node headlessly (a `boot()` shared by the
  UI and a headless task that the service starts).

**Review follow-up (2026-09-29):**
- `RealNode.joinedTopics` holds only topics whose subscribe + channelCreate succeeded.
- Topics requested before the node is ready, or whose join failed, sit in `pendingTopics`. They are joined right after settle and retried on every renew tick, so the broker's `nodeSubPending` retry and start-up joins actually take effect.
