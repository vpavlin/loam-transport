// logos-transport — the app's transport API, now running over the multi-tenant broker
// seam (SharedDeliveryNode + RealNode). The PUBLIC API is byte-for-byte the same as the
// KYM-mirror transport it replaces, so sessions.ts / App.tsx are unchanged. What moved:
// the one liblogosdelivery node now lives behind an UnderlyingNode (RealNode), and
// receives are demuxed by content topic through the broker to this app's single tenant.
// Swapping RealNode for a device-wide shared-delivery service later is the only change.
// The proven bring-up (join-before-settle), the listener, storeSync and the double-base64
// send were moved into RealNode VERBATIM — see real-node.ts. This file is the public shim.
import { fromByteArray, toByteArray } from "base64-js";
import { sha256 as sha256hash } from "@noble/hashes/sha256";
import { utf8Bytes as utf8, utf8Decode as fromUtf8 } from "./utf8";
import { SharedDeliveryNode, Tenant } from "./broker";
import { RealNode } from "./real-node";
import { ServiceNode } from "./service-node";

// Per-stage diagnostic counters (surface in a Sync card). rxOpened/rxOpenFail are the
// app's open() outcome, reported back via onReceive's return value.
export const counters = {
  rxRaw: 0, rxNoPayload: 0, rxSelfEcho: 0, rxSeen: 0,
  rxOpened: 0, rxOpenFail: 0, rxNew: 0, rxDup: 0, txTotal: 0, txAttempt: 0, txFail: 0, peers: -1, mesh: -1,
};
export const diag = { chan: 0, msg: 0, err: 0, sample: "", txErr: "" };
export function getRxSample(): string {
  return `chan:${diag.chan} msg:${diag.msg} err:${diag.err}${diag.sample ? " | " + diag.sample : ""}${diag.txErr ? " | txErr:" + diag.txErr : ""}`;
}

// Autoshard (RFC 51 gen-0) for a content topic — must match the C++ core's shardFor.
export function shardFor(contentTopic: string, count = 8): number {
  const parts = contentTopic.split("/"); // ["", app, version, name, enc]
  if (parts.length < 3) return -1;
  const h = sha256hash(utf8(parts[1] + parts[2]));
  let val = 0n;
  for (let i = 24; i < 32; i++) val = (val << 8n) | BigInt(h[i]);
  return Number(val % BigInt(count));
}

// FLEET — logos.test (Logos Test Network, cluster 2, 8 shards). We were on logos.dev,
// but logos.dev migrated to CLUSTER 3: the preset baked into liblogosdelivery still maps
// logos.dev→cluster 2, so a fresh node dials the (now cluster-3) logos.dev boxes with
// cluster-2 config and never meshes — "existing connections persist, new ones fail".
// logos.test stays on cluster 2, which keeps qaku's shard math valid (sha256("qaku"+"1")
// % 8 = shard 0). Preset + entryNodes must stay in lockstep with qaku_core (C++ desktop).
const FLEET_PRESET = "logos.test";

// Kernel operating mode. "Core" = full service node (relays the shard, discovers peers via
// discv5) — safe default. "Edge" = client-only (filter-subscribe + lightpush-publish, no
// shard relay, no discovery): lighter on battery/data, leans on the fleet's Core nodes.
// Read only at node start — call setNodeMode() BEFORE start(), then relaunch to change it.
export type NodeMode = "Core" | "Edge";
let NODE_MODE: NodeMode = "Core";
export function setNodeMode(m: NodeMode) { NODE_MODE = m === "Edge" ? "Edge" : "Core"; }
export function getNodeMode(): NodeMode { return NODE_MODE; }

export const ENTRY_NODES: string[] = [
  "/dns4/node-01.do-ams3.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmQ9X2xDfPG3uL77V9piYDhjq14JhKCtcmNYsTMKNqrKCj",
  "/dns4/node-02.do-ams3.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmB8NYprrfQrgWVzsJtYWkfjsXbmJEGNMG6othXsQ53BwG",
  "/dns4/node-01.gc-us-central1-a.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmF8WtwGPmeGHgYAX2277jHgy5cW9F7zsB8EqUjBZQAZQ3",
  "/dns4/node-02.gc-us-central1-a.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmUuXhUW9bdJpzN1kfDziFiUZo4bszTk66cvr7uuyCHXR7",
  "/dns4/node-01.ac-cn-hongkong-c.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmL3oU95jh1BZHozn3uNhx8HEneirgr8M1jEAapzXGDqRF",
  "/dns4/node-02.ac-cn-hongkong-c.logos.test.status.im/tcp/30303/p2p/16Uiu2HAm28CoBZjpyxsanC8tQpbvZ7bZJnVYuB1EgFzb571qpWsV",
];
const SETTLE_MS = 10000;         // KYM SETTLE_MS
const FILTER_RENEW_MS = 60000;   // KYM FILTER_RENEW_MS
const STORE_PAGE = 100;          // KYM STORE_PAGE
const STORE_TIMEOUT_MS = 20000;  // KYM STORE_TIMEOUT_MS
const STORE_MAX_PAGES = 25;      // KYM STORE_MAX_PAGES (25*100 = 2500 events/topic)

export type OnReceive = (topic: string, candidates: Uint8Array[]) => boolean; // true iff app opened one
export type OnStatus = (s: string) => void;

// Edge drops relay + discv5 (it neither serves the shard nor discovers peers); it publishes
// via lightpush and receives via filter, leaning on the fleet's Core nodes. Core is the
// proven RELAY config — no light-client fields (they make waku_new reject → offline).
function buildConfig(): any {
  return NODE_MODE === "Edge"
    ? { mode: "Edge", preset: FLEET_PRESET, entryNodes: ENTRY_NODES, tcpPort: 0 }
    : { mode: "Core", preset: FLEET_PRESET, relay: true, entryNodes: ENTRY_NODES, tcpPort: 0, discv5Discovery: true };
}

// KYM payloadCandidates — verbatim. Passed into RealNode so its listener/store stay pure.
export function payloadCandidates(payload: any): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (Array.isArray(payload)) {
    let s = "";
    for (let i = 0; i < payload.length; i++) s += String.fromCharCode(payload[i] & 0xff);
    let once: Uint8Array | null = null;
    try { once = toByteArray(s); out.push(once); } catch { /* not base64 text */ }
    if (once) { try { out.push(toByteArray(fromUtf8(once))); } catch { /* not double */ } }
    out.push(Uint8Array.from(payload.map((b: number) => b & 0xff)));
  } else if (typeof payload === "string") {
    try {
      const once = toByteArray(payload);
      out.push(once);
      try { out.push(toByteArray(fromUtf8(once))); } catch { /* not double */ }
    } catch { /* not base64 */ }
  }
  return out;
}

// ---- the one node, behind the broker seam ----
// The backend is chosen LAZILY at first use: RealNode (this process runs the node) by
// default, or ServiceNode (bind the device-wide shared service over AIDL) when a client app
// opts in via preferServiceBackend() and the client native module is present. A single-app
// consumer uses start()/join()/publishSealed(); the SERVICE uses registerClient() per tenant.
let onReceiveCb: OnReceive | null = null;
let preferService = false;
let clientAppId = "app";
export function preferServiceBackend(on: boolean, appId?: string) { preferService = on; if (appId) clientAppId = appId; }

let backend: RealNode | ServiceNode | null = null;
let shared: SharedDeliveryNode | null = null;
let tenant: Tenant | null = null;
function ensure() {
  if (shared) return;
  backend = (preferService && ServiceNode.available())
    ? new ServiceNode({ appId: clientAppId })
    : new RealNode({ counters, diag, payloadCandidates, entryNodes: ENTRY_NODES, buildConfig,
        SETTLE_MS, FILTER_RENEW_MS, STORE_PAGE, STORE_TIMEOUT_MS, STORE_MAX_PAGES });
  shared = new SharedDeliveryNode(backend);
  // the app's single tenant opens (decrypts) via onReceive and reports back.
  tenant = shared.registerTenant("app").onMessage(
    (topic: string, cands: Uint8Array[]) => (onReceiveCb ? onReceiveCb(topic, cands) : false),
  );
}

export function deliveryAvailable(): boolean { return RealNode.available() || ServiceNode.available(); }
export function getStoreInfo(): string { return backend ? backend.storeInfo : ""; }
export function getCtx(): string { return backend ? backend.getCtx() : ""; }

// ---- multi-tenant API for the shared-delivery SERVICE ----
// A single-app consumer (qaku/kym) uses start()/join()/publishSealed() unchanged (the
// implicit "app" tenant above). The SERVICE, which owns the device-wide node, registers
// ONE tenant per bound client app instead: each client subscribes via its Tenant, sends
// via publishSealed(topic,bytes) (send is node-level), and receives via its onMessage,
// routed by content topic. Bring the node up first with start({topics:[], …}).
export function registerClient(appId: string, onMessage: (topic: string, candidates: Uint8Array[]) => boolean): Tenant {
  ensure(); return shared!.registerTenant(appId).onMessage(onMessage);
}
export function clientSubscribe(appId: string, topic: string): Promise<void> {
  ensure(); const t = shared!.tenants.get(appId); return t ? t.subscribe(topic) : Promise.resolve();
}
export function unregisterClient(appId: string): Promise<void> {
  ensure(); const t = shared!.tenants.get(appId); return t ? t.close() : Promise.resolve();
}

// Bring the node up (or, if up, join new topics), then record topic ownership so the
// broker routes those topics to this app's tenant.
export async function start(opts: { deviceId: string; topics: string[]; onReceive: OnReceive; onStatus?: OnStatus }): Promise<void> {
  onReceiveCb = opts.onReceive;
  ensure();
  backend!.setDeviceId(opts.deviceId);
  await backend!.start(opts.topics, opts.onStatus);
  shared!._adopt("app", opts.topics);   // the single tenant owns the initial topics (no reliance on join())
}

// Publish a sealed payload on a topic (RealNode double-base64s over SDS; ServiceNode forwards to the service).
export async function publishSealed(topic: string, sealed: Uint8Array): Promise<void> {
  ensure(); await backend!.send(topic, sealed);
}

// Add topics after the node is up — via the tenant so the broker records ownership and
// subscribes the underlying node exactly once per topic (refcounted).
export async function join(topics: string[]): Promise<void> {
  ensure();
  if (!backend!.isReady()) return;
  for (const t of topics) if (!tenant!.topics.has(t)) await tenant!.subscribe(t);
}

export async function stop(): Promise<void> { if (backend) await backend.stop(); }

export function storeSync(onCandidates: (topic: string, candidates: Uint8Array[]) => boolean) {
  ensure(); return backend!.storeSync(onCandidates);
}

export function refreshPeerInfo(): Promise<void> { ensure(); return backend!.refreshPeerInfo(); }
