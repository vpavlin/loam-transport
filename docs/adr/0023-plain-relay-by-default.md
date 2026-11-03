# 23. Plain relay by default; SDS channels are opt-in

- **Status:** accepted (supersedes [0002](0002-sds-reliable-channels-over-raw-relay.md))
- **Date:** 2026-11-03

## Context

ADR 0002 put every topic on SDS reliable channels so a message lost in transit would be repaired.
Since then:

- SDS adds a ~19 KB rolling bloom filter to every message. Measured on delivery 0.3.0, Scala frames
  were 760–1368 bytes over relay and 19.6–20.4 KB over channels; Scala traffic cost the shrooms VPS
  about 356 GB in one day (2026-10-20). Scala moved to relay then (`/scala/`), the other apps stayed.
- Every app on Loam already repairs gaps itself with loam-sync's RBSR catch-up (Scala, KYM, Qaku,
  Perun, Kith, Freequencies), and Backpack needs no repair (its update notes are signed; the newest
  wins). SDS duplicated that work.
- Each channel topic needs a `channelCreate` after the subscribe. When it failed, the topic stayed
  pending: the Store pull skipped it while answering "accepted", and Backpack on a phone missed
  updates until Loam was restarted (2026-11-03).

## Decision

- Every topic goes over plain relay (`subscribe` / `send`). No channel is created.
- An app that still wants SDS opts in per prefix: `setTopicMode("/myapp/", "channels")` here, and
  `loam_core.setTopicMode(prefix, "channels")` on the desktop (loam_core 0.7.3 makes relay its default too).
- Relay and channel peers keep interoperating: a relay node peels the SDS frames it receives, and a
  channel node gets relay frames as plain messages. Old and new builds sync during the rollout.

## Consequences

- Messages are their payload size again (no bloom filter): far less traffic for phones, hubs and
  the fleet, and less pressure on an RLN message budget's bandwidth.
- One join step fewer, so one way fewer for a topic to get stuck.
- A message lost in transit is repaired by the app's own catch-up (or a Store pull), not by SDS.
  An app with no catch-up of its own must opt in to channels or add one.
