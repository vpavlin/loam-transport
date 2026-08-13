# 2. SDS Reliable Channels, not raw relay

- **Status:** accepted
- **Date:** 2026-07

## Context

liblogosdelivery offers two ways to move a message: raw relay (`subscribe`/`send`) and
**SDS Reliable Channels** (`channelCreate`/`channelSend`/`onChannelMessageReceived`).
Raw relay is fire-and-forget gossip: a message dropped in transit is simply gone.

## Decision

Carry app bytes on **SDS Reliable Channels**. SDS wraps each message with a causal
history + bloom-filter acknowledgement, giving **ordering, gap detection, retransmit of
un-acked messages, and causal history** inside the delivery layer — the live-reliability
we'd otherwise have to hand-build. It is the mature path (30+ releases). `channelId ==
contentTopic ==` the derived topic; `senderId ==` a stable per-install device id.

## Rejected

- **Raw relay + our own reliability** — reinventing SDS, badly.
- **libchat's group transport** — a different protocol (its own node, MLS, add-only
  in-memory groups); investigated and rejected for sync (see the logos-sync notes).

## Consequences

- Live drops self-heal; we only add **backfill** for cold-start/long-offline history
  (SDS does not reconstruct arbitrary history — that's logos-sync's catch-up + ADR 0009).
- SDS requires a no-op Encrypt provider (it refuses a channel with none) since we AEAD
  above it — see the SPEC.
