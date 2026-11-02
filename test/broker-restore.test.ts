import assert from "node:assert";
import { SharedDeliveryNode } from "../src/broker.ts";

// Loam 0.0.66: an approved app restored at Loam start (no live callback) caches its topics; when it
// connects it gets what arrived meanwhile; unsubscribe stops routing and drops what's buffered for it.
let router: (t: string, p: any) => boolean = () => false;
const subs = new Set<string>();
const node = {
  async start() {}, async subscribe(t: string) { subs.add(t); }, async unsubscribe(t: string) { subs.delete(t); },
  onReceive(r: any) { router = r; }, isReady() { return true; },
};
const push = (t: string, p: any) => router(t, p);
const b = new SharedDeliveryNode(node as any);

// restored: tenant without a callback, topics joined
const bp = b.registerTenant("backpack", { cacheLimit: 10 });
await bp.subscribe("/backpack/1/A/json");
await bp.subscribe("/backpack/1/B/json");
assert.ok(subs.has("/backpack/1/A/json") && subs.has("/backpack/1/B/json"), "topics joined without the app connected");
push("/backpack/1/A/json", "pA6");
push("/backpack/1/B/json", "pB60");
assert.equal(bp.buffered(), 2, "cached while the app is away");

// the app connects: drained in order
const got: any[] = [];
const r = bp.reattach((_t, p) => { got.push(p); return true; });
assert.deepEqual(got, ["pA6", "pB60"]);
assert.deepEqual(r, { delivered: 2, dropped: 0 });

// unsubscribe: buffered messages for that topic go, routing stops, node leaves the topic
bp.detach();
push("/backpack/1/A/json", "pA7");
push("/backpack/1/B/json", "pB61");
await bp.unsubscribe("/backpack/1/A/json");
assert.ok(!subs.has("/backpack/1/A/json"), "node left the topic");
assert.equal(push("/backpack/1/A/json", "pA8"), false, "no owner any more");
const got2: any[] = [];
bp.reattach((_t, p) => { got2.push(p); return true; });
assert.deepEqual(got2, ["pB61"], "only the still-wanted topic's message is delivered");

// a topic two apps share stays joined until both leave
const other = b.registerTenant("other", { cacheLimit: 10 });
await other.subscribe("/backpack/1/B/json");
await bp.unsubscribe("/backpack/1/B/json");
assert.ok(subs.has("/backpack/1/B/json"), "still owned by the other app");
await other.unsubscribe("/backpack/1/B/json");
assert.ok(!subs.has("/backpack/1/B/json"));
console.log("broker-restore: ok");
