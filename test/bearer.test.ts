// Portable BLE-mesh bearer tests (ADR 0012) — no phone, no radio. MockRadio is an in-memory
// link layer wired into an arbitrary graph; the REAL gossip logic (BleMeshBearer) runs over
// it unchanged. Proves: multi-hop flood delivery, loop/dedup kill on cycles, hop-TTL bounds,
// content-hash frame id stability, and MultiBearer fan-out + deduped funnel.
import assert from "node:assert";
import test from "node:test";
import type { Bearer, Frame, MeshRadio } from "../src/bearer.ts";
import { BleMeshBearer, MultiBearer, makeFrame, frameId, encodeFrame, decodeFrame } from "../src/bearer.ts";

// ── in-memory mesh: radios in a graph, synchronous deterministic delivery ────
type Edge = string;
const ekey = (a: string, b: string) => (a < b ? a + "|" + b : b + "|" + a);
class MockMesh {
  radios = new Map<string, MockRadio>();
  edges = new Set<Edge>();
  connect(a: string, b: string) { this.edges.add(ekey(a, b)); }
  neighbours(id: string): string[] {
    const out: string[] = [];
    for (const [oid, r] of this.radios) if (oid !== id && r.running && this.edges.has(ekey(id, oid))) out.push(oid);
    return out;
  }
  deliver(from: string, to: string, bytes: Uint8Array) {
    const r = this.radios.get(to);
    if (r && r.running && this.edges.has(ekey(from, to))) r._recv(from, bytes);
  }
}
class MockRadio implements MeshRadio {
  running = false;
  private cb: (peer: string, bytes: Uint8Array) => void = () => {};
  mesh: MockMesh;
  id: string;
  constructor(mesh: MockMesh, id: string) { this.mesh = mesh; this.id = id; mesh.radios.set(id, this); }
  async start() { this.running = true; }
  async stop() { this.running = false; }
  peers() { return this.mesh.neighbours(this.id); }
  sendTo(peer: string, bytes: Uint8Array) { if (this.running) this.mesh.deliver(this.id, peer, bytes); }
  onReceiveFrom(cb: (peer: string, bytes: Uint8Array) => void) { this.cb = cb; }
  _recv(from: string, bytes: Uint8Array) { this.cb(from, bytes); }
}

// A node = a BleMeshBearer over one radio, collecting the frames it delivers locally.
async function node(mesh: MockMesh, id: string, ttl = 6) {
  const radio = new MockRadio(mesh, id);
  const bearer = new BleMeshBearer(radio, { ttl });
  const rx: Frame[] = [];
  bearer.onReceive((f) => rx.push(f));
  await bearer.start();
  return { id, bearer, rx, ids: () => rx.map((f) => f.id) };
}

const P = (s: string) => new TextEncoder().encode(s);

test("multi-hop flood: a line A-B-C-D delivers to everyone once", async () => {
  const m = new MockMesh();
  const a = await node(m, "A"), b = await node(m, "B"), c = await node(m, "C"), d = await node(m, "D");
  m.connect("A", "B"); m.connect("B", "C"); m.connect("C", "D");
  await a.bearer.send(makeFrame("/x/1/e/proto", P("hello")));
  for (const n of [b, c, d]) assert.equal(n.rx.length, 1, `${n.id} got exactly one`);
  assert.equal(a.rx.length, 0, "originator does not deliver its own send back up");
  assert.equal(new TextDecoder().decode(d.rx[0].payload), "hello", "payload intact 3 hops away");
});

test("cycle A-B-C-A: no loops, each peer delivers once", async () => {
  const m = new MockMesh();
  const a = await node(m, "A"), b = await node(m, "B"), c = await node(m, "C");
  m.connect("A", "B"); m.connect("B", "C"); m.connect("C", "A");
  await a.bearer.send(makeFrame("/x/1/e/proto", P("loop")));
  assert.equal(b.rx.length, 1, "B once despite the cycle");
  assert.equal(c.rx.length, 1, "C once despite the cycle");
});

test("hop TTL bounds propagation", async () => {
  const m = new MockMesh();
  const ns = [];
  for (const id of ["A", "B", "C", "D", "E"]) ns.push(await node(m, id, /*ttl*/ 2));
  m.connect("A", "B"); m.connect("B", "C"); m.connect("C", "D"); m.connect("D", "E");
  // ttl=2: A floods hop=2 → B delivers+forwards hop=1 → C delivers (hop=1, not forwarded). D/E never see it.
  await ns[0].bearer.send(makeFrame("/x/1/e/proto", P("ttl")));
  assert.equal(ns[1].rx.length, 1, "B (1 hop) sees it");
  assert.equal(ns[2].rx.length, 1, "C (2 hops) sees it");
  assert.equal(ns[3].rx.length, 0, "D (3 hops) does NOT — TTL exhausted");
  assert.equal(ns[4].rx.length, 0, "E (4 hops) does NOT");
});

test("star hub relays between leaves", async () => {
  const m = new MockMesh();
  const hub = await node(m, "H"), l1 = await node(m, "L1"), l2 = await node(m, "L2"), l3 = await node(m, "L3");
  for (const l of ["L1", "L2", "L3"]) m.connect("H", l);
  await l1.bearer.send(makeFrame("/x/1/e/proto", P("via-hub")));
  assert.equal(hub.rx.length, 1, "hub receives");
  assert.equal(l2.rx.length, 1, "L2 gets it relayed through the hub");
  assert.equal(l3.rx.length, 1, "L3 too");
});

test("frame id is a stable content hash (dedup key across bearers)", () => {
  const a = makeFrame("/x/1/e/proto", P("same"));
  const b = makeFrame("/x/1/e/proto", P("same"));
  assert.equal(a.id, b.id, "same topic+payload → same id");
  assert.notEqual(a.id, makeFrame("/x/1/e/proto", P("diff")).id, "different payload → different id");
  assert.notEqual(a.id, makeFrame("/y/1/e/proto", P("same")).id, "different topic → different id");
  // id independent of hop
  assert.equal(frameId(a.topic, a.payload), makeFrame(a.topic, a.payload, 99).id);
});

test("wire encode/decode round-trips and preserves hop", () => {
  const f = makeFrame("/scala/1/cal/proto", P("café ☕ sealed"), 4);
  const g = decodeFrame(encodeFrame(f))!;
  assert.equal(g.topic, f.topic);
  assert.equal(g.hop, 4);
  assert.equal(g.id, f.id);
  assert.deepEqual(Array.from(g.payload), Array.from(f.payload));
});

// A Bearer test-double: records what was sent; inject() simulates an inbound frame.
class CaptureBearer implements Bearer {
  sent: Frame[] = [];
  private cb: (f: Frame) => void = () => {};
  name: string;
  constructor(name: string) { this.name = name; }
  async start() {} async stop() {}
  reachablePeers() { return 1; }
  onReceive(cb: (f: Frame) => void) { this.cb = cb; }
  async send(f: Frame) { this.sent.push(f); }
  inject(f: Frame) { this.cb(f); }
}

test("MultiBearer fans out to every bearer", async () => {
  const waku = new CaptureBearer("waku"), ble = new CaptureBearer("ble");
  const multi = new MultiBearer().add(waku).add(ble);
  const f = makeFrame("/x/1/e/proto", P("out"));
  await multi.send(f);
  assert.equal(waku.sent.length, 1, "waku got it");
  assert.equal(ble.sent.length, 1, "ble got it");
  assert.equal(waku.sent[0].id, f.id);
});

test("MultiBearer funnels once even when the same frame arrives on two bearers", async () => {
  const waku = new CaptureBearer("waku"), ble = new CaptureBearer("ble");
  const multi = new MultiBearer().add(waku).add(ble);
  const up: Frame[] = [];
  multi.onReceive((f) => up.push(f));
  const f = makeFrame("/x/1/e/proto", P("dup"));
  waku.inject(f); // arrives over Waku
  ble.inject(f);  // and the SAME message floods in over BLE
  assert.equal(up.length, 1, "delivered up exactly once (deduped by content id)");
  // a genuinely different message still gets through
  ble.inject(makeFrame("/x/1/e/proto", P("other")));
  assert.equal(up.length, 2);
});

test("MultiBearer does not re-funnel a frame it originated (echo suppression)", async () => {
  const ble = new CaptureBearer("ble");
  const multi = new MultiBearer().add(ble);
  const up: Frame[] = [];
  multi.onReceive((f) => up.push(f));
  const f = makeFrame("/x/1/e/proto", P("mine"));
  await multi.send(f);       // we originate it
  ble.inject(f);             // a neighbour floods it back to us
  assert.equal(up.length, 0, "our own origination isn't delivered back up");
});
