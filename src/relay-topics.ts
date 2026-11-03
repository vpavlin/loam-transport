// Which content topics go over plain relay instead of SDS reliable channels.
//
// Plain relay is the default for every topic (2026-11-03). SDS puts a ~19 KB rolling bloom filter on
// every message (nim-sds default: 10 000 entries at 0.1% false positives): measured on delivery 0.3.0,
// Scala frames were 760–1368 bytes over relay and 19.6–20.4 KB over channels, and Scala traffic cost
// the shrooms VPS ~356 GB in a day. Every app on Loam repairs gaps itself (loam-sync RBSR catch-up:
// Scala, KYM, Qaku, Perun, Kith, Freequencies) or needs no repair (Backpack: the newest signed note
// wins), so SDS added cost and a failure point (a channelCreate that could leave a topic pending).
// Relay and channel peers interoperate: a relay node peels the SDS frames it receives, and a channel
// node gets relay frames as plain messages on the topic.
//
// An app that still wants SDS channels opts in per prefix: setTopicMode("/myapp/", "channels").

const channelPrefixes = new Set<string>();

/** Topics starting with `prefix` use SDS channels ("channels") or plain relay ("relay", the default).
 *  Call before the topic is joined; a joined topic keeps its mode until the node restarts. */
export function setTopicMode(prefix: string, mode: "relay" | "channels"): void {
  if (!prefix) return;
  if (mode === "channels") channelPrefixes.add(prefix); else channelPrefixes.delete(prefix);
}

export function isRelayTopic(topic: string): boolean {
  for (const p of channelPrefixes) if (topic.startsWith(p)) return false;
  return true;
}
