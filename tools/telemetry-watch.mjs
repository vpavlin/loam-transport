// loam-telemetry watcher/decoder. Derives the SAME telemetry topic + key as app/src/lib/telemetry.ts
// from a pre-shared secret, then decodes sealed snapshots a phone flushed to the fleet. Subscribing to
// the topic itself needs a Waku node — that's the hub's job (logos-hub / loam-core); this tool is the
// decoder half, so the flow is:
//
//   1) print the topic to subscribe:
//        TELEMETRY_SECRET=whatever node src/lib/logos-transport-pkg/tools/telemetry-watch.mjs --topic
//   2) point the hub at it and pipe received payloads here (one base64 sealed payload per line, or
//      hub --json lines with a base64 field — we scan each line for a decodable blob):
//        hub watch delivery_module --topic <TOPIC> | TELEMETRY_SECRET=whatever node src/lib/logos-transport-pkg/tools/telemetry-watch.mjs
//   3) or decode a single payload directly:
//        TELEMETRY_SECRET=whatever node src/lib/logos-transport-pkg/tools/telemetry-watch.mjs <base64-sealed-payload>
//
// Run from the app dir so Node resolves @noble from node_modules.
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { chacha20poly1305 } from "@noble/ciphers/chacha";

const SECRET = process.env.TELEMETRY_SECRET || "";
if (!SECRET) { console.error("set TELEMETRY_SECRET (the same value as EXPO_PUBLIC_TELEMETRY_SECRET on the phone)"); process.exit(1); }

const enc = (s) => new TextEncoder().encode(s);
const HEXC = "0123456789abcdef";
const hex = (b) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };

const K = hkdf(sha256, enc(SECRET), enc("loam-telemetry-v1"), new Uint8Array(0), 32);
const Ke = hkdf(sha256, K, new Uint8Array(0), enc("loam-telemetry/payload/v1"), 32);
const TOPIC = `/loam-telemetry/1/${hex(hmac(sha256, K, enc("loam-telemetry/topic/v1")).slice(0, 16))}/proto`;

function open(sealed) {
  const nonce = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  return chacha20poly1305(Ke, nonce, enc(TOPIC)).decrypt(ct);
}
// Try to decode a base64 blob into a telemetry snapshot; returns the object or null.
function tryDecode(b64) {
  try {
    const sealed = new Uint8Array(Buffer.from(b64, "base64"));
    if (sealed.length < 13) return null;
    return JSON.parse(new TextDecoder().decode(open(sealed)));
  } catch { return null; }
}
function fmt(s) {
  const net = s.peers > 0 ? `net ${s.peers}p` : "OFFLINE";
  return `${s.t}  ${(s.dev || "?").slice(0, 12)}  ${net} mode:${s.mode || "?"}  ble[armed:${s.armed} tx:${s.bleTx} rx:${s.bleRx} del:${s.bleDelivered} drop:${s.bleDropped}]`;
}

if (process.argv.includes("--topic")) { console.log(TOPIC); process.exit(0); }

const arg = process.argv[2];
if (arg && !arg.startsWith("--")) {
  const s = tryDecode(arg);
  console.log(s ? fmt(s) : "could not decode (wrong secret or not a telemetry payload)");
  process.exit(s ? 0 : 1);
}

// stream mode: scan each stdin line for any base64 blob that decodes as a snapshot
console.error(`# watching for loam-telemetry on ${TOPIC}\n# (pipe hub message payloads in; each decodable snapshot prints below)`);
let n = 0;
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  for (const tok of line.split(/["'\s,:{}]+/)) {
    if (tok.length < 20) continue;
    const s = tryDecode(tok);
    if (s) { console.log(`#${++n} ${fmt(s)}`); break; }
  }
});
