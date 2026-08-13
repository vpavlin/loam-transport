import assert from "node:assert";
import { SharedDeliveryNode } from "/home/vpavlin/logos-transport/src/broker.ts";

// mock node: records subscriptions; lets the test push messages into the router.
let router: (t: string, p: any) => boolean = () => false;
const subs = new Set<string>();
const node = {
  async start() {}, async subscribe(t){ subs.add(t); }, async unsubscribe(t){ subs.delete(t); },
  onReceive(r){ router = r; }, isReady(){ return true; },
};
const push = (t: string, p: any) => router(t, p);

const b = new SharedDeliveryNode(node);

// 1) live delivery
const rx: any[] = [];
const t = b.registerTenant("scala", { cacheLimit: 3 });
await t.subscribe("/scala/1/cal/json");
t.onMessage((topic, p) => { rx.push(p); return true; });
push("/scala/1/cal/json", "live1");
assert.deepEqual(rx, ["live1"]);

// 2) detach → messages buffer (subscription STAYS, so routing still hits us)
t.detach();
assert.ok(subs.has("/scala/1/cal/json"), "subscription kept while detached");
push("/scala/1/cal/json", "bg1");
push("/scala/1/cal/json", "bg2");
assert.deepEqual(rx, ["live1"], "nothing delivered live while detached");

// 3) reattach → drains in order, dropped=0 (fit in the cache)
const got: any[] = [];
const r1 = t.reattach((topic, p) => { got.push(p); return true; });
assert.deepEqual(got, ["bg1", "bg2"]);
assert.deepEqual(r1, { delivered: 2, dropped: 0 });

// 4) overflow → oldest evicted, dropped reported (→ app must reconcile)
t.detach();
for (const m of ["a","b","c","d","e"]) push("/scala/1/cal/json", m); // limit 3
const got2: any[] = [];
const r2 = t.reattach((topic, p) => { got2.push(p); return true; });
assert.deepEqual(got2, ["c","d","e"], "kept the newest 3");
assert.deepEqual(r2, { delivered: 3, dropped: 2 });

// 5) a non-caching tenant still drops on detach (default behaviour unchanged)
const t2 = b.registerTenant("plain"); // no cacheLimit
await t2.subscribe("/plain/x");
t2.onMessage(() => true);
t2.detach();
push("/plain/x", "z");
const g: any[] = [];
assert.deepEqual(t2.reattach((topic,p)=>{g.push(p);return true;}), { delivered: 0, dropped: 0 });

console.log("broker offline-cache: ALL PASS");
