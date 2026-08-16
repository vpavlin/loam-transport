// Two-phone BLE routing reproduction — NO phone, NO radio. Drives the REAL SharedDeliveryNode
// broker + BleMeshBearer + frame codec through the exact wiring App.tsx/service-bridge use on a
// device, to answer: when phone A floods a sealed write over BLE, does phone B's approved client
// tenant actually receive it? Replicates verbatim:
//   - armMesh receive:            broker._route(f.topic, [f.payload])     (logos-transport.ts:326)
//   - service-bridge activate cb: (topic, cands) => { deliver; return true } (service-bridge.ts)
//   - clientSubscribe:            broker.tenants.get(ck).subscribe(topic)  (logos-transport.ts:215)
//   - the Loam "app" tenant:      onMessage(() => false)                   (probe, App.tsx start)
import assert from "node:assert";
import test from "node:test";
import type { MeshRadio, Frame } from "../src/bearer.ts";
import { BleMeshBearer, makeFrame } from "../src/bearer.ts";
import { SharedDeliveryNode } from "../src/broker.ts";

// ── in-memory radio link between two phones (deterministic, synchronous) ──────
class LinkedRadio implements MeshRadio {
  running = false;
  peer: LinkedRadio | null = null;
  id: string;
  private cb: (peer: string, bytes: Uint8Array) => void = () => {};
  constructor(id: string) { this.id = id; }
  async start() { this.running = true; }
  async stop() { this.running = false; }
  peers(): string[] { return this.peer && this.peer.running ? [this.peer.id] : []; }
  sendTo(_peerId: string, bytes: Uint8Array) { if (this.peer && this.peer.running) this.peer._recv(this.id, bytes); }
  onReceiveFrom(cb: (peer: string, bytes: Uint8Array) => void) { this.cb = cb; }
  _recv(from: string, bytes: Uint8Array) { this.cb(from, bytes); }
}

// A stub Waku node — the broker needs one, but BLE-only tests never drive it.
function stubNode() {
  const subs: string[] = [];
  return {
    subs,
    start: async () => {},
    subscribe: async (t: string) => { subs.push(t); },
    unsubscribe: async () => {},
    onReceive: (_r: (t: string, p: any) => boolean) => {},
    isReady: () => true,
  };
}

// Build one "phone": broker + armed mesh, wired exactly like the device.
function makePhone(id: string) {
  const node = stubNode();
  const broker = new SharedDeliveryNode(node as any);
  const radio = new LinkedRadio(id);
  const mesh = new BleMeshBearer(radio);
  // armMesh receive (logos-transport.ts:326) — funnel BLE frames into the SAME broker route:
  mesh.onReceive((f: Frame) => { broker._route(f.topic, [f.payload]); });
  return { node, broker, radio, mesh };
}

// The service-bridge's activate() cb (verbatim shape): a blind pipe that records what the
// client WOULD receive over AIDL, and always returns true.
function registerClient(broker: SharedDeliveryNode, appId: string) {
  const inbox: { topic: string; cands: Uint8Array[] }[] = [];
  broker.registerTenant(appId).onMessage((topic: string, cands: any) => {
    inbox.push({ topic, cands }); return true;
  });
  return inbox;
}

const seal = (s: string) => new TextEncoder().encode(s);

test("BLE: A floods a topic B's client subscribed → B's client receives it", async () => {
  const A = makePhone("A"), B = makePhone("B");
  A.radio.peer = B.radio; B.radio.peer = A.radio;
  await A.mesh.start(); await B.mesh.start();

  const T = "/waku/2/rs/2/7/kym-room-xyz/proto";
  // B's Loam owns a probe topic (returns false), and qaku is approved + subscribed to T.
  B.broker.registerTenant("app").onMessage(() => false);
  B.broker._adopt("app", ["/logos-delivery/1/probe/proto"]);
  const qakuB = registerClient(B.broker, "qaku");
  await B.broker.tenants.get("qaku")!.subscribe(T);   // clientSubscribe

  // A floods a sealed write on T (publishSealed's mesh path).
  await A.mesh.send(makeFrame(T, seal("hello-over-ble")));

  assert.equal(qakuB.length, 1, "qaku on B should have received exactly one frame");
  assert.equal(qakuB[0].topic, T);
  assert.equal(new TextDecoder().decode(qakuB[0].cands[0]), "hello-over-ble");
});

test("MISMATCH: A floods topic T1 but B's client subscribed T2 → dropped (unowned)", async () => {
  const A = makePhone("A"), B = makePhone("B");
  A.radio.peer = B.radio; B.radio.peer = A.radio;
  await A.mesh.start(); await B.mesh.start();

  const qakuB = registerClient(B.broker, "qaku");
  await B.broker.tenants.get("qaku")!.subscribe("/topic/SUBSCRIBED/proto");
  await A.mesh.send(makeFrame("/topic/SENT-ON/proto", seal("x")));

  assert.equal(qakuB.length, 0, "a topic mismatch drops the frame as unowned — this is the suspected bug");
});

test("ORDERING: frame arrives BEFORE the client subscribes → dropped (no retro-delivery)", async () => {
  const A = makePhone("A"), B = makePhone("B");
  A.radio.peer = B.radio; B.radio.peer = A.radio;
  await A.mesh.start(); await B.mesh.start();

  const T = "/topic/room/proto";
  const qakuB = registerClient(B.broker, "qaku");
  // frame arrives while B has NOT yet subscribed T
  await A.mesh.send(makeFrame(T, seal("early")));
  assert.equal(qakuB.length, 0, "arrives before subscribe → dropped");

  // now subscribe and re-send: SeenSet on A won't re-flood the same id, so use a new payload
  await B.broker.tenants.get("qaku")!.subscribe(T);
  await A.mesh.send(makeFrame(T, seal("after-subscribe")));
  assert.equal(qakuB.length, 1, "after subscribe → delivered");
});

test("PROBE does not block clients: probe frame (app→false) + client frame both handled right", async () => {
  const A = makePhone("A"), B = makePhone("B");
  A.radio.peer = B.radio; B.radio.peer = A.radio;
  await A.mesh.start(); await B.mesh.start();

  const PROBE = "/logos-delivery/1/probe/proto", T = "/topic/room/proto";
  B.broker.registerTenant("app").onMessage(() => false);
  B.broker._adopt("app", [PROBE]);
  const qakuB = registerClient(B.broker, "qaku");
  await B.broker.tenants.get("qaku")!.subscribe(T);

  await A.mesh.send(makeFrame(PROBE, seal("probe")));   // owned by app → returns false → "dropped"
  await A.mesh.send(makeFrame(T, seal("real")));         // owned by qaku → delivered
  assert.equal(qakuB.length, 1);
  assert.equal(new TextDecoder().decode(qakuB[0].cands[0]), "real");
});
