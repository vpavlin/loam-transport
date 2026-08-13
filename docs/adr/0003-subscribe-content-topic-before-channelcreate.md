# 3. Subscribe the content topic before channelCreate

- **Status:** accepted
- **Date:** 2026-08 (commit `3d6d13c`)

## Context

Joining a channel is two calls. The obvious order — just `channelCreate` — leaves you
receiving **nothing**: traffic arrives at the relay/filter layer, but the app's channel
callback never fires. The counter reads `ours: 0` and it looks like the network is dead.

## Decision

In `join(topic)`, **`subscribe(contentTopic)` FIRST, then `channelCreate(id, contentTopic,
deviceId)`**. `channelCreate` does not itself subscribe the content topic, and the
delivery recv-service only emits `onChannelMessageReceived` for **subscribed** topics.
So the subscribe is the gate that feeds the channel layer. Proven against qaku_core
(`subscribeAsync` THEN `channelCreateAsync`).

## Rejected

- **`channelCreate` alone** — the exact "channel joined, receives zero" bug.
- **Subscribe a raw pubsub topic** (low-level `waku_relay_subscribe`) — silently
  subscribes a shard that doesn't exist; use the content-topic call (auto-shards).

## Consequences

- Content-topic leases expire on the fleet → renew on an idempotent timer (SPEC L8).
- This ordering is non-obvious and easy to "clean up"; the header enforces it.
