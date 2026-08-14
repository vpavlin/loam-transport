// loam-mesh-radio — the React Native adapter that implements the portable `MeshRadio`
// (src/bearer.ts) over the native Android BLE module (LoamMeshModule.kt). Hand this to
// enableMesh() and the portable BleMeshBearer drives the real radio:
//
//   import { LoamMeshRadio } from "logos-transport/native/blemesh/loam-mesh-radio";
//   import { enableMesh } from "logos-transport";
//   if (LoamMeshRadio.available()) await enableMesh(new LoamMeshRadio());
//
// Android-only (arm64), foreground/shared-service context. iOS is a later bearer (ADR 0012).
import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import type { MeshRadio } from "../../src/bearer";

const Native: any = (NativeModules as any).LoamMesh;

export class LoamMeshRadio implements MeshRadio {
  private emitter: NativeEventEmitter | null = null;
  private subs: { remove: () => void }[] = [];
  private cb: (peer: string, bytes: Uint8Array) => void = () => {};
  private peerList: string[] = [];
  private nodeId: string;

  // nodeId = the app's stable deviceId (ADR 0014). Handed to native before start() so the
  // mesh keys peers by this stable id, not the rotating BLE MAC.
  constructor(nodeId: string = "") { this.nodeId = nodeId; }

  static available(): boolean { return Platform.OS === "android" && !!Native; }

  // Compact native BLE data-path diagnostic (fragments sent/recv/delivered, MTU, last error).
  // Surfaced on the debug card so a BLE failure can be localized without adb.
  static async stats(): Promise<string> {
    try { return Native && Native.stats ? await Native.stats() : ""; } catch { return ""; }
  }

  async start(): Promise<void> {
    if (!Native) throw new Error("LoamMesh native module not present");
    // Android 12+ (API 31) requires runtime BLE permissions; request before starting.
    if (Platform.OS === "android" && Number(Platform.Version) >= 31) {
      try {
        await PermissionsAndroid.requestMultiple([
          "android.permission.BLUETOOTH_SCAN" as any,
          "android.permission.BLUETOOTH_ADVERTISE" as any,
          "android.permission.BLUETOOTH_CONNECT" as any,
        ]);
      } catch { /* the native start() will surface a denial */ }
    }
    this.emitter = new NativeEventEmitter(Native);
    this.subs.push(this.emitter.addListener("loamMeshRx", (e: { peer: string; data: string }) => {
      try { this.cb(e.peer, toByteArray(e.data)); } catch { /* ignore a bad frame */ }
    }));
    this.subs.push(this.emitter.addListener("loamMeshPeers", (e: { peers: string[] }) => {
      this.peerList = Array.isArray(e.peers) ? e.peers : [];
    }));
    try { if (this.nodeId && Native.setNodeId) await Native.setNodeId(this.nodeId); } catch { /* */ }
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
