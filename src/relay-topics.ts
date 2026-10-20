// Which content topics go over plain relay instead of SDS reliable channels.
//
// SDS puts a ~19 KB rolling bloom filter on every message (nim-sds default: 10 000 entries at
// 0.1% false positives). For an app whose own sync already repairs gaps (Scala's RBSR catch-up),
// that is pure overhead: measured on delivery 0.3.0, the same Scala frames were 760–1368 bytes
// over relay and 19.6–20.4 KB over channels. Desktop Scala (0.12.7, loam_core setTopicMode)
// sends its calendars over relay; phones follow with this. Relay and channel peers interoperate:
// a relay node peels the SDS frames it receives, and a channel node gets relay frames as plain
// messages on the topic.
//
// Per topic, so apps sharing one node keep their own choice. The default lists Scala so the Loam
// app (the shared node other apps reach over AIDL) does the same for Scala without a new AIDL call.

const prefixes = new Set<string>(["/scala/"]);

/** Topics starting with `prefix` use plain relay ("relay") or SDS channels ("channels"). Call
 *  before the topic is joined; a joined topic keeps its mode until the node restarts. */
export function setTopicMode(prefix: string, mode: "relay" | "channels"): void {
  if (!prefix) return;
  if (mode === "relay") prefixes.add(prefix); else prefixes.delete(prefix);
}

export function isRelayTopic(topic: string): boolean {
  for (const p of prefixes) if (topic.startsWith(p)) return true;
  return false;
}
