# 14. Identity-first BLE connection management (learning from bitchat)

- **Status:** accepted — implementing
- **Date:** 2026-08-14
- **Extends:** [0012](0012-ble-mesh-bearer.md) (BLE mesh bearer)

## Context

0012's native radio reached hardware and mostly worked: links form, MTU negotiates to
517, and fragments are **sent and received over the air** (on-screen `recv` climbs). But
sync still failed, and the on-device counters exposed *why* — three linked pathologies,
all rooted in **keying connection state by the BLE MAC address**:

- **Ghost peers.** Android uses **Resolvable Private Addresses** that rotate for privacy;
  combined with both devices dialing each other, one physical phone showed up as **three
  "peers"** (`cli=1 srv=2`). Stale entries never got reaped.
- **Sends to dead links.** With ghost entries in `peers()`, the bearer fanned writes to
  zombie connections (high `sent`/`wFail`) while the one real link delivered nothing clean.
- **Reassembly that never completes.** `recv` high, `deliv=0`: fragments arrive but partial
  assemblies pile up forever (no timeout), and duplicate links split/duplicate them.

We looked at **bitchat** (permissionlesstech/bitchat + bitchat-android) — the most
battle-tested open-source BLE mesh of exactly this dual-role shape. Its core lesson:
**never key on the MAC — key on a stable cryptographic peer identity, learned on connect.**

## What bitchat does that we're adopting

| bitchat | Our fix |
|---|---|
| Peer ID = first 8 bytes of SHA-256(device Noise static key); **stable across reboots/reinstalls**; peers keyed by it, learned from an **announce** packet after connect — never the MAC. | Announce a **stable node ID** on every link; key all state/routing/dedup/count by node ID. |
| Split managers (`BluetoothGattClientManager`, `…ServerManager`, `MeshConnectionTracker`, `PeerManager`) — the tracker holds state per **peer ID**, so redundant links reconcile. | **One live link per node ID**; close/ignore duplicates; reap on disconnect. |
| Fragments: 8-byte fragment ID + index/total; **128 concurrent assemblies, 30 s timeout, 1 MiB cap**. | Reassembly keyed by (nodeID,msgId) with a **30 s timeout** + bounded concurrency. |
| Relay **jitter 10–220 ms** + adaptive TTL (cap in dense graphs); LRU seen-set (1000/5 min). | Forward jitter + TTL cap — *phase 2* (the storm we saw was ghost-driven; identity removes most of it). |

## Decision

Make BLE **identity-first**, at the native link layer (the portable `BleMeshBearer` stays a
dumb gossip over `MeshRadio` — unchanged):

1. **Stable node ID.** Reuse what we already ship — the app's `deviceId` (stable per device;
   a SHA-256 fingerprint of our secp256k1 signing key from logos-sync 0.3.0 is an equally
   valid source). No Noise needed. JS hands it to the radio via `setNodeId()` before `start()`.
2. **Announce on connect.** Add a 1-byte **frame type** to the GATT payload — `A` announce
   (payload = our node ID) or `F` fragment (`[msgId|idx|count|chunk]`). On every new link
   (client after service discovery, server on connect) we send an `A`; on receiving one we
   learn `address → nodeID`.
3. **Key everything by node ID.** `peers()` returns **node IDs** (an address with no announce
   yet is *pending*, not counted). `sendTo(nodeID)` resolves to a live link and sends. The
   on-screen count becomes the true number of distinct devices.
4. **One link per node ID.** When a second address announces an already-known node ID, keep
   one link and drop the rest (tie-break: lower node ID keeps the client role — the stable
   version of 0012's MAC tie-break, which RPA had defeated). Reap links on disconnect.
5. **Reassembly timeout.** Stamp each partial assembly; evict > 30 s and bound concurrency,
   so a lost fragment can't wedge a buffer forever.

The wire format changes (new type byte), so this is a **breaking BLE-protocol bump** — fine,
it's pre-release and both devices update together.

## What we deliberately keep different from bitchat

- **No Noise / no new crypto for identity.** Confidentiality + authenticity already live
  above the bearer (opaque sealed bytes, ADR 0001; event signing, logos-sync 0008). The
  mesh only needs a *stable label* to key links — `deviceId` suffices. bitchat couples ID to
  its Noise layer; we stay decoupled.
- **The mesh stays dumb; convergence is the sync layer's job** (0012). bitchat dedups
  messages in the mesh; we dedup by **event id in the CRDT fold**, so our seen-set only kills
  flood loops, not application duplicates.

## Consequences

- Ghost peers collapse to one logical device; the counters become truthful; sends target a
  **live** link; reassembly can't wedge — directly closing the three pathologies above.
- New native surface (announce handshake + `address↔nodeID` maps + per-node link table), and
  a `setNodeId` call from JS. `MeshRadio`'s interface is unchanged (a "peer" string is now a
  node ID, not a MAC) — so `BleMeshBearer` and every consumer are untouched.
- Feeds [0013](0013-desktop-ble-relay-gateway.md): a desktop relay is just another node ID on
  the mesh; identity-first routing is what lets a laptop bridge deterministically.

## Risks / open

- **Still needs on-hardware verification** — this is the fix for what hardware *revealed*, but
  it's another native iteration; the on-screen `BLE data:` counters (now node-keyed) remain the
  gate.
- **Announce reliability.** If an announce is lost, the peer stays *pending* (uncounted,
  unrouted) until retried — send it on connect **and** periodically until acked by first data.
- **Tie-break with equal/again-rotating IDs** — node IDs are app-stable so this is robust, but
  a peer that reinstalls gets a new `deviceId`; treat it as a new device (correct).
- Relay jitter + adaptive TTL (bitchat) deferred to phase 2.

Sources: bitchat whitepaper & bitchat-android (`mesh/` package: `PeerManager`,
`MeshConnectionTracker`, `BluetoothGattClient/ServerManager`).
