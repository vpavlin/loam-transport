// What a received delivery payload may hold, as candidate byte strings for the app to try opening.
// Same wire as loam_core's include/loam/delivery_transport.hpp (LOAM_DELIVERY_WIRE_VERSION 1); the
// shared vectors (test/fixtures/delivery_vectors.json, copied from loam-basecamp core/test) check it.
// No relative imports, so Node's test runner loads it; logos-transport.ts adds the LIP-243 segment
// unwrapping (segment-compat.ts) on top.
import { toByteArray } from "base64-js";

// Bytes → text for a second base64 decode. Base64 text is ASCII, so this equals the UTF-8 decode for
// every input that can decode; anything else throws in toByteArray either way.
function asciiText(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

// KYM payloadCandidates (minus the segment step): the payload as base64 once, twice, and raw.
export function rawPayloadCandidates(payload: any): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (Array.isArray(payload)) {
    let s = "";
    for (let i = 0; i < payload.length; i++) s += String.fromCharCode(payload[i] & 0xff);
    let once: Uint8Array | null = null;
    try { once = toByteArray(s); out.push(once); } catch { /* not base64 text */ }
    if (once) { try { out.push(toByteArray(asciiText(once))); } catch { /* not double */ } }
    out.push(Uint8Array.from(payload.map((b: number) => b & 0xff)));
  } else if (typeof payload === "string") {
    try {
      const once = toByteArray(payload);
      out.push(once);
      try { out.push(toByteArray(asciiText(once))); } catch { /* not double */ }
    } catch { /* not base64 */ }
  }
  return out;
}
