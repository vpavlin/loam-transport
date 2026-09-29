# 7. A reconnect watchdog for network handoffs

- **Status:** accepted
- **Date:** 2026-08

## Context

On a WiFi→5G handoff (or any transient drop) the node's transport peers silently fall to
zero and **do not recover on their own** — the app looks connected but syncs nothing.
Observed directly on the shared delivery node: "does not survive WiFi→5G."

## Decision

Run a **reconnect watchdog** in the real-node layer: poll peer count on a timer; on two
consecutive 0-peer reads, `redial()` — reconnect each `entryNode` and re-subscribe every
joined topic. Peers recover and post-reconnect events sync. (Peer-count gauges under-
report, so the trigger is *sustained* zero, not a single read — ADR aligns with "never
conclude offline from one 0.")

## Rejected

- **Trust the node to self-heal** — it doesn't, for this transition.
- **Redial on every 0-read** — flaps on the noisy gauge; require two consecutive.

## Consequences

- Sync survives real-world mobile network changes.
- Re-subscribe on redial re-applies the subscribe-before-channelCreate gate (ADR 0003).

## Amendment (2026-09-29): never re-create the node; don't touch it offline

- **Never re-create the node.** The Android implementation had grown into stop → `LogosMessaging.new()` →
  start. On device, a second `new()` in the same process segfaults the native library (SIGSEGV within a
  second of "node new"; the exit shows as `reason=SIGNALED status=11`). The breadcrumb trail proved it
  (ADR 0019). Re-dial is now what this ADR originally said: `connect()` each entry node **on the live
  node**. A node that failed to start stays down until the next app start.
- **Skip re-dial and subscription renewal while offline.** Even on the live node, the once-a-minute re-dial
  and subscription renewal on a device with no internet crashed natively too. Both now run only when Android
  reports a network with **validated internet** (`LoamMesh.online()`); otherwise the trail records
  `redial skipped: offline` / `renew skipped: offline`. Offline, nothing can be dialed anyway, and the BLE
  mesh (0012/0019) carries the traffic.
- **Correction to "Consequences":** sync survives network changes *once the internet is back*. While
  offline, the watchdog deliberately does nothing.

**Review follow-up (2026-09-29):**
- Only a re-dial that actually dialed counts toward the backoff (45 s → 10 min). Offline skips don't, and a return to online resets it; the trail marks "offline" / "back online" once each.
- A re-dial tries 2 random entry nodes with a 3 s timeout. `connect()` is a synchronous native call that holds the shared native-module thread.
- A restart reuses the existing node context and never calls `new()` again.
- The offline test is "a network that claims internet" (`NET_CAPABILITY_INTERNET`), not "validated". Validated is false behind a Wi-Fi login page, on some VPNs and on mesh networks, where the fleet can still be reachable.
