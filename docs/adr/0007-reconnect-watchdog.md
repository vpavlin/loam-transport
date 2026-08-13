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
