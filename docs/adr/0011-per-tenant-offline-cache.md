# 11. Per-tenant offline cache in the shared node

- **Status:** accepted
- **Date:** 2026-08-13

## Context

The shared delivery node (co.logos.delivery) is a **foreground service that keeps
running** while an individual app (Scala / Qaku / KYM) is backgrounded or closed. It
is subscribed to that app's content topics on the app's behalf, so it is *already
receiving* the app's traffic while the app is away — and today it **drops it on the
floor**: an unbound client's `Tenant` is `close()`d, its subscription released, and
the messages are gone. The app then does a full catch-up (RBSR reconciliation, see
[`logos-sync`](https://github.com/vpavlin/logos-sync)) on every reopen.

That reconciliation is avoidable for the common case — *app backgrounded a few
minutes, phone stayed on, node stayed up*. The node had the messages the whole time.

## Decision

Give each tenant an **opt-in, bounded, in-memory offline cache** in the broker. When
a caching tenant's client unbinds we **`detach()`** it instead of `close()`ing it:

- **keep the subscription** (this is the whole point — the node keeps receiving);
- **buffer** incoming sealed payloads into a ring of at most `cacheLimit`, evicting
  oldest on overflow and counting the evictions (`dropped`).

When the client re-binds we **`reattach(onMessage)`**: drain the buffer **in order**
through the app's callback, then resume live delivery, and report
`{ delivered, dropped }`.

- **The app drains the cache first, then reconciles only the remainder.** Draining is
  idempotent (the app dedups by event id), so it composes with catch-up. If
  `dropped === 0` the cache was complete and catch-up can be **skipped** entirely — the
  replay we were paying for on every open is gone. If `dropped > 0` the cache
  overflowed while away, so the app still runs catch-up to fill the gap.
- **Opt-in per approved app.** `cacheLimit` is set at registration; the consent
  decision (which apps may be cached, and how much) lives in the shared-delivery
  service, not the broker. Default `0` = today's behaviour (unbind drops the
  subscription). A `hard` unregister always fully closes (opt-out / teardown).
- **The cache holds only opaque sealed bytes**, keyed by tenant + content topic. The
  node has no keys and never decrypts — the consent/crypto boundary (ADR 0001) is
  intact. What sits in the ring is the same ciphertext that was on the wire.

Concretely this becomes a **local, per-tenant mini-Store on the device** — which is
especially welcome because mobile's fleet Store-pull (ADR 0009) is unreliable.

## Scope / non-goals

- **It complements catch-up, it does not replace it.** The cache cannot cover a
  message that arrived while the **node itself was down** (phone off / service killed)
  — that is exactly the case RBSR catch-up handles. Nor an overflow, nor an event from
  a peer the node never saw. Drain-then-reconcile is the contract.
- **In-memory for now.** It survives app backgrounding (the target case) but not a
  service restart / reboot. Disk-persisting the ring (a real durable local Store) is a
  clean follow-up via an injected persistence hook — deliberately deferred so the first
  cut stays small.

## Rejected

- **Cache everything for everyone, always.** Unbounded memory, and it caches for apps
  that never come back; the per-app opt-in + ring bound are load-bearing.
- **Decrypt-and-fold in the node.** Breaks the crypto/consent boundary and duplicates
  the app's engine. The node caches opaque bytes; the app folds.
- **Rely on Waku Store instead.** Not exposed on desktop, unreliable on mobile
  (ADR 0009); a local cache is both faster and always-available while the node runs.

## Consequences

- For "backgrounded but node alive," reopening an app is **drain-and-go with zero
  reconciliation**; catch-up remains the backstop for everything the cache can't cover.
- New broker surface: `Tenant.detach()` / `reattach()` / `cacheLimit` / `lastReplay`;
  `registerTenant(id, {cacheLimit})`; and at the service seam `registerClient(...,
  {cacheLimit})` (re-register reattaches) / `unregisterClient(id, {hard?})`
  (detach-if-caching else close). Covered by `test/broker-cache.test.ts`.
