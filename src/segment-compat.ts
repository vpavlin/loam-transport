// segment-compat.ts — read reliable-channel content from BOTH delivery library generations.
//
// liblogosdelivery v0.39 (desktop delivery_module 0.3.x) wraps every reliable-channel payload in a
// LIP-243 SegmentMessage protobuf — even one that fits a single segment — while keeping the wire marker
// "RELIABLE-CHANNEL-API/1". The phones' v0.38.1 library hands such a frame to the app as-is, so the
// app sees protobuf instead of its own bytes. This recognises the wrapper and returns the inner payload.
// Mirror of loam-basecamp core/src/segment_compat.hpp (same rules, same golden vectors in the tests).
//
// SegmentMessage (proto3, nim-segmentation 0593ef7c): f1 originalPayloadHash (32 B keccak256),
// f2 originalPayloadLength, f3 index, f4 dataSegmentCount, f5 paritySegmentCount, f6 isParity,
// f7 payload. proto3 omits defaults: a single segment carries no f3 and no f6.
import { keccak_256 } from "@noble/hashes/sha3.js";

export interface Segment {
  ok: boolean; hash: Uint8Array; payload: Uint8Array;
  length: number; index: number; dataCount: number; parityCount: number; isParity: boolean;
}

export function parseSegment(b: Uint8Array): Segment {
  const s: Segment = { ok: false, hash: new Uint8Array(0), payload: new Uint8Array(0),
    length: 0, index: 0, dataCount: 0, parityCount: 0, isParity: false };
  if (b.length === 0 || b[0] !== 0x0a) return s;            // must start with f1 (bytes)
  let i = 0, haveHash = false;
  const varint = (): number | null => {
    let r = 0, mul = 1;
    while (i < b.length) {
      const x = b[i++];
      r += (x & 0x7f) * mul;
      if (!(x & 0x80)) return r;
      mul *= 128; if (mul > 2 ** 56) return null;
    }
    return null;
  };
  while (i < b.length) {
    const tag = varint(); if (tag === null) return s;
    const f = Math.floor(tag / 8), wt = tag & 7;
    if (wt === 2 && (f === 1 || f === 7)) {
      const ln = varint(); if (ln === null || i + ln > b.length) return s;
      const v = b.subarray(i, i + ln); i += ln;
      if (f === 1) { s.hash = v; haveHash = true; } else s.payload = v;
    } else if (wt === 0 && f >= 2 && f <= 6) {
      const v = varint(); if (v === null) return s;
      if (f === 2) s.length = v; else if (f === 3) s.index = v; else if (f === 4) s.dataCount = v;
      else if (f === 5) s.parityCount = v; else s.isParity = v !== 0;
    } else {
      return s;                                               // unknown field / wire type
    }
  }
  s.ok = haveHash && s.hash.length === 32 && s.dataCount >= 1;
  return s;
}

export const isSegmentWrapped = (b: Uint8Array): boolean => parseSegment(b).ok;

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** The inner payload of a complete, hash-verified single segment; otherwise null. */
export function unwrapSingleSegment(b: Uint8Array): Uint8Array | null {
  const s = parseSegment(b);
  if (!s.ok || s.dataCount !== 1 || s.index !== 0 || s.isParity || s.parityCount !== 0) return null;
  if (s.length !== s.payload.length) return null;
  if (!eq(keccak_256(s.payload), s.hash)) return null;
  return s.payload;
}
