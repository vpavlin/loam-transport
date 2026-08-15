// SharedNodeStatus — the one component every Loam app mounts to get consistent shared-node
// UX. Bundles the three things that were copy-pasted (or forgotten) per app:
//   1. the node-down / not-approved banner (SharedNodeBanner) — the "shout",
//   2. a peer-info refresh poll — so peer/mesh counts stay live (scala/perun never polled),
//   3. an optional compact sync line (perun had none).
//
// Mount once near the top of your screen:
//   import { SharedNodeStatus } from "<...>/loam-transport-pkg/src/SharedNodeStatus";
//   <SharedNodeStatus appName="Scala" showSync />
//
// React-only; kept out of the transport's main entry so headless/Node consumers skip react.
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { SharedNodeBanner } from "./SharedNodeBanner";
import { counters, refreshPeerInfo, serviceDiag } from "./logos-transport";

export function SharedNodeStatus({
  appName,
  showSync = false,
  debug = false,
  pollMs = 3000,
  style,
}: { appName?: string; showSync?: boolean; debug?: boolean; pollMs?: number; style?: any }) {
  const [, force] = useState(0);
  const [diag, setDiag] = useState("");
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { await refreshPeerInfo(); } catch { /* best-effort */ }
      if (debug) { try { setDiag(await serviceDiag()); } catch { /* */ } }
      if (alive) force((n) => n + 1);
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [pollMs, debug]);

  return (
    <View style={style}>
      <SharedNodeBanner appName={appName} />
      {showSync ? <SyncLine /> : null}
      {debug && diag ? <Text style={st.diag} selectable>{diag}</Text> : null}
    </View>
  );
}

// Compact, opinion-free sync indicator driven by the SDK counters. A dot + a word so any
// app reads the same: green = peers + mesh, amber = peers but mesh still forming, grey = none.
function SyncLine() {
  const peers = counters.peers;
  const meshForming = counters.mesh === 0;
  const color = peers > 0 && !meshForming ? "#22c55e" : peers > 0 ? "#f59e0b" : "#9ca3af";
  const label =
    peers > 0 ? `${peers} peer${peers === 1 ? "" : "s"}${meshForming ? " · forming…" : ""}` : "connecting…";
  return (
    <View style={st.row}>
      <View style={[st.dot, { backgroundColor: color }]} />
      <Text style={st.txt}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  txt: { color: "#9ca3af", fontSize: 12 },
  diag: { color: "#f59e0b", fontSize: 10, fontFamily: "monospace", marginTop: 4 },
});
