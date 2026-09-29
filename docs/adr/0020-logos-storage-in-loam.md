# 20. Logos Storage in Loam (one fetch client per phone)

- **Status:** proposed
- **Date:** 2026-09-29
- **Builds on:** [0010](0010-shared-node-broker-and-servicenode.md) (shared node + ServiceNode),
  [0007](0007-reconnect-watchdog.md) (online detection)

## Context

Scala fetches snapshots (and later attachments) from **Logos Storage**. On Android it embeds its own
Storage node: a cross-compiled `libstorage` (22 MB, reproducible build with the nim-libp2p IPv6 dial
fix, `scala/mobile/native/logosstorage/`) behind a small JS wrapper (`init / connect / exists / fetch /
downloadToFile`). Android Storage is **fetch-only**. Publishing happens on hubs and desktops.

Embedding it per app has the costs that made us move Logos Delivery into Loam (0010):

- **Every app ships and runs its own copy:** a 22 MB library, its own ports, peers and DHT state, and a
  cache only it can use. Kith, qaku attachments and anything later would each repeat this.
- **Every app handles connectivity itself, and does it badly.** Scala gives a snapshot a 20 s head start
  before falling back to a normal sync, because it can't tell "slow" from "offline". Offline it waits the
  full 20 s for nothing.
- **Bugs get fixed per app.** The IPv6 dial fix had to be rebuilt into Scala specifically.

Loam already knows what an app can't: whether Android has validated internet, how many peers the node
has, and whether the BLE mesh is up.

## Decision

Loam hosts **one Logos Storage fetch client for the whole phone**, beside the Delivery node. Apps reach it
through the existing ServiceNode binding (same approval and consent) with a small API:

```
storage.fetch(cid, { bootstrap?: SPR[] })  -> { state, fd?, size? }  + progress events
storage.status()                           -> { running, peers, online, cacheBytes }
storage.cached(cid)                        -> boolean
```

- **The result is a state, not a boolean:** `cached` (served from Loam's cache, no network), `fetched`,
  `offline` (no validated internet: **fails immediately**), `no-peers` (online, but nothing to fetch
  from), `not-found`, `timeout`. The app can tell the user something true, and fall back at once, e.g.
  Scala sends its sync request instead of waiting 20 s.
- **Content crosses as a file descriptor, never as bytes.** A binder transaction is capped at about 1 MB,
  so `fetch` returns a `ParcelFileDescriptor` to the cached file (read-only), plus progress events while
  it downloads. Bootstrap SPRs from the caller (e.g. from a Scala invite) are merged into Loam's set.
- **A shared, content-addressed cache.** Anything any app fetched is served locally to every app. A CID
  is self-verifying, so sharing needs no trust between apps. Eviction is LRU with a size cap.
- **The node runs only while needed.** It starts on the first `fetch` (or at boot if a client asks) and
  idles out after a quiet period. Online detection reuses `LoamMesh.online()` (0007 amendment).
- **Migration.** Scala keeps its embedded client as a fallback while Loam is absent or older than the
  version with Storage, then drops it (and 22 MB).

## Rejected

- **Keep Storage per app.** Duplicate nodes, caches, fixes and connectivity heuristics in every app.
- **Return bytes over AIDL.** Breaks on anything near the 1 MB binder limit (snapshots of large calendars,
  attachments).
- **A full Storage node (serve and publish) on phones.** Battery, data and background limits; publishing
  stays on hubs and desktops, which are always on.

## Consequences

- One library, one set of fixes, one cache. Apps get fast, explicit failure offline.
- **It depends on the headless boot (0010 amendment).** A bind-restarted Loam must start the Storage
  client too, or `fetch` would fail even when online.
- New AIDL methods mean a new Loam service version. **Append them after the existing methods**: inserting
  before `metrics()` shifted transaction ids and broke every client once already.

## Later

- **Small cached files phone-to-phone over the BLE mesh.** The cache is content-addressed and BLE
  fragments up to ~130 KB (0019), so a snapshot could reach an offline phone from a neighbour that has it.
- Prefetch hints, such as "this calendar's latest snapshot", so Loam can warm the cache while online.
