# 6. Node mode: Core vs Edge, Edge default on mobile

- **Status:** accepted
- **Date:** 2026-08 (commit `cd357fd`)

## Context

A full relay node (`mode: Core`) joins the gossip mesh and relays the shard — great for
reliability, costly for a phone's battery and cellular data. The `mode` field
(`"Core"`/`"Edge"`) is the first-class knob; hand-adding raw `filter`/`lightpush` fields
instead makes `waku_new` **reject the config** (node reports offline).

## Decision

Expose `mode`. **`Edge` is the mobile default** (opt into `Core` for stable WiFi):
`{ mode:"Edge", preset, entryNodes, tcpPort:0 }` — client-only, publishes via lightpush,
receives via filter, no shard relay, no discv5. Desktop and the headless hub stay
**Core** (they're the service nodes Edge clients lean on; an all-Edge topic has nobody
relaying).

Two rules: `mode` is read only at node **start()** (a runtime toggle takes effect next
launch, or tear-down-and-recreate); and ship Core-tested before flipping any app to Edge
on cellular — that's the historically flaky path.

## Rejected

- **Always Core on mobile** — battery/data cost; users noticed.
- **Raw light-client fields** — rejected by `waku_new`; `mode:"Edge"` is the clean,
  config-accepted way to get a light client.

## Consequences

- Mobile is battery-friendly by default; the fleet + hub carry relay duty.
- A topic must have at least one Core peer (fleet or hub) or Edge clients can't sync.
