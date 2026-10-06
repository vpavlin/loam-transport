# 22. Unlinkable presence: rotating BLE ids, per-topic sender ids, hidden origin

- **Status:** accepted, implementing (2026-10-06)
- **Amends:** [0014](0014-identity-first-ble-connections.md) and [0019](0019-ble-link-protocol-v2.md) (the wire node id)
- **Prompted by:** the technical note "Unlinkable presence on BLE mesh" (6 Oct 2026, BitChat's peer ID, its rotation draft, and prior BLE tracking results)

## Context

A passive listener in Bluetooth range should not be able to tell that two observations at different times or places came from the same phone, beyond what one rotation period reveals. We checked our mesh against that and found three leaks, all verified in source:

1. **The Bluetooth id was the internet id.**
   - The phone announced `base64url(sha256(deviceId)[0..12])` on every link, for the whole life of the install (0019).
   - The same Loam `deviceId` was the SDS `senderId` of every channel on the shared node, for every app.
   - SDS writes the sender id in the clear: protobuf field 7, and again in other peers' causal-history entries (sds 0.3.0, with our no-op encryption).
   - So anyone reading a room's Waku traffic could compute a phone's Bluetooth id and recognise the phone physically, indefinitely. One sender id across all apps and rooms also linked them on Waku, undoing the per-room identities of loam-keycard ADR 0001.
   - On the desktop it was worse: apps pass their own id to `loam_core.setSenderId`, and Scala and Kith pass their signing identity, which then went on the wire as the sender id.
2. **The origin showed in the hop count.** New frames always left at hop 6, so any frame seen at 6 came from the device that sent it.
3. **The origin showed in the timing.** Relays forwarded at once and originators sent at once, so nothing hid who spoke first.

## Decision

### 1. The Bluetooth id is random and rotates (Android radio)

- `wireId` = 12 random bytes (SecureRandom), base64url, still 16 characters, so it still fits one minimum-MTU write.
- A new id on every `start()`, then every 15 min + random(0..5 min).
- **Rotation restarts the radio.** Links drop, advertising and scanning restart, and peers re-dial. A peer that kept a link open could tie the old id to the new one, so links must not survive a rotation. In-flight frames are lost; the sync layer re-sends them (0012).
- `setNodeId(deviceId)` stays in the API for compatibility. The value is used in logs only.
- **No wire change.** Peers already treat the id as an opaque key, so old and new phones interoperate.

### 2. Per-topic SDS sender ids

- `senderId(topic) = hex(sha256("loam-sds-sender-v1|" + secret + "|" + topic))[0..24]`
- `secret` is 32 random bytes per install, never sent anywhere:
  - phone: SecureStore `loam-sds-sender-secret`, passed to `start({ senderSecret })`;
  - desktop: `$LOAM_CORE_DATA/sender-secret` (mode 600).
- A topic's sender id is stable across restarts, because SDS keeps per-sender history. Different topics give unrelated ids.
- **The desktop never uses what apps pass to `setSenderId`.** It is kept for compatibility only.
- **Compatibility:** an app on its own node that doesn't pass a secret gets ids keyed by its `deviceId`. That is still per topic, but tied to an id older builds sent in the clear.
- Nothing compares sender ids for self-echo. QAKU's echo check uses the `from` field inside the sealed payload, so it is unaffected.

### 3. Hidden origin (portable `bearer.ts` and desktop `mesh.hpp`)

- TTL goes from 6 to 7. A new frame starts at `ttl - random(0..2)`, i.e. hop 5–7, so a hop of 5 or 6 no longer marks the sender.
- A relay clamps an incoming hop to its own TTL before decrementing. Otherwise one peer could send hop 200 and flood the mesh.
- **Every send and every relay waits a random 10–220 ms, as BitChat does.** On the phone this is `setTimeout`; on the desktop it is a `QTimer` on the module thread, guarded against teardown.
- Tests pin `originHopSpread: 0` and jitter `[0, 0]` to keep the old deterministic paths, and add tests for the spread, the clamp and the delay.

## What this does not fix (open)

- **The topic is still in the clear in every Bluetooth frame,** e.g. `/scala/1/<calendarId>/json`. It links a device across id rotations and shows which room nearby devices share. The fix is to replace it with a rotating tag keyed by the room key. That changes the wire format, and apps would have to supply the tag, because Loam never sees room keys. It is the next change to the Bluetooth protocol.
- **Android rotates its own address (RPA) on its own clock.** We can't align our rotation with it, so for up to one period the old address can bridge the old and new ids. DP-3T measured the same overlap with GAEN.
- **The service UUID is constant.** It reveals that a Loam user is nearby, not which one. Advertisement shape and timing can still fingerprint a device (Shi et al., USENIX Security 2024; arXiv 2609.26079).
- **The desktop Bluetooth id is random per process but doesn't rotate yet.** Desktop Bluetooth doesn't find the adapter yet anyway (ble_mesh TODO).
- **Linux may advertise the adapter's public address** unless BlueZ privacy is enabled. Unchecked.
- **Content has no forward secrecy:** sealed frames use the room key. Unchanged by this ADR.
- **Rotation costs a few seconds of reconnect every ~15 min.** We'll measure it on hardware.

## Consequences

- No breaking wire change; old and new peers interoperate.
- Loam needs a new release, and so does `loam_core` on the desktop. Apps on the shared node get the new sender ids automatically.
- After the update, every channel gets a new sender id. SDS treats it as a new participant, which is harmless: history is reconciled by event id (RBSR), not by sender.
