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

  registerTenant(tenantId: string): Tenant {
    let t = this.tenants.get(tenantId);
    if (!t) { t = new Tenant(this, tenantId); this.tenants.set(tenantId, t); }
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

  constructor(broker: SharedDeliveryNode, id: string) { this.broker = broker; this.id = id; }

  onMessage(cb: (topic: string, payload: any) => boolean): this { this.cb = cb; return this; }

  async subscribe(topic: string): Promise<void> {
    this.topics.add(topic);
    await this.broker._subscribe(this.id, topic);
  }

  _deliver(topic: string, payload: any): boolean {
    return this.cb ? this.cb(topic, payload) : false;
  }
}
