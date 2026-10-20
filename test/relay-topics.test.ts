import assert from "node:assert";
import { setTopicMode, isRelayTopic } from "../src/relay-topics.ts";

assert.equal(isRelayTopic("/scala/1/abc/json"), true, "Scala calendars use relay by default");
assert.equal(isRelayTopic("/qaku/1/abc/proto"), false, "other apps keep channels");
assert.equal(isRelayTopic("/kith/1/x/json"), false);
setTopicMode("/kith/", "relay");
assert.equal(isRelayTopic("/kith/1/x/json"), true, "an app can opt in");
setTopicMode("/scala/", "channels");
assert.equal(isRelayTopic("/scala/1/abc/json"), false, "and back out");
setTopicMode("", "relay");
assert.equal(isRelayTopic("/anything"), false, "an empty prefix is ignored");
console.log("relay-topics: ok");
