import type { MeshRadio } from "./bearer";

// A MOCK BLE radio over WebSocket — the test/CI stand-in for LoamMeshRadio (native GATT). It
// implements the SAME MeshRadio seam BleMeshBearer runs on, so the entire transport (auto-arm on
// degrade, fan-out to bearers, cross-bearer dedup) runs UNCHANGED while frames travel over a host
// relay (test/tools/mesh-relay.js) instead of Bluetooth. Point two emulators' Loam nodes at one
// relay and they form a mesh with zero radio — which is how we prove seamless bearer switching.
//
// The relay is a broadcast star, so from a node's view there is exactly ONE virtual neighbour
// ("relay") when connected: BleMeshBearer sends once, the relay fans out, and carry-forward
// naturally doesn't loop (its only peer is the one the frame came from). Not for production.
export class WsMeshRadio implements MeshRadio {
  private ws: WebSocket | null = null;
  private cb: (peer: string, bytes: Uint8Array) => void = () => {};
  private up = false;
  private closed = false;
  constructor(private id: string, private url: string) {}

  async start(): Promise<void> { this.closed = false; this._connect(); }

  private _connect(): void {
    if (this.closed) return;
    const u = this.url + (this.url.includes("?") ? "&" : "?") + "id=" + encodeURIComponent(this.id);
    const ws = new WebSocket(u);
    (ws as any).binaryType = "arraybuffer";
    ws.onopen = () => { this.up = true; };
    ws.onclose = () => { this.up = false; if (!this.closed) setTimeout(() => this._connect(), 1000); }; // auto-reconnect
    ws.onerror = () => { /* onclose handles retry */ };
    ws.onmessage = (e: any) => {
      const d = e.data;
      const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
      if (bytes) { try { this.cb("relay", bytes); } catch { /* never let a consumer kill the radio */ } }
    };
    this.ws = ws;
  }

  async stop(): Promise<void> { this.closed = true; this.up = false; try { this.ws?.close(); } catch { /* */ } this.ws = null; }

  peers(): string[] { return this.up ? ["relay"] : []; }

  sendTo(_peerId: string, bytes: Uint8Array): void {
    if (!this.ws || !this.up) return;
    // Send a clean ArrayBuffer slice (the frame may be a subarray of a larger buffer).
    try { this.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); } catch { /* */ }
  }

  onReceiveFrom(cb: (peer: string, bytes: Uint8Array) => void): void { this.cb = cb; }
}
