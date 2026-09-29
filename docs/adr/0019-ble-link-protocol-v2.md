# 19. BLE link protocol v2 (what two real phones taught us)

- **Status:** accepted — verified on hardware (phone + tablet, Loam 0.0.43+, 2026-09-29)
- **Date:** 2026-09-29
- **Supersedes:** the native-radio details of [0012](0012-ble-mesh-bearer.md) and the wire/announce
  details of [0014](0014-identity-first-ble-connections.md). Their decisions (mesh bearer, identity-first
  routing) stand.

## Context

From 2026-08-16 to 2026-09-28 the BLE mesh was stuck at "links form, counters move, nothing is delivered",
and later, "works one way, sometimes". A full review of the native radio, the portable bearer, and the
qaku → Loam → mesh path, followed by two-device testing, found several independent bugs. Any one of them
was enough to make the mesh look haunted:

1. **Two GATT operations in flight at once.** `requestMtu` → `discoverServices` and CCCD write → announce
   were fired back to back. Android runs one GATT operation per link and drops the rest, so the announce
   was often lost, the link stayed anonymous (unroutable under 0014), and nothing was delivered.
2. **Frames larger than Android allows.** At MTU 517 a fragment was 514 B, but Android caps one attribute
   value at **512 B** regardless of MTU.
   - On API < 33 the peer rejected the write, while the sender counted it as sent because
     `onCharacteristicWrite` ignored the status. The result was `wOk` climbing and `recv=0` on the other side.
   - On API 33+ `writeCharacteristic` / `notifyCharacteristicChanged` threw `IllegalArgumentException`
     into a Binder callback and **killed the app**.

   Announces (17 B) fit, so peers were learned (`nodes=1`), which made the bug look like a routing problem.
3. **Links that stayed one-way.** A side that missed the peer's announce only re-sent *its own* id and never
   asked for the peer's. The server side announced exactly once.
4. **Frames that didn't fit a minimum-MTU link.** The raw `deviceId` announce (~25 B) and fragments with a
   16-byte floor exceeded the 20 B that MTU 23 carries.
5. **Loss above the radio.** The portable seen-set remembered frames forever, so byte-identical re-sends
   (every CRDT retry and catch-up re-serve) were never flooded again (see 0012 amendment).

## Decision

### Wire format (breaking: v2 phones do not interoperate with 0.0.39)

Every GATT write or notify carries exactly one frame. The first byte is its type:

| Type | Byte | Payload | Meaning |
|---|---|---|---|
| `A` | 0x41 | wire node id (16 B) | "this link is me" |
| `Q` | 0x51 | wire node id (16 B) | "this link is me — **who are you?**" (the receiver records the id, then answers with `A`) |
| `F` | 0x46 | `msgId(2 BE) \| idx(1) \| count(1) \| chunk` | one fragment of a portable frame (0012) |

- **Wire node id** = `base64url(sha256(deviceId)[0..12])`, which is always 16 characters. Peers treat it as an
  opaque key. It keeps every announce within one minimum-MTU write (1 + 16 ≤ 20).
- **Fragment size** = `min(MTU − 3, 512) − 5`. The 512 is Android's maximum attribute length, and the 5 is the
  type byte plus the fragment header. There is no floor.
- **Max 255 fragments** per message, because `idx` and `count` are one byte each. A larger message is refused
  (`err=too big`) instead of wrapping around and corrupting reassembly.

### Link rules

- **One GATT operation at a time, per link, started from the previous operation's callback.**
  - Client setup: `requestMtu` → (`onMtuChanged`) `discoverServices` → (`onServicesDiscovered`) CCCD write →
    (`onDescriptorWrite`) announce. A 1.2 s fallback discovers anyway if the stack never reports the MTU.
    `discoverOnce` guards against both paths firing.
  - Data uses the same rule: a per-link queue sends the next frame only after `onCharacteristicWrite` /
    `onNotificationSent`.
- **Ask until known, then give up.** Every 2.5 s, each link whose peer id is still unknown gets a `Q`. After
  8 tries (about 20 s) the link is dropped so the scanner re-dials it from scratch. This also clears
  zombie links whose setup failed silently.
- **Drop useless links.** A link whose peer has no Loam service or characteristic is disconnected at once.
- **A failed status is a failed send.** A non-success status in `onCharacteristicWrite` /
  `onNotificationSent` counts as `wFail` with `err=write status N`, so the stats can never show success
  when nothing arrived.
- **A radio call must never throw into a callback.** `writeToPeer` and the announce timer are wrapped. An
  exception is logged and counted, and never kills the process.
- **Connect with `TRANSPORT_LE`**, which avoids status-133 BR/EDR attempts on dual-mode phones.
- **Refuse prepared (long) writes** (`GATT_REQUEST_NOT_SUPPORTED`). Frames are sized to fit one write, and
  reassembling chunks by offset is not implemented.
- **Stopping clears everything.** `stop()` / `start()` clear every per-link table: queues, in-flight flags,
  identities, reassembly. A stale `inFlight` used to mute a re-formed link to the same address.

### Observability (how these were found without adb)

- **Stats line:** `stats()` returns
  `node= nodes= cli= srv= pend= mtu= sent= wOk= wFail= recv= deliv= reasm= lastFrag= err=`. Loam shows it
  on the Bluetooth card and includes it in the copy dump (`radio:`).
- **Crash report:** Loam shows the previous run's crash on screen, as selectable text with a copy button. It
  combines three sources:
  - JVM stack traces, via the uncaught handler writing `loam-last-crash.txt`;
  - Android exit reasons (`ApplicationExitInfo`, native trace where available);
  - a **breadcrumb trail**: JS marks lifecycle steps into `loam-trail.txt`, rotated per process.

  The trail is what proved the unrelated node segfault (ADR 0007 amendment).

## Consequences

- Two phones deliver both ways over Bluetooth only, including catch-up (qaku, 2026-09-29).
- **Breaking wire change:** every phone in a mesh must run Loam ≥ 0.0.41.
- The mock radio (0017) still can't exercise any of this. The link protocol is verified only on hardware.

## Open

- **Duplicate links under RPA rotation.** Routing collapses them by node id, but they use connection slots.
- **Some stacks stop advertising after the first connection** (not yet seen, but reported for bitchat).
- **No carry-forward outbox.** A message sent with nobody in range is not kept for later; the app's
  catch-up covers it.
- **Android < 12 needs location permission** for scanning, and Loam doesn't request it.

## Review follow-up (2026-09-29)

- **Per-link state is role-aware.** When one role of a dual-role link (client or server) disconnects while the other is still up, the address keeps its identity, MTU and queue. Wiping them had dropped the fragment cap to 15 B for good.
- **A send whose completion never arrives times out after 5 s** (`err=send timeout`), so it can't wedge a link. A link refuses new messages beyond a 1500-frame backlog (`err=queue full`).
- **No `Q` goes out on a client link still in setup,** because it would collide with the in-flight GATT operation.
- **Every radio call made from a callback or timer is wrapped:** discover, notification setup, `connectGatt`, `sendResponse`, write and notify. A failure drops the link instead of throwing.
