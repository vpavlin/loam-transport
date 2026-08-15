# 15. Loam on desktop: composable logos-core modules (delivery + ble_mesh)

- **Status:** proposed — awaiting approval (design-first; no code until accepted)
- **Date:** 2026-08-15
- **Supersedes/extends:** 0010 (shared-node broker), 0011 (per-tenant cache), 0012 (BLE mesh bearer), 0013 (desktop BLE relay gateway), 0014 (identity-first BLE)

## Context

We want Basecamp/desktop apps (kym_core, scala, qaku_core, …) to get the Loam value-adds — the
**BLE offline mesh**, **caching / offline catch-up**, and a **shared node** — the same way the
mobile apps do. Basecamp is Qt/C++; logos-core apps are C++ core modules + pure-QML views.

**Owner's ruling (binding):**
1. Do **NOT** bundle a delivery node inside a "loam" module. **Depend on the existing
   `delivery_module`** and consume it.
2. The **BLE mesh must be its own reusable logos-core module** (`ble_mesh`) that Loam *and other
   apps* depend on à la carte — not baked into any one app or a monolithic "loam" module.

So "Loam" on desktop is **not one module** — it is the *composition pattern*: a small set of
independently-reusable core modules, wired per app through the existing dependency system.

### What is already true (facts, cited)

- **Module dependency model.** A core module declares deps in `metadata.json#dependencies`
  (e.g. kym_core and scala both declare `["delivery_module"]`). Each dep is a **Nix flake input**
  pinned to the same `logos-module-builder`, so all peers share one SDK ABI. At build,
  `logos-cpp-generator` emits a typed client per dependency into `struct LogosModules`; the impl
  calls `modules().delivery_module.channelSendAsync(...)` etc. Core↔core is these **generated
  proxies over Qt Remote Objects** (modules run as **separate processes**) — *not* the QML
  `logos.callModule` path (that is view→core). Packaged as a hashed `.lgx`; extra native deps go
  through `metadata.json#nix.cmake.find_packages`.
- **`delivery_module` already exposes SDS on desktop.** Public surface includes
  `createNode/start/stop`, `send/subscribe`, and **reliable channels**
  `channelCreate(channelId, contentTopic, senderId)` / `channelSend` / event
  `channelMessageReceived(channelId, senderId, payload, ts)`. There is **no `waku_store_query`**
  on desktop (ADR 0009); cross-peer **set reconciliation / cold-start backfill (RBSR) is the
  app's job**, already implemented above delivery in kym_core and scala (logos-sync).
- **There is NO bearer injection seam inside `delivery_module` / liblogosdelivery.** Its API is
  fixed; there is no `setMeshRadio` equivalent. On mobile the mesh is a **sibling bearer above**
  delivery: `MultiBearer` fans a sealed frame to every bearer and funnels receives into one
  dedup'd stream; `publishSealed()` floods the *same* sealed bytes over Waku **and** the mesh, and
  both funnel into the same route (ADR 0012). liblogosdelivery is untouched.
- **Caching.** Mobile's ADR-0011 cache is an **in-memory per-tenant ring buffer in the broker**
  (holds only ciphertext, not reboot-durable). On desktop there is **no broker and no Waku Store**
  — instead each app-core already **persists its full event log to disk** as the durable copy, and
  peers backfill via an always-on hub + RBSR (ADR 0009).

## Decision

Adopt a **sibling-module fan-out** architecture on desktop. Concretely:

### Modules and dependency edges

```
        kym_core / scala / qaku_core          (app cores: identity, crypto, CRDT-fold, RBSR)
              │  depends on
      ┌───────┴────────┐
      ▼                ▼
 delivery_module    ble_mesh                  (two peer bearers, each dependencies: [])
 (exists)           (NEW, reusable)
```

- **`delivery_module`** — unchanged. The Logos node + SDS reliable channels. `dependencies: []`.
  No fork, no second node.
- **`ble_mesh`** — **NEW standalone core module**, `dependencies: []`, reusable by any app. Owns
  (a) a **Qt Bluetooth `MeshRadio`** and (b) the **portable gossip layer** (seen-set, hop-TTL,
  store-carry-forward) ported from `bearer.ts`'s `BleMeshBearer` to C++. Public surface:
  `start/stop`, `flood(topic, payload:bytes)`, `peers()/reachablePeers()`, event
  `frameReceived(topic, payload, ts)`. Declares Qt Bluetooth via `nix.cmake.find_packages`.
- **App cores** — `dependencies: ["delivery_module", "ble_mesh"]`. On send, fan the sealed write
  to **both** (`delivery.channelSend` **and** `ble_mesh.flood`); on receive, funnel **both**
  `delivery.channelMessageReceived` and `ble_mesh.frameReceived` into one `ingestRaw`. **Dedup is
  free**: logos-sync already converges by event id, and frames dedup by
  `frameId = sha256(topic‖0x00‖payload)[:16]`, so the same bytes over Waku and BLE collapse to one.

### The C++ MultiBearer seam (how apps avoid hand-wiring the fan-out)

Generalise scala's existing single-bearer `src/logos_transport.hpp` into a small C++ **MultiBearer**
that holds a list of bearers (`delivery_module`, `ble_mesh`) behind one `send()/onReceive()` — the
desktop mirror of `bearer.ts`. Ship it as a **vendored header first** (as scala already vendors
`logos_transport.hpp` + `logos_sync/`), and promote it to its own module only if reuse demands.
This keeps app cores unchanged except for adding `ble_mesh` to `dependencies` and constructing the
bearer list.

### Desktop BLE radio = Qt Bluetooth

Implement `MeshRadio` with `QLowEnergyController` (peripheral **and** central), since Basecamp
already links Qt — one cross-platform radio rather than separate BlueZ/CoreBluetooth code. It MUST
be **wire-compatible with the current Android Loam mesh (ADR 0014, identity-first)** so a desktop
and a phone mesh together: same GATT service/characteristic UUIDs, the `WRITE_NO_RESPONSE|NOTIFY`
flow, MTU handling, the radio-level fragmentation header, the **identity-first handshake +
stable node-id** from ADR 0014, and the bearer wire frame `[ver|hop|topicLen|topic|payload]`. The
exact constants come from the *current* `LoamMeshModule` + `bearer.ts` at implementation time (not
from the stale standalone checkout).

### Caching stance

**Defer a desktop cache.** Desktop app-cores already persist the full event log to disk, so the
ADR-0011 broker cache is not on the critical path. Introduce a desktop broker/per-topic sealed-byte
cache **only if** a *shared desktop delivery node* (many app-cores behind one node, mobile-style)
is later introduced. Until then, "caching" on desktop = the existing on-disk log + RBSR catch-up.

## Consequences

- **Nothing forks delivery.** The node stays single-sourced; `ble_mesh` is additive and independently
  useful. Any future app gets the mesh by adding one dependency.
- **App-core change is minimal**: add `ble_mesh` to `dependencies`, construct the MultiBearer, done.
  Fan-out/dedup is mechanical and already proven in the TS bearer.
- **Two wire-compat seams to hold:** (1) `ble_mesh` ↔ Android Loam GATT/frame format (ADR 0014);
  (2) `delivery_module` channels ↔ mobile SDS (double-base64 framing, senderId, shard/topic) —
  already proven in kym/qaku.
- New native surface (Qt Bluetooth + a C++ gossip port) is contained inside `ble_mesh`; app cores
  and `delivery_module` are unaffected if BLE is absent (mesh simply reports 0 peers).

## Risks / open questions

1. **Desktop peripheral role.** `QLowEnergyController::PeripheralRole` + GATT server on Linux
   BlueZ is historically uneven, and peripheral/advertising is limited on some platforms
   (Windows). Advertising is make-or-break — prototype it *first* (Phase 3a) before committing.
2. **Cross-platform identity.** ADR 0014 (identity-first, stable node-id) is "accepted —
   implementing" on Android but **device-unverified**; desktop targets a spec still settling. Land
   the stable node-id/tiebreak jointly across Android + desktop, or desktop↔phone won't be trusted.
3. **Moving target.** The Android radio itself is not yet on-device-verified, so desktop co-evolves
   with it — expect the wire spec to shift until a phone↔phone mesh is proven.
4. **Not decided here:** whether to ever run a *shared desktop node* (broker + cache), or keep
   per-app nodes with mesh as the only shared bearer. Left open until there's a concrete need.

## Phased plan

1. **C++ MultiBearer seam** — generalise `logos_transport.hpp` to a bearer list; route
   kym_core/scala through it, delivery-only. No BLE; de-risks fan-out/dedup. Low risk.
2. **`ble_mesh` portable half** — port `BleMeshBearer` gossip + frame codec to C++ with a MockRadio
   and unit tests mirroring the TS suite. No hardware.
3. **`ble_mesh` Qt Bluetooth radio** — (3a) prove peripheral advertising + central scan on desktop;
   (3b) desktop↔desktop mesh; (3c) desktop↔Android wire-compat. Resolve stable node-id here.
4. **Wire app cores to both bearers** — verify convergence over BLE-only (internet off) and healing
   to the fleet on reconnect.
5. **(Deferred)** desktop broker/cache — only if a shared desktop node is introduced.
