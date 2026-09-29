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

// Debug breadcrumb (Loam sets globalThis.__loamMark → a crash-surviving native trail file).
const mark = (s: string) => { try { (globalThis as any).__loamMark?.(s); } catch { /* */ } };

export class RealNode implements UnderlyingNode {
  private d: RealNodeDeps;
  private didSetup = false;
  private ctx = "";                // node handle — set when new() returns (used during bring-up)
  private ready = false;           // true only AFTER settle (gates receive/send/store, like KYM's `node`)
  private starting: Promise<void> | null = null;
  private listenerAttached = false;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  // Peerless watchdog: peer-exchange can't recover from 0 peers (no peer to ask), and on mobile the
  // mesh also drops on doze / wifi↔cellular handoff. Poll peers; re-dial if peerless after connecting.
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  // Node maintenance (re-dial, subscription renewal) runs one job at a time: the two used to fire in the
  // same second and the native node segfaulted ~1 s later, intermittently (on device, 2026-09-29).
  private nodeJob: Promise<void> = Promise.resolve();
  private exclusive(job: () => Promise<void>): Promise<void> {
    const run = this.nodeJob.then(job, job);
    this.nodeJob = run.catch(() => { /* */ });
    return run;
  }
  // Re-dial gap: doubles while re-dialing doesn't bring peers (up to 10 min), resets once peers appear.
  private redialGapMs = 45000;
  private wasOffline = false;
  // Topics asked for before the node was ready, or whose join failed: joined after settle and retried on
  // each renew tick. (joinedTopics only ever holds topics whose subscribe + channelCreate succeeded, so a
  // retry of a failed join isn't mistaken for "already joined".)
  private pendingTopics = new Set<string>();
  private everConnected = false;
  private zeroPeerTicks = 0;
  private lastReconnectMs = 0;
  private reconnecting = false;
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
      // Reuse a node we already created (a start that failed after new(), or a restart after stop()):
      // a second LogosMessaging.new() in the same process segfaults the native library.
      let c: string = this.ctx;
      if (!c) {
        mark("node new mode=" + (config && config.mode));
        c = await LogosMessaging.new(config);
        mark("node new ok ctx=" + String(c).slice(-6));
      } else mark("node restart ctx=" + String(c).slice(-6));
      this.ctx = c;
      step("Joining mesh…");
      await LogosMessaging.start(c);
      mark("node started");
      // Subscribe + channelCreate every topic BEFORE the settle, so the mesh forms with
      // the channel/subscription already wired in (KYM's order — the bit I'd gotten wrong).
      for (const t of initialTopics) await this.joinRoute(c, t);
      step("Forming mesh…");
      await new Promise((r) => setTimeout(r, this.d.SETTLE_MS)); // settle AFTER join
      this.ready = true; // only now does the listener start processing (matches KYM)
      await this.exclusive(() => this.joinPending());   // topics requested during start-up / settle
      if (this.renewTimer) clearInterval(this.renewTimer);
      this.renewTimer = setInterval(() => { this.exclusive(async () => {
        if (!this.ready) return;
        // Offline: skip (nothing to renew against; see reconnect() on offline native crashes).
        if (!(await this.isOnline())) return;
        mark(`renew ${this.joinedTopics.size} topics` + (this.pendingTopics.size ? ` (+${this.pendingTopics.size} pending)` : ""));
        await this.joinPending();
        for (const t of [...this.joinedTopics]) { try { await LogosMessaging.subscribeContentTopic(this.ctx, t); } catch { /* next tick retries */ } }
      }).catch(() => { /* */ }); }, this.d.FILTER_RENEW_MS);
      // Arm the peerless watchdog (self-polls, so it works even if the app never calls refreshPeerInfo).
      this.everConnected = false; this.zeroPeerTicks = 0;
      if (this.watchdogTimer) clearInterval(this.watchdogTimer);
      this.watchdogTimer = setInterval(() => { this.peerWatchdog().catch(() => { /* */ }); }, 10000);
      step("Connected");
    })();
    try { await this.starting; } catch (e) { this.ready = false; throw e; } finally { this.starting = null; }
  }

  // Add a topic after the node is up (KYM refreshRoutes) — subscribe+channelCreate.
  async subscribe(topic: string): Promise<void> {
    if (this.joinedTopics.has(topic)) return;
    // Not settled yet (or a BLE-only start): remember it; start() joins it after settle and the renew
    // tick retries it, so it's never lost on the Waku side.
    this.pendingTopics.add(topic);
    if (!this.ready) return;
    await this.exclusive(() => this.joinRoute(this.ctx, topic));   // throws on failure → caller retries
    this.pendingTopics.delete(topic);
  }
  private async joinPending(): Promise<void> {
    for (const t of [...this.pendingTopics]) {
      if (this.joinedTopics.has(t)) { this.pendingTopics.delete(t); continue; }
      try { await this.joinRoute(this.ctx, t); this.pendingTopics.delete(t); } catch { /* next renew tick */ }
    }
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

  // Fire-and-forget RAW relay publish — NO SDS reliable channel. For diagnostics/telemetry, where
  // ordering, retransmit and causal history are pure waste (and worse: a cold-joining collector can
  // never resolve the SDS causal deps, so channel sends never deliver to it). A raw relay message on
  // the content topic reaches any LIVE subscriber immediately. payload = base64(sealed), ephemeral.
  async sendRaw(topic: string, sealed: Uint8Array): Promise<void> {
    if (!this.ready) throw new Error("node-null");
    // Double-base64, EXACTLY like the channel send: the FFI base64-decodes `payload` once, so the wire
    // payload = base64(sealed) — and a receiver (loam_core) then does its ONE b64-decode to get `sealed`
    // (the app-core contract: "one decode; the app peels the last layer"). Single-b64 here would put the
    // RAW bytes on the wire, and the receiver's decode would shred them.
    const doubled = fromByteArray(utf8(fromByteArray(sealed)));
    await LogosMessaging.send(this.ctx, JSON.stringify({ contentTopic: topic, payload: doubled, ephemeral: true }));
  }

  // KYM stopNode — best-effort; keeps didSetup so a restart is cheap.
  async stop(): Promise<void> {
    if (this.renewTimer) { clearInterval(this.renewTimer); this.renewTimer = null; }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    this.joinedTopics.clear(); this.pendingTopics.clear();
    if (this.ready && LogosMessaging) {
      const c = this.ctx;
      this.ready = false;
      mark("node stop");
      try { await LogosMessaging.stop(c); } catch { /* ignore */ }
    }
  }

  // KYM storeSync — cursor-paged history pull over EVERY joined topic. Hands each stored
  // message's candidates to the app (which opens+folds) and returns {msgs, events, detail}.
  async storeSync(onCandidates: (topic: string, candidates: Uint8Array[]) => boolean): Promise<{ msgs: number; events: number; detail: string }> {
    mark(`storeSync topics=${this.joinedTopics.size}`);
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

  // Sits at 0 peers → re-dial (PX can't bootstrap from 0). Re-dial WHETHER OR NOT we ever connected:
  // a node that STARTED while offline (internet off at launch, then restored) never gets everConnected
  // set, so gating on it left the node stuck at 0 peers forever with force-stop the only recovery.
  // We just give the FIRST connect a longer grace (~60s) so a normal cold-start mesh isn't cut short;
  // after we've ever connected, a drop re-dials at ~30s. Either way the 45s cooldown prevents thrash.
  private async peerWatchdog(): Promise<void> {
    if (this.reconnecting) return;
    if (!this.ready) return;   // not started (or start failed): nothing to re-dial on; never re-create the node
    await this.refreshPeerInfo();
    const peers = this.d.counters.peers;
    if (peers > 0) { this.everConnected = true; this.zeroPeerTicks = 0; this.redialGapMs = 45000; return; }
    if (peers !== 0) return; // -1 = metrics not read yet; don't count it as peerless
    const threshold = this.everConnected ? 3 : 6;   // ~30s after a drop, ~60s for the first connect
    if (++this.zeroPeerTicks >= threshold && Date.now() - this.lastReconnectMs > this.redialGapMs) {
      this.zeroPeerTicks = 0;
      try { console.warn(`[loam] mobile node peerless ~${threshold * 10}s (everConnected=${this.everConnected}) → re-dialing`); } catch { /* */ }
      await this.reconnect();
    }
  }

  // Re-dial the fleet on the LIVE node: connect() each entry node, then renew the subscriptions.
  // Never stop + re-create the node: a second LogosMessaging.new() in the same process segfaults the
  // native library (SIGSEGV within a second of "node new", seen on device every ~60-100 s offline).
  async reconnect(): Promise<void> {
    if (this.reconnecting || !this.ready || !this.ctx) return;
    this.reconnecting = true;
    return this.exclusive(() => this.redial());
  }
  private async redial(): Promise<void> {
    try {
      const ctx = this.ctx;
      if (!this.ready || !ctx) return;   // stopped while this job waited its turn
      // Offline (no validated internet): skip. Dialing can't succeed, and a dial + subscription burst
      // on an offline node crashed it natively (SIGSEGV ~1 s after "redial", on device, 2026-09-29).
      // Skipping doesn't count as an attempt: the backoff grows only for dials that didn't help.
      if (!(await this.isOnline())) return;
      this.lastReconnectMs = Date.now();
      this.redialGapMs = Math.min(this.redialGapMs * 2, 600000);   // reset to 45 s when peers appear
      // Two random entry nodes, short timeout: connect() is a synchronous native call that holds the
      // shared native-module thread (BLE sends, marks) while it waits.
      const peers = [...this.d.entryNodes].sort(() => Math.random() - 0.5).slice(0, 2);
      mark(`redial peerless -> ${peers.length} entry nodes`);
      let ok = 0;
      for (const peer of peers) {
        try { await LogosMessaging.connect(ctx, peer, 3000); ok++; } catch { /* unreachable */ }
      }
      mark(`redial done ok=${ok}`);   // subscriptions are renewed by the regular renew tick
    }
    finally { this.reconnecting = false; }
  }
  // Validated internet per Android (LoamMesh.online). Unknown → online (only an explicit false skips).
  // Marks the trail only on a change, and a return to online resets the re-dial backoff.
  private async isOnline(): Promise<boolean> {
    let online = true;
    try { const f = (globalThis as any).__loamOnline; if (typeof f === "function") online = (await f()) !== false; } catch { /* */ }
    if (online !== !this.wasOffline) {
      mark(online ? "back online" : "offline: skipping re-dial and renew");
      if (online) { this.redialGapMs = 45000; this.lastReconnectMs = 0; }
      this.wasOffline = !online;
    }
    return online;
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
