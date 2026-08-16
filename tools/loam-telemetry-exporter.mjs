// loam-telemetry Prometheus exporter. Derives the same topic+key as src/telemetry.ts from a pre-shared
// secret, decodes sealed snapshots a node flushed to the fleet, keeps the latest per device, and serves
// them at /metrics so Prometheus can scrape → Grafana can compare Android vs Basecamp nodes over time.
//
// Source-agnostic: it reads a line stream on stdin and scans each line for a decodable telemetry blob,
// so ANY subscriber can feed it — the hub running loam_core (or delivery_module) joined to the topic:
//   TELEMETRY_SECRET=S node loam-telemetry-exporter.mjs --topic          # print the topic to subscribe
//   hub watch loam_core --json | TELEMETRY_SECRET=S node loam-telemetry-exporter.mjs --port 9109
// Then scrape http://host:9109/metrics. Run from an app dir so Node resolves @noble.
import http from "node:http";
import readline from "node:readline";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { chacha20poly1305 } from "@noble/ciphers/chacha";

const SECRET = process.env.TELEMETRY_SECRET || "";
if (!SECRET) { console.error("set TELEMETRY_SECRET (== the phone/desktop EXPO_PUBLIC_TELEMETRY_SECRET)"); process.exit(1); }
const PORT = Number((process.argv.find((a) => a.startsWith("--port="))?.split("=")[1]) || process.env.PORT || 9109);

const enc = (s) => new TextEncoder().encode(s);
const HEXC = "0123456789abcdef";
const hex = (b) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };
const K = hkdf(sha256, enc(SECRET), enc("loam-telemetry-v1"), new Uint8Array(0), 32);
const Ke = hkdf(sha256, K, new Uint8Array(0), enc("loam-telemetry/payload/v1"), 32);
const TOPIC = `/loam-telemetry/1/${hex(hmac(sha256, K, enc("loam-telemetry/topic/v1")).slice(0, 16))}/proto`;

if (process.argv.includes("--topic")) { console.log(TOPIC); process.exit(0); }

function tryDecode(b64) {
  try {
    const sealed = new Uint8Array(Buffer.from(b64, "base64"));
    if (sealed.length < 13) return null;
    const pt = chacha20poly1305(Ke, sealed.subarray(0, 12), enc(TOPIC)).decrypt(sealed.subarray(12));
    const o = JSON.parse(new TextDecoder().decode(pt));
    return o && typeof o === "object" && o.dev ? o : null;
  } catch { return null; }
}

// latest snapshot per device, plus when we received it (for staleness / up)
const latest = new Map(); // dev -> { snap, at }
let decoded = 0;

// Which snapshot fields become numeric gauges (booleans → 0/1); everything else is ignored or a label.
const GAUGES = {
  loam_peers: "peers", loam_mesh: "mesh",
  loam_rx_raw: "rxRaw", loam_rx_new: "rxNew", loam_rx_openfail: "rxOpenFail",
  loam_tx_total: "txTotal", loam_tx_fail: "txFail",
  loam_ble_tx: "bleTx", loam_ble_rx: "bleRx", loam_ble_delivered: "bleDelivered", loam_ble_dropped: "bleDropped",
  loam_ble_peers: "blePeers",
};
const BOOLS = { loam_ble_armed: "armed", loam_ble_forced: "forced" };
const num = (v) => (typeof v === "number" && isFinite(v) ? v : (v === true ? 1 : v === false ? 0 : null));
const esc = (s) => String(s).replace(/["\\\n]/g, (m) => (m === "\n" ? " " : "\\" + m));

function metrics() {
  const now = Date.now();
  const out = [];
  const emit = (name, help, rows) => { if (!rows.length) return; out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...rows); };
  const rowsFor = (name, field, map = num) => {
    const rows = [];
    for (const [dev, { snap }] of latest) { const v = map(snap[field]); if (v != null) rows.push(`${name}{dev="${esc(dev)}",src="${esc(snap.src || "?")}"} ${v}`); }
    return rows;
  };
  for (const [name, field] of Object.entries(GAUGES)) emit(name, field, rowsFor(name, field));
  for (const [name, field] of Object.entries(BOOLS)) emit(name, field + " (0/1)", rowsFor(name, field, (v) => (v ? 1 : 0)));
  // info metric carries string labels (mode); freshness for up/last-seen
  const info = [], seen = [], up = [];
  for (const [dev, { snap, at }] of latest) {
    const lbl = `dev="${esc(dev)}",src="${esc(snap.src || "?")}",mode="${esc(snap.mode || "?")}"`;
    info.push(`loam_node_info{${lbl}} 1`);
    seen.push(`loam_last_seen_seconds{dev="${esc(dev)}"} ${Math.round(at / 1000)}`);
    up.push(`loam_up{dev="${esc(dev)}"} ${now - at < 120000 ? 1 : 0}`); // "up" if a snapshot arrived in the last 2m
  }
  emit("loam_node_info", "node identity/labels", info);
  emit("loam_last_seen_seconds", "unix time of the last snapshot from this device", seen);
  emit("loam_up", "1 if a snapshot arrived in the last 120s", up);
  // Auto-expose ANY other top-level numeric field (so a Basecamp publisher's bearer metrics land as
  // gauges without hand-mapping): loam_x_<field>. Skips known gauges/bools + the label/meta fields.
  const known = new Set([...Object.values(GAUGES), ...Object.values(BOOLS), "t", "dev", "src", "mode"]);
  const extra = new Map(); // field -> rows
  for (const [dev, { snap }] of latest) for (const [k, v] of Object.entries(snap)) {
    if (known.has(k) || typeof v !== "number" || !isFinite(v)) continue;
    const name = "loam_x_" + k.replace(/[^a-zA-Z0-9_]/g, "_");
    (extra.get(name) || extra.set(name, []).get(name)).push(`${name}{dev="${esc(dev)}",src="${esc(snap.src || "?")}"} ${v}`);
  }
  for (const [name, rows] of extra) emit(name, "(auto)", rows);
  out.push(`# HELP loam_exporter_decoded_total telemetry snapshots decoded`, `# TYPE loam_exporter_decoded_total counter`, `loam_exporter_decoded_total ${decoded}`);
  return out.join("\n") + "\n";
}

http.createServer((req, res) => {
  if (req.url === "/metrics") { res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }); res.end(metrics()); }
  else { res.writeHead(200, { "content-type": "text/plain" }); res.end(`loam-telemetry-exporter\ntopic ${TOPIC}\ndevices ${latest.size} decoded ${decoded}\nGET /metrics\n`); }
}).listen(PORT, () => console.error(`# loam-telemetry-exporter on :${PORT}/metrics  topic=${TOPIC}`));

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  for (const tok of line.split(/["'\s,:{}\[\]]+/)) {
    if (tok.length < 20) continue;
    const s = tryDecode(tok);
    if (s) { latest.set(s.dev, { snap: s, at: Date.now() }); decoded++; break; }
  }
});
