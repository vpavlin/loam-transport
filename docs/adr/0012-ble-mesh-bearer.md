# 12. BLE mesh as a second bearer

- **Status:** accepted — **portable core built & proven (9 tests); native radio written, not yet device-verified**
- **Date:** 2026-08-13 (revised with implementation learnings)

## Context

Everything today moves over exactly one **bearer**: the internet, via a Waku node.
When the internet is down, throttled, or the venue Wi-Fi is saturated (a conference is
the canonical case — *Qaku in a packed room*), sync stops even though the people who
want to sync are **standing next to each other**. Phones in a room can talk directly
over **Bluetooth Low Energy** with no infrastructure at all. We want a device that
loses the fleet to **automatically mesh with nearby devices over BLE** and keep syncing
locally, then fold those local changes back into the fleet when the internet returns.

The good news is that most of the hard part is already solved by the layers we have —
so this is much cheaper than "build a mesh messenger."

## Why it's cheaper than it looks

Three properties of the existing stack make BLE "just another pipe":

1. **We move opaque sealed bytes, keyed by content topic** (ADR 0001). BLE doesn't need
   to understand anything — it carries the *same* sealed frames to whoever's in range.
   A BLE eavesdropper sees ciphertext, exactly like a Waku one; the crypto boundary is
   unchanged.
2. **The sync layer is bearer-agnostic and already idempotent.** `loam-sync`
   (CRDT merge + recursive-RBSR catch-up) converges an event set no matter *which* pipe
   delivered a frame — dedup is by event id. So a message that arrives over BLE and the
   same message over Waku collapse to one. **BLE needs no ordering, no reliability, no
   retransmit of its own** — the sync layer provides convergence; BLE just has to get
   frames from A to nearby B *sometimes*. Its catch-up runs over BLE unchanged: two
   phones that meet exchange RBSR fingerprints over a BLE characteristic and reconcile.
3. **The shared node is already a persistent, permissioned, device-wide service**
   (ADR 0010) with a foreground service + wakelock. That is *precisely* the process
   allowed to keep a radio alive in the background — and one BLE mesh membership shared
   by all tenant apps mirrors one Waku node shared by all apps. The offline cache
   (ADR 0011) composes for free: frames that arrive over BLE for a closed app buffer
   exactly like Waku ones.

So the feature is: **add a second bearer next to Waku, fan every outgoing sealed frame
to all active bearers, funnel every incoming frame from any bearer into the same
receive→route→tenant path.** The sync/crypto/consent layers are untouched.

## Decision

Introduce a **bearer abstraction** and a **BLE mesh bearer** beside the Waku one.

### Where it lives (answering the open question)

- **The abstraction + the mesh logic live in `loam-transport`.** Define a `Bearer`
  interface (`send(frame)`, `onReceive(cb)`, `reachablePeers()`, `start/stop`) and a
  `MultiBearer` that the broker publishes to and receives from. Waku becomes
  `WakuBearer` (wrapping today's `UnderlyingNode`); BLE becomes `BleMeshBearer`. The
  **gossip/dedup/forwarding logic is portable TS** here, testable with a mock radio —
  no phone required, same as the broker.
- **The BLE radio driver lives in the Shared Delivery app's native layer**, exactly
  like the Waku node's JNI does. It needs OS BLE permissions and the persistent
  foreground service to run central+peripheral roles for every app. `loam-transport`
  defines the bearer; the Loam node *provides* it.

This split is the same one we already use for Waku (portable transport logic in the
lib, the node in the service) — so it's a known shape, not a new pattern.

### The BLE bearer, concretely

- **Dual-role GATT.** Each device both **advertises** a fixed *Loam mesh* service UUID
  and **scans** for it, then opens GATT connections to nearby Loam peers (a phone as
  central holds ~7 links; as peripheral it accepts more). Frames move over a single
  GATT characteristic with **fragmentation/reassembly** (ATT MTU is ~185–512 bytes
  negotiated; our sync frames are ~200–500 B, so 1–3 fragments — a good fit).
- **Application-layer gossip.** Classic BLE is not a mesh, so we build one: each device
  **forwards** received frames to its other connected peers, with a **seen-set**
  (frame hash) to kill loops/floods and a small **hop TTL**. Store-carry-forward as
  people move around the room means eventual delivery across a sparse graph. This is a
  well-trodden design (Briar/Bridgefy-class); we get to keep it *dumb* because
  convergence is the sync layer's job, not the mesh's.
- **Topic-aware forwarding (v2).** Peers exchange a compact **bloom filter of their
  subscribed content topics** on connect, so a device only forwards frames a neighbor
  actually wants. v1 can flood (cheap at room scale); v2 adds the filter for density.
- **Catch-up over BLE.** When two devices connect, `loam-sync`'s `buildInitial`/
  `respond` runs over BLE frames — a fresh phone pulls the whole Q&A/calendar from a
  neighbor with **no internet at all**.

### The auto-fallback trigger

BLE is a **fallback/augment, not always-on** (battery). The Loam node arms the BLE
bearer when the internet path degrades — Waku peer count hits 0, or publishes start
timing out — and duty-cycles it down when the fleet is healthy. A user-visible
**"Conference / offline mesh"** toggle forces it on. Because we're offline-first, the
merge-back is automatic: events authored while meshing over BLE flow to the fleet the
moment the Waku bearer reconnects — the event log doesn't care which bearer carried a
write.

## Rejected / considered

- **Bluetooth Mesh (the SIG spec).** Designed for IoT *control* (managed flood, ~11
  usable bytes per access payload, no connection-oriented bulk). Wrong tool for general
  data sync — we'd fight it. Reject.
- **Nearby Connections (Android) / Multipeer Connectivity (iOS).** Batteries-included
  local meshing that auto-selects BLE+Wi-Fi — *but they don't interoperate across
  platforms* (Android↔iOS can't mesh), which kills the conference use case. Keep in
  mind for same-platform bulk, but cross-platform needs a common protocol → raw GATT.
- **Wi-Fi Aware (NAN) / Wi-Fi Direct.** Much higher bandwidth; the right **complementary
  bearer for bulk** (posters, attachments) — but also no clean Android↔iOS interop, and
  heavier. Proposed as a *later* third bearer behind the same `Bearer` interface: BLE
  for discovery + small sync frames, Wi-Fi Aware for large blobs where both ends are the
  same platform.

## Honest risks (must be in the plan)

- **Background radio is OS-restricted.** Android 12+ needs `BLUETOOTH_SCAN/ADVERTISE/
  CONNECT` runtime perms (`neverForLocation`), and background scanning is throttled — the
  foreground Loam service is the enabler. **iOS is the hard one**: background peripheral
  advertising drops the local name into a special overflow region and is only
  discoverable by devices explicitly scanning for the UUID; background modes + careful
  UUID design are mandatory, and iOS↔iOS vs iOS↔Android behave differently. Prototype on
  real hardware early; treat iOS background as a known unknown.
- **Battery.** Continuous scan+advertise+links is a real drain — hence trigger-on-degrade
  + duty-cycling, not always-on. The "only when the internet is down/overloaded" framing
  is the right one and should be enforced by default.
- **Throughput is small.** Fine for events/questions/calendar entries (hundreds of
  bytes) — **not** for files/posters. Frame-size caps; bulk waits for the Wi-Fi bearer.
- **Topology at scale.** 200 people, ~7 links each = a sparse gossip graph with eventual,
  not instant, delivery. Acceptable for "eventually everyone sees the Q&A"; document it
  so nobody expects a broadcast bus.
- **Open mesh = DoS surface.** Anyone can advertise the Loam UUID and inject frames
  (they can't *decrypt* — sealed bytes — but they can *flood*). Mitigate with frame-size
  caps, per-peer rate limits, the seen-set, and optionally a mesh-admission secret or
  lightweight PoW. Design the frame header for this from day one.

## Consequences

- Sync survives internet loss and congestion by meshing with people in the room, and
  heals back to the fleet automatically — a genuinely new capability, not a workaround.
- `loam-transport` gains a `Bearer`/`MultiBearer` seam (a clean refactor of today's
  single-node assumption); the sync, crypto, consent, and cache layers are unchanged.
- New native surface in the Loam app (BLE central+peripheral + GATT) — the biggest cost,
  and where the OS-background risk concentrates. Phased: **v1** flood-gossip of small
  sealed frames over raw GATT via the shared node, trigger-on-degrade; **v2** topic-aware
  forwarding + a Wi-Fi Aware bulk bearer behind the same interface.

## Implementation notes — what got built (and what the code taught us)

The **portable half is done and proven**; the native radio is written but awaits hardware.

- **The abstraction holds, and it's smaller than the sketch.** `src/bearer.ts`:
  `Bearer` (`start/stop/send/onReceive/reachablePeers`), `MultiBearer` (fan-out + deduped
  funnel), `BleMeshBearer` (flood-gossip: seen-set + hop-TTL + store-carry-forward) over a
  `MeshRadio` interface (`start/stop/peers/sendTo/onReceiveFrom`). `reachablePeers()` earned
  its place; a separate topic-bloom method did not (deferred to v2, as planned).
- **Dedup is by a content-hash frame id, not a generated one** —
  `id = sha256(topic ‖ 0x00 ‖ payload)[:16]`. So the *same* sealed message collapses whether
  it arrived over Waku or was flooded over BLE, with **no shared id generator** — this is what
  lets MultiBearer funnel "once" and lets `send()` suppress its own echo. `hop` is deliberately
  **excluded** from the id so forwarding (which decrements hop) never changes identity.
- **The portable/native split is clean and testable with zero hardware.** All mesh
  intelligence (loop-kill, TTL, forwarding) lives in `BleMeshBearer`; the radio is a *dumb*
  link. `test/bearer.test.ts` drives the real gossip over an in-memory `MockRadio` graph —
  **9 tests green** (`node --test`): multi-hop line, cycle/loop dedup, TTL bound, star relay,
  content-id stability, wire round-trip, and MultiBearer fan-out / cross-bearer funnel /
  echo-suppression. This validated the design before a single Kotlin line ran.
- **Wire frame:** `[ ver(1) | hop(1) | topicLen(2 BE) | topic utf8 | payload… ]`. The id is
  *not* on the wire — recomputed from `(topic‖payload)` on receive, so a peer can't forge a
  different id and hop can't perturb it.
- **Arming is TRANSPARENT — the node owns it, not the app.** The app/shared-service registers
  the radio ONCE (`setMeshRadio(factory)`); a 15s watchdog **auto-arms** the mesh when the
  fleet path is degraded (`counters.peers <= 0`) and **duty-cycles it down** when healthy —
  apps never toggle a bearer. `forceMesh(on)` is the single user-facing override (the
  "conference" case). This corrects an earlier per-app `enableMesh` design that leaked the
  bearer into app code. Caveat: peer counts under-report, so the auto-trigger errs toward
  arming (safe) and the force path is the reliable one; a publish-failure signal is a TODO.
- **The Waku path is untouched.** `publishSealed()` also floods the sealed bytes over the mesh
  when armed; an armed mesh funnels each BLE frame into the **same broker route** as a Waku receive — the sealed bytes
  are handed in as the tenant's single decode candidate, so the app `open()`s them exactly as
  it does Waku traffic and the sync layer dedups by event id. `enableMesh/disableMesh/
  meshEnabled/meshPeers`. Any `logos-transport` consumer (qaku, kym, scala all route through
  `publishSealed`) gains the mesh by handing over a radio.
- **Native radio (`native/blemesh/`, Android, UNVERIFIED).** Dual-role GATT: advertise a fixed
  Loam service UUID + run a write/notify characteristic (peripheral) while scanning + dialing
  Loam peers (central); a device is a "peer" by address in *either* role. Concrete decisions
  the code forced: a **connect tiebreak** (only the lower address dials, to avoid A↔B opening
  two links) and **MTU-aware fragmentation** with a 4-byte `[msgId|idx|count]` header +
  per-`(addr,msgId)` reassembly. RN adapter (`loam-mesh-radio.ts`) + a prebuild-surviving
  config plugin (`withLoamMesh.js`, copies the `.kt`, registers the package, adds the
  Android-12 BLE perms).

## Open questions (updated)

- **iOS** background advertising/scan reliability — still the make-or-break; needs a hardware
  spike. (v1 is Android-only.)
- **The connect-tiebreak needs a real address.** Android often returns a randomized/placeholder
  `adapter.address` (`02:00:00:00:00:00`); the code guards that case, but the real fix is to
  carry a stable per-node id in the advertisement (or the first framed handshake) and tiebreak
  on *that*, not the MAC. Do this before the hardware spike.
- Mesh admission: fully open (rely on rate-limits + seen-set) vs a shared mesh secret vs PoW.
- Presence: expose "who's reachable over BLE" to apps, or keep the bearer invisible below sync?
  `meshPeers()` gives a count today; a per-peer presence signal is still open.
- v2: topic-bloom forwarding + a Wi-Fi Aware bulk bearer behind the same `Bearer` interface.
