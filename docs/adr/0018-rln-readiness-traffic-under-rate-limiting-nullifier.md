# 18. RLN readiness: shaping our traffic for the Rate-Limiting Nullifier

- **Status:** proposed (plan of action; parts gated on answers from the Logos Messaging team)
- **Date:** 2026-09-23
- **Relates to:** 0006 (Core vs Edge node mode), 0010 (shared-node broker + ServiceNode), 0002 (SDS
  reliable channels), 0007 (reconnect watchdog); complements loam-sync's snapshot ADR (log snapshots to
  Storage) and its batching work.

## Context

The Logos Messaging network (a Waku fork; our node is **liblogosdelivery 0.38.1**, commit `e91aaaa`,
under `logos-messaging/logos-delivery`) is expected to enable **RLN (Rate-Limiting Nullifier)** spam
protection. RLN is already **shipped-but-dormant** in the node we ship: `librln.so` (zerokit) is linked
and force-loaded, the `WakuMessage` carries a `proof` field, and the `waku_rln_relay` implementation +
the rlnv2 membership contract are vendored. Our client sets **none** of it — the single injection seam is
`buildConfig()` in `src/logos-transport.ts` (today just `{mode, preset, entryNodes}`); setting
`rlnContractAddress` in that config alone flips RLN on.

**What RLN costs a publisher** (Logos LIPs 64/WAKU2-NETWORK, 17/WAKU2-RLN-RELAY, RLN-V2):

- **Budget = 100 messages per 10-minute epoch, per _membership_, hard-capped** (`MAX_MESSAGE_LIMIT=100`,
  `rlnEpochSizeSec=600`). It is a **quota of 100 per epoch** — burst-then-idle is fine, but the 101st
  message in a 10-minute window reuses a `message_id`, double-signals, and is dropped everywhere.
- **A membership is per-_node_, not per-app.** All apps sharing one Loam node (kym, qaku, perun, scala)
  **share one 100/epoch budget.**
- **Over-budget** → the message is Rejected and the relayer that forwarded it takes a gossipsub
  scoring penalty. **No slashing on the messaging fleet** (`staked_fund=0`); cryptographic slashing exists
  only on the separate Status-L2 deployment. **Proof-less** messages are still forwarded while a shard is
  under 1 Mbps and dropped above it — so **RLN is _soft_ today and will harden.**
- **Membership** is an on-chain, permissionless, **no-stake (gas only)** registration of a commitment;
  the secret stays on the node. Chain is unresolved in the sources (network spec says Sepolia; the
  keystore tool says Linea Sepolia — likely a migration).
- **Edge/phone (the hinge):** the intended path is **RLN-as-a-service** — the phone lightpushes to a
  **service node that attaches _its own_ proof and spends _its own_ allowance**, keeping the membership +
  multi-MB zk circuit + ~200 ms proof-gen **off the phone**. Whether this RLNaaS/lightpush path is wired
  on our fleet today is unconfirmed.

**Why this bites us specifically.** Our traffic is bursty and multiplexed onto one node:

- One `channelSend` per CRDT event, **no batching** in the client today.
- **SDS retransmits an unacked message up to 5×**, each a fresh metered publish → a 100-event import is
  ~600 messages (~6 epochs), not 100.
- SDS **segmentation is currently a no-op** (1 send/msg), but once wired a >100 KB payload fans out to up
  to **256** metered messages.
- Cold-device **catch-up** re-serves a whole log; live `SYNC_REQ` re-serve is relay publishes that burn
  the **serving** node's budget (store-pull is a read path and is not RLN-metered).

## Decision

**RLN is a transport/Loam concern; the apps only shape their message _count_ and surface backpressure.**
Proof attachment is node-internal (`librln` on the relay path) — our send code never constructs a proof —
so "handle RLN" means: configure it, own the membership, and pace the one shared budget. Concretely:

**Layer ownership**

| Concern | Owner |
|---|---|
| Turn RLN on (config), membership/credential lifecycle, proof attachment (node-internal) | **loam-transport** (`buildConfig()`) |
| Outbound **token-bucket pacer** (cap 100/epoch, refill per epoch, priority-aware) + **retransmit tuning** + a **backpressure signal** | **loam-transport** (owns the node + the one shared budget) |
| **Event batching** (pack N events → 1 message) + **pull-not-push** catch-up + **log snapshots to Storage** | **loam-sync** (only the sync layer can coalesce app payloads; do it once, all apps win) |
| Keep blobs in **Storage** off-channel + respect a max-channel-payload guard + show a "paused/rate-limited" state | **each app** (UI + discipline) |
| Its own (higher-tier / multiple) membership + monitoring RLN rejects | **the hub / infra** (a relay node → the 100/epoch is directly ours, shared across every household it serves — the sharpest pain point) |

So: **Loam does RLN; apps do traffic-shaping.** Not "both do RLN."

**Workstream A — no-regret, do now** (pure wins even before RLN: less bandwidth, battery, faster cold
start):

1. **Log snapshots to Storage for bootstrap catch-up** (loam-sync; see its snapshot ADR). Removes the
   single biggest burst — a joining device fetches one content-addressed blob instead of hundreds of
   relay-served messages.
2. **Event batching** in loam-sync — coalesce pending events in a short window into one channel message.
   ~4 KB packs 10–40 tiny events → 10–40× fewer messages.
3. **Tune SDS retransmit down** — lean on RBSR catch-up rather than 5× resends.
4. **Max-channel-payload guard → route overflow to Storage** (never let segmentation fan out).

**Workstream B — Loam mechanism** (build dormant, flip on when Logos does):

5. Outbound **token-bucket pacer** (cap 100/epoch; live edits before bulk re-serve) + a **backpressure
   signal** apps surface in their sync indicator.
6. **RLN config injection** at `buildConfig()` (contract/chain/epoch/rate); ensure Edge clients route
   through RLN-proxying service nodes.

**Workstream C — blocked on Logos** (coordination):

7. **Credential-plumbing gap:** the stable messaging FFI exposes RLN contract/chain/epoch/rate but **not**
   the membership keystore (`credPath`/`credPassword`/`credIndex`/`userMessageLimit`) — those live only in
   the deeper `WakuNodeConf`, and the builder fails closed without them. Provisioning a membership through
   our node API needs an **upstream change** (or Logos-managed registration).
8. Confirm the **hub** can get adequate rate (100-cap vs a higher tier / multiple memberships).

**Questions to put to the Logos Messaging team** (they gate B/C):

1. Is RLN **enforced on our fleet today**, or soft? Hardening timeline?
2. Which **chain** — Sepolia or Linea Sepolia?
3. Is **RLNaaS / RLN-over-lightpush wired now** so Edge phones don't self-prove — or must they?
4. What **rate** can a relay node (our hub) get — the 100 cap, or a higher tier / multiple memberships?
5. Will they **plumb the keystore credential through the messaging FFI**, or provide managed registration?

## Consequences

- The bulk of the work is in the **shared layers** (loam-transport + loam-sync), so all four apps inherit
  RLN-readiness without per-app RLN code. Per-app work is limited to keeping blobs in Storage and
  reflecting backpressure in the UI.
- Workstream A shrinks our wire footprint **regardless of RLN** and de-risks the eventual switch, so it
  proceeds now without waiting on Logos.
- The **hub is the acute risk**: a single relay membership at 100/epoch serving many active households.
  Snapshots (pull, not push) plus batching are what keep it under budget; if that's not enough, it needs a
  higher-tier or multiple memberships (question 4).
- **Edge answer flips the plan if wrong:** if phones must self-prove (no RLNaaS), they need the membership
  + multi-MB circuit + per-message proof-gen on-device — a large cost we would have to design around. This
  is the one unknown that can move the center of gravity, so B/C stay *proposed* until question 3 is
  answered.
- Because RLN is soft today, we must not design around a limit that will tighten — we build the count
  reduction now and keep the pacer/config dormant behind a flag until the fleet enforces.

**Open questions:** the five above; snapshot cadence/writer (deferred to the snapshot ADR); whether store
reads stay unmetered under a future RLN-for-store design.
