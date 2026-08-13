# 8. entryNodes required; the preset carries the cluster

- **Status:** accepted
- **Date:** 2026-08

## Context

Two silent "never meshes" failures traced to node config:

1. **Empty `entryNodes`.** A `{mode, preset}` config with no bootstrap peers leaves the
   node isolated ("No peers for topic") — it never dials the fleet. The mobile face of a
   "hub silently isolated."
2. **Stale preset after a fleet cluster migration.** The preset *carries the clusterId*.
   `logos.dev` migrated to cluster 3, so new nodes on the `logos.dev` preset dialed the
   now-different-cluster boxes with mismatched config and never grafted a mesh —
   while long-lived nodes kept working (only new joins failed).

## Decision

- Always supply a **real, non-empty `entryNodes`** bootstrap list.
- Pin the preset to the fleet's **current** cluster: use **`logos.test`** (cluster 2),
  not `logos.dev` (cluster 3), keeping the entry-node multiaddrs pinned.
- No manual `clusterId`/`shard` pinning — the preset + auto-sharding handle it.

## Rejected

- **Preset only, empty entryNodes** — isolated node (failure 1).
- **Sticking with `logos.dev`** — broke all new joins after the migration (failure 2).

## Consequences

- New nodes mesh reliably. Cross-check with the always-on hub: if IT relays, the fleet's
  up and a failing client is the problem (not the fleet).
