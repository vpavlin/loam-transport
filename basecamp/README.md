# logos-transport — Basecamp (C++) side

The desktop counterpart of the RN transport, for a Logos **Basecamp module's C++ core**
(`type:"core"`, `interface:"universal"`, Qt-free, like `kym_core`/`qaku_core`). Header-only
(`logos_transport.hpp`), crypto-agnostic, extracted from `kym_core` and proven in KYM + qaku.

It wraps the host's `delivery_module` (SDS Reliable Channels over an embedded Waku node)
and moves **opaque sealed bytes** on content topics. Your core keeps identity, crypto,
envelope, reconcile, and state; this owns node bring-up, join, send framing, and receive.

**Wire-compatible with mobile** — same double-b64 channel framing + autoshard scheme, so
a module built on it interops with existing KYM/qaku phones and hubs on the same topic.

## Shape

`Transport<LogosMap>` is templated only on `LogosMap` (a real, complete SDK header =
`nlohmann::json`). The ~8 `delivery_module` calls come in as an `Ops` struct of
`std::function`s you build in your `.cpp` (where the generated delivery-module type is
complete). So `Transport<LogosMap>` is a clean by-value member of your core — no
templating on a type you can't name in a header.

## Integrate (your core's `.cpp`)

```cpp
#include "logos_transport.hpp"
using Tx = logos_transport::Transport<LogosMap>;

// 1) Build Ops — thin lambdas wrapping modules().delivery_module.*, adapting the SDK's
//    StdLogosResult callbacks to the transport's (ok,err) Cb. (Confirm the exact async
//    method names/arg order against your pinned SDK rev's header.)
Tx::Ops makeOps() {
  Tx::Ops o;
  o.createNode    = [this](const std::string& cfg, Tx::Cb cb){
      modules().delivery_module.createNodeAsync(cfg, [cb](StdLogosResult r){ cb(r.success, r.error); }); };
  o.start         = [this](Tx::Cb cb){
      modules().delivery_module.startAsync([cb](StdLogosResult r){ cb(r.success, r.error); }); };
  o.subscribe     = [this](const std::string& t, Tx::Cb cb){
      modules().delivery_module.subscribeAsync(t, [cb](StdLogosResult r){ cb(r.success, r.error); }); };
  o.channelCreate = [this](const std::string& id, const std::string& ct, const std::string& sid, Tx::Cb cb){
      modules().delivery_module.channelCreateAsync(id, ct, sid, [cb](StdLogosResult r){ cb(r.success, r.error); }); };
  o.channelSend   = [this](const std::string& id, const LogosMap& p, Tx::Cb cb){
      modules().delivery_module.channelSendAsync(id, p, [cb](StdLogosResult r){ cb(r.success, r.error); }); };
  o.onMessage        = [this](Tx::RecvCb h){
      modules().delivery_module.onMessageReceived(
          [h](const std::string&, const std::string& ct, const LogosMap& p, int64_t){ h(ct, p); }); };
  o.onChannelMessage = [this](Tx::RecvCb h){
      modules().delivery_module.onChannelMessageReceived(
          [h](const std::string& channelId, const std::string&, const LogosMap& p, int64_t){ h(channelId, p); }); };
  return o;
}

// 2) Construct once (e.g. in onContextReady). Config: deviceId = SDS senderId;
//    entryNodes empty on the GUI host, pinned (fleet) + hubMode=true for a HEADLESS hub.
m_tx.emplace(
  makeOps(),
  Tx::Config{ .useChannels = true, .hubMode = isHub(), .deviceId = m_deviceId,
              .entryNodes = isHub() ? kFleet : std::vector<std::string>{} },
  /*topics()*/  [this]{ std::vector<std::string> t; for (auto& r : m_rooms) t.push_back(r.topic); return t; },
  /*onReceive*/ [this](const std::string& topic, const std::string& sealedOnceDecoded){
                    Room* r = roomForTopic(topic); if (!r) return;      // topic → room
                    auto plain = tryOpen(r->id, sealedOnceDecoded, r->topic);  // YOUR open()
                    if (!plain) return;                                 // wrong key/candidate
                    dispatchEnvelope(*r, *plain);                       // EVENT → fold; SYNC_REQ → re-serve
                },
  /*onReady*/   [this]{ for (auto& r : m_rooms) sendSummary(r); },      // post-start reconcile (optional)
  /*setStatus*/ [this](const std::string& s){ setStatus(s); },
  /*delay*/     [](int ms, std::function<void()> f){ QTimer::singleShot(ms, f); }); // hubMode only

// 3) Bring up — poll-safe; call from onContextReady and/or your hub self-drive tick.
m_tx->bootstrap();

// 4) Send a locally-authored event: seal (OpenSSL RAND_bytes nonce — desktop has a real
//    RNG), then hand RAW sealed bytes to send(); the transport does b64 + framing.
void broadcast(Room& r, const Event& e) {
  if (!m_tx->ready()) return;
  Bytes nonce(12); RAND_bytes(nonce.data(), 12);
  Bytes sealed = seal(r.id, encodeEnvelope(e), r.topic, nonce);
  m_tx->send(r.topic, std::string(sealed.begin(), sealed.end()));
}

// 5) New room after the node is up:
void onRoomAdded(Room& r) { if (m_tx->ready()) m_tx->join(r.topic); }
```

(`m_tx` as `std::optional<Tx>` or `std::unique_ptr<Tx>` member — both are fine; `Tx` has no
default ctor.)

### `onReceive` — the crypto seam
You get `(topic, sealedOnceDecoded)` — the payload after ONE base64 decode (the transport
peeled delivery's outer layer). Your `open()` peels the inner base64 and authenticates with
the room's key. `open()` is authenticated, so a wrong key/candidate just fails — no false
positives. (Accepting both single- and double-decoded candidates, like mobile's
`payloadCandidates`, is the belt-and-suspenders version; one inner-decode is usually enough.)

### What stays in YOUR core (not extracted, on purpose)
crypto (`seal`/`open`, key derivation) · identity · topic derivation (e.g.
`/scala/1/<hmac(key)>/proto`) · envelope + reconcile (EVENT fold, SYNC_REQ / RBSR summary,
dedup, LWW) · state model.

## Gotchas
All in the header's top comment — read it. The big ones: double-b64 framing (must match
mobile), register handlers before createNode, `hubMode` delay for headless, pin
`entryNodes` only for a headless hub, keep `useChannels` on, and the cross-thread receive
drop fixed in cpp-sdk `d77c3dd` (run the hub on a logoscore past that commit). Desktop
nonce uses OpenSSL `RAND_bytes` — no Hermes RNG trap (that was mobile-only).

## Build
Header-only: `#include "logos_transport.hpp"` in your core (list it in `CMakeLists.txt`
`SOURCES`/`INCLUDE_DIRS` and `git add` it — nix only sees tracked files). No extra link
deps beyond what your module already links.
