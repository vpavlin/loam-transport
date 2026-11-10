// The shared delivery wire vectors (loam-basecamp core/test/delivery_vectors.json, copied to
// test/fixtures): what a desktop on loam_core or on loam_core's delivery_transport.hpp puts on the
// wire must open on the phone. For every vector marked `phone` (the payload shapes the phone's
// library hands over), payloadCandidates must offer the sender's sealed bytes.
import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { rawPayloadCandidates } from "../src/payload.ts";
import { withUnwrappedSegments } from "../src/segment-compat.ts";
const payloadCandidates = (p: any) => withUnwrappedSegments(rawPayloadCandidates(p));   // as logos-transport.ts

const v = JSON.parse(readFileSync(new URL("./fixtures/delivery_vectors.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

test("vectors are wire version 1", () => assert.equal(v.wire, 1));

test("the desktop's send payload opens on the phone", () => {
  assert.ok(payloadCandidates(v.send.payload).map(hex).includes(v.send.bytesHex));
});

for (const x of v.receive.filter((x: any) => x.phone)) {
  test(`phone: ${x.name}`, () => {
    assert.ok(payloadCandidates(x.payload).map(hex).includes(x.bytesHex), "sealed bytes among the candidates");
  });
}
