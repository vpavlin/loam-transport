# 0. Record architecture decisions

- **Status:** accepted
- **Date:** 2026-08-13 (retroactively documenting decisions taken 2026-07 → 2026-08)

## Context

logos-transport was extracted from KYM/Qaku after each of those apps independently
re-learned the same painful transport facts (subscribe-before-channelCreate, the
double-base64 depth, async-or-deadlock…). The mechanics live in
[`TRANSPORT_SPEC.md`](../TRANSPORT_SPEC.md) as a layered L0–L10 reference. What was
missing was the **why** behind the load-bearing choices — so the next integrator
(or a refactor) doesn't "simplify" a gotcha back into a silent failure.

These ADRs are written **retroactively** from the code, the spec, the commit history,
and hard-won debugging memory. They record decisions, the alternatives rejected, and
the symptom you get if you undo them.

## Decision

Keep a numbered ADR log in `docs/adr/` (same lightweight format as the sibling
[`logos-sync`](https://github.com/vpavlin/logos-sync)). The SPEC stays the "how";
ADRs are the "why + what-breaks-if-reverted."

## The log

- [0001](0001-crypto-agnostic-opaque-bytes.md) — Crypto-agnostic: move opaque sealed bytes
- [0002](0002-sds-reliable-channels-over-raw-relay.md) — SDS Reliable Channels, not raw relay
- [0003](0003-subscribe-content-topic-before-channelcreate.md) — Subscribe the content topic before channelCreate
- [0004](0004-double-base64-byte-array-framing.md) — Double-base64 + byte-array payload framing
- [0005](0005-all-delivery-ops-async.md) — All delivery ops are async
- [0006](0006-core-vs-edge-node-mode.md) — Node mode: Core vs Edge, Edge default on mobile
- [0007](0007-reconnect-watchdog.md) — A reconnect watchdog for network handoffs
- [0008](0008-entrynodes-and-preset-carry-the-cluster.md) — entryNodes required; the preset carries the cluster
- [0009](0009-no-store-on-desktop.md) — No Store query on desktop → backfill is the app's job
- [0010](0010-shared-node-broker-and-servicenode.md) — One node per phone: the broker + ServiceNode seam
- [0011](0011-per-tenant-offline-cache.md) — Per-tenant offline cache in the shared node
- [0012](0012-ble-mesh-bearer.md) — BLE mesh as a second bearer *(accepted; portable core proven, native radio not yet device-verified)*
- [0013](0013-desktop-ble-relay-gateway.md) — Desktop/laptop as a BLE mesh relay & internet gateway *(proposed)*
- [0014](0014-identity-first-ble-connections.md) — Identity-first BLE connection management *(accepted; implementing)*
- [0015](0015-loam-on-desktop-composable-core-modules.md) — Loam on desktop: a `loam_core` facade over composable bearer modules (delivery, ble_mesh, …) *(proposed)*
