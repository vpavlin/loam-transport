// loam-mesh-radio — the React Native adapter that implements the portable `MeshRadio`
// (src/bearer.ts) over the native Android BLE module (LoamMeshModule.kt). Hand this to
// enableMesh() and the portable BleMeshBearer drives the real radio:
//
//   import { LoamMeshRadio } from "logos-transport/native/blemesh/loam-mesh-radio";
//   import { enableMesh } from "logos-transport";
//   if (LoamMeshRadio.available()) await enableMesh(new LoamMeshRadio());
//
// Android-only (arm64), foreground/shared-service context. iOS is a later bearer (ADR 0012).
import { NativeModules, NativeEventEmitter, Platform } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import type { MeshRadio } from "../../src/bearer";

const Native: any = (NativeModules as any).LoamMesh;

export class LoamMeshRadio implements MeshRadio {
  private emitter: NativeEventEmitter | null = null;
  private subs: { remove: () => void }[] = [];
  private cb: (peer: string, bytes: Uint8Array) => void = () => {};
  private peerList: string[] = [];

  static available(): boolean { return Platform.OS === "android" && !!Native; }

  async start(): Promise<void> {
    if (!Native) throw new Error("LoamMesh native module not present");
    this.emitter = new NativeEventEmitter(Native);
    this.subs.push(this.emitter.addListener("loamMeshRx", (e: { peer: string; data: string }) => {
      try { this.cb(e.peer, toByteArray(e.data)); } catch { /* ignore a bad frame */ }
    }));
    this.subs.push(this.emitter.addListener("loamMeshPeers", (e: { peers: string[] }) => {
      this.peerList = Array.isArray(e.peers) ? e.peers : [];
    }));
    await Native.start();
    // seed the peer list once (events keep it fresh thereafter)
    try { this.peerList = await Native.peers(); } catch { /* */ }
  }

  async stop(): Promise<void> {
    for (const s of this.subs) try { s.remove(); } catch { /* */ }
    this.subs = [];
    this.peerList = [];
    if (Native) try { await Native.stop(); } catch { /* */ }
  }

  peers(): string[] { return this.peerList; }

  sendTo(peerId: string, bytes: Uint8Array): void {
    if (!Native) return;
    // fire-and-forget; the mesh is best-effort and the sync layer reconciles gaps
    Native.sendTo(peerId, fromByteArray(bytes)).catch(() => {});
  }

  onReceiveFrom(cb: (peerId: string, bytes: Uint8Array) => void): void { this.cb = cb; }
}
