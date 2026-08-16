// loam-telemetry — a TRANSPORT feature, not app glue. The interesting Loam bugs happen OFF the network
// (BLE-only, dead zones) where you can't watch live. So the node itself buffers its OWN diagnostics to
// disk each tick and, the moment the fleet is reachable, seals + flushes them to a dedicated telemetry
// topic. A watcher (tools/telemetry-watch.mjs, driven by the hub's Waku node) derives the same topic+key
// from a pre-shared secret and decodes them — a device's offline→online story, observable without the
// user retyping a stat. Enable once with transport.enableTelemetry(secret); every app on the shared node
// and Loam itself get it for free, and any UI just reads transport.telemetryStatus().
//
// Lazy-loaded by logos-transport (never a static import) so the pure core — bearer/broker, node tests —
// never pulls in expo-*/@noble. Ships CIPHERTEXT only; the node sealing its OWN telemetry with its OWN
// key doesn't touch the transport's app-payload opacity.
import * as FileSystem from "expo-file-system";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import * as Crypto from "expo-crypto";
import { counters, publishRaw, join, getNodeMode, meshEnabled, meshForcedOn, meshPeers } from "./logos-transport";

const enc = (s: string) => new TextEncoder().encode(s);
const HEXC = "0123456789abcdef";
const hex = (b: Uint8Array) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };

const CAP = 500;
const BUF = (FileSystem.documentDirectory || "") + "loam-telemetry-buf.json";

let enabled = false;
let timer: ReturnType<typeof setInterval> | null = null;
let Ke = new Uint8Array(32);
let topic = "";
let deviceId = "";
let lastFlush = "";
let lastError = "";
let buf: any[] = [];
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  try { const i = await FileSystem.getInfoAsync(BUF); if (i.exists) { const a = JSON.parse(await FileSystem.readAsStringAsync(BUF)); if (Array.isArray(a)) buf = a; } } catch { /* */ }
  loaded = true;
}
async function persist(): Promise<void> { try { await FileSystem.writeAsStringAsync(BUF, JSON.stringify(buf)); } catch { /* */ } }

function seal(plaintext: Uint8Array): Uint8Array {
  const nonce = Crypto.getRandomBytes(12);
  const ct = chacha20poly1305(Ke, nonce, enc(topic)).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0); out.set(ct, nonce.length);
  return out;
}

// The node's own diagnostic snapshot — pulled straight from the transport's live state, no app input.
function snapshot(): Record<string, any> {
  const c = counters as any;
  return {
    t: new Date().toISOString(), dev: deviceId, src: "android",
    peers: c.peers, mesh: c.mesh, rxRaw: c.rxRaw, rxNew: c.rxNew, rxOpenFail: c.rxOpenFail,
    txTotal: c.txTotal, txFail: c.txFail, mode: safe(getNodeMode),
    bleTx: c.bleTx, bleRx: c.bleRx, bleDelivered: c.bleRxDelivered, bleDropped: c.bleRxDropped,
    armed: safe(meshEnabled), forced: safe(meshForcedOn), blePeers: safe(meshPeers),
  };
}
function safe<T>(f: () => T): T | null { try { return f(); } catch { return null; } }

// Start telemetry: derive the topic+key from the secret, subscribe it, and begin the record/flush loop.
export function start(secret: string, opts?: { deviceId?: string; everyMs?: number }): void {
  if (enabled || !secret) return;
  deviceId = opts?.deviceId || deviceId;
  const K = hkdf(sha256, enc(secret), enc("loam-telemetry-v1"), new Uint8Array(0), 32);
  Ke = hkdf(sha256, K, new Uint8Array(0), enc("loam-telemetry/payload/v1"), 32);
  topic = `/loam-telemetry/1/${hex(hmac(sha256, K, enc("loam-telemetry/topic/v1")).slice(0, 16))}/proto`;
  enabled = true;
  try { void join([topic]); } catch { /* */ }
  const every = opts?.everyMs && opts.everyMs > 0 ? opts.everyMs : 5000;
  void load();
  timer = setInterval(() => { void tick(); }, every);
  void tick();
}

export function stop(): void { if (timer) clearInterval(timer); timer = null; enabled = false; }

async function tick(): Promise<void> {
  await load();
  buf.push(snapshot());
  while (buf.length > CAP) buf.shift();
  await persist();
  if ((counters as any).peers > 0) await flush(); // fleet reachable → drain
}

// Flush buffered snapshots to the telemetry topic (best-effort; keeps what it couldn't send).
export async function flush(): Promise<number> {
  if (!enabled) return 0;
  await load();
  if (buf.length === 0) return 0;
  const pending = buf.slice();
  let sent = 0;
  try {
    for (const s of pending) {
      try { await publishRaw(topic, seal(enc(JSON.stringify(s)))); sent++; }
      catch (e: any) { lastError = String((e && e.message) || e); break; }
    }
  } finally {
    if (sent > 0) { buf = buf.slice(sent); await persist(); lastFlush = new Date().toISOString(); }
  }
  return sent;
}

export function status(): { enabled: boolean; topic: string; buffered: number; lastFlush: string; lastError: string } {
  return { enabled, topic, buffered: buf.length, lastFlush: lastFlush || "—", lastError: lastError || "—" };
}
