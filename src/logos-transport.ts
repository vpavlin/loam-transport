// logos-transport — the app's transport API, now running over the multi-tenant broker
// seam (SharedDeliveryNode + RealNode). The PUBLIC API is byte-for-byte the same as the
// KYM-mirror transport it replaces, so sessions.ts / App.tsx are unchanged. What moved:
// the one liblogosdelivery node now lives behind an UnderlyingNode (RealNode), and
// receives are demuxed by content topic through the broker to this app's single tenant.
// Swapping RealNode for a device-wide shared-delivery service later is the only change.
// The proven bring-up (join-before-settle), the listener, storeSync and the double-base64
// send were moved into RealNode VERBATIM — see real-node.ts. This file is the public shim.
import { fromByteArray, toByteArray } from "base64-js";
import { sha256 as sha256hash } from "@noble/hashes/sha2";
import { utf8Bytes as utf8, utf8Decode as fromUtf8 } from "./utf8";
import { SharedDeliveryNode, Tenant } from "./broker";
import { RealNode } from "./real-node";
import { ServiceNode } from "./service-node";
import { BleMeshBearer, makeFrame } from "./bearer";
import type { MeshRadio } from "./bearer";

// Per-stage diagnostic counters (surface in a Sync card). rxOpened/rxOpenFail are the
// app's open() outcome, reported back via onReceive's return value.
export const counters = {
  rxRaw: 0, rxNoPayload: 0, rxSelfEcho: 0, rxSeen: 0,
  rxOpened: 0, rxOpenFail: 0, rxNew: 0, rxDup: 0, txTotal: 0, txAttempt: 0, txFail: 0, peers: -1, mesh: -1,
  // BLE-mesh-specific (ADR 0012), kept separate from the Waku rx/tx above so the card can
  // localize a BLE failure: bleTx = frames we handed to the mesh to flood; bleRx = frames
  // that arrived FROM the mesh at the JS layer. bleRx climbing with no internet == BLE works.
  bleTx: 0, bleRx: 0,
  // Of the bleRx frames, how many the broker actually ROUTED to a tenant (delivered) vs
  // DROPPED as a foreign/unowned topic. bleRx climbing but bleRxDropped climbing == the
  // receiving side never subscribed the topic (the drop is here, not the radio).
  bleRxDelivered: 0, bleRxDropped: 0,
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

// Kernel operating mode. "Edge" = client-only (filter-subscribe + lightpush-publish, no
// shard relay, no discovery): lighter on battery/data and works on mobile AND WiFi — the
// safe DEFAULT for phones. "Core" = full service node (relays the shard, discovers peers):
// best on stable WiFi/power, historically flaky on cellular. Read only at node start —
// call setNodeMode() BEFORE start(), then relaunch to change it.
export type NodeMode = "Core" | "Edge";
let NODE_MODE: NodeMode = "Edge";
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
let started = false;
export function preferServiceBackend(on: boolean, appId?: string) {
  preferService = on; if (appId) clientAppId = appId;
  // A pre-start diagnostic (e.g. a status widget's refreshPeerInfo) can call ensure() and wire
  // the DEFAULT embedded backend before we know this preference — and ensure() is idempotent,
  // so the shared node would never be used. If start() hasn't run yet, re-wire to match.
  if (shared && !started) {
    const wantService = on && ServiceNode.available();
    if ((backend instanceof ServiceNode) !== wantService) {
      wire(wantService ? new ServiceNode({ appId: clientAppId, counters, diag }) : makeReal());
    }
  }
}

let backend: RealNode | ServiceNode | null = null;
let shared: SharedDeliveryNode | null = null;
let tenant: Tenant | null = null;
function makeReal(): RealNode {
  return new RealNode({ counters, diag, payloadCandidates, entryNodes: ENTRY_NODES, buildConfig,
    SETTLE_MS, FILTER_RENEW_MS, STORE_PAGE, STORE_TIMEOUT_MS, STORE_MAX_PAGES });
}
function wire(b: RealNode | ServiceNode) {
  backend = b;
  shared = new SharedDeliveryNode(backend);
  // the app's single tenant opens (decrypts) via onReceive and reports back.
  tenant = shared.registerTenant("app").onMessage(
    (topic: string, cands: Uint8Array[]) => (onReceiveCb ? onReceiveCb(topic, cands) : false),
  );
}
function ensure() {
  if (shared) return;
  wire((preferService && ServiceNode.available()) ? new ServiceNode({ appId: clientAppId, counters, diag }) : makeReal());
}

// Refresh live node health (peers/mesh) — on the ServiceNode path this pulls the
// shared node's metrics over AIDL. Call from a debug/status poll; no-op on RealNode
// (its counters update on receive). Lets a Debug panel show real peers/mesh instead of -1.
export function refreshDebug(): Promise<void> {
  const b = backend as any;
  return b && typeof b.refreshPeerInfo === "function" ? b.refreshPeerInfo() : Promise.resolve();
}

export function usingServiceBackend(): boolean { return backend instanceof ServiceNode; }
export function serviceNodeDown(): boolean { return backend instanceof ServiceNode ? backend.isNodeDown() : false; }
export function serviceAwaitingApproval(): boolean { return backend instanceof ServiceNode ? backend.isAwaitingApproval() : false; }
export function launchSharedService(): void { if (backend instanceof ServiceNode) backend.launchService(); }
// Explicit "why isn't the shared node being used" diagnostic — surfaced in-app for debugging.
let lastServiceError = "";
export async function serviceDiag(): Promise<string> {
  const avail = ServiceNode.available();
  const usingSvc = backend instanceof ServiceNode;
  const nodeDiag = usingSvc ? await (backend as ServiceNode).diag() : "backend is embedded (RealNode)";
  return `prefer=${preferService} available=${avail} using=${usingSvc} | ${nodeDiag}${lastServiceError ? " | " + lastServiceError : ""}`;
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
// `opts.cacheLimit > 0` opts this client into offline caching (ADR 0011): when it
// unbinds, the service keeps its subscription and buffers messages instead of
// dropping them. The consent decision (per approved app) lives in the service and
// is passed here. Re-registering an already-known (detached) client REATTACHES —
// it drains the buffer through `onMessage` in order and returns the replay report
// (`dropped > 0` means the cache overflowed, so the client should still reconcile).
export function registerClient(
  appId: string,
  onMessage: (topic: string, candidates: Uint8Array[]) => boolean,
  opts?: { cacheLimit?: number },
): Tenant {
  ensure();
  const existed = shared!.tenants.has(appId);
  const tenant = shared!.registerTenant(appId, opts);
  // Re-bind of a cached, detached client → drain what arrived while it was away
  // (report is on tenant.lastReplay: dropped > 0 means the client should reconcile).
  if (existed && tenant.cacheLimit > 0) tenant.reattach(onMessage as any);
  else tenant.onMessage(onMessage);
  return tenant;
}
// Toggle a client's offline caching live (the shared-delivery consent UI calls this).
// 0 disables; a positive limit enables. Any already-buffered messages still drain.
export function setClientCache(appId: string, cacheLimit: number): void {
  ensure(); const t = shared!.tenants.get(appId); if (t) t.cacheLimit = cacheLimit;
}
// Read a client's cache state for display: its limit + how many are buffered now.
export function clientCacheInfo(appId: string): { cacheLimit: number; buffered: number } {
  ensure(); const t = shared!.tenants.get(appId);
  return t ? { cacheLimit: t.cacheLimit, buffered: t.buffered() } : { cacheLimit: 0, buffered: 0 };
}
export function clientSubscribe(appId: string, topic: string): Promise<void> {
  ensure(); const t = shared!.tenants.get(appId); return t ? t.subscribe(topic) : Promise.resolve();
}
// Client unbound. A caching client DETACHES (keep the subscription + buffer, unless
// `hard`); a non-caching one (or hard opt-out) CLOSES (unsubscribe + drop).
export function unregisterClient(appId: string, opts?: { hard?: boolean }): Promise<void> {
  ensure();
  const t = shared!.tenants.get(appId);
  if (!t) return Promise.resolve();
  if (t.cacheLimit > 0 && !(opts && opts.hard)) { t.detach(); return Promise.resolve(); }
  return t.close();
}

// Bring the node up (or, if up, join new topics), then record topic ownership so the
// broker routes those topics to this app's tenant.
let deviceId = "";   // remembered so the telemetry feature can stamp snapshots without app plumbing
export async function start(opts: { deviceId: string; topics: string[]; onReceive: OnReceive; onStatus?: OnStatus }): Promise<void> {
  onReceiveCb = opts.onReceive;
  deviceId = opts.deviceId;
  ensure();
  backend!.setDeviceId(opts.deviceId);
  try {
    await backend!.start(opts.topics, opts.onStatus);
  } catch (e) {
    // Shared service selected but not bindable (Logos Delivery not installed) → fall back
    // to an embedded node so the app still works standalone.
    if (backend instanceof ServiceNode) {
      lastServiceError = "start fell back: " + String((e as any)?.message || e);
      try { opts.onStatus && opts.onStatus("Shared node unavailable — using own node"); } catch { /* */ }
      wire(makeReal());
      backend!.setDeviceId(opts.deviceId);
      await backend!.start(opts.topics, opts.onStatus);
    } else { throw e; }
  }
  shared!._adopt("app", opts.topics);   // the single tenant owns the initial topics (no reliance on join())
  started = true;                        // lock the backend choice; preferServiceBackend re-wires only pre-start
}

// ---- telemetry (offline-buffered node diagnostics) — a transport FEATURE, see ./telemetry.ts ----
// enableTelemetry(secret) and the node buffers its own stats offline + flushes them to a sealed topic
// when the fleet returns; any UI reads telemetryStatus(). Lazy-loaded so the pure core never pulls in
// expo-*/@noble — call it after start() so the deviceId is known.
let _tele: typeof import("./telemetry") | null = null;
export async function enableTelemetry(secret: string, opts?: { everyMs?: number }): Promise<void> {
  if (!secret) return;
  if (!_tele) _tele = await import("./telemetry");
  _tele.start(secret, { deviceId, everyMs: opts?.everyMs });
}
export function disableTelemetry(): void { try { _tele?.stop(); } catch { /* */ } }
export function flushTelemetry(): Promise<number> { try { return _tele?.flush() ?? Promise.resolve(0); } catch { return Promise.resolve(0); } }
export function telemetryStatus(): { enabled: boolean; topic?: string; buffered?: number; lastFlush?: string; lastError?: string } {
  try { return _tele?.status() ?? { enabled: false }; } catch { return { enabled: false }; }
}

// Publish a sealed payload on a topic (RealNode double-base64s over SDS; ServiceNode forwards to the service).
// When the BLE mesh bearer is armed, ALSO flood the same sealed bytes to nearby peers — the
// event log doesn't care which bearer carried a write, and dedup is by event id.
export async function publishSealed(topic: string, sealed: Uint8Array): Promise<void> {
  ensure();
  // The two bearers are INDEPENDENT (that's the point of MultiBearer). Flood the mesh
  // FIRST and swallow its errors, so a Waku failure can't skip it — otherwise a fully
  // offline phone (backend.send throws: node not settled, or lightpush has no peers)
  // never floods its own writes onto BLE, and only online→offline propagates. The Waku
  // send stays AFTER and still throws on failure, so the caller's requeue-for-Waku logic
  // (retry when back online → the event still reaches the fleet/store) is preserved.
  let meshOk = false;
  if (mesh) { counters.bleTx++; noteTopic(meshTxTopics, topic); try { await mesh.send(makeFrame(topic, sealed)); meshOk = true; } catch { /* mesh is best-effort */ } }
  try {
    await backend!.send(topic, sealed);
  } catch (e) {
    // The Waku send throws when the node isn't fleet-settled ("node-null"), so an online caller
    // re-queues for retry. But over a BLE-only start the mesh ALREADY carried the frame to nearby
    // peers — so swallowing the throw here (only when meshOk) stops the app from queuing a write
    // that DID propagate. Online (no mesh armed) the throw still bubbles up → retry-for-fleet.
    if (!meshOk) throw e;
  }
}

// ---- BLE mesh bearer (ADR 0012) — TRANSPARENT, auto-armed on degrade ----
// A second bearer beside Waku, and deliberately NOT an app feature. The node (this transport;
// ultimately the shared delivery service, ADR 0010) owns the mesh. The app/service registers
// the native radio ONCE via setMeshRadio(); the transport then AUTO-ARMS the mesh when the
// internet path degrades (Waku peers hit 0 / isolated) and duty-cycles it DOWN when the fleet
// is healthy again — apps just call publishSealed()/receive and never toggle anything. A
// "conference" force keeps it on regardless. Received frames funnel into the SAME broker route
// as Waku (the tenant opens the sealed bytes; sync dedups by event id), and sends fan to
// whichever bearers are up — so BLE is invisible below the sync layer, by design.
let mesh: BleMeshBearer | null = null;
// ── mesh routing diagnostics ─────────────────────────────────────────────────
// The BLE-vs-Waku "not treated equally" bug is a topic-match question: a frame only
// delivers if its topic is in the broker's owners map. Record the last few topics we
// FLOOD (tx), and the last few we DELIVER vs DROP on receive, plus the owned set — so a
// glance shows whether the sender's topic matches what the receiver subscribed. Tails only
// (topics are long); newest-first, deduped, capped.
const meshTxTopics: string[] = [];
const meshRxDeliv: string[] = [];
const meshRxDrop: string[] = [];
function topicTail(t: string): string { return t && t.length > 14 ? "…" + t.slice(-14) : t || "(empty)"; }
function noteTopic(ring: string[], t: string): void {
  const tail = topicTail(t);
  const i = ring.indexOf(tail); if (i >= 0) ring.splice(i, 1);
  ring.unshift(tail); while (ring.length > 4) ring.pop();
}
// Snapshot for a Debug panel: what we flood, what we own, what we deliver/drop over BLE.
export function meshRouteDiag(): { tx: string[]; owned: string[]; deliv: string[]; drop: string[] } {
  return {
    tx: [...meshTxTopics],
    owned: (shared ? shared.ownedTopics() : []).map(topicTail),
    deliv: [...meshRxDeliv],
    drop: [...meshRxDrop],
  };
}
let meshRadioFactory: (() => MeshRadio) | null = null;
let meshForced = false;
let meshOpts: { ttl?: number } | undefined;
let meshTimer: ReturnType<typeof setInterval> | null = null;

// Register (or clear) the device's mesh radio capability. Called ONCE at node bring-up by the
// app or the shared-delivery service — not per publish, not per app toggle.
export function setMeshRadio(factory: (() => MeshRadio) | null, opts?: { ttl?: number }): void {
  meshRadioFactory = factory; meshOpts = opts;
  if (factory) {
    if (!meshTimer) meshTimer = setInterval(() => { void evaluateMesh(); }, 15000);
    void evaluateMesh();
  } else {
    if (meshTimer) { clearInterval(meshTimer); meshTimer = null; }
    void disarmMesh();
  }
}
// Conference / "offline mesh" override — the ONE user-facing control (ADR 0012): force the
// mesh on regardless of fleet health. Off = transparent auto-arm-on-degrade.
export function forceMesh(on: boolean): void { meshForced = on; void evaluateMesh(); }
export function meshForcedOn(): boolean { return meshForced; }
export function meshEnabled(): boolean { return mesh !== null; }
export function meshPeers(): number { return mesh ? mesh.reachablePeers() : 0; }

// The auto-arm decision. "Internet path degraded" = not confirmed-connected to the fleet;
// counters.peers is the Waku peer count (refreshed here). NB: peer counts under-report on
// Edge (a 0 is "unknown", never trusted as truth elsewhere) — so this errs toward arming the
// fallback, which is the safe direction; the force override is the reliable path. The real
// trigger will also watch publish failures — TODO once we have on-device signal.
async function evaluateMesh(): Promise<void> {
  if (!meshRadioFactory) return;
  try { if (backend && typeof backend.refreshPeerInfo === "function") await backend.refreshPeerInfo(); } catch { /* */ }
  const degraded = meshForced || counters.peers <= 0;
  if (degraded && !mesh) await armMesh();
  else if (!degraded && mesh && !meshForced) await disarmMesh();
}
async function armMesh(): Promise<void> {
  if (mesh || !meshRadioFactory) return;
  ensure();
  const m = new BleMeshBearer(meshRadioFactory(), meshOpts);
  m.onReceive((f) => {
    counters.rxRaw++; counters.bleRx++;
    const opened = shared ? shared._route(f.topic, [f.payload]) : false;
    if (opened) { counters.rxNew++; counters.bleRxDelivered++; noteTopic(meshRxDeliv, f.topic); }
    else { counters.rxDup++; counters.bleRxDropped++; noteTopic(meshRxDrop, f.topic); }
  });
  try { await m.start(); mesh = m; } catch { /* radio not ready — retry next tick */ }
}
async function disarmMesh(): Promise<void> { const m = mesh; mesh = null; if (m) { try { await m.stop(); } catch { /* */ } } }

// Add topics after the node is up — via the tenant so the broker records ownership and
// subscribes the underlying node exactly once per topic (refcounted).
export async function join(topics: string[]): Promise<void> {
  ensure();
  // Subscribe when the node is Waku-ready OR the BLE mesh is armed. Otherwise, over a BLE-only
  // (fleet-down) start, added topics never get owned by the broker and every incoming mesh frame
  // on them is dropped as "foreign/unowned" (see SharedDeliveryNode._route).
  if (!backend!.isReady() && !mesh) return;
  for (const t of topics) if (!tenant!.topics.has(t)) await tenant!.subscribe(t);
}

export async function stop(): Promise<void> { if (backend) await backend.stop(); }

export function storeSync(onCandidates: (topic: string, candidates: Uint8Array[]) => boolean) {
  ensure(); return backend!.storeSync(onCandidates);
}

export function refreshPeerInfo(): Promise<void> { ensure(); return backend!.refreshPeerInfo(); }
