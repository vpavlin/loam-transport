# 20. Unlinkable presence on the BLE mesh and the Waku sender id

- **Status:** accepted, implementing
- **Date:** 2026-10-06
- **Amends:** [0014](0014-identity-first-ble-connections.md) and [0019](0019-ble-link-protocol-v2.md) (the wire node id)

## Context

A technical note on unlinkable presence in BLE meshes (BitChat's stable peer id, its unshipped rotation draft, DP-3T/GAEN, the Logos mixnet) asked one question: can a passive listener tell that two Bluetooth observations, at different times or places, came from the same phone? Checking our stack against it found:

1. **The phone's BLE id was a hash of the Loam `deviceId`,** announced in the clear on every link and stable for the install's life (0019: `base64url(sha256(deviceId)[0..12])`).
2. **The same `deviceId` was the SDS sender id for every app's channel on the shared node.** SDS writes the sender id in the clear (sds 0.3.0 protobuf field 7, plus other peers' causal-history entries; channels run with the no-op encryption provider). So anyone reading a room's Waku traffic could compute the phone's BLE id and recognise it physically. It also linked all of a phone's apps and rooms on Waku, undoing the per-calendar and per-room identities of loam-keycard ADR 0001.
3. **On the desktop, the SDS sender id was whatever the last app passed to `setSenderId`:** `loam-core` by default, the user's signing identity for Scala and Kith.
4. **New frames left at the full hop count** and relays forwarded at once, so the hop value and timing pointed at the originator.

The topic is also in the clear in every BLE frame (`[ver|hop|topicLen|topic|payload]`), which ties a phone across any id rotation and shows which rooms nearby devices share. Only the payload is sealed.

## Decision

1. **Random, rotating BLE wire id (Android).** The id a phone announces is 12 random bytes (base64url, 16 chars, same size as before), unrelated to `deviceId`. It is renewed on every `start()` and about every 15 minutes (15 min + up to 5 min of jitter, so phones don't rotate in step). A rotation restarts the radio: links drop, advertising restarts, the scanner re-dials. Keeping links open across a rotation would let the peer on the other end tie the old id to the new one. `setNodeId(deviceId)` stays in the API, but its value never goes on the air.
2. **Per-topic SDS sender id (phone and desktop).** `hex(sha256("loam-sds-sender-v1|" + secret + "|" + topic))[0..24]`, keyed by a random per-install secret:
   - Phone: `start({ senderSecret })`. Loam keeps the secret in SecureStore. Without a secret, the `deviceId` keys the hash, which is per topic but tied to an id that older builds sent in the clear.
   - Desktop: `loam_core` keeps it in `~/.loam-core/sender-secret` (mode 600) and ignores what apps pass to `setSenderId`.

   The id is stable for a topic across restarts, as SDS keeps per-sender history. No app reads the transport-level sender id; Scala's own sender field lives inside its sealed payload.
3. **Sender privacy in the gossip (phone `bearer.ts`, desktop `mesh.hpp`).** A new frame starts at `ttl - random(0..2)`, with the default TTL raised from 6 to 7 so the shortest reach stays 5 hops. A relay clamps an incoming hop to its own TTL before decrementing, so a peer can't make a frame flood further. Every send and every relay waits a random 10–220 ms (BitChat's numbers), so "sent with no delay" doesn't mark the origin either.

## Not decided here

- **Topic tag instead of the topic on BLE.** This is the proper fix for linking by topic: a rotating tag keyed by the room key, e.g. `HMAC(roomKey, epoch)[0..8]`. Loam never sees room keys, so apps would have to supply the tag; the change also breaks the BLE wire format. It is left for the next BLE format change. Until then, the topic in a frame lets anyone who knows it (any Waku observer of that room) recognise "a member of this room is nearby", and lets anyone who doesn't link sightings of the same room across rotations.
- **Desktop BLE id rotation.** The desktop id is already random per process. It doesn't rotate during a run, and on Linux the adapter may advertise its public address unless BlueZ privacy is on.
- **Address alignment.** Android rotates its private address (RPA) on its own schedule, about every 15 minutes, which we can't align with. Within one address epoch, an observer can tie the old wire id to the new one; across epochs it can't. GAEN accepts the same overlap.
- **What stays visible:** the Loam service UUID (a Loam user is nearby), the shape and timing of advertising, and frame sizes.

## Consequences

- **Wire compatible:** old and new phones and desktops interoperate. Hop values stay in range, an id is still an opaque 16-char key, and SDS doesn't care what the sender id is.
- **Each rotation briefly drops BLE links** (a few seconds to re-form). The sync layer re-sends anything that was in flight.
- **Tests:**
  - `test/bearer.test.ts`: origin-hop spread, relay clamp, jitter.
  - `loam-basecamp ble_mesh/test/mesh_test.cpp`: the same three in C++.
  - The sender-id derivation is byte-identical on phone and desktop (checked against Python's SHA-256).
