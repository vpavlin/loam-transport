# 9. No Store query on desktop → backfill is the app's job

- **Status:** accepted
- **Date:** 2026-07

## Context

Waku Store is the archive: a node can *query* historical messages from fleet store
nodes. On **mobile** the kernel symbol `waku_store_query` is bridgeable (the phone only
needs to read). On **desktop**, liblogosdelivery's delivery module exposes only
`createNode/start/subscribe/send/channel*` — **no Store query**. So a desktop peer cannot
pull arbitrary history from the fleet.

## Decision

- **Mobile:** offer `storeSync()` — cursor-paged history pull from the fleet store for
  every joined topic (idempotent; decrypt each returned payload exactly like a live
  receive). Surface the result count as the make-or-break signal.
- **Desktop:** there is no Store to pull from, so backfill must be **peer-served** — an
  always-on hub that holds the log, plus set-reconciliation to send only the delta. That
  reconciliation is **not** the transport's job; it lives in
  [`logos-sync`](https://github.com/vpavlin/logos-sync) (catch-up protocol).

## Rejected

- **Assume Store everywhere** — the desktop module doesn't have it; a desktop-only app
  would silently never backfill.
- **Rebroadcast-everything as the desktop backfill** — works but O(log) forever; replaced
  by logos-sync's delta catch-up.

## Consequences

- The transport's contract stops at live send/receive (+ mobile store pull). History
  convergence for cold-start/long-offline peers is a layer above it.
