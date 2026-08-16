// loam-telemetry publisher for a Basecamp / headless node. The mobile transport publishes its own
// telemetry natively; a desktop node (loam_core) exposes metricsJson() + sendSealed(), so this companion
// closes the loop WITHOUT adding crypto to the C++ module: on a timer it reads the node's metrics, builds
// a snapshot (src:"basecamp"), seals it (same topic+key as src/telemetry.ts), and publishes it via the
// node's own delivery bearer. Run it from an app dir (Node resolves @noble); drive it with shell templates:
//
//   TELEMETRY_SECRET=S node loam-telemetry-publish.mjs \
//     --dev basecamp-hub \
//     --metrics-cmd 'logos-hub call loam loam_core metricsJson' \
//     --publish-cmd 'logos-hub call loam loam_core sendSealed {topic} {payload}'
//
import { execFile } from "node:child_process";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "node:crypto";

const SECRET = process.env.TELEMETRY_SECRET || "";
if (!SECRET) { console.error("set TELEMETRY_SECRET"); process.exit(1); }
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); if (a) return a.split("=").slice(1).join("="); const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const DEV = arg("dev", "basecamp");
const SRC = arg("src", "basecamp");
const INTERVAL = Number(arg("interval", "5")) * 1000;
const METRICS_CMD = arg("metrics-cmd", "");
const PUBLISH_CMD = arg("publish-cmd", "");
if (!METRICS_CMD || !PUBLISH_CMD) { console.error("--metrics-cmd and --publish-cmd (with {topic} {payload}) are required"); process.exit(1); }

const enc = (s) => new TextEncoder().encode(s);
const HEXC = "0123456789abcdef";
const hex = (b) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };
const K = hkdf(sha256, enc(SECRET), enc("loam-telemetry-v1"), new Uint8Array(0), 32);
const Ke = hkdf(sha256, K, new Uint8Array(0), enc("loam-telemetry/payload/v1"), 32);
const TOPIC = `/loam-telemetry/1/${hex(hmac(sha256, K, enc("loam-telemetry/topic/v1")).slice(0, 16))}/proto`;

function seal(obj) {
  const n = new Uint8Array(randomBytes(12));
  const ct = chacha20poly1305(Ke, n, enc(TOPIC)).encrypt(enc(JSON.stringify(obj)));
  const out = new Uint8Array(12 + ct.length); out.set(n, 0); out.set(ct, 12);
  return Buffer.from(out).toString("base64");
}
const sh = (cmd) => new Promise((res) => execFile("bash", ["-lc", cmd], { maxBuffer: 4 << 20 }, (e, out) => res(e ? "" : out)));

// Parse a metrics blob that may be raw JSON or the hub's {"result":"<json-string>"} envelope.
function parseMetrics(s) {
  try {
    let o = JSON.parse(s.trim());
    if (o && typeof o.result === "string") { try { o = JSON.parse(o.result); } catch { /* */ } }
    return o && typeof o === "object" ? o : null;
  } catch { return null; }
}
// Flatten a loam_core metrics object into a flat numeric snapshot: peers/connected + bearer_<name>_<key>.
function snapshotFrom(m) {
  const snap = { t: new Date().toISOString(), dev: DEV, src: SRC };
  if (typeof m.peers === "number") snap.peers = m.peers;
  if (typeof m.connected === "boolean") snap.connected = m.connected ? 1 : 0;
  for (const b of Array.isArray(m.bearers) ? m.bearers : []) {
    const bn = String(b.name || b.bearer || "b").replace(/[^a-zA-Z0-9]/g, "");
    for (const [k, v] of Object.entries(b)) if (typeof v === "number") snap[`bearer_${bn}_${k}`] = v;
  }
  return snap;
}

async function tick() {
  const m = parseMetrics(await sh(METRICS_CMD));
  if (!m) { console.error("metrics-cmd produced no JSON"); return; }
  const payload = seal(snapshotFrom(m));
  await sh(PUBLISH_CMD.replaceAll("{topic}", TOPIC).replaceAll("{payload}", payload));
  console.error(`# published snapshot (${payload.length}B) on ${TOPIC}`);
}

console.error(`# loam-telemetry-publish: dev=${DEV} src=${SRC} every ${INTERVAL / 1000}s → ${TOPIC}`);
tick();
setInterval(tick, INTERVAL);
