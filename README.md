# loam-transport

A **shared, crypto-agnostic sync transport** for React Native / Expo apps built on
the Logos stack. It runs an embedded Logos node (`liblogosdelivery`) on the device and
moves **opaque sealed bytes** over **SDS Reliable Channels**, giving you two-way,
multi-writer sync between phones and a desktop [Basecamp](https://logos.co) module.

It is extracted verbatim from the transport proven end-to-end in two shipping apps —
**KYM** (budget) and **qaku** (Q&A) — which both now import this exact module. The
transport knows nothing about your data or your crypto: you hand it topics and sealed
bytes; it handles node bring-up, the gossip mesh, channel framing, live receive,
history pull from the fleet store, and reconnection.

> **Two sides, one wire.** This repo carries the transport for **both** ends, wire-
> compatible with each other:
> - **`src/` + `native/` + `plugins/`** — the **mobile** (React Native / Expo, Hermes,
>   **arm64 Android**) transport. The rest of this README covers it.
> - **`basecamp/`** — the **desktop** transport for a Basecamp module's **C++ core**
>   (like `kym_core`/`qaku_core`). Header-only. **← use this for a Basecamp-only app
>   like scala.** See [`basecamp/README.md`](basecamp/README.md).

---

## The idea

```
your app                          loam-transport (this repo)
─────────                         ───────────────────────────
seal/open (your keys)   ──────►   publishSealed(topic, bytes)  ─► SDS channel ─► fleet
topic derivation                  onReceive(topic, candidates) ◄─ live mesh   ◄─ fleet
envelope dispatch       ◄──────   storeSync(onCandidates)      ◄─ fleet store
```

The transport is **crypto-agnostic**: on receive it hands you the candidate
sealed-byte arrays and *you* open one with your key (only the right key/candidate
authenticates). You keep full control of encryption, identity, and wire envelope; the
transport only moves bytes.

## What you supply (the contract)

You write a thin **adapter** (~150 lines) that supplies three things and delegates all
wire to this module. See [`examples/`](examples/) for the real KYM and qaku adapters.

1. **Crypto** — `seal(id, plaintext, topic)` / `open(id, sealed, topic)`
   (ChaCha20-Poly1305, AAD = topic, in the reference apps).
2. **Topic(s)** — a content topic per "room"/household, derived however you like
   (the apps derive `/{app}/1/<hmac(key)>/proto` from the shared secret).
3. **Envelope dispatch** — parse the opened plaintext and route it (the apps use
   `{v:1, type:"EVENT"|"SYNC_REQ", ...}`).

## Transport API (`src/logos-transport.ts`)

| function | purpose |
|---|---|
| `start({deviceId, topics, onReceive, onStatus})` | bring the node up: setup → new → start → (subscribe + channelCreate per topic) → settle → renew. Idempotent. |
| `publishSealed(topic, sealed: Uint8Array)` | send sealed bytes over the topic's SDS channel (double-base64 framing). |
| `storeSync(onCandidates)` | cursor-paged history pull from the fleet store for every joined topic. |
| `join(topics)` | add topics after the node is up (subscribe + channelCreate). |
| `stop()` | stop the node (best-effort). |
| `refreshPeerInfo()` | update `counters.peers` / `counters.mesh` from node metrics. |
| `deliveryAvailable()` / `getCtx()` / `getStoreInfo()` / `shardFor(topic)` | helpers. |
| `counters` / `diag` / `getRxSample()` | per-stage diagnostics for a debug/sync card. |

`onReceive(topic, candidates: Uint8Array[]) => boolean` — try to `open()` a candidate
with your key(s); **return `true` iff one opened** (so the transport tallies
`rxOpened` vs `rxOpenFail`).

## Second bearer: the BLE offline mesh

The transport can move the **same sealed bytes** over a **BLE mesh** as a second
bearer beside the Logos/Waku wire, so nearby phones sync with no fleet and no
internet (ADRs [0012](docs/adr/0012-ble-mesh-bearer.md)–[0014](docs/adr/0014-identity-first-ble-connections.md)).
`src/bearer.ts` holds the bearer abstraction: a `BleMeshBearer` (flood/relay with
hop-limited frames and a seen-set) and a `MultiBearer` that fans one publish out to
every bearer and funnels receives back in, deduped. You hand the transport a native
GATT radio **once** with `setMeshRadio(factory)`; it then **auto-arms** the mesh when
peers appear. `forceMesh(true)` pins it on; `meshPeers()` reports reachable mesh
peers. Desktop can act as a relay gateway (ADR 0013); connections are identity-first
(ADR 0014). For **headless testing** of bearer switching (no Bluetooth), point the mesh
at a mock radio with `EXPO_PUBLIC_MESH_WS_URL` — `src/ws-mesh-radio.ts` +
`tools/mesh-relay.js` let two nodes mesh over WebSocket (ADR
[0017](docs/adr/0017-mock-meshradio-headless-bearer-testing.md)).

## Telemetry & observability

`enableTelemetry(secret)` turns the node into its own diagnostics source (ADR
[0016](docs/adr/0016-loam-telemetry-offline-buffered-observability.md)): it **buffers its
own stats offline** and **flushes them, sealed, to a telemetry topic when the fleet
returns** — so the offline bugs (the whole point of the mesh) become observable. It's
opt-in, reconfigurable at runtime (a persisted secret; `EXPO_PUBLIC_TELEMETRY_SECRET`
fallback), ciphertext-only, and **lazy-loaded** so the pure core stays dep-free.
`telemetryStatus()` feeds any UI. The `tools/` pipeline decodes it into **Prometheus
`/metrics`** (`loam-telemetry-exporter.mjs`), lets a Basecamp node publish
(`loam-telemetry-publish.mjs`), and the hub captures it (`logos-hub telemetry`) — so
Android and Basecamp nodes land side-by-side in Grafana. See [`tools/README.md`](tools/README.md).

## Shared-node UI components

For apps that ride the device-wide shared node, the package ships ready-made React
components so you don't hand-roll status UI: **`SharedNodeBanner`** (prompts to
open/approve the shared service when it needs attention), **`SharedNodeStatus`** (live
peers/mesh/approval state), and **`LoamDebug`** (a diagnostics panel with a one-tap
**copy** button — grab all stats for a bug report without retyping). Import them from
the package instead of writing your own banner.

---

## Integration (Expo / React Native)

1. **Copy** `src/logos-transport.ts`, `src/utf8.ts`, the `native/logosdelivery/`
   folder, and `plugins/withLogosDelivery.js` into your app.
2. **Peer deps**: `react-native`, `base64-js`, `@noble/hashes`, and — for your
   adapter's crypto — `@noble/ciphers` and **`expo-crypto`** (see gotcha #1).
3. **Register the config plugin** in `app.json`:
   ```json
   { "expo": { "plugins": ["./plugins/withLogosDelivery.js"] } }
   ```
   It survives `expo prebuild` by re-copying the `.so` + Kotlin bridge into the
   generated `android/` and registering the native package (it is **not**
   autolinkable — manual JNI).
4. **Write your adapter** (copy `examples/qaku-delivery-adapter.ts` and swap in your
   crypto/topics/envelope). Call `transport.start(...)` once; `publishSealed` to send.
5. `expo prebuild --platform android` && `gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`.

---

## Gotchas — every one cost real debugging. Read before integrating.

1. **RNG for your nonce: use `expo-crypto`, NOT `@noble/hashes` `randomBytes`.**
   Hermes has no `crypto.getRandomValues`, so `@noble`'s `randomBytes` **throws** —
   silently killing *every* publish while receive still works (open() needs no RNG).
   This was the single hardest bug. In your `seal()`:
   ```ts
   import * as Crypto from "expo-crypto";
   const nonce = Crypto.getRandomBytes(12); // synchronous, no polyfill needed
   ```
2. **Two apps on one device → set `tcpPort: 0` + `discv5Discovery: false`.** Already
   set in `start()`'s config here. Ephemeral TCP + no fixed discv5 UDP port lets a
   second `liblogosdelivery` node (another app) run without a port collision. Pinned
   `entryNodes` mean discovery isn't needed (proven to still mesh).
3. **Double-base64 `channelSend` convention.** `publishSealed` sends
   `base64(utf8Bytes(base64(sealed)))`; `payloadCandidates` peels 1–2 layers on
   receive. This matches the desktop C++ core's (accidental-but-deployed) framing —
   **do not "simplify" it** or desktop↔mobile stops interoperating.
4. **`@noble/hashes` import path is version-specific.** v2.x: `@noble/hashes/sha2.js`;
   v1.x: `@noble/hashes/sha256`. Adjust the one import in `logos-transport.ts` to your
   installed version (this is the only per-app edit KYM vs qaku needed).
5. **Hermes-safe UTF-8 only.** `TextEncoder`/`TextDecoder` are not guaranteed on
   Hermes — use the hand-rolled `utf8.ts` (bundled), never the globals.
6. **Node config is minimal on purpose.** `{mode:"Core", preset:"logos.test",
   relay:true, entryNodes}` (+ the two coexistence fields). Use `logos.test`
   (cluster 2) — `logos.dev` is cluster 3 and fails to mesh (see ADR 0008). **Do not add light-client
   fields** (filter/lightpush/store/service-nodes) — `waku_new` rejects them and the
   node comes up "offline".
7. **Settle window.** The node isn't `ready` (and the receive listener is gated off)
   for ~10s after start, while the mesh forms. Messages during that window are
   dropped by design — publish/receive after `start()` resolves.
8. **Join order: subscribe THEN channelCreate, BEFORE settle.** `subscribeContentTopic`
   feeds the recv_service that the SDS channel's ingress rides on; `channelCreate`
   alone does not subscribe. Getting this backwards = `rxOpened 0` (traffic arrives,
   channel never sees it).

## The .so — provenance & rebuilding

`native/logosdelivery/arm64-v8a/*.so` are prebuilt Logos delivery libraries
(`liblogosdelivery.so` = the Waku node, `librln.so`, `liblogos_messaging_jni.so` = the
JNI shim, `libc++_shared.so`). The JNI shim (`jni/logos_messaging_ffi.c`) and Kotlin
bridge (`android/java/.../LogosMessagingModule.kt`) expose the FFI to JS. To rebuild
the `.so` from upstream, see the Logos delivery build; the FFI surface this transport
depends on is in `jni/liblogosdelivery.h` (stable) and `liblogosdelivery_kernel.h`
(store/lightpush, advanced).

## Non-RN targets

If your app isn't Expo RN on arm64 Android, the JS transport doesn't drop in, but two
things still transfer: (a) the **contract** and **gotchas** above (especially the
double-b64 framing and the node config — these must match to interoperate with
existing peers), and (b) the **native lib + FFI headers** in `native/logosdelivery/`
to bind from your platform. `docs/TRANSPORT_SPEC.md` is the normative, layer-by-layer
spec of the wire behavior.

## Proven in

- **KYM** (budget) — `kym/mobile/src/lib/delivery.ts` adapter
- **qaku** (Q&A) — `qaku-logos/mobile/src/lib/delivery.ts` adapter

## Why it is shaped this way

The [`docs/adr/`](docs/adr/) log records the load-bearing decisions (crypto-agnostic
bytes, SDS-over-relay, subscribe-before-channelCreate, the base64/byte-array framing,
async-or-deadlock, Core/Edge, the reconnect watchdog, entryNodes+cluster, no-Store-on-
desktop, the shared-node seam) — the *why* behind the [`docs/TRANSPORT_SPEC.md`](docs/TRANSPORT_SPEC.md) *how*.
