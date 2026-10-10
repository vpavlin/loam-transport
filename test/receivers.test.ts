import assert from "node:assert";
import { Receivers } from "../src/receivers.ts";

const rx = new Receivers();
const got: string[] = [];
const scala = (t: string) => { if (!t.startsWith("/scala/")) return false; got.push("scala " + t); return true; };
const kith = (t: string) => { if (!t.startsWith("/kith/")) return false; got.push("kith " + t); return true; };
rx.add(scala); rx.add(kith); rx.add(scala);
assert.equal(rx.size, 2, "the same handler is added once");
assert.equal(rx.dispatch("/scala/1/a/json", []), true);
assert.equal(rx.dispatch("/kith/1/b/json", []), true);
assert.equal(rx.dispatch("/qaku/1/c/json", []), false, "nobody owns it");
assert.deepEqual(got, ["scala /scala/1/a/json", "kith /kith/1/b/json"]);

const r2 = new Receivers();
r2.add(() => { throw new Error("boom"); }); r2.add(kith);
assert.equal(r2.dispatch("/kith/1/x/json", []), true, "a throwing receiver doesn't block the next");
console.log("receivers: ok");
