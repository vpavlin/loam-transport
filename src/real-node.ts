// RealNode — the embedded backend: one liblogosdelivery node behind the UnderlyingNode
// seam. This is the phone-side adapter the shared-delivery design calls for. It owns the
// node lifecycle and every native call; the bring-up ORDER, the receive listener, the
// double-base64 send, storeSync paging and the metrics parse are moved here VERBATIM from
// the KYM-mirror transport — not paraphrased — so behaviour is byte-for-byte unchanged.
// The only structural change: received messages are handed to a broker `route()` instead
// of opened inline, and the node handle lives on the instance instead of a module global.
import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import { utf8Bytes as utf8, utf8Decode as fromUtf8 } from "./utf8";
import type { UnderlyingNode } from "./broker";

const { LogosMessaging } = NativeModules as any;
const emitter = LogosMessaging ? new NativeEventEmitter(LogosMessaging) : null;

export interface RealNodeDeps {
  counters: any;
  diag: any;
  payloadCandidates: (payload: any) => Uint8Array[];
  entryNodes: string[];
  buildConfig: () => any;          // reads current NODE_MODE at call time
  SETTLE_MS: number;
  FILTER_RENEW_MS: number;
  STORE_PAGE: number;
  STORE_TIMEOUT_MS: number;
  STORE_MAX_PAGES: number;
}

export class RealNode implements UnderlyingNode {
  private d: RealNodeDeps;
  private didSetup = false;
  private ctx = "";                // node handle — set when new() returns (used during bring-up)
  private ready = false;           // true only AFTER settle (gates receive/send/store, like KYM's `node`)
  private starting: Promise<void> | null = null;
  private listenerAttached = false;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private deviceId = "";
  private route: (topic: string, payload: any) => boolean = () => false;
  readonly joinedTopics = new Set<string>();   // KYM `routes`
  private storeReqSeq = 0;
  storeInfo = "";

  constructor(deps: RealNodeDeps) { this.d = deps; }

  static available(): boolean { return !!LogosMessaging; }
  setDeviceId(id: string) { this.deviceId = id; }
  isReady(): boolean { return this.ready; }
  getCtx(): string { return this.ready ? this.ctx : ""; }

  // KYM joinRoute — subscribe THEN channelCreate. Uses the local ctx during bring-up.
  private async joinRoute(ctx: string, topic: string): Promise<void> {
    await LogosMessaging.subscribeContentTopic(ctx, topic);
    await LogosMessaging.channelCreate(ctx, topic, topic, this.deviceId);
    this.joinedTopics.add(topic);
  }

  // KYM startReceiving — register the ONE listener. Gated on `ready` (set after settle),
  // exactly like KYM, so messages during the settle window are dropped. Crypto-agnostic:
  // hands candidates to the broker route() instead of opening inline.
  onReceive(route: (topic: string, payload: any) => boolean): void {
    this.route = route;
    if (this.listenerAttached || !emitter) return;
    this.listenerAttached = true;
    emitter.addListener("logosMessage", (evt: { wakuPtr?: string; event?: string }) => {
      const { counters, diag } = this.d;
      counters.rxRaw++;
      try {
        const s0 = String((evt && evt.event) || "");
        if (s0.indexOf("channel_message_received") >= 0) diag.chan++;
        else if (s0.indexOf("message_received") >= 0) diag.msg++;
        else if (s0.indexOf("error") >= 0) diag.err++;
      } catch { /* */ }
      if (!this.ready) return; // node not up yet — nothing to hand the app (KYM: `if (!node) return`)
      try {
        const raw = evt && evt.event;
        if (!raw) { counters.rxNoPayload++; return; }
        const m: any = JSON.parse(raw);
        const wm = m.wakuMessage || m.message || m;
        const payload = wm && wm.payload != null ? wm.payload : m.payload;
        if (payload == null) { counters.rxNoPayload++; return; }
        counters.rxSeen++;
        const topic = m.contentTopic || m.channelId || (wm && wm.contentTopic) || "";
        const cands = this.d.payloadCandidates(payload);
        const opened = this.route(topic, cands);
        if (opened) { counters.rxOpened++; return; }
        counters.rxOpenFail++;
        if (!diag.sample) {
          const kind = Array.isArray(payload) ? "arr" + payload.length
            : typeof payload === "string" ? "b64:" + payload.length : typeof payload;
          const isChan = m && m.eventType === "channel_message_received";
          diag.sample = `${isChan ? "chan" : "msg"} pl=${kind} cand=${cands.length}`;
        }
      } catch { /* foreign traffic / bad shape — never throw in the listener */ }
    });
  }

  // KYM ensureNode — EXACT order: setup → new → start → joinRoute(subscribe+channelCreate)
  // for every topic → settle → renew. Idempotent; concurrent callers share the in-flight
  // startup. Adding a topic once up joins it immediately (KYM refreshRoutes) via subscribe().
  async start(initialTopics: string[], onStatus?: (s: string) => void): Promise<void> {
    if (!LogosMessaging) throw new Error("Logos Delivery native module not present in this build");
    const step = (s: string) => { try { onStatus && onStatus(s); } catch { /* */ } };
    if (this.ready) { for (const t of initialTopics) if (!this.joinedTopics.has(t)) await this.joinRoute(this.ctx, t); return; }
    if (this.starting) { await this.starting; for (const t of initialTopics) if (!this.joinedTopics.has(t)) await this.joinRoute(this.ctx, t); return; }
    this.starting = (async () => {
      step("Starting node…");
      if (!this.didSetup) { await LogosMessaging.setup(); this.didSetup = true; }
      const config = this.d.buildConfig();
      step("mode:" + (config && config.mode));
      const c: string = await LogosMessaging.new(config);
      this.ctx = c;
      step("Joining mesh…");
      await LogosMessaging.start(c);
      // Subscribe + channelCreate every topic BEFORE the settle, so the mesh forms with
      // the channel/subscription already wired in (KYM's order — the bit I'd gotten wrong).
      for (const t of initialTopics) await this.joinRoute(c, t);
      step("Forming mesh…");
      await new Promise((r) => setTimeout(r, this.d.SETTLE_MS)); // settle AFTER join
      this.ready = true; // only now does the listener start processing (matches KYM)
      if (this.renewTimer) clearInterval(this.renewTimer);
      this.renewTimer = setInterval(() => {
        if (!this.ready) return;
        for (const t of this.joinedTopics) LogosMessaging.subscribeContentTopic(this.ctx, t).catch(() => { /* next tick retries */ });
      }, this.d.FILTER_RENEW_MS);
      step("Connected");
    })();
    try { await this.starting; } catch (e) { this.ready = false; throw e; } finally { this.starting = null; }
  }

  // Add a topic after the node is up (KYM refreshRoutes) — subscribe+channelCreate.
  async subscribe(topic: string): Promise<void> {
    const isNew = !this.joinedTopics.has(topic);
    // Remember the topic even when the node isn't settled yet, so the settle/reconnect path
    // (subscribeContentTopic over joinedTopics) picks it up when the fleet comes back — otherwise
    // a topic joined during a BLE-only start is lost on Waku forever.
    this.joinedTopics.add(topic);
    if (this.ready && isNew) await this.joinRoute(this.ctx, topic);
  }

  // liblogosdelivery exposes unsubscribe in the FFI but it is not yet bridged in Kotlin;
  // no-op for now (the shared-service milestone bridges it). Kept for the interface.
  async unsubscribe(_topic: string): Promise<void> { /* TODO: bridge unsubscribeContentTopic */ }

  // KYM publishSealed (channel branch) — DOUBLE-base64 over the SDS reliable channel.
  async send(topic: string, sealed: Uint8Array): Promise<void> {
    const { counters, diag } = this.d;
    counters.txAttempt++;
    if (!this.ready) { diag.txErr = "node-null"; throw new Error("node-null"); } // THROW so the caller keeps it queued
    const sealedB64 = fromByteArray(sealed);
    const doubled = fromByteArray(utf8(sealedB64));
    try {
      await LogosMessaging.channelSend(this.ctx, topic, JSON.stringify({ payload: doubled, ephemeral: false }));
      counters.txTotal++;
    } catch (e: any) {
      counters.txFail++;
      diag.txErr = String((e && (e.message || e.code)) || e).slice(0, 140);
      throw e;
    }
  }

  // KYM stopNode — best-effort; keeps didSetup so a restart is cheap.
  async stop(): Promise<void> {
    if (this.renewTimer) { clearInterval(this.renewTimer); this.renewTimer = null; }
    this.joinedTopics.clear();
    if (this.ready && LogosMessaging) {
      const c = this.ctx;
      this.ready = false;
      try { await LogosMessaging.stop(c); } catch { /* ignore */ }
    }
  }

  // KYM storeSync — cursor-paged history pull over EVERY joined topic. Hands each stored
  // message's candidates to the app (which opens+folds) and returns {msgs, events, detail}.
  async storeSync(onCandidates: (topic: string, candidates: Uint8Array[]) => boolean): Promise<{ msgs: number; events: number; detail: string }> {
    if (!this.ready || typeof LogosMessaging.storeQuery !== "function") {
      this.storeInfo = "store: bridge missing (rebuild app)";
      return { msgs: 0, events: 0, detail: this.storeInfo };
    }
    const ctx = this.ctx;
    let totalMsgs = 0, totalEvents = 0;
    const parts: string[] = [];
    for (const topic of this.joinedTopics) {
      const label = topic.slice(7, 15); // short hex of the content topic
      let cursor: any = undefined;
      let topicMsgs = 0, topicEvents = 0, note = "";
      for (let page = 0; page < this.d.STORE_MAX_PAGES; page++) {
        const query: any = {
          requestId: `lt-${this.storeReqSeq++}-${page}`, // MANDATORY — omitting it faults the FFI
          contentTopics: [topic], includeData: true, paginationForward: true, paginationLimit: this.d.STORE_PAGE,
        };
        if (cursor) query.paginationCursor = cursor;
        let respStr: string | null = null;
        for (const peer of this.d.entryNodes) { // ask each fleet node until one answers this page
          try { respStr = await LogosMessaging.storeQuery(ctx, JSON.stringify(query), peer, this.d.STORE_TIMEOUT_MS); if (respStr) break; }
          catch { respStr = null; }
        }
        if (!respStr) { note = "no store peer answered"; break; }
        if (respStr.indexOf("{") !== 0) { note = respStr.slice(0, 40); break; } // "on_response-ok" sentinel = empty
        let resp: any;
        try { resp = JSON.parse(respStr); } catch { note = `bad json: ${respStr.slice(0, 30)}`; break; }
        const msgs: any[] = resp.messages || resp.Messages || resp.messageData || [];
        topicMsgs += msgs.length;
        for (const entry of msgs) {
          const wm = entry.message || entry.wakuMessage || entry;
          const payload = wm && wm.payload != null ? wm.payload : entry.payload;
          if (payload == null) continue;
          if (onCandidates(topic, this.d.payloadCandidates(payload))) topicEvents++;
        }
        cursor = resp.paginationCursor ?? resp.pagination_cursor ?? resp.cursor;
        if (!cursor || msgs.length === 0) break; // last page
      }
      totalMsgs += topicMsgs; totalEvents += topicEvents;
      parts.push(`${label}:${topicMsgs}m/${topicEvents}e${note ? `(${note})` : ""}`);
    }
    this.storeInfo = `store: ${totalMsgs} msg → ${totalEvents} ev  [${parts.join("  ")}]`;
    return { msgs: totalMsgs, events: totalEvents, detail: this.storeInfo };
  }

  // KYM getPeerCount — sum ALL gossipsub-mesh gauges, parse shard(s), report peers/mesh.
  async refreshPeerInfo(): Promise<void> {
    const { counters } = this.d;
    if (!this.ready || typeof LogosMessaging.getNodeInfo !== "function") return;
    try {
      const metrics: string = await LogosMessaging.getNodeInfo(this.ctx, "Metrics");
      if (typeof metrics !== "string" || !metrics) return;
      let peers = -1, mesh = 0;
      for (const raw of metrics.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const value = Number(line.slice(line.lastIndexOf(" ") + 1));
        if (!Number.isFinite(value)) continue;
        if (line.startsWith("libp2p_peers ")) peers = Math.trunc(value);
        else if (line.includes("gossipsub") && line.includes("mesh")) mesh += Math.trunc(value);
      }
      if (peers >= 0) counters.peers = peers;
      counters.mesh = mesh;
    } catch { /* node down / metrics unavailable */ }
  }
}
