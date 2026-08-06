// QAKU's thin adapter over the SHARED logos-transport. The transport moves opaque
// sealed bytes on topics and cannot drift from KYM; this file supplies ONLY the two
// app-specific things: qaku's TOPIC (namespace) and its CRYPTO (seal/open) + envelope
// dispatch (EVENT / SYNC_REQ). If sync ever breaks again, the bug is in logos-transport
// (shared, so fix it once) or here (crypto/envelope) — never a re-implemented wire path.
import { deriveIdentity, topicFor, seal, open, Identity } from "./crypto";
import { getDeviceId } from "./device";
import { utf8Bytes, utf8Decode } from "./utf8";
import * as transport from "./logos-transport";

// Re-export the transport's diagnostics/helpers so existing UI imports keep working.
export { counters, getRxSample } from "./logos-transport";

let identity: Identity | null = null;
let topic = "";
let deviceId = "";

type OnEvent = (event: any) => void;      // a decoded EVENT envelope's `event`
type OnSyncReq = (from: string) => void;  // a peer asking us to re-serve our log
type OnStatus = (s: string) => void;

// Open a candidate with our session key and dispatch the envelope. Returns true iff a
// candidate opened (so the transport can tally rxOpened vs rxOpenFail).
function openAndDispatch(candidates: Uint8Array[], onEvent: OnEvent, onSyncReq?: OnSyncReq): boolean {
  for (const cand of candidates) {
    let plaintext: Uint8Array;
    try { plaintext = open(identity!, cand, topic); } catch { continue; } // authenticated — only the right one wins
    try {
      const env = JSON.parse(utf8Decode(plaintext));
      if (env && env.type === "EVENT" && env.event) onEvent(env.event);
      else if (env && env.type === "SYNC_REQ" && onSyncReq) onSyncReq(typeof env.from === "string" ? env.from : "");
    } catch { /* opened but not a valid envelope */ }
    return true;
  }
  return false;
}

export async function startNode(secret: Uint8Array, onEvent: OnEvent, onStatus?: OnStatus, onSyncReq?: OnSyncReq): Promise<void> {
  identity = deriveIdentity(secret);
  topic = topicFor(identity);
  deviceId = await getDeviceId();
  // One call = KYM's ensureNode flow (setup→new→start→subscribe+channelCreate→settle→renew).
  await transport.start({
    deviceId,
    topics: [topic],
    onStatus,
    onReceive: (_topic, candidates) => openAndDispatch(candidates, onEvent, onSyncReq),
  });
}

// Seal an event's wire bytes / open sealed bytes with qaku's household key.
export function sealEvent(plaintext: Uint8Array): Uint8Array { return seal(identity!, plaintext, topic); }
export function openSealed(sealed: Uint8Array): Uint8Array { return open(identity!, sealed, topic); }

export async function publishSealed(sealed: Uint8Array): Promise<void> {
  return transport.publishSealed(topic, sealed);
}

// Ask peers to re-serve everything (pull half): publish a sealed SYNC_REQ envelope.
export async function sendSyncReq(): Promise<void> {
  if (!identity || !topic) return;
  const env = { v: 1, type: "SYNC_REQ", from: deviceId };
  try { await transport.publishSealed(topic, sealEvent(utf8Bytes(JSON.stringify(env)))); } catch { /* offline — next join retries */ }
}

// Cold-start history pull: fold every stored EVENT for our topic.
export async function storeSync(onEvent: OnEvent): Promise<number> {
  const res = await transport.storeSync((_topic, candidates) => {
    for (const cand of candidates) {
      try {
        const env = JSON.parse(utf8Decode(open(identity!, cand, topic)));
        if (env && env.type === "EVENT" && env.event) { onEvent(env.event); return true; }
        break; // opened but not an EVENT
      } catch { /* try next candidate */ }
    }
    return false;
  });
  return res.events;
}

export function getTopic(): string { return topic; }
export function getShard(): number { return topic ? transport.shardFor(topic) : -1; }
export async function refreshPeerCount(): Promise<number> {
  await transport.refreshPeerInfo();
  return transport.counters.peers;
}
