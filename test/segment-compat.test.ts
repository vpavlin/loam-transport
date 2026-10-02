// segment-compat tests — same golden vectors as loam-basecamp core/test/segment_compat_test.cpp
// (nim-segmentation 0593ef7c tests/test_wire_vectors.nim) plus the phone's base64 decode chain.
import assert from "node:assert";
import test from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { parseSegment, isSegmentWrapped, unwrapSingleSegment } from "../src/segment-compat.ts";

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const H = "000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F";
const enc = new TextEncoder();
function varint(v: number): number[] { const o: number[] = []; while (v >= 0x80) { o.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } o.push(v); return o; }
// What a v0.39 peer puts on the wire for a payload that fits one segment.
function wrapSingle(p: Uint8Array): Uint8Array {
  const o: number[] = [0x0a, 32, ...keccak_256(p)];
  if (p.length) o.push(0x10, ...varint(p.length));
  o.push(0x20, 1);
  if (p.length) o.push(0x3a, ...varint(p.length), ...p);
  return Uint8Array.from(o);
}

test("upstream golden vectors parse; none of them is a single segment", () => {
  const data = hex("0A20" + H + "10F403" + "1801" + "2003" + "3A03AABBCC");
  const parity = hex("0A20" + H + "10F403" + "2003" + "2801" + "3001" + "3A021122");
  const minimal = hex("0A20" + H + "2001");
  const d = parseSegment(data);
  assert.ok(d.ok); assert.equal(d.index, 1); assert.equal(d.dataCount, 3); assert.equal(d.length, 500);
  assert.deepEqual([...d.payload], [0xaa, 0xbb, 0xcc]);
  assert.ok(parseSegment(parity).isParity);
  assert.ok(isSegmentWrapped(minimal));
  assert.equal(unwrapSingleSegment(data), null);
  assert.equal(unwrapSingleSegment(parity), null);
  assert.equal(unwrapSingleSegment(minimal), null);      // fake hash
});

test("single segment round-trips; tampering and old content are left alone", () => {
  const app = enc.encode("eyJ2IjoxLCJ0eXBlIjoiRVZFTlQifQ==");
  const w = wrapSingle(app);
  assert.deepEqual(unwrapSingleSegment(w), app);
  assert.deepEqual(unwrapSingleSegment(wrapSingle(new Uint8Array(0))), new Uint8Array(0));
  const t = w.slice(); t[t.length - 1] ^= 1;
  assert.equal(unwrapSingleSegment(t), null);
  assert.equal(unwrapSingleSegment(app), null);
  assert.ok(!isSegmentWrapped(app));
  assert.equal(unwrapSingleSegment(hex("0A0548454C4C4F")), null);   // f1 not 32 bytes
  assert.equal(unwrapSingleSegment(w.subarray(0, w.length - 3)), null);
});

test("a 300-byte payload (multi-block keccak) round-trips", () => {
  const p = enc.encode("x".repeat(300));
  assert.deepEqual(unwrapSingleSegment(wrapSingle(p)), p);
});
