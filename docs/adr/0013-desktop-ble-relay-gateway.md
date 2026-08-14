# 13. Desktop/laptop as a BLE mesh relay & internet gateway

- **Status:** proposed
- **Date:** 2026-08-14
- **Extends:** [0012](0012-ble-mesh-bearer.md) (BLE mesh bearer), [0010](0010-shared-node-broker-and-servicenode.md) (shared node as a device-wide service)

## Context

ADR 0012 added a BLE bearer so **phones standing next to each other** keep syncing when
the internet is gone. But two limits surfaced once it hit hardware:

1. **No node bridges BLE→Waku today.** A frame that arrives over BLE is funnelled *up*
   to local apps only (`broker._route` → tenant), never *out* to the other bearer. So an
   event authored on a fully-offline phone reaches a neighbour over BLE, but **cannot reach
   the fleet** until that *same phone* personally regains internet. If the author never
   reconnects, the event is stranded in the BLE island. (Confirmed in the code: the mesh
   receive handler routes locally and never calls the node's `send`.)
2. **A phone is a poor mesh anchor.** Battery forces BLE to be duty-cycled/off; the antenna
   is weak; and the device that most needs to relay to the internet (the one *with*
   internet) is exactly the one 0012's auto-trigger *disarms* (healthy fleet → mesh off).

A **laptop running Basecamp** inverts all three: it is **mains-powered** (BLE can stay on),
has a **stronger radio** (wider room coverage), and is **usually online**. A laptop that
joins the BLE mesh *and* bridges to Waku becomes a **relay + internet gateway**: it hears
the offline phones over Bluetooth and carries their sealed frames to the fleet (and fleet
frames back to the room). One online laptop then rescues a whole room of dead-internet
phones — the offline authors never have to reconnect themselves.

This is a natural, high-leverage extension, and most of it already exists: the bearer
abstraction, the gossip, the content-hash dedup, and the "opaque sealed bytes" boundary are
all portable and platform-free (0012). What's new is (a) a **desktop radio**, and (b) an
explicit **relay policy** that re-fans frames *across* bearers instead of only up to apps.

## Decision

Add a **relay/gateway role** and a **desktop BLE radio**, both behind the seams 0012 already
defined — no change to sync, crypto, consent, or the wire frame.

### 1. Cross-bearer relay is a node *role*, opt-in (portable — `loam-transport`)

Today `MultiBearer` funnels an incoming frame up to the app *once* (deduped by content-hash
id). Add a **relay mode**: when set, a frame received on bearer X is *also* re-`send()`-‑to
the **other** bearers, not just delivered locally. That single change turns any node with two
bearers into a store-and-forward bridge:

- **Loop-safe by construction, reusing what 0012 built.** The frame id is
  `sha256(topic‖0x00‖payload)[:16]` and `hop` is excluded from it. The `SeenSet` already
  suppresses re-emitting an id we've handled, on *every* bearer; the sync layer dedups by
  event id on top. So a frame bridged BLE→Waku, echoed back over Waku, is dropped — bridging
  needs **no new anti-loop machinery**, only the flag that permits the re-fan.
- **Opt-in per node, because the trade-off differs by device.** A phone stays **local-only**
  (default; battery + it's a leaf). A **mains-powered gateway** (laptop, or the existing
  Linux hubs) sets **relay = on** and bridges both directions continuously. This is a policy
  bit on `MultiBearer`, not a new interface.
- **Directionality.** BLE→Waku (rescue offline authors) and Waku→BLE (feed the room fleet
  updates) are independently switchable; a gateway runs both. hop-TTL + seen-set bound the
  BLE side; the Waku side is the normal relay.

### 2. The desktop radio implements the same `MeshRadio` seam

0012's `MeshRadio` (`start/stop/peers/sendTo/onReceiveFrom`) is platform-free; only the
driver is native. Add a **desktop implementation** speaking the **same Loam service UUID,
same GATT characteristic, same `[ver|hop|topicLen|topic|payload]` wire frame** as the phones,
so a laptop is just another mesh peer. The portable `BleMeshBearer` gossip (seen-set, TTL,
fragment/reassembly) is reused verbatim; only `sendTo`/`onReceiveFrom` are new.

### 3. Package it as a **relay daemon**, not inside the QML view

Mirror the mobile decision (0010/0012: the radio lives in a persistent, permissioned
*service*, not in app code). On desktop the analogue already exists — the **headless hubs**
(`kym-hub`, `scala-hub`) run `logoscore` + a Waku node as a long-lived `systemd --user`
daemon. The BLE relay is the **same shape**: a daemon that owns the Waku bearer (as the hubs
already do) **plus** a BLE bearer **plus** relay=on. Basecamp's GUI gets an **"Offline mesh
relay"** toggle that launches/monitors this daemon (exactly how the app already launches the
shared service), rather than embedding a radio in a QML module whose lifetime is a window.

## Recommended architecture (and the open build choice)

```
   phones (BLE, offline) ──BLE GATT──┐
                                     ▼
                         ┌───────────────────────────┐
                         │  loam-relay daemon (laptop)│
                         │  ┌─────────┐  ┌──────────┐ │
                         │  │ BleMesh │  │  Waku    │ │   relay = on
                         │  │ Bearer  │◄─┤  Bearer  │ │   (bridge both ways,
                         │  └────┬────┘  └────┬─────┘ │    seen-set-deduped)
                         │       └── MultiBearer ─────┘
                         └───────────┼───────────────┘
                                     ▼  Waku
                              the fleet / other online peers
```

Two viable ways to realise the daemon; **decide Linux-first** (matches the existing hubs and
BlueZ is the most capable desktop BLE stack):

- **(A) Node sidecar (fastest spike).** Reuse the portable `BleMeshBearer` **TS verbatim**;
  implement `MeshRadio` over a Node BLE lib — **central via `@abandonware/noble`, peripheral
  via `bleno`** (both drive BlueZ). Bridge to a local delivery node for the Waku half. Pro:
  reuses 0012's tested TS unchanged; fastest to a working relay. Con: node BLE libs are
  BlueZ-bound (Linux-first; macOS partial, Windows poor) and unmaintained-ish.
- **(B) Qt Bluetooth in a C++ relay module.** `QLowEnergyController` does both central and
  **peripheral** roles and is genuinely cross-platform (Linux/macOS/Windows). Port the ~180-
  line gossip to C++ (small, and parity-testable against the TS the way `logos-sync` is).
  Pro: one cross-platform radio, no node runtime, sits next to `liblogosdelivery`/logoscore.
  Con: reimplements the gossip in C++ (kept honest by golden-vector parity).

**Recommendation:** ship **(A) as the Linux proof-of-relay** (reuses everything, proves the
gateway value in a room today), and pursue **(B)** as the durable cross-platform desktop
radio once the relay semantics are proven. Both hide behind `MeshRadio`, so the daemon and
the relay policy don't change when the radio does.

## Rejected / considered

- **Embed BLE in the Basecamp QML module.** The radio would die with the window and couldn't
  relay in the background — the same reason 0010/0012 put the radio in a service. Reject.
- **Make phones relay instead.** Battery + weak antenna + the online phone gets auto-disarmed
  (0012). A phone *can* be flipped to relay for a pinch, but the laptop is the right anchor.
- **Require the offline author to reconnect.** That's the status quo and the whole problem —
  the event is stranded until the author personally regains internet. The relay removes that.
- **Wi-Fi Aware / Direct for the laptop link.** No clean desktop↔phone story across
  platforms; revisit as a bulk bearer behind the same interface (as 0012 noted).

## Honest risks

- **Desktop BLE peripheral support is uneven.** Advertising + a GATT *server* is solid on
  Linux/BlueZ, workable on macOS (CoreBluetooth/Qt), and weak on Windows. Linux-first
  sidesteps this; document per-OS support and let the daemon degrade to **central-only** (it
  can still *dial* phones and relay, just not be dialled).
- **Relay amplification / storms.** Bridging couples the bearers; a mis-set relay could echo
  frames. Mitigated by the existing content-hash seen-set + sync-layer id dedup + hop-TTL, but
  the relay path must be **rate-limited per peer** and the seen-set sized for gateway volume
  (it sees the whole room, not one phone's traffic). Prove no-loop with two relays in range.
- **A malicious/rogue gateway.** It bridges **sealed bytes only** — it cannot decrypt or forge
  app content (crypto boundary unchanged, 0001). It *could* withhold or replay frames: replay
  is caught by the seen-set + event-id fold; withholding is just non-delivery (the mesh is
  best-effort, sync reconciles when any honest path appears). Optional mesh-admission secret
  (0012's open question) applies here too.
- **Trust surface widens.** A room now trusts that *some* gateway relays honestly for
  liveness (not for integrity). Acceptable for the "conference room" use case; note it.

## Consequences

- **Closes the BLE→Waku gap.** Offline phones' events reach the fleet through the laptop
  without the authors ever reconnecting — the missing half of 0012's "heal back to the fleet."
- A laptop becomes a **range-extender + internet gateway**: one online machine syncs a room of
  dead-internet phones, both directions.
- `loam-transport` gains a **relay policy bit** on `MultiBearer` (small, loop-safe via existing
  dedup) and a **desktop `MeshRadio`** — the sync/crypto/consent/cache layers stay untouched.
- New surface: a **`loam-relay` daemon** (sibling to `kym-hub`/`scala-hub`) + a Basecamp toggle
  to run it. The biggest cost and where OS-BLE risk concentrates — phased Linux-first.

## Open questions

- **Where does the daemon's Waku half bind?** Reuse a hub-style `logoscore` node, or the same
  `liblogosdelivery` the Basecamp core already runs — avoid two Waku nodes on one host.
- **Gateway election.** With several laptops in a room, do all relay (dedup makes it safe but
  wasteful) or is there a light election/backoff so one anchors and others stand by?
- **Presence/observability.** Surface "N phones bridged, M frames relayed" so a host can see the
  gateway working (the mobile on-screen `bleTx/bleRx/relayed` counters generalise here).
- **Cross-platform peripheral** (macOS/Windows) — the durable (B) path; needs its own spike.
