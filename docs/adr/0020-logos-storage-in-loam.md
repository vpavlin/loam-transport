# 20. Logos Storage in Loam (one fetch client per phone)

- **Status:** accepted, amended 2026-10-23 (background jobs, cancel, cache; see the amendment at the end)
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

## Amendment 2026-10-23: background jobs, cancel, a cache that survives

Backpack (an app store on Logos Storage: github.com/vpavlin/backpack) is the second user after Scala,
and it changed two requirements. Its APKs are 1-70 MB, so a fetch takes minutes. And when the user
leaves the app, Android cuts its network, so the download dies. Loam's foreground service keeps the
network, so a fetch started there should outlive the app that asked for it.

**Loam knows CIDs, not file types.** Nothing in Loam understands APKs, snapshots or attachments. An app
asks for a CID. Loam brings it into its local store and cache, and hands the bytes back when the app
asks again. Checking what the bytes are (Backpack: SHA-256 and APK signer) stays in the app.

### The API (replaces the sketch above)

```
storage.fetch(cid, { bootstrap?: Peer[] })  -> { state }          start or join a background job; returns at once
storage.status(cid)                         -> { state, bytes, total, error? }
storage.cancel(cid)                         -> { state }
storage.open(cid)                           -> ParcelFileDescriptor (read-only) | error   only when state = done
storage.info()                              -> { running, online, peers, cacheBytes, cacheCap, jobs }
```

- **A fetch is a job, keyed by CID, not by caller.** Two apps asking for the same CID share one job. The
  job runs in Loam's service: the requesting app may close, and Android may kill it. When it comes back,
  `status(cid)` says how far it got; `open(cid)` gives the bytes without touching the network.
- **States:** `queued`, `fetching`, `done`, `failed` (with `offline`, `no-peers`, `not-found` or
  `timeout`, as above), `cancelled`. Progress is a poll of `status`, not a stream of events: the app
  may not be alive to receive events, and polling once a second is cheap over AIDL.
- **Cancel** calls `storage_download_cancel` from a second thread (the storage thread is the one blocked
  in the download), then drops the CID's blocks. Any app that joined the job can cancel it. Jobs are
  per CID, so cancelling for one app cancels it for all; acceptable while one app asks for any given CID.
- **Bootstrap peers** come from the caller: a Backpack repo link or a Scala invite carries the node that
  holds the CID, and Loam dials it directly before fetching (NAT-ed phones can't rely on discovery).
- **Jobs run one at a time** on Loam's storage thread (libstorage's C calls block). The queue is FIFO.
  A small CID queued behind a 70 MB one waits; acceptable for now, revisit with a second lane.

### The cache

- **Completed CIDs are plain files** under Loam's files dir, named by CID, written by
  `storage_download_stream`. `open` hands out a read-only descriptor to that file.
- **libstorage's own data dir is scratch.** It is wiped when the node starts. Backpack found that a data
  dir left by a download that was killed makes the next download hang; reusing it across process deaths
  is not safe yet. The finished files are the cache, not the block store.
- **Cap and eviction:** a size cap (default 1 GB, set in Loam), LRU by last `open`. A file is never
  evicted while its job is running or within an hour of finishing and not yet opened. That gives an app
  that started a fetch time to come back for it.
- **Per-app accounting** for the UI ("Backpack: 340 MB"), not enforcement. Every app that fetched a CID
  counts it.

### What Backpack learned that applies here

- **Library:** logos-storage-nim PR #1540 (d82d0d39 + a2a353e). Older builds stall on multi-block
  downloads (the "manifest arrives, blocks never do" swarm bug), and Scala's prebuilt arm64 build
  crashed inside fetch. See backpack ADR 0005.
- **JNI:** a timed-out call must mark its response "abandoned", so the late callback doesn't write
  freed memory. `storage_fetch` returns once the manifest is in; most blocks arrive during
  `download_stream`, so progress is measured from the output file and the block store together.
- **Speed is round-trip bound:** publishers should upload with 512 KiB blocks (backpack ADR 0006).
  Nothing in Loam depends on it.
- **The node starts once per process and is never restarted in-process** (a second `start` aborts, and
  an in-process restart hung the next download). Idle-out therefore means stopping the node and
  letting the process keep it stopped until the next fetch, not a restart loop.

### Rollout (progressive)

1. **Loam:** the storage service (libstorage + JNI from Backpack, PR #1540 build), the job queue, the
   cache, and the AIDL methods, **appended after the existing ones**. Approval: the existing per-app
   grant covers Storage too (same consent: "this app may use Loam's network").
2. **loam-transport:** a `storage` client module (`fetch/status/cancel/open/info`) over the existing
   binding, returning `null` when the Loam service has no Storage.
3. **Backpack:** uses Loam's Storage when present, keeps its embedded node as the fallback. Downloads
   continue with the app closed; reopening shows the job's progress and picks up the file.
4. **Scala**, then other apps, move their snapshot and attachment fetches over, and drop their copies
   of libstorage once Loam with Storage is common.

