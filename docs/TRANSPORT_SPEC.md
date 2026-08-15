# Logos multi-writer transport spec (derived from KYM, the proven reference)

This is the **normative** spec every layer of a KYM-derived app (qaku) must match
**byte-for-byte** to interoperate mobile↔desktop over Logos Delivery / Waku. It is
extracted from KYM's shipped, working code. Namespace token `<ns>` = `kym` for KYM,
`qaku` for qaku — it is the ONLY value that legitimately differs. Every clause is a
testable MUST. Cited KYM sources are authoritative; qaku must produce identical
behavior/bytes.

Reference files:
- KYM mobile crypto: `kym/mobile/src/lib/identity.ts`
- KYM mobile transport: `kym/mobile/src/lib/delivery.ts`
- KYM desktop core: `kym/kym_core/src/kym_core_impl.cpp`

---

## L0 — Crypto (byte-identical across every device + language)

- **K**  = HKDF-SHA256(ikm=S, salt=`"<ns>-pair-v1"`, info=`""`, len=32)
- **Ke** = HKDF-SHA256(ikm=K, salt=`""` (EMPTY), info=`"<ns>/payload/v1"`, len=32)
- **seal(pt, topic)** = `nonce(12) || ChaCha20-Poly1305(Ke, nonce, pt, aad=utf8(topic))`
  where the cipher output is `ciphertext || tag(16)`. So sealed = `nonce||ct||tag`.
- **open(sealed, topic)**: nonce=`sealed[0:12]`, body=`sealed[12:]` (ct+tag), aad=utf8(topic).
- AAD is the **content-topic string bytes**, nothing else.
- MUST-VERIFY cross-impl: a C++-sealed message opens with the JS crypto and vice
  versa. (Confirmed for qaku: Ke matches; C++ seal → mobile open succeeds.)

## L1 — Content topic

- **topic(epoch)** = `"/<ns>/1/" + hex( HMAC-SHA256(K, "<ns>/topic/v1|"+epoch)[0:16] ) + "/proto"`
- epoch defaults to `0`. hex is lowercase.
- Autosharding maps this content topic onto a pubsub shard `/waku/2/rs/2/<n>`. The
  fleet serves all shards; **do not** try to force a shard.

## L2 — Wire envelope (plaintext BEFORE seal)

The plaintext that gets sealed is UTF-8 JSON of one of:
- **EVENT**:    `{"v":1,"type":"EVENT","event":{…domain event…}}`
- **SYNC_REQ**: `{"v":1,"type":"SYNC_REQ","from":"<deviceId>"}`
- **SUMMARY**:  `{"type":"SUMMARY","from":"<deviceId>","ids":["…event ids…"]}` (RBSR; optional but recommended)

Receiver dispatches on `type`. Unknown/!object → drop that one message, never throw.

## L3 — base64 framing depth (THE interop-critical layer)

The wire always carries **`base64(sealed)` as a byte-string** (i.e. the ASCII bytes of
the base64 text of the sealed bytes). Both platforms converge to this; they differ in
how many explicit base64 ops they apply because their FFIs differ:

- **Desktop SEND** (`kym_core_impl.cpp` deliverySend): payload = `bytesPayload(b64encode(sealed))`
  — a JSON **array of the byte values of the base64 string**. The C++ delivery_module
  adds the one wire-layer. → i.e. hand the transport `base64(sealed)` as bytes, exactly ONCE.
  **qaku MUST NOT double-encode** (no `b64s(b64(sealed))`).
- **Desktop RECEIVE** (`onMessageReceived`/`onChannelMessageReceived`): `sealed =
  b64decode( toWire(payload) )` — a **single** b64decode. `toWire`: string→string,
  array→string(chars), `{_bytes:"…"}`→b64decode.
- **Mobile SEND** (`delivery.ts` publishSealed, channel): `payload =
  base64( utf8Bytes( base64(sealed) ) )` — DOUBLE. The mobile JNI base64-decodes once,
  so the wire ends up as `base64(sealed)`-as-bytes, same as desktop. Raw `send` path
  (lightpush) is **single**: `payload = base64(sealed)`.
- **Mobile RECEIVE** (`payloadCandidates`): produce ALL of, and let authenticated
  open() pick the winner:
  - if payload is an **array**: `toByteArray(String.fromCharCode(...bytes))` AND raw `Uint8Array(bytes)`
  - if payload is a **string**: `toByteArray(s)` AND `toByteArray(utf8Decode(toByteArray(s)))`

## L4 — utf8 conversion (Hermes gotcha)

- Mobile MUST use **hand-rolled** utf8 encode/decode (byte loops), NOT
  `TextEncoder`/`TextDecoder` — KYM: *"no TextEncoder/TextDecoder guaranteed on Hermes."*
  A `TextDecoder` in the payload double-peel path can silently corrupt the base64 text →
  `invalid tag`. (qaku VIOLATION: `fromUtf8 = new TextDecoder().decode`, `utf8 = new TextEncoder().encode`.)

## L5 — Native receive event shape (mobile)

- The native emits `{ wakuPtr, event }` where **`event` is a JSON string**. Parse it:
  `m = JSON.parse(evt.event)`. The WakuMessage is `m.wakuMessage || m.message || m`;
  its **`payload` is usually a byte ARRAY (number[])**, sometimes a base64 string.
  Read `wm.payload ?? m.payload`. (qaku had read a non-existent top-level `m.payload`.)
- Distinguish `channel_message_received` vs `message_received` via `m.eventType` for diagnostics.
- **No self-echo filter.** Keep echoes; dedup by event id only.

## L6 — Transport calls / join order

- Join a route: **`subscribeContentTopic(ctx, topic)` FIRST, THEN `channelCreate(ctx,
  topic, topic, deviceId)`** (channelId == contentTopic == derived topic). The recv
  service gates on the content-topic subscription; channelCreate alone doesn't subscribe.
- Send: channel path = `channelSend(ctx, topic, JSON{payload,ephemeral})`; raw path =
  `send(ctx, JSON{contentTopic,payload,ephemeral})` (lightpush-capable — a NAT'd phone
  needs this). Sending both is acceptable (receivers dedup by id).
- Desktop core: default `sendAsync`; `channelSendAsync` under a channels flag. Both with
  the SAME single-encoded payload.

## L7 — Node config

- `{ mode:"Core", preset:"logos.test", relay:true, entryNodes:[…6 fleet…] }`. entryNodes
  MUST be pinned on BOTH mobile and desktop, or the node never meshes ("Connected" but 0 peers).
  `preset` MUST be `logos.test` (cluster 2) — `logos.dev` is cluster 3 and fails to mesh (ADR 0008).
  `mode` shown as `Core` here for the desktop/hub; the **mobile default is `Edge`** (mobile-safe:
  filter/lightpush, works on cellular, lighter) — see ADR 0006. Core is the opt-in stable-WiFi relay mode.

## L8 — Lease renewal

- Content-topic (filter) subscriptions lease-expire on the fleet. Re-subscribe every
  ~60s via a `setInterval` (`subscribeContentTopic`, idempotent). Never re-`channelCreate`
  (resets SDS state). Without this a phone silently goes deaf after ~1 min.

## L9 — Reconcile + anti-drop (the "pull" half)

- On join: publish a **SYNC_REQ**; peers re-serve. Receiver of SYNC_REQ re-serves its
  whole log (ignore own `from`). SUMMARY/RBSR is the optimized form (serve only missing ids).
- Desktop: **seed burst** — re-broadcast the whole log a few times over the first ~12s
  on node-up (sparse mesh drops one-shot publishes), and a periodic auto-resync/summary
  (~30s) driven from `snapshot()`.
- All receives dedup by event id (`mergeEvents`), so re-serving is idempotent.

## L10 — Diagnostics (so a failure is localizable without a logcat)

- Counters: rxRaw, rxSeen, rxOpened, rxOpenFail, rxNew, tx, peers.
- A receive **sample**: native event type tally (chan/msg/err) + first unopenable
  message's payload shape (arr len / b64 len) + candidate count + last open error.
- Peer count polled on a timer (KYM: 5s), else it reads a stale sentinel forever.

---

### Known qaku divergences to check (as of this spec)
1. **L4**: qaku uses `TextEncoder`/`TextDecoder` (`fromUtf8`/`utf8`) — must hand-roll. **Prime suspect for current `invalid tag`.**
2. **L3**: qaku_core previously double-encoded (`b64s`) — fixed 0.1.9; verify no residue and that mobile double-peel matches.
3. **L9**: qaku lacked SYNC_REQ (added 0.1.9); SUMMARY/RBSR still absent (acceptable).
4. **L2**: qaku_core admin-gates `answer/moderate/poll-create` — a secret-only phone guest's such events drop (domain policy, not transport; flag but out of scope).
