// logos_transport.hpp — SHARED, crypto-agnostic sync transport for a Logos Basecamp
// module's C++ core (the desktop counterpart of the React-Native logos-transport.ts).
//
// Extracted verbatim-where-possible from KYM's kym_core (the multi-topic/"routes"
// core) and proven in KYM + qaku. It wraps the host's `delivery_module` (SDS Reliable
// Channels over an embedded Waku node) and moves OPAQUE sealed bytes on content
// topics. It knows nothing about your data or your crypto: you seal bytes and call
// send(); on receive it hands you the once-decoded bytes and YOU open them with your
// key. Your core keeps identity/crypto/envelope/state; this handles delivery.
//
// Header-only + templated over the delivery-module type, so you just #include it in
// your core and pass your `modules().delivery_module`. The SDK types LogosMap
// (nlohmann::json alias) and StdLogosResult must be in scope (include the Logos SDK
// before this header, as every *_core does).
//
// ── What YOU supply ──────────────────────────────────────────────────────────
//   • topics()            → the content topics to join (one per room/household)
//   • onReceive(topic, s) → open `s` (once-b64-decoded sealed bytes) with your key
//                           and ingest; the transport never sees your keys
//   • deviceId            → SDS senderId
//   • seal before send    → call send(topic, sealedBytes); transport does the framing
//
// ── Gotchas baked in (each cost real debugging) ──────────────────────────────
//   1. DOUBLE-base64 channel framing: send() b64-encodes your sealed bytes, hands
//      that as a byte ARRAY (bytesPayload); delivery base64s again on the wire. The
//      receive path b64-decodes ONCE and hands you the inner-b64 bytes — your open()
//      peels the last layer. This MUST match the mobile transport or desktop↔mobile
//      stops interoperating. Do not "simplify" it.
//   2. Payload representation (byte ARRAY vs string) differs by cpp-sdk build — send()
//      probes array→string once and caches the winner, so a GUI host that can't set
//      env never crashes on it.
//   3. Incoming payload arrives as a JSON string, a byte array, or {"_bytes":"<b64>"} —
//      toWire() handles all three.
//   4. Register the receive handlers BEFORE createNode. Under a headless logoscore hub
//      the onMessageReceived subscription IPC must reach the delivery process before
//      the node is built (else "No external callbacks" and nothing is delivered) — set
//      hubMode=true to delay createNode ~1.5s. The GUI host wires it synchronously.
//   5. In-progress guard: bootstrap() may be polled every snapshot; a second
//      createNode firing mid-startup makes nwaku never finish. One startup at a time;
//      a failure callback clears the guard so a later poll retries.
//   6. useChannels: SDS Reliable Channels (recommended, interops with mobile). With it
//      OFF the core uses raw relay and will NOT reconcile with channel peers (the KYM
//      "stuck on Checking peers" symptom). Default ON here.
//   7. entryNodes: usually empty on desktop — the Basecamp host bootstraps the fleet.
//      A HEADLESS hub has no host, so it MUST pin the fleet entryNodes or it joins no
//      shard mesh ("No peers for topic"). Pass them in Config for a headless build.
//   8. Cross-thread receive: delivery may emit messageReceived off the Qt/main thread;
//      an older cpp-sdk drops cross-thread signals (fixed in cpp-sdk d77c3dd). If your
//      onReceive never fires under the GUI host despite traffic, that's the cause.
//
#pragma once
#include <string>
#include <vector>
#include <functional>
#include <cstdlib>
#include <cstdio>

namespace logos_transport {

// ── base64 (RFC 4648, no newlines). Replace with your core's if you already have one.
namespace b64detail {
inline const char *tbl() { return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; }
inline std::string encode(const std::string &in) {
    std::string out; out.reserve(((in.size() + 2) / 3) * 4);
    int val = 0, bits = -6; const unsigned char *p = (const unsigned char *)in.data();
    for (size_t i = 0; i < in.size(); ++i) {
        val = (val << 8) + p[i]; bits += 8;
        while (bits >= 0) { out.push_back(tbl()[(val >> bits) & 0x3F]); bits -= 6; }
    }
    if (bits > -6) out.push_back(tbl()[((val << 8) >> (bits + 8)) & 0x3F]);
    while (out.size() % 4) out.push_back('=');
    return out;
}
inline std::string decode(const std::string &in) {
    std::vector<int> T(256, -1);
    for (int i = 0; i < 64; i++) T[(unsigned char)tbl()[i]] = i;
    std::string out; int val = 0, bits = -8;
    for (unsigned char c : in) {
        if (c == '=' || T[c] == -1) break;
        val = (val << 6) + T[c]; bits += 6;
        if (bits >= 0) { out.push_back(char((val >> bits) & 0xFF)); bits -= 8; }
    }
    return out;
}
} // namespace b64detail

// Templated over the delivery-module type (SDK-generated) so this header stays free of
// the exact type name. LogosMap and StdLogosResult must be in scope (from the SDK).
template <class DeliveryModule, class LogosMap, class StdLogosResult>
class Transport {
public:
    struct Config {
        std::string logLevel = "INFO";
        std::string preset = "logos.dev";
        std::vector<std::string> entryNodes;   // empty on desktop (host bootstraps); pin for headless
        bool useChannels = true;               // SDS Reliable Channels (interops with mobile)
        bool hubMode = false;                  // headless: delay createNode ~1.5s after handler reg
        std::string deviceId;                  // SDS senderId
    };
    using TopicList = std::function<std::vector<std::string>()>;                       // topics to join
    using OnReceive = std::function<void(const std::string &topic, const std::string &sealedOnceDecoded)>;
    using SetStatus = std::function<void(const std::string &)>;
    using DelayCall = std::function<void(int ms, std::function<void()>)>;              // e.g. QTimer::singleShot

    Transport(DeliveryModule &dm, Config cfg, TopicList topics, OnReceive onReceive,
              SetStatus setStatus = {}, DelayCall delay = {})
        : m_dm(dm), m_cfg(std::move(cfg)), m_topics(std::move(topics)),
          m_onReceive(std::move(onReceive)), m_setStatus(std::move(setStatus)), m_delay(std::move(delay)) {}

    bool ready() const { return m_nodeReady; }

    // Bring the node up once (idempotent): register receive handlers → createNode →
    // start → (subscribe + channelCreate per topic). Safe to poll — the in-progress
    // guard and m_nodeReady make repeat calls no-ops.
    void bootstrap() {
        if (m_nodeReady || m_starting) return;
        auto topics = m_topics();
        if (topics.empty()) return;             // nothing to sync yet (unpaired)
        m_starting = true;

        // toWire: incoming payload may be a JSON string, a byte array, or {"_bytes":b64}.
        auto toWire = [](const LogosMap &v) -> std::string {
            if (v.is_string()) return v.template get<std::string>();
            if (v.is_array()) { std::string s; s.reserve(v.size());
                for (const auto &c : v) if (c.is_number_integer()) s.push_back((char)c.template get<int>());
                return s; }
            if (v.is_object() && v.contains("_bytes") && v["_bytes"].is_string())
                return b64detail::decode(v["_bytes"].template get<std::string>());
            return std::string();
        };
        auto handle = [this, toWire](const std::string &topic, const LogosMap &payload) {
            std::string b64 = toWire(payload);
            if (b64.empty() && payload.is_object() && payload.contains("payload")) b64 = toWire(payload["payload"]);
            if (!b64.empty() && m_onReceive) m_onReceive(topic, b64detail::decode(b64)); // one decode; app peels the rest
        };
        // BOTH handlers registered (only the transport we joined delivers): raw relay
        // routes by contentTopic; SDS channel routes by channelId (== the topic).
        m_dm.onMessageReceived([handle](const std::string &, const std::string &contentTopic,
                                        const LogosMap &payload, long long) { handle(contentTopic, payload); });
        m_dm.onChannelMessageReceived([handle](const std::string &channelId, const std::string &,
                                        const LogosMap &payload, long long) { handle(channelId, payload); });

        if (m_setStatus) m_setStatus("Connecting...");
        LogosMap cfg = LogosMap::object();
        cfg["logLevel"] = m_cfg.logLevel; cfg["mode"] = "Core"; cfg["preset"] = m_cfg.preset;
        if (!m_cfg.entryNodes.empty()) { cfg["relay"] = true;
            LogosMap arr = LogosMap::array(); for (auto &e : m_cfg.entryNodes) arr.push_back(e); cfg["entryNodes"] = arr; }
        std::string cfgStr = cfg.dump();
        fprintf(stderr, "logos_transport bootstrap cfg=%s\n", cfgStr.c_str());

        auto startNode = [this, cfgStr]() {
            m_dm.createNodeAsync(cfgStr, [this](StdLogosResult r) {
                if (!r.success) { m_starting = false; if (m_setStatus) m_setStatus("Delivery error (createNode): " + r.error); return; }
                m_dm.startAsync([this](StdLogosResult r2) {
                    if (!r2.success) { m_starting = false; if (m_setStatus) m_setStatus("Delivery error (start): " + r2.error); return; }
                    m_nodeReady = true;
                    if (m_setStatus) m_setStatus("Connected");
                    for (const auto &t : m_topics()) join(t);   // subscribe + channelCreate every topic
                });
            });
        };
        // Headless hub: delay createNode so the handler-registration IPC lands first.
        if (m_cfg.hubMode && m_delay) m_delay(1500, startNode); else startNode();
    }

    // Join one topic on the wire (subscribe + create the SDS channel, or a plain
    // content-topic subscription in raw mode). channelId == contentTopic == the topic.
    void join(const std::string &topic) {
        if (m_cfg.useChannels)
            m_dm.channelCreateAsync(topic, topic, m_cfg.deviceId, [](StdLogosResult) {});
        else
            m_dm.subscribeAsync(topic, [](StdLogosResult) {});
    }

    // Publish sealed bytes on a topic. Encapsulates the double-base64 framing + the
    // array/string representation probe. ASYNC/fire-and-forget — a sync send would
    // block the event loop through a stalling lightpush and freeze the module.
    void send(const std::string &topic, const std::string &sealedBytes) {
        if (!m_nodeReady) return;
        const std::string b64 = b64detail::encode(sealedBytes);   // inner layer; delivery adds the outer
        auto attempt = [&](int repr) -> bool {
            try {
                LogosMap p = (repr == 1) ? bytesPayload(b64) : LogosMap(b64);
                if (m_cfg.useChannels) m_dm.channelSendAsync(topic, p, [](StdLogosResult) {});
                else                   m_dm.sendAsync(topic, p, [](StdLogosResult) {});
                return true;
            } catch (...) { return false; }
        };
        if (m_sendRepr == 1 || m_sendRepr == 2) { if (attempt(m_sendRepr)) return; m_sendRepr = 0; }
        if (attempt(1)) { m_sendRepr = 1; return; }   // newer builds: byte-array payload
        if (attempt(2)) { m_sendRepr = 2; return; }   // older builds: string payload
        fprintf(stderr, "logos_transport send: no working payload representation\n");
    }

private:
    // The delivery send() payload must be a JSON byte ARRAY under the current cpp-sdk
    // (a JSON string throws "type must be array, but is string" in the glue). Same wire
    // bytes either way (delivery base64s the bytes), just handed to the glue as an array.
    static LogosMap bytesPayload(const std::string &s) {
        LogosMap a = LogosMap::array();
        for (unsigned char c : s) a.push_back((unsigned)c);
        return a;
    }

    DeliveryModule &m_dm;
    Config m_cfg;
    TopicList m_topics;
    OnReceive m_onReceive;
    SetStatus m_setStatus;
    DelayCall m_delay;
    bool m_nodeReady = false;
    bool m_starting = false;
    int m_sendRepr = 0;   // 0 = unprobed, 1 = byte array, 2 = string
};

} // namespace logos_transport
