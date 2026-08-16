// Mock BLE "ether" — a WebSocket broadcast hub. Each Loam node's WsMeshRadio connects here and a
// binary frame from one node is rebroadcast to every OTHER node: a star that stands in for the BLE
// broadcast medium, so two emulators (or any hosts) form a mesh with ZERO Bluetooth. This is what
// lets us prove loam-transport's bearer switching (Waku <-> mesh) end-to-end without a radio.
//
//   node mesh-relay.js            # listens on ws://0.0.0.0:8787  (emulator reaches it at 10.0.2.2)
//   MESH_PORT=9000 node mesh-relay.js
const { WebSocketServer } = require("ws");
const PORT = process.env.MESH_PORT ? +process.env.MESH_PORT : 8787;
const wss = new WebSocketServer({ host: "0.0.0.0", port: PORT });
let seq = 0, frames = 0;
wss.on("connection", (ws, req) => {
  const id = new URL(req.url, "http://x").searchParams.get("id") || "n" + ++seq;
  ws._loamId = id;
  console.log(`[+] ${id} connected  (clients=${wss.clients.size})`);
  ws.on("message", (data, isBinary) => {
    frames++;
    let fanout = 0;
    for (const c of wss.clients) if (c !== ws && c.readyState === 1) { c.send(data, { binary: isBinary }); fanout++; }
    if (frames % 20 === 0 || fanout === 0) console.log(`    frame #${frames} from ${id} -> ${fanout} peer(s) (${isBinary ? data.length + "B" : "text"})`);
  });
  ws.on("close", () => console.log(`[-] ${id} left  (clients=${wss.clients.size})`));
  ws.on("error", (e) => console.log(`[!] ${id} error: ${e.message}`));
});
console.log(`mesh relay up on ws://0.0.0.0:${PORT}   (emulator dials ws://10.0.2.2:${PORT})`);
