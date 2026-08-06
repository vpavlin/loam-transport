// KYM's thin adapter over the SHARED logos-transport (mobile/src/lib/logos-transport.ts).
// The transport moves OPAQUE sealed bytes on content topics and is byte-for-byte the
// same wire KYM has always used (it was extracted FROM this file) — so this swap keeps
// KYM's proven sync. This adapter supplies the ONLY app-specific pieces:
//   • ROUTES — one household per budget: { budgetId, Identity, derived topic }
//   • CRYPTO — seal/open with the budget's key (identity.ts), AAD = topic
//   • ENVELOPE dispatch — EVENT → onEvent(budgetId,event), SYNC_REQ → onSyncReq(...)
// If sync ever breaks again, the bug is in logos-transport (shared, fix once) or here
// (routes/crypto/envelope) — never a re-implemented wire path.
import { loadIdentity } from "./identityStore";
import { loadRegistry } from "./budgets";
import { seal, open, topicFor, Identity } from "./identity";
import type { KymEvent } from "./engine";
import { getDeviceId } from "./device";
import { utf8Bytes, utf8Decode } from "./utf8";
import * as transport from "./logos-transport";

/** True if the native module is present in this build at all. */
export function deliveryAvailable(): boolean {
  return transport.deliveryAvailable();
}

// ONE Waku node, N routes — one per budget/household (each its own key + derived
// topic). Incoming messages route to whichever budget's key authenticates them
// (open() throws on the wrong key). Mirrors kym_core: subscribe all topics, route by
// contentTopic → budget. Sends seal with the target budget's key/topic.
interface Route { budgetId: string; id: Identity; topic: string }
let routes: Route[] = [];

// App callbacks, set by startReceiving(); the transport's single listener calls
// adapterReceive() which dispatches through these. Set independently of node bring-up,
// so startReceiving() and ensureNode() may be called in either order.
let onEventCb: ((budgetId: string, event: KymEvent) => void) | null = null;
let onSyncReqCb: ((budgetId: string, from: string) => void) | null = null;

/** Error thrown when a sync is attempted before pairing. Surfaced to the user. */
export const NOT_PAIRED = "NOT_PAIRED: pair this device with your household first";

// Build a route per budget that HAS a household secret (paired or self-hosted).
async function buildRoutes(): Promise<Route[]> {
  const reg = await loadRegistry();
  const out: Route[] = [];
  for (const b of reg.budgets) {
    const id = await loadIdentity(b.id);
    if (id) out.push({ budgetId: b.id, id, topic: topicFor(id) });
  }
  return out;
}

// Transport hands us the candidate sealed-byte arrays for a content topic; open one
// with the matching budget's key and dispatch. Return true iff a candidate opened
// (so the transport tallies rxOpened vs rxOpenFail). open() is authenticated, so only
// the right key/candidate wins — trying the topic's own route first, then all as a
// defensive fallback, matches the old route-by-decryption behaviour.
function adapterReceive(topic: string, candidates: Uint8Array[]): boolean {
  const primary = routes.find((x) => x.topic === topic);
  const tryRoutes = primary ? [primary, ...routes.filter((r) => r !== primary)] : routes;
  for (const cand of candidates) {
    for (const r of tryRoutes) {
      let plaintext: Uint8Array;
      try { plaintext = open(r.id, cand, r.topic); } catch { continue; } // wrong key/candidate
      try {
        const env = JSON.parse(utf8Decode(plaintext));
        if (env && env.type === "EVENT" && env.event) {
          onEventCb?.(r.budgetId, env.event as KymEvent);
        } else if (env && env.type === "SYNC_REQ") {
          onSyncReqCb?.(r.budgetId, typeof env.from === "string" ? env.from : "");
        }
      } catch { /* opened but not a valid envelope */ }
      return true;
    }
  }
  return false;
}

/**
 * Bring the node up once (idempotent): build routes (must be paired) → start the
 * shared transport on every budget's topic. Concurrent callers share the transport's
 * in-flight startup. Rejects with NOT_PAIRED if unpaired. Returns the node ctx.
 */
export async function ensureNode(onStatus?: (s: string) => void): Promise<string> {
  if (!transport.deliveryAvailable()) throw new Error("Logos Delivery native module not present in this build");
  if (transport.getCtx()) return transport.getCtx(); // already up
  routes = await buildRoutes();
  if (routes.length === 0) throw new Error(NOT_PAIRED);
  const deviceId = await getDeviceId();
  await transport.start({
    deviceId,
    topics: routes.map((r) => r.topic),
    onStatus,
    onReceive: adapterReceive,
  });
  return transport.getCtx();
}

/**
 * Publish one KYM event on the budget's household topic. Wire envelope
 * {v:1,type:"EVENT",event} is sealed (ChaCha20-Poly1305, AAD=topic) with the
 * household key; the transport does the double-base64 channel framing. No key for
 * this budget on this device → nothing to send.
 */
export async function sendEnvelope(event: KymEvent, budgetId: string): Promise<void> {
  await ensureNode();
  const r = routes.find((x) => x.budgetId === budgetId);
  if (!r) return;
  const envelope = { v: 1, type: "EVENT", event };
  const sealed = seal(r.id, utf8Bytes(JSON.stringify(envelope)), r.topic);
  await transport.publishSealed(r.topic, sealed);
}

/**
 * Re-derive routes and join any newly-added budget's topic on the live node (after
 * creating or pairing a budget) — no full restart. No-op if the node isn't up yet
 * (ensureNode builds fresh routes when it starts).
 */
export async function refreshRoutes(): Promise<void> {
  if (!transport.getCtx()) return;
  routes = await buildRoutes();
  await transport.join(routes.map((r) => r.topic));
}

/**
 * Ask each household to re-serve everything we're missing (pull half of sync).
 * Envelope {v:1,type:"SYNC_REQ",from:<deviceId>} sealed per budget. Peers re-send
 * their whole log; ingest dedups by event id, so asking repeatedly is harmless.
 */
export async function sendSyncReq(deviceId: string): Promise<void> {
  await ensureNode();
  for (const r of routes) {
    const envelope = { v: 1, type: "SYNC_REQ", from: deviceId };
    const sealed = seal(r.id, utf8Bytes(JSON.stringify(envelope)), r.topic);
    await transport.publishSealed(r.topic, sealed).catch(() => {});
  }
}

/**
 * Register the receive callbacks. The shared transport owns the single native
 * listener (attached in ensureNode); this just wires our dispatch into it. Returns an
 * unsubscribe that detaches the callbacks. Safe to call before or after ensureNode.
 */
export function startReceiving(
  onEvent: (budgetId: string, event: KymEvent) => void,
  onSyncReq?: (budgetId: string, from: string) => void
): () => void {
  if (!transport.deliveryAvailable()) return () => {};
  onEventCb = onEvent;
  onSyncReqCb = onSyncReq || null;
  return () => { onEventCb = null; onSyncReqCb = null; };
}

/**
 * PULL history from the fleet store — the reliable catch-up path. Delegates paging to
 * the transport; for each stored message's candidates we open with the topic's budget
 * key and fold EVENT envelopes (dedup by id, so re-pulling is harmless).
 */
export async function storeSync(
  onEvent: (budgetId: string, event: KymEvent) => void
): Promise<{ msgs: number; events: number; detail: string }> {
  await ensureNode();
  return transport.storeSync((topic, candidates) => {
    const primary = routes.find((x) => x.topic === topic);
    const tryRoutes = primary ? [primary] : routes;
    for (const cand of candidates) {
      for (const r of tryRoutes) {
        try {
          const env = JSON.parse(utf8Decode(open(r.id, cand, r.topic)));
          if (env && env.type === "EVENT" && env.event) { onEvent(r.budgetId, env.event as KymEvent); return true; }
        } catch { /* wrong candidate/key — try next */ }
      }
    }
    return false;
  });
}

// Receive diagnostics for the Sync card. Mapped from the transport's counters so the
// shape KYM's UI expects (seen/opened/sent/raw/sample) is unchanged.
export function getRx(): { seen: number; opened: number; sent: number; raw: number; sample: string } {
  const c = transport.counters;
  return { seen: c.rxSeen, opened: c.rxOpened, sent: c.txTotal, raw: c.rxRaw, sample: transport.getRxSample() };
}

/** Last store-query outcome (msg/event counts per topic), for the Sync card. */
export function getStoreInfo(): string { return transport.getStoreInfo(); }

/**
 * Live connectivity from the node's Prometheus metrics: peer count + gossipsub-mesh
 * peers. Shard is derived from our topic (autoshard) to match the desktop's rs/2/N.
 * Returns null when unavailable (older bridge / node down) so callers can hide it.
 */
export async function getPeerCount(): Promise<{ peers: number; mesh: number; shard: string } | null> {
  if (!transport.getCtx()) return null;
  await transport.refreshPeerInfo();
  const c = transport.counters;
  if (c.peers < 0) return null;
  const shard = routes.length ? `2/${transport.shardFor(routes[0].topic)}` : "?";
  return { peers: c.peers, mesh: c.mesh, shard };
}

/** Stop the node (best-effort). */
export async function stopNode(): Promise<void> {
  routes = [];
  await transport.stop();
}
