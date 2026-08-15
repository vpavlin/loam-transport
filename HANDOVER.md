# Handover — integrating `loam-transport` into scala (Basecamp core)

**Audience:** the agent building **scala** (a Basecamp-only Logos app, C++ core, no mobile
yet). **Goal:** give scala's core two-way multi-writer sync over Logos Delivery / SDS
Reliable Channels by dropping in the shared, proven transport instead of re-deriving it.

## What this repo is

`loam-transport` is the sync transport extracted from two **shipping, proven** Logos apps
— **KYM** (budget) and **qaku** (Q&A). It moves **opaque sealed bytes** on content topics
over SDS Reliable Channels; it is **crypto-agnostic** (your core owns keys/envelope). Two
wire-compatible sides live here:
- `src/` + `native/` + `plugins/` — the React-Native/Expo (mobile) side. **Ignore for scala.**
- **`basecamp/` — the C++ side for a Basecamp core. This is what scala uses.**

## Status (be precise about what's proven)

- ✅ **Mobile transport** — validated end-to-end on a real phone (KYM + qaku sync live).
- ✅ **`basecamp/logos_transport.hpp`** — a faithful, verbatim-where-possible extraction of
  `kym_core`'s transport (the *same code that syncs KYM Basecamp in production*). Its wire
  behavior is proven by that provenance. It **compiles + runs** in a stub-typed smoke test
  (`bootstrap → onReady → send → channel-receive` all fire).
- ⏳ **Not yet compiled against a real SDK build.** The delivery-module type only resolves
  inside a generated `.cpp` in the nix build. **scala's integration IS the first real
  build** — that's the remaining test, and it's your job. Expect only integration-shaped
  issues (method names/arg order vs your pinned SDK rev), not wire-logic bugs.

## The 5-minute mental model

```
scala_core (yours)                          logos_transport.hpp (this repo)
──────────────────                          ───────────────────────────────
seal/open (your keys)      ── send(topic, sealedBytes) ─►  SDS channel ─► fleet ─► peers
topic derivation           ◄─ onReceive(topic, sealed) ──  live receive ◄─ fleet ◄─ peers
envelope + reconcile       Ops{} wraps modules().delivery_module.*   (you build in .cpp)
state model                Config{ deviceId, useChannels, entryNodes, hubMode }
```

You supply: `Ops` (thin lambdas over `modules().delivery_module.*`), `Config`, `topics()`,
`onReceive` (open + ingest), optional `onReady` (post-start reconcile), `setStatus`, and —
for a headless hub — `delay` (`QTimer::singleShot`). Everything else is handled.

## Do this

1. **Read `basecamp/README.md`** — it has the exact ~40-line integration (the `Ops` builder
   wrapping `modules().delivery_module.*`, construction, `bootstrap()`, `send()`), and
   `basecamp/logos_transport.hpp`'s top comment — it documents every gotcha inline.
2. **Copy `basecamp/logos_transport.hpp`** into `scala_core/src/`, add it to
   `CMakeLists.txt` (`SOURCES`/`INCLUDE_DIRS`), and **`git add` it** (nix only sees tracked
   files).
3. **Keep in scala's core** (the transport deliberately does NOT do these): `seal`/`open` +
   key derivation, topic derivation (`/scala/1/<hmac(key)>/proto`-style), the wire envelope
   (`{v:1,type:"EVENT"|"SYNC_REQ",...}` in the reference apps), reconcile (EVENT fold,
   SYNC_REQ / RBSR summary, dedup, LWW), and state. Steal these patterns from
   `examples/kym-delivery-adapter.ts` (mobile, but the envelope/dispatch logic is the same
   shape) or directly from `kym_core`/`qaku_core`.
4. **Confirm the SDK method names/arg order** of `createNodeAsync / startAsync /
   subscribeAsync / channelCreateAsync / channelSendAsync / onMessageReceived /
   onChannelMessageReceived` against **your pinned SDK rev's header** before wiring `Ops`
   (they're stable, but verify — see the skills below).
5. **Wire-compat matters:** to interop with existing KYM/qaku peers you must keep the
   double-b64 framing (the transport does it) AND match their topic/autoshard scheme. If
   scala is its own app with its own peers, just be internally consistent (mobile side of
   scala, if it ever exists, uses `src/`).

## Non-negotiable gotchas (all handled by the header, but know them)

- **Double-base64 channel framing** — `send()` does it; don't "simplify."
- **Send payload rep probe** (byte-array vs string per cpp-sdk build) — `send()` probes+caches; a wrong guess is a SIGABRT.
- **Register receive handlers before `createNode`**; for a **headless hub** set `Config.hubMode=true` + supply `delay` (else "No external callbacks", receives nothing).
- **Headless hub needs `entryNodes`** pinned (fleet) or it's isolated ("No peers for topic"). GUI host: leave empty.
- **Headless receive needs cpp-sdk ≥ `d77c3dd`** (PR #68) — otherwise delivery emits `messageReceived` off-thread and Qt Remote Objects silently drops it (connects + sends, receives **nothing**). Run the hub on a `logoscore` past that commit. GUI host unaffected.
- **Keep `useChannels` ON** (SDS). OFF = raw relay, won't reconcile with channel peers.

## Skills to load (canonical Logos facts, already in this environment)

- `logos-basecamp-module` — building/shipping a core+view, the `modules().delivery_module`
  surface, ≤4-arg/JSON-string methods, ASCII-only headers, portable-`.lgx` repo, and the
  three **headless-hub gotchas** (self-drive QTimer on the event-loop thread; the
  cross-thread `d77c3dd` receive fix; `entryNodes`).
- `logos-reliable-channels` — the SDS channel API + semantics (`channelCreate` /
  `channelSend` / `onChannelMessageReceived`), and why a channel "syncs nothing."
- `logos-multiwriter-sync` — the reconcile half scala must still write (HLC fold, RBSR
  backfill, the two hub gotchas).
- `logos-distributed-debugging` — the method playbook if it "syncs nothing."

## Build + load the modules (templates provided)

`basecamp/reference/` has copy-paste-ready, known-good templates so you don't have to
reverse-engineer the build or the hub:
- `flake.nix` — pins the **channels-enabled** `delivery_module` (`0fb3a742…`) + builder
  (`afe4430e…`), the same revs KYM/qaku use (one SDK, wire-interop).
- `metadata.json` — `scala_core` manifest (`type:core`, dep `delivery_module`, ASCII-only).
- `CMakeLists.txt` — lists `src/logos_transport.hpp` (**git add it** — nix only sees tracked files).
- `hub-run.sh` + `hub.service` — the headless-hub launcher (pins fleet `entryNodes`, arms
  the self-drive tick) + systemd unit.
- `reference/README.md` — how to get `delivery_module` + `capability_module` `.lgx` and a
  `logoscore` **built on cpp-sdk ≥ `d77c3dd`** (required, or the hub receives nothing), and
  stage all three modules in one dir.

## How to test scala's integration

1. **Builds** — `nix build .#lgx-portable` for `scala_core` (this is the real SDK
   compile-check the header is still missing).
2. **Two peers, no phone** — run scala_core as a **headless hub** (`logoscore -D -m <dir>`
   then `load-module scala_core`, `SCALA_HUB=1`, `entryNodes` pinned, logoscore ≥ `d77c3dd`)
   and a GUI Basecamp scala on the same room/topic; author on one, confirm it folds on the
   other. Mirror KYM's `hub/` runner.
3. **Instrument the seam** — count `send` (tx) and `onReceive` opens (rx) on a debug/sync
   card; `tx>0, rx=0` on the hub ⇒ the cross-thread `d77c3dd` gotcha or `entryNodes`.

## Report back (what to tell us)

- Did `basecamp/logos_transport.hpp` **compile** against scala's SDK rev unchanged? If not,
  the exact `Ops` signature deltas (method name/arg-order differences) — we'll fold fixes
  back into the shared header so KYM/qaku/scala stay on one copy.
- Did **two scala peers sync** (hub ↔ GUI)? Any gotcha you hit that isn't documented above.
- Anything scala needed that the transport should expose (e.g. a `storeSync`/history pull —
  the mobile side has one; the C++ side currently leaves history to republish-on-demand /
  your RBSR, matching kym_core).

## Provenance / questions

Extracted 2026-08-06 from `kym_core` (`/home/vpavlin/kym`) + `qaku_core`
(`/home/vpavlin/qaku-logos`). The mobile side is validated live. Ping the KYM/qaku
maintainer (this repo's author) with signature deltas so we converge on one shared copy.
