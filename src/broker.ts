// broker — the multi-tenant seam. A single UnderlyingNode (one Waku node) wrapped so
// that N independent apps ("tenants") can each register their content topics and
// receive ONLY their own traffic. In qaku today there is exactly one tenant, but the
// app runs through this seam so that swapping the embedded RealNode for a shared
// device-wide delivery service later is a one-line change, not a rewrite.
//
// Ported from the standalone prototype (~/logos-shared-delivery). Transport-agnostic:
// no crypto, no topic scheme, no app id. Receive is routed by content topic; the
// tenant callback returns whether the app "opened" (decrypted) the message, which the
// underlying node uses for its rx counters.

export interface UnderlyingNode {
  // Bring the one node up and join the initial topics (impl owns the exact ordering).
  start(initialTopics: string[], onStatus?: (s: string) => void): Promise<void>;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
  // Register the single global receive stream; the broker demuxes it by content topic.
  onReceive(route: (topic: string, payload: any) => boolean): void;
  isReady(): boolean;
}

export class SharedDeliveryNode {
  node: UnderlyingNode;
  /** contentTopic -> Set<tenantId>  (the routing table) */
  owners = new Map<string, Set<string>>();
  /** tenantId -> Tenant */
  tenants = new Map<string, Tenant>();

  constructor(node: UnderlyingNode) {
    this.node = node;
    // ONE global receive handler for the whole device; demux by content topic.
    this.node.onReceive((topic, payload) => this._route(topic, payload));
  }

  // `cacheLimit > 0` opts this tenant into offline caching (ADR 0011): when its app
  // backgrounds/unbinds the broker keeps the subscription alive and buffers up to
  // `cacheLimit` messages, delivered on reattach. Default 0 = today's behaviour
  // (unbind drops the subscription). The opt-in is per approved app — the consent
  // decision lives in the shared-delivery service, which passes the limit here.
  registerTenant(tenantId: string, opts?: { cacheLimit?: number }): Tenant {
    let t = this.tenants.get(tenantId);
    if (!t) { t = new Tenant(this, tenantId); this.tenants.set(tenantId, t); }
    if (opts && typeof opts.cacheLimit === "number") t.cacheLimit = opts.cacheLimit;
    return t;
  }

  // ---- internal, called by Tenant ----

  async _subscribe(tenantId: string, topic: string): Promise<void> {
    let set = this.owners.get(topic);
    if (!set) { set = new Set(); this.owners.set(topic, set); await this.node.subscribe(topic); }
    set.add(tenantId);
  }

  async _unsubscribe(tenantId: string, topic: string): Promise<void> {
    const set = this.owners.get(topic);
    if (!set) return;
    set.delete(tenantId);
    if (set.size === 0) { this.owners.delete(topic); await this.node.unsubscribe(topic); }
  }

  // Record ownership of topics the node already joined during its bring-up (join-before-
  // settle), WITHOUT re-subscribing — so routing works but the proven order is untouched.
  _adopt(tenantId: string, topics: string[]): void {
    for (const t of topics) {
      let set = this.owners.get(t);
      if (!set) { set = new Set(); this.owners.set(t, set); }
      set.add(tenantId);
    }
  }

  // The topics this device's broker currently routes (for diagnostics: does a BLE
  // frame's topic match anything an app subscribed?).
  ownedTopics(): string[] { return [...this.owners.keys()]; }

  // Returns true iff some owning tenant opened (decrypted) the message.
  _route(topic: string, payload: any): boolean {
    const set = this.owners.get(topic);
    if (!set || set.size === 0) return false; // foreign / unowned topic -> dropped
    let opened = false;
    for (const tenantId of set) {
      const t = this.tenants.get(tenantId);
      if (t && t._deliver(topic, payload)) opened = true;
    }
    return opened;
  }
}

export class Tenant {
  broker: SharedDeliveryNode;
  id: string;
  topics = new Set<string>();
  cb: ((topic: string, payload: any) => boolean) | null = null;

  /** Offline cache (ADR 0011). 0 = disabled. When > 0 and the app is detached, the
   *  broker keeps the subscription and buffers incoming sealed payloads here (a ring
   *  of at most `cacheLimit`), delivered in order on reattach. */
  cacheLimit = 0;
  private buffer: { topic: string; payload: any }[] = [];
  /** Messages evicted because the ring was full while detached. A non-zero value on
   *  reattach means the cache could NOT cover the gap → the app must reconcile. */
  private dropped = 0;
  /** The result of the most recent reattach() — read this after re-registering a
   *  client to decide whether catch-up is needed (dropped > 0). */
  lastReplay: { delivered: number; dropped: number } = { delivered: 0, dropped: 0 };

  constructor(broker: SharedDeliveryNode, id: string) { this.broker = broker; this.id = id; }

  onMessage(cb: (topic: string, payload: any) => boolean): this { this.cb = cb; return this; }

  async subscribe(topic: string): Promise<void> {
    this.topics.add(topic);
    await this.broker._subscribe(this.id, topic);
  }

  // App backgrounded / client unbound, but this tenant caches: DROP the live callback
  // yet KEEP the subscription — incoming messages now buffer instead of being lost.
  // (No unsubscribe: that's the whole point.) For a non-caching tenant the service
  // still calls close() instead.
  detach(): void { this.cb = null; }

  /** How many messages are buffered right now (0 when live/attached). For the
   *  shared-delivery UI to show "N waiting" per app. */
  buffered(): number { return this.buffer.length; }

  // App reopened / client rebound: install the live callback, drain the buffered
  // messages IN ORDER (the app dedups by event id, so this is idempotent), and report
  // how many were delivered vs dropped. dropped > 0 ⇒ the cache overflowed while away,
  // so the app should still run catch-up; dropped === 0 ⇒ the cache was complete and
  // catch-up can be skipped (the "avoid replay" win).
  reattach(cb: (topic: string, payload: any) => boolean): { delivered: number; dropped: number } {
    this.cb = cb;
    const drained = this.buffer;
    const dropped = this.dropped;
    this.buffer = [];
    this.dropped = 0;
    for (const m of drained) cb(m.topic, m.payload);
    this.lastReplay = { delivered: drained.length, dropped };
    return this.lastReplay;
  }

  // Release everything this tenant owns (unsubscribe its topics, drop it). Used by the
  // shared-delivery service when a NON-caching client disconnects (or on opt-out).
  async close(): Promise<void> {
    for (const t of this.topics) await this.broker._unsubscribe(this.id, t);
    this.topics.clear();
    this.buffer = [];
    this.dropped = 0;
    this.broker.tenants.delete(this.id);
    this.cb = null;
  }

  _deliver(topic: string, payload: any): boolean {
    if (this.cb) return this.cb(topic, payload);   // live — deliver to the app now
    if (this.cacheLimit > 0) {                       // detached + opted-in → cache it
      this.buffer.push({ topic, payload });
      while (this.buffer.length > this.cacheLimit) { this.buffer.shift(); this.dropped++; }
    }
    return false;                                    // not opened by the app right now
  }
}
