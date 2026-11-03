import assert from "node:assert";
import { setTopicMode, isRelayTopic } from "../src/relay-topics.ts";

// plain relay is the default for every app
assert.equal(isRelayTopic("/scala/1/abc/json"), true, "Scala calendars use relay");
assert.equal(isRelayTopic("/backpack/1/abc/json"), true, "Backpack update notes use relay");
assert.equal(isRelayTopic("/qaku/1/abc/proto"), true, "so do the other apps");
assert.equal(isRelayTopic("/kym/1/x/proto"), true);
// SDS channels are opt-in per prefix, and can be undone
setTopicMode("/kith/", "channels");
assert.equal(isRelayTopic("/kith/1/x/json"), false, "an app can opt in to channels");
assert.equal(isRelayTopic("/kym/1/x/proto"), true, "only that app");
setTopicMode("/kith/", "relay");
assert.equal(isRelayTopic("/kith/1/x/json"), true, "and back out");
setTopicMode("", "channels");
assert.equal(isRelayTopic("/anything"), true, "an empty prefix is ignored");
console.log("relay-topics: ok");
