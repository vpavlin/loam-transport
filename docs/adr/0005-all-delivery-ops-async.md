# 5. All delivery ops are async

- **Status:** accepted
- **Date:** 2026-07

## Context

The delivery module is reached over IPC (Qt Remote Objects on desktop, JNI on mobile).
A synchronous call blocks the caller until the reply — and the reply is dispatched on
the **same event-loop thread** the caller is blocking. On a stalling lightpush or a slow
node bring-up, the call sits on the ~20 s IPC timeout, freezing the module (buttons
stuck, node "never ready").

## Decision

Every delivery op is **async with a callback**: `createNodeAsync`, `startAsync`,
`subscribeAsync`, `channelCreateAsync`, `channelSendAsync`, `getNodeInfo`. `send()` is
fire-and-forget. The bootstrap is a callback chain: `createNode → start → (join per
topic) → onReady`. Never call the sync variants from the event-loop thread.

Corollary for the **headless hub**: drive its own delivery calls from a `QTimer` on the
event-loop thread, never a `std::thread` — a worker-thread driver leaves `createNode`
hanging (the async callbacks only dispatch on the event-loop thread).

## Rejected

- **Sync calls "for simplicity"** — the deadlock above; it presents as "core module
  stuck" or "node never ready," not as an obvious hang.

## Consequences

- Bring-up and every op are non-blocking; a stalling network degrades gracefully.
- The app must think in callbacks/continuations, which the `Ops`/`Transport` shape
  encapsulates.
