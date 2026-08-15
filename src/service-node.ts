// ServiceNode — the CLIENT-side UnderlyingNode. Instead of running its own liblogosdelivery
// node (RealNode), it binds the device-wide Logos Delivery SERVICE over AIDL and routes
// subscribe/send/receive through it. Drop-in for RealNode: same surface the transport uses.
//
// Requires the host app to provide a `LogosDeliveryClient` native module (binds the AIDL
// service, forwards calls, emits received messages). If that module is absent (service not
// integrated), ServiceNode.available() is false and the transport falls back to RealNode.
import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import type { UnderlyingNode } from "./broker";

const Client = (NativeModules as any).LogosDeliveryClient;
const emitter = Client ? new NativeEventEmitter(Client) : null;

export class ServiceNode implements UnderlyingNode {
  private appId: string;
  private counters: any;
  private diag: any;
  private ready = false;
  private route: (topic: string, payload: any) => boolean = () => false;
  private listenerAttached = false;
  private reconnectTimer: any = null;
  nodeDown = false;   // bound, but the service app's node/JS isn't running (no metrics)
  awaitingApproval = false;   // bound + node up, but this app hasn't been approved by the owner
  readonly joinedTopics = new Set<string>();
  storeInfo = "store: via shared service";

  constructor(opts: { appId: string; counters?: any; diag?: any }) { this.appId = opts.appId; this.counters = opts.counters; this.diag = opts.diag; }

  static available(): boolean { return !!Client; }
  setDeviceId(_id: string) { /* the shared service owns node identity */ }
  isReady(): boolean { return this.ready; }
  getCtx(): string { return this.ready ? "service" : ""; }

  onReceive(route: (topic: string, payload: any) => boolean): void {
    this.route = route;
    if (this.listenerAttached || !emitter) return;
    this.listenerAttached = true;
    // The service forwards each message as a JSON array of base64 payload candidates
    // (it stays a blind pipe; we open with our own key upstream, exactly like RealNode).
    emitter.addListener("logosDeliveryMessage", (m: { topic?: string; candidatesJson?: string }) => {
      try {
        if (!this.ready) return;
        const topic = m.topic || "";
        if (this.counters) this.counters.rxRaw = (this.counters.rxRaw || 0) + 1;
        const arr: string[] = m.candidatesJson ? JSON.parse(m.candidatesJson) : [];
        const cands = arr.map((b64) => toByteArray(b64));
        this.route(topic, cands);
      } catch { /* never throw in the listener */ }
    });
    // Reconnect lifecycle: when the service is updated/killed and comes back, re-subscribe
    // our topics (the owner's grant persists, so no re-prompt). While it's gone, keep rebinding.
    emitter.addListener("logosDeliveryConnected", () => {
      for (const t of this.joinedTopics) { try { Client.subscribe(t); } catch { /* */ } }
      this.ready = true; this.nodeDown = false;
      if (this.reconnectTimer) { clearInterval(this.reconnectTimer); this.reconnectTimer = null; }
    });
    emitter.addListener("logosDeliveryDisconnected", () => {
      this.ready = false;
      if (!this.reconnectTimer) this.reconnectTimer = setInterval(() => { try { Client.reconnect(); } catch { /* */ } }, 3000);
    });
  }

  // The service app is installed but its node/JS isn't running (bound, but no metrics).
  isNodeDown(): boolean { return this.nodeDown; }
  // Bring the Logos Delivery app to the foreground so its node starts (call from foreground).
  launchService(): void { try { Client.launchService && Client.launchService(); } catch { /* */ } }
  async diag(): Promise<string> { try { return Client && Client.diag ? await Client.diag() : "client module has no diag()"; } catch (e: any) { return "diag() threw: " + (e?.message || e); } }
  async serviceInstalled(): Promise<boolean> { try { return await Client.isInstalled(); } catch { return false; } }

  async start(initialTopics: string[], onStatus?: (s: string) => void): Promise<void> {
    if (!Client) throw new Error("LogosDeliveryClient native module not present");
    const step = (s: string) => { try { onStatus && onStatus(s); } catch { /* */ } };
    step("Binding shared node…");
    const ok = await Client.connect();          // bind the AIDL service
    if (!ok) throw new Error("could not bind Logos Delivery service");
    await Client.register(this.appId);          // triggers the "Allow App X?" consent
    step("Awaiting approval / syncing…");
    for (const t of initialTopics) { await Client.subscribe(t); this.joinedTopics.add(t); }
    this.ready = true;
    step("Connected (shared node)");
  }

  async subscribe(topic: string): Promise<void> {
    if (!this.ready || this.joinedTopics.has(topic)) return;
    await Client.subscribe(topic); this.joinedTopics.add(topic);
  }
  async unsubscribe(_topic: string): Promise<void> { /* service-side; no per-topic unsub yet */ }

  async send(topic: string, sealed: Uint8Array): Promise<void> {
    if (!this.ready) { if (this.diag) this.diag.txErr = "node-null"; throw new Error("node-null"); }
    if (this.counters) this.counters.txAttempt = (this.counters.txAttempt || 0) + 1;
    try {
      await Client.send(topic, fromByteArray(sealed));
      if (this.counters) this.counters.txTotal = (this.counters.txTotal || 0) + 1;
      if (this.diag) this.diag.txErr = "";
    } catch (e: any) {
      if (this.counters) this.counters.txFail = (this.counters.txFail || 0) + 1;
      if (this.diag) this.diag.txErr = String((e && (e.message || e.code)) || e).slice(0, 140);
      throw e;
    }
  }

  // Store history + live peer metrics belong to the service's node; not proxied yet.
  async storeSync(_onCandidates: (t: string, c: Uint8Array[]) => boolean): Promise<{ msgs: number; events: number; detail: string }> {
    return { msgs: 0, events: 0, detail: this.storeInfo };
  }
  // Pull the shared node's live peers/mesh over AIDL so the app's status + the
  // optimistic publish-confirmation (which key off counters.mesh) work as on an
  // embedded node. The service stays a blind pipe — this is only node health.
  async refreshPeerInfo(): Promise<void> {
    if (!this.ready || !this.counters || typeof Client.metrics !== "function") return;
    try {
      const m = JSON.parse(await Client.metrics());
      if (m.authorized === false) {   // gated: not approved yet — reveal no health
        this.awaitingApproval = true; this.nodeDown = false;
        this.counters.peers = -1; this.counters.mesh = -1; return;
      }
      this.awaitingApproval = false;
      this.nodeDown = typeof m.peers !== "number";   // bound but node/JS not reporting
      if (typeof m.peers === "number") this.counters.peers = m.peers;
      if (typeof m.mesh === "number") this.counters.mesh = m.mesh;
    } catch { this.nodeDown = true; }
  }
  isAwaitingApproval(): boolean { return this.awaitingApproval; }
  async stop(): Promise<void> { this.ready = false; try { await Client.disconnect?.(); } catch { /* */ } }
}
