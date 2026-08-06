# logos-transport — Basecamp (C++) side

The desktop counterpart of the RN transport, for a Logos **Basecamp module's C++ core**
(like `kym_core` / `qaku_core`). Header-only (`logos_transport.hpp`), templated over
your SDK's delivery-module type, crypto-agnostic. Extracted from `kym_core` (multi-topic
"routes"), proven in KYM + qaku.

It wraps the host's `delivery_module` (SDS Reliable Channels over an embedded Waku node)
and moves **opaque sealed bytes** on content topics. Your core keeps identity, crypto,
envelope, and state; this handles node bring-up, join, send framing, and receive.

## Wire compatibility

This uses the **same double-base64 channel framing** and the same content-topic /
autoshard scheme as the mobile transport, so a Basecamp module built on it **interops
with existing KYM/qaku phones and hubs** on the same household topic. Keep `useChannels`
ON (default) to reconcile with channel peers.

## Integrate (scala's core)

Your core already has: the SDK in scope (`LogosMap`, `StdLogosResult`, `modules()`),
a device id, per-room content topics, and `seal`/`open` for your household key. Wire the
transport in ~20 lines:

```cpp
#include "logos_transport.hpp"

// Alias the templated transport to your SDK's concrete types.
using Delivery = decltype(modules().delivery_module);
using Transport = logos_transport::Transport<Delivery, LogosMap, StdLogosResult>;

// Construct once (e.g. in your Impl), supplying the four app-specific pieces.
Transport m_tx{
    modules().delivery_module,
    /*Config*/ { .deviceId = m_deviceId, .useChannels = true,
                 // entryNodes empty on the GUI host; pin the fleet for a HEADLESS hub:
                 .entryNodes = std::getenv("SCALA_HUB") ? kFleet : std::vector<std::string>{},
                 .hubMode   = std::getenv("SCALA_HUB") != nullptr },
    /*topics()*/   [this]{ std::vector<std::string> t; for (auto& r : m_rooms) t.push_back(r.topic); return t; },
    /*onReceive*/  [this](const std::string& topic, const std::string& sealedOnceDecoded){
                       // Open with THIS room's key (topic → room), then ingest the envelope.
                       Room* r = roomForTopic(topic); if (!r) return;
                       auto plain = tryOpen(r->identity, sealedOnceDecoded, r->topic); // your open()
                       if (!plain) return;                                             // wrong key/candidate
                       dispatchEnvelope(*r, *plain);   // EVENT → fold; SYNC_REQ → re-serve
                   },
    /*setStatus*/  [this](const std::string& s){ setStatus(s); },
    /*delay*/      [](int ms, std::function<void()> f){ QTimer::singleShot(ms, f); } // for hubMode
};

// Bring up (poll-safe — call from onContextReady and/or your hub tick):
m_tx.bootstrap();

// Send a locally-authored event: seal, then hand RAW sealed bytes to send().
void broadcast(Room& r, const Event& e) {
    if (!m_tx.ready()) return;
    Bytes nonce(12); RAND_bytes(nonce.data(), 12);                 // OpenSSL — desktop has a real RNG
    Bytes sealed = seal(r.identity, encodeEnvelope(e), r.topic, nonce);
    m_tx.send(r.topic, std::string(sealed.begin(), sealed.end())); // transport does b64 + framing
}

// A newly paired room after the node is up:
void onRoomAdded(Room& r) { if (m_tx.ready()) m_tx.join(r.topic); }
```

### `onReceive` — the crypto seam

The transport hands you `(topic, sealedOnceDecoded)` — the payload after ONE base64
decode (it peeled delivery's outer layer). Your `open()` peels the inner base64 and
authenticates with the room's key. Trying candidates (single- vs double-decoded) is the
same trick mobile's `payloadCandidates` uses; on desktop a single inner-decode is
usually enough, but accept both to be safe. `open()` is authenticated, so a wrong
key/candidate just fails — no false positives.

### Envelope

The reference apps use `{v:1, type:"EVENT"|"SYNC_REQ", ...}`, sealed. Keep whatever
envelope you like — the transport never inspects it. For sync you'll want the pull half
(publish a sealed `SYNC_REQ`; peers re-serve) and, ideally, an RBSR summary reconcile —
but that's **your core's** concern (like `kym_core`'s `sendSummary`), not the transport.

## What stays in YOUR core (not extracted)

Deliberately, so the transport is generic:
- **crypto** (`seal`/`open`, key derivation) and **identity**
- **topic derivation** (e.g. `/scala/1/<hmac(key)>/proto`)
- **envelope + reconcile** (EVENT fold, SYNC_REQ / RBSR summary, dedup, LWW)
- **state model** (rooms/log)

## Gotchas

All baked into / documented in `logos_transport.hpp` header comment — read it. The big
ones: double-b64 framing (must match mobile), register handlers before createNode,
`hubMode` delay for headless, pin `entryNodes` only for a headless hub, and keep
`useChannels` on. The desktop nonce uses OpenSSL `RAND_bytes` — no Hermes RNG trap here
(that was a *mobile*-only bug; see the top-level README gotcha #1).

## Build

Header-only: `#include "logos_transport.hpp"` in your core. No extra link deps beyond
what your Basecamp module already links (the SDK + delivery_module glue). The bundled
base64 is self-contained; swap in your core's if you prefer.
