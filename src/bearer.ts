// bearer — the multi-bearer seam (ADR 0012). Everything above this is bearer-agnostic:
// the broker publishes a sealed Frame and receives sealed Frames, not caring which pipe
// carried them. A `Bearer` is one pipe (Waku, or a BLE mesh); a `MultiBearer` fans an
// outgoing frame to every active bearer and funnels every incoming frame from any bearer
// into ONE receive stream, deduped. Because loam-sync converges by event id and this layer
// dedups by a content-hash frame id, a message that arrives over BLE and the same message
// over Waku collapse to one — BLE needs no ordering/reliability of its own.
//
// This file is PORTABLE and phone-free: the BLE mesh gossip (seen-set, hop-TTL, forward)
// runs over an abstract `MeshRadio`. Native BLE implements MeshRadio on the device; tests
// implement it with an in-memory mesh (MockRadio) — no hardware, same logic.
import { sha256 as sha256hash } from "@noble/hashes/sha2";

// ── Frame: a sealed sync frame as it travels a bearer ────────────────────────
// `id` is a CONTENT hash (topic ‖ payload) so it is stable across bearers → the same
// message over Waku and BLE dedups without any shared id generator. `hop` is the
// remaining flood TTL (decremented on each forward); it is NOT part of the id.
export interface Frame {
  id: string;
  topic: string;
  hop: number;
  payload: Uint8Array; // opaque sealed bytes — this layer never inspects them
}

export interface Bearer {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(frame: Frame): Promise<void>;
  onReceive(cb: (frame: Frame) => void): void;
  reachablePeers(): number;
}

// The abstract radio the BLE bearer drives. Native BLE (central+peripheral GATT with
// fragmentation) implements this on the device; MockRadio implements it in tests. The
// radio is a DUMB link layer: deliver these bytes to that connected peer, tell me what
// arrived, tell me who's connected. All mesh intelligence lives in BleMeshBearer.
export interface MeshRadio {
  start(): Promise<void>;
  stop(): Promise<void>;
  peers(): string[]; // ids of currently-connected neighbours
  sendTo(peerId: string, bytes: Uint8Array): void; // radio handles MTU fragmentation
  onReceiveFrom(cb: (peerId: string, bytes: Uint8Array) => void): void;
}

const HEX = "0123456789abcdef";
function hex(b: Uint8Array): string { let s = ""; for (const x of b) s += HEX[x >> 4] + HEX[x & 15]; return s; }
function utf8(s: string): Uint8Array { const o: number[] = []; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 0x80) o.push(c); else if (c < 0x800) o.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); else o.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); } return Uint8Array.from(o); }
function fromUtf8(b: Uint8Array): string { let s = "", i = 0; while (i < b.length) { const c = b[i++]; if (c < 0x80) s += String.fromCharCode(c); else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f)); else s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f)); } return s; }

// Content-hash frame id — stable across bearers and independent of hop, so dedup works
// whether a frame arrives via Waku or is flooded over BLE.
export function frameId(topic: string, payload: Uint8Array): string {
  const t = utf8(topic);
  const buf = new Uint8Array(t.length + 1 + payload.length);
  buf.set(t, 0); buf[t.length] = 0x00; buf.set(payload, t.length + 1);
  return hex(sha256hash(buf).slice(0, 16));
}
export function makeFrame(topic: string, payload: Uint8Array, hop = 6): Frame {
  return { id: frameId(topic, payload), topic, hop, payload };
}

// ── wire encoding for the BLE bearer ─────────────────────────────────────────
// [ ver(1) | hop(1) | topicLen(2 BE) | topic utf8 | payload… ]. The id is NOT on the
// wire — it's recomputed from (topic‖payload) on receive, so a tampered/duplicated frame
// can't forge a different id, and hop (which changes on forward) never affects it.
const WIRE_VER = 1;
export function encodeFrame(f: Frame): Uint8Array {
  const t = utf8(f.topic);
  const out = new Uint8Array(4 + t.length + f.payload.length);
  out[0] = WIRE_VER;
  out[1] = f.hop & 0xff;
  out[2] = (t.length >> 8) & 0xff; out[3] = t.length & 0xff;
  out.set(t, 4); out.set(f.payload, 4 + t.length);
  return out;
}
export function decodeFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length < 4 || bytes[0] !== WIRE_VER) return null;
  const hop = bytes[1];
  const tlen = (bytes[2] << 8) | bytes[3];
  if (bytes.length < 4 + tlen) return null;
  const topic = fromUtf8(bytes.subarray(4, 4 + tlen));
  const payload = bytes.subarray(4 + tlen);
  return { id: frameId(topic, payload), topic, hop, payload };
}

// A bounded set of recently-seen frame ids (loop/flood kill + cross-bearer dedup). Insertion
// -ordered; evicts the oldest past `cap` so memory stays bounded on a long-lived mesh.
export class SeenSet {
  private ids = new Set<string>();
  private order: string[] = [];
  private cap: number;
  constructor(cap = 4096) { this.cap = cap; }
  has(id: string): boolean { return this.ids.has(id); }
  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id); this.order.push(id);
    if (this.order.length > this.cap) { const old = this.order.shift()!; this.ids.delete(old); }
  }
}

// ── BLE mesh bearer: flood-gossip over a MeshRadio ───────────────────────────
// Send = flood a frame to all neighbours. Receive = deliver locally ONCE (funnel up),
// then store-carry-forward to the OTHER neighbours with hop-1, until hop runs out or the
// seen-set kills it. Deliberately dumb — convergence is loam-sync's job, not the mesh's.
export class BleMeshBearer implements Bearer {
  readonly name = "ble";
  private seen: SeenSet;
  private rxCb: (f: Frame) => void = () => {};
  private radio: MeshRadio;
  private opts: { ttl?: number; seenCap?: number };
  constructor(radio: MeshRadio, opts: { ttl?: number; seenCap?: number } = {}) {
    this.radio = radio;
    this.opts = opts;
    this.seen = new SeenSet(opts.seenCap ?? 4096);
  }
  async start(): Promise<void> {
    this.radio.onReceiveFrom((peer, bytes) => this._onRadio(peer, bytes));
    await this.radio.start();
  }
  async stop(): Promise<void> { await this.radio.stop(); }
  reachablePeers(): number { return this.radio.peers().length; }
  onReceive(cb: (f: Frame) => void): void { this.rxCb = cb; }

  // Originate a local write onto the mesh: flood to every neighbour at full TTL.
  async send(frame: Frame): Promise<void> {
    if (this.seen.has(frame.id)) return; // already originated/seen — don't re-flood
    this.seen.add(frame.id);
    const ttl = this.opts.ttl ?? 6;
    this._broadcastExcept(null, { ...frame, hop: ttl });
  }

  private _onRadio(fromPeer: string, bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    if (!f || this.seen.has(f.id)) return; // malformed, loop, or already delivered
    this.seen.add(f.id);
    try { this.rxCb(f); } catch { /* deliver locally; never let a consumer kill the mesh */ }
    if (f.hop > 1) this._broadcastExcept(fromPeer, { ...f, hop: f.hop - 1 }); // carry-forward
  }

  private _broadcastExcept(exceptPeer: string | null, f: Frame): void {
    const bytes = encodeFrame(f);
    for (const p of this.radio.peers()) if (p !== exceptPeer) this.radio.sendTo(p, bytes);
  }
}

// ── MultiBearer: fan out to all bearers, funnel in from any, deduped ─────────
// Itself a Bearer (composite), so the broker treats "Waku + BLE" as one pipe. A frame the
// app originates goes to every bearer; a frame that arrives on any bearer is delivered up
// exactly once (dedup by content-hash id across bearers) — so the same message over Waku
// and BLE never double-delivers to the sync layer.
export class MultiBearer implements Bearer {
  readonly name = "multi";
  private bearers: Bearer[] = [];
  private seen: SeenSet;
  private rxCb: (f: Frame) => void = () => {};
  constructor(opts: { seenCap?: number } = {}) { this.seen = new SeenSet(opts.seenCap ?? 4096); }

  add(b: Bearer): this {
    this.bearers.push(b);
    b.onReceive((f) => this._funnel(f));
    return this;
  }
  list(): Bearer[] { return this.bearers.slice(); }

  async start(): Promise<void> { for (const b of this.bearers) await b.start().catch(() => {}); }
  async stop(): Promise<void> { for (const b of this.bearers) await b.stop().catch(() => {}); }
  reachablePeers(): number { return this.bearers.reduce((n, b) => n + b.reachablePeers(), 0); }
  onReceive(cb: (f: Frame) => void): void { this.rxCb = cb; }

  // Fan an outgoing frame to every bearer (each bearer dedups its own re-sends).
  async send(frame: Frame): Promise<void> {
    this.seen.add(frame.id); // our own originations shouldn't re-funnel if echoed back
    for (const b of this.bearers) await b.send(frame).catch(() => {});
  }

  private _funnel(f: Frame): void {
    if (this.seen.has(f.id)) return; // already delivered via another bearer (or we sent it)
    this.seen.add(f.id);
    try { this.rxCb(f); } catch { /* isolate consumer errors */ }
  }
}
