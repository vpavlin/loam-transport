# 1. Crypto-agnostic: move opaque sealed bytes

- **Status:** accepted
- **Date:** 2026-07

## Context

Every app encrypts, but not the same way — Scala seals with AES-256-GCM, KYM/Qaku/Perun
with ChaCha20-Poly1305 (topic as AAD). If the transport owned encryption it would have
to pick one cipher (a pointless migration for the others) or negotiate ciphers (a layer
nobody needs).

## Decision

The transport moves **opaque sealed bytes** and never sees a key. You hand it
`publishSealed(topic, bytes)`; on receive it hands you the candidate sealed byte-arrays
and *you* open one with your key — only the right key/candidate authenticates. Topic
derivation, identity, and the wire envelope are all yours.

## Rejected

- **Bundle a canonical cipher** — forces Scala off AES-GCM; buys nothing.
- **A key-management layer in the transport** — couples an orthogonal concern (and the
  future MLS upgrade) to node plumbing.

## Consequences

- Apps keep full control of crypto; different ciphers coexist on one transport.
- The transport is testable without keys, and the same wire carries any app's bytes.
