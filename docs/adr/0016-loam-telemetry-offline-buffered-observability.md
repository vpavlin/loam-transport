# 16. loam-telemetry: offline-buffered node diagnostics over a sealed topic → Prometheus

- **Status:** accepted (mobile + tooling built & unit-verified; live-fleet + native-C++ publisher pending)
- **Date:** 2026-08-16
- **Relates to:** 0001 (crypto-agnostic opaque bytes), 0010 (shared-node broker), 0012 (BLE mesh bearer), 0015 (loam_core desktop facade)

## Context

The Loam bugs that matter happen **off the network** — a BLE-only room, a dead zone, a phone that
won't sync until it re-reaches the fleet. You cannot watch those live, and the debugging loop so far was
"read numbers off a phone screen and retype them," which is slow and lossy (see the BLE-receive
investigation — every round trip was a hand-typed stat). We need to **capture, compare and visualize**
node health across *both* Android and Basecamp/desktop nodes, including the offline stretches.

Two false starts informed the decision:
1. A first cut put telemetry in the **Loam app** (`App.tsx`) with hand-wired `record()`/`flush()` calls
   into the transport. Owner's steer (binding): *don't hook it explicitly into delivery from the app —
   make it a Loam feature so every app and the UI get it.*
2. Simply exposing `metricsJson()` for polling gives no **offline** story: a phone in a dead zone has
   nothing to poll, and the interesting transition (offline → online) is exactly what's lost.

## Decision

**Telemetry is a transport feature, not app glue,** and it is **offline-first**:

1. **One call.** `transport.enableTelemetry(secret)` and the node **self-drives** — an internal timer
   snapshots the node's *own* live state (`counters` + bearer/mesh status; no app input) into a bounded,
   disk-persisted ring, and **flushes to the fleet only when reachable** (`peers > 0`). Any UI reads
   `transport.telemetryStatus()`; `LoamDebug` shows it automatically, so every app on the shared node
   gets device telemetry for free.
2. **Sealed, opt-in, ciphertext-only.** Off by default. `enableTelemetry(secret)` is idempotent and
   **reconfigurable** — Loam sets it at **runtime** from a persisted secret (a UI field: type a secret →
   on, clear → off), with a build-time `EXPO_PUBLIC_TELEMETRY_SECRET` as fallback, so no special build is
   needed to turn it on. Snapshots are sealed with chacha20poly1305; the **topic and key both derive from
   the secret** via
   hkdf/hmac (`/loam-telemetry/1/<hmac(K)[..16]>/proto`), so nobody without it can read *or even locate*
   the stream. The node sealing its *own* diagnostics with its *own* key does **not** violate 0001 —
   app payloads stay opaque as ever; this is separate, node-owned data.
3. **Lazy-loaded.** `logos-transport` pulls telemetry via dynamic `import()` (only a `typeof import` type
   ref is static), so the pure core (bearer/broker, node tests) never gains `expo-*`/`@noble` deps —
   13/13 core tests stay green. The crypto deps are declared as **optional** peer-deps.
4. **Both platforms publish over delivery.** Android publishes natively (above). Basecamp/headless nodes
   publish via a companion (`tools/loam-telemetry-publish.mjs`) that reads `loam_core.metricsJson()` and
   sends a sealed snapshot through `loam_core.sendSealed()` — **no C++ crypto** — tagged `src:"basecamp"`.
5. **Capture + expose = loam_core + an exporter.** `loam_core` (run headless in the hub) subscribes the
   telemetry topic; `tools/loam-telemetry-exporter.mjs` decodes the sealed stream, keeps the latest per
   device, and serves **Prometheus `/metrics`** labeled `dev` + `src`. `logos-hub telemetry <profile>`
   wires the two. Prometheus scrapes it, Grafana compares Android vs Basecamp and across devices.

## Consequences

- **Observability across the fleet,** including offline→online transitions, without touching a phone.
- **Privacy-preserving by construction:** opt-in, ciphertext-only, topic hidden behind the secret.
- Requires a **pre-shared secret** distributed to publishers and the collector — acceptable for a
  diagnostics channel; not a user-data path.
- The Basecamp publisher is a **Node companion**, chosen deliberately over adding chacha+hkdf to the C++
  module (heavier build, no test harness here). A **native `loam_core` publisher/collector** is the
  clean follow-up; the wire format (sealed JSON, the derivation) is fixed so it can slot in unchanged.
- Verified in Node (seal↔open parity; full publish→decode→`/metrics` for an Android and a mock-Basecamp
  snapshot). **Unverified against a live fleet** — same constraint as the mesh work (no fleet-capable
  node in the dev box).

## Alternatives considered

- **App-level record/flush glue** — rejected per owner's steer; not reusable, invisible to the UI.
- **Poll `metricsJson()` only** — no offline buffering, loses the transition that matters.
- **Unsealed telemetry** — rejected; even diagnostics leak device/topology, and an open topic is
  trivially locatable.
- **Native C++ publisher first** — deferred; the Node companion delivers the same wire result now and is
  unit-testable, and the format is stable for a later native swap.
