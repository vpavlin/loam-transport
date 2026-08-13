# 4. Double-base64 + byte-array payload framing

- **Status:** accepted
- **Date:** 2026-07 → 2026-08

## Context

The wire representation of a payload is interop-critical and has bitten every app. Two
distinct traps:

1. **Depth.** The SDS reliable-channel path (mobile logos-transport real-node) is
   **double-base64**; legacy plain relay is single. A receiver that peels the wrong
   number of layers gets garbage that never AEAD-opens.
2. **Representation.** The current cpp-sdk `channelSend` expects the payload as a JSON
   **byte array** `[65,66,…]`, not a JSON string. Passing `payload.dump()` serialized the
   array to the *text* `"[65,66,…]"` and sent THAT — every desktop/hub message was
   undecodable on the wire (mobile received nothing). This was scala's "sends fine,
   receives nothing" root cause.

## Decision

- **Send:** inner-base64 the sealed bytes, hand the module the **byte-array** LogosMap
  (never `.dump()`); the module adds the outer base64. On receive, peel raw → single →
  double and keep the candidate that AEAD-opens.
- Probe the byte-array vs string representation once and cache which the linked sdk wants
  (`bytesPayload` first, string fallback) — so the header works across sdk versions.
- utf8-convert carefully on mobile (Hermes gotcha, SPEC L4).

## Rejected

- **Assume single-base64 / a JSON string** — the two failures above, both silent.

## Consequences

- The framing is asymmetric-looking but symmetric in effect; the header owns it so apps
  never touch base64 depth. A change here is a wire-break — test both directions.
