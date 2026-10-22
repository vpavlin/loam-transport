// rx-meta: the network timestamp + source travel with every message — node → broker → tenant (live
// and offline-cache replay) → receivers → the app's onReceive — and a receiver without the argument
// keeps working.  node --experimental-strip-types test/rx-meta.test.ts
import assert from "node:assert";
import { SharedDeliveryNode, rxMeta, NO_META, type RxMeta } from "../src/broker.ts";
import { Receivers } from "../src/receivers.ts";

let router: (t: string, p: any, m?: RxMeta) => boolean = () => false;
const node = { async start() {}, async subscribe() {}, async unsubscribe() {}, onReceive(r: any) { router = r; }, isReady() { return true; } };
const b = new SharedDeliveryNode(node as any);

// rxMeta normalises: ns number / numeric string / junk → 0
assert.deepEqual(rxMeta(1729600000123456789, "live", "delivery").tsMs, 1729600000123);
assert.equal(rxMeta("1729600000123456789", "history", "delivery").ts > 0, true);
assert.equal(rxMeta(undefined, undefined, "ble").ts, 0);
assert.equal(rxMeta(-5, "live", "x").ts, 0);

const got: RxMeta[] = [];
const recv = new Receivers();
recv.add((_t, _c, m) => { got.push(m ?? NO_META); return true; });
const legacy: string[] = [];
recv.add((t) => { legacy.push(t); return false; });   // an old receiver ignoring meta still runs
const t = b.registerTenant("app").onMessage((topic, c, m) => recv.dispatch(topic, c, m));
await t.subscribe("/a/1/x/json");

router("/a/1/x/json", [new Uint8Array([1])], rxMeta(1000, "live", "delivery"));
assert.equal(got[0].ts, 1000); assert.equal(got[0].source, "live");
router("/a/1/x/json", [new Uint8Array([1])]);          // a backend without meta
assert.equal(got[1].ts, 0);

// offline cache keeps meta through detach → reattach
t.cacheLimit = 10; t.detach();
router("/a/1/x/json", [new Uint8Array([2])], rxMeta(2000, "history", "delivery"));
const seen: RxMeta[] = [];
t.reattach((_topic, _c, m) => { seen.push(m); return true; });
assert.equal(seen[0].ts, 2000); assert.equal(seen[0].source, "history");

const r2 = new Receivers(); const plain: number[] = [];
r2.add((_t, c) => { plain.push(c.length); return true; });     // two-argument receiver type-checks + runs
assert.equal(r2.dispatch("/t", [new Uint8Array(1)], rxMeta(5, "", "ble")), true);
console.log("rx-meta: ok");
