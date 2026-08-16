// A headless mesh peer for the mock-radio harness: connects to mesh-relay.js as a second node and
// speaks the REAL wire codec (decodeFrame/encodeFrame from bearer.ts). It (a) decodes and prints
// every frame a Loam node floods — proving the transport SENDS over the mock bearer — and (b)
// injects its own frames on the probe topic — proving a Loam node RECEIVES over the mock bearer.
// So one emulator + this script proves both directions of bearer transport with no second device.
//   node --experimental-strip-types test/tools/fake-peer.ts
import { WebSocket } from "ws";
import { decodeFrame, makeFrame, encodeFrame } from "../../src/bearer.ts";

const URL = process.env.RELAY || "ws://127.0.0.1:8787";
const PROBE = "/logos-delivery/1/probe/proto";
const ws = new WebSocket(URL + "?id=nodepeer");
let rx = 0, tx = 0;

ws.on("open", () => {
  console.log(`node-peer connected to ${URL}`);
  setInterval(() => {
    const f = makeFrame(PROBE, new TextEncoder().encode("from-node-peer:" + tx));
    ws.send(encodeFrame(f));
    console.log(`  -> TX #${tx} injected onto mesh: "from-node-peer:${tx}" (id=${f.id})`);
    tx++;
  }, 5000);
});
ws.on("message", (data: Buffer) => {
  const bytes = new Uint8Array(data);
  const f = decodeFrame(bytes);
  rx++;
  if (f) console.log(`  <- RX #${rx} from a Loam node: topic=…${f.topic.slice(-18)} payload="${new TextDecoder().decode(f.payload)}" hop=${f.hop}`);
  else console.log(`  <- RX #${rx} UNDECODABLE (${bytes.length}B) — wire mismatch!`);
});
ws.on("close", () => console.log("node-peer disconnected"));
ws.on("error", (e: any) => console.log("node-peer error:", e.message));
