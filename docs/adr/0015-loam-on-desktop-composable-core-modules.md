# 15. Loam on desktop: a `loam_core` facade over composable bearer modules

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

Introduce a **`loam_core` facade module** that owns the transport layer and exposes ONE stable,
bearer-agnostic API. Apps depend only on `loam_core`; `loam_core` depends on the bearer modules and
fans out / dedups across them. This mirrors how loam-transport already works on mobile (a single
transport facade over `WakuBearer` + `BleMeshBearer`; apps never touch a bearer directly).

### Modules and dependency edges

```
   kym_core / scala / qaku_core            loam_ui                (QML view: metrics + control)
        │ dependencies:["loam_core"]          │ logos.callModule("loam_core", …)
        │  (only transport dep)               │ (control + metrics API)
        └──────────────┬──────────────────────┘
                       ▼
                   loam_core                     (NEW facade: transport API + control/metrics API
                       │                          + MultiBearer fan-out/dedup)
                       │  dependencies: ["delivery_module","ble_mesh", …future: "lora"…]
              ┌────────┼─────────────┐
              ▼        ▼             ▼
         delivery   ble_mesh      lora …          (bearer modules, each dependencies: [])
         (exists)   (NEW)         (future)
```

- **`loam_core`** — **NEW facade module**. `dependencies` lists every bearer. It holds the C++
  **MultiBearer** (the desktop mirror of `bearer.ts`): on send it fans the sealed frame to every
  bearer; on receive it funnels all bearers into one **dedup'd** stream
  (`frameId = sha256(topic‖0x00‖payload)[:16]`). It exposes the **stable transport API** apps
  program against — roughly `start(cfg)/stop`, `join(topic)`, `sendSealed(topic, bytes)`, event
  `received(topic, senderId, payload, ts)`, plus status (`peers()`, `meshPeers()`, per-bearer
  health). Apps are **bearer-agnostic**: adding `lora` (or any bearer) is a `loam_core` change with
  **zero app edits**. `loam_core` provides transport only — identity/crypto/CRDT stay in the app.
- **`delivery_module`** — unchanged. Logos node + SDS reliable channels. `dependencies: []`. No
  fork, no second node. `loam_core` maps its channel semantics (`channelCreate`/`channelSend`/
  `channelMessageReceived`) onto the delivery bearer.
- **`ble_mesh`** — **NEW bearer module**, `dependencies: []`, reusable directly too. Owns (a) a
  **Qt Bluetooth `MeshRadio`** and (b) the **portable gossip layer** (seen-set, hop-TTL,
  store-carry-forward) ported from `bearer.ts`'s `BleMeshBearer` to C++. Bearer surface:
  `start/stop`, `flood(topic, payload:bytes)`, `peers()/reachablePeers()`, event
  `frameReceived(topic, payload, ts)`. Declares Qt Bluetooth via `nix.cmake.find_packages`.
- **App cores** — `dependencies: ["loam_core"]`. Keep identity/crypto/CRDT-fold/RBSR on top of the
  facade: call `loam_core.sendSealed`, consume `received`. **Dedup is free** (facade + event-id
  convergence), so a write arriving over both Waku and BLE folds once.
- **`loam_ui`** — **NEW reusable QML view module** for metrics + control, the desktop counterpart of
  the mobile Loam app's panel + `LoamDebug`. Pure QML (no C++): it renders `loam_core`'s metrics and
  drives its controls via `logos.callModule("loam_core", …)`. Droppable into Basecamp as its own
  "Loam" control view, or embeddable in an app's settings. Because it's thin and API-driven, a new
  bearer shows up in the UI automatically once `loam_core` reports it — no `loam_ui` change.

### Control & metrics surface (what `loam_ui` drives)

`loam_core`'s stable API is not only transport — it also exposes **control** and **metrics** so a UI
(or an app) can steer the bearer set. This generalises the Android Loam app's controls (force-mesh,
Core/Edge) to N bearers:

- **Metrics** (poll or subscribe): overall `{ connected, peers }` plus a per-bearer list
  `[{ name, enabled, priority, state, peers, rxN, txN, health }]` — e.g. delivery `{peers, mesh,
  rx/tx}`, ble_mesh `{blePeers, bleTx/bleRx, armed}`. One shape so the UI renders any bearer
  uniformly.
- **Control:**
  - `setBearerEnabled(name, on)` — turn a bearer off/on.
  - `setBearerPriority(order[])` — the send/preference order (e.g. prefer delivery, BLE as
    fallback; or cost-aware "don't flood BLE while Waku is healthy"). Fan-out-to-all stays the
    resilient default; priority tunes it.
  - **Force switches:** `forceMesh(on)` (arm BLE even with internet up, to test the mesh — the
    existing Android toggle), `setNodeMode("Core"|"Edge")` (the delivery bearer's battery/relay
    mode), and per-bearer force-on/off.
- These live on `loam_core` (single source of truth); `loam_ui` is a thin renderer. Keeping control
  in the facade means an app's own settings screen can offer the same knobs without reimplementing
  them, and the mobile `LoamDebug`/status components map onto the same surface.

### Why the facade (not app-depends-on-bearers directly)

A stable `loam_core` API insulates every app from bearer churn: new bearers, mesh policy, dedup,
and node lifecycle live in one place instead of being re-implemented per app. It is the exact
desktop analog of the loam-transport lib's public surface — the same reason apps import
`transport.*` on mobile rather than wiring Waku and BLE themselves.

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
  useful. Bearers are pluggable behind `loam_core`.
- **Stable app API; bearer churn is invisible.** Apps depend only on `loam_core` and program against
  one transport surface. Adding a bearer (lora), changing mesh policy, or fixing dedup is a
  `loam_core` change with **zero app edits** — the whole point of the facade.
- **Cost: an extra IPC hop.** app → `loam_core` → `delivery`/`ble_mesh` is two Qt-Remote-Objects
  hops instead of one. Manageable (the app→delivery pattern already works), but `loam_core` MUST
  re-emit `received` on the right thread — QRO **drops cross-thread signal emits** (the known
  cpp-sdk gotcha, fixed in d77c3dd); marshal received events onto the QRO thread before re-emitting.
- **Two wire-compat seams to hold:** (1) `ble_mesh` ↔ Android Loam GATT/frame format (ADR 0014);
  (2) `delivery_module` channels ↔ mobile SDS (double-base64 framing, senderId, shard/topic) —
  already proven in kym/qaku.
- New native surface (Qt Bluetooth + a C++ gossip port) is contained inside `ble_mesh`; `loam_core`,
  app cores, and `delivery_module` are unaffected if BLE is absent (mesh simply reports 0 peers).

## Code reuse & parity (Android ↔ desktop)

Android/mobile is Kotlin+TS; desktop is C++ — no source sharing across that boundary. So we
buy interop the way kym/qaku already prove crypto parity, not by sharing code:

1. **One wire spec, two implementations.** The BLE GATT constants (service/char/CCCD UUIDs,
   MTU, the `[msgId,idx,count]` fragmentation header) and the bearer frame
   `[ver|hop|topicLen|topic|payload]` + `frameId = sha256(topic‖0x00‖payload)[:16]` are a single
   normative spec (in `bearer.ts` / `LoamMeshModule` today). Extract those into a **shared spec
   doc + a small constants file per language** so neither side drifts. `frameId` is already ported
   verbatim into `loam_core` (`multibearer.hpp`) — that's the first parity point.
2. **Golden test vectors.** The gossip/frame codec gets a language-neutral vector set (inputs →
   expected frame bytes / frameId / reassembly), committed once and run by BOTH the TS suite and
   the C++ `ble_mesh` tests — the same pattern as kym_core's `crypto_parity.cpp` against JS golden
   JSON. This verifies the C++ port byte-for-byte without shared source.
3. **Same facade shape both sides.** `loam_core`'s API deliberately mirrors the mobile
   loam-transport surface (`start/join/sendSealed/received`, `forceMesh/setNodeMode`, per-bearer
   metrics), so design, docs, and mental model transfer even though the code doesn't.

Within the C++/Basecamp world, reuse is real source reuse: `loam_core` (+ its bearers) is shared
by **every** Basecamp app, and its internals started as scala's proven `logos_transport.hpp`
generalised to a MultiBearer. So "reuse between the two implementations" = shared wire spec +
shared vectors + one C++ transport module for all desktop apps.

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

1. **`loam_core` facade, delivery-only** — new module wrapping just `delivery_module` behind the
   stable transport + control/metrics API + a MultiBearer with one bearer. Switch kym_core/scala to
   `dependencies:["loam_core"]` and route through it, unchanged behaviour. No BLE; de-risks the
   facade + the extra IPC hop + the QRO re-emit thread handling. Low risk, and it's the seam
   everything else plugs into.
2. **`loam_ui` view** — pure-QML metrics + control panel over `loam_core` (bearer list, force-mesh,
   Core/Edge, enable/priority). Validates the control/metrics API early and gives an on-desktop
   window into the transport. No hardware.
3. **`ble_mesh` portable half** — port `BleMeshBearer` gossip + frame codec to C++ with a MockRadio
   and unit tests mirroring the TS suite. No hardware.
4. **`ble_mesh` Qt Bluetooth radio** — (4a) prove peripheral advertising + central scan on desktop;
   (4b) desktop↔desktop mesh; (4c) desktop↔Android wire-compat. Resolve stable node-id here.
5. **Register `ble_mesh` under `loam_core`** — add it to `loam_core.dependencies` and the bearer
   list; **app cores and `loam_ui` stay unchanged** (the new bearer just appears in metrics/control).
   Verify convergence over BLE-only (internet off) and healing to the fleet on reconnect. (Future
   bearers like `lora` join here the same way.)
6. **(Deferred)** desktop broker/cache — only if a shared desktop node is introduced.
