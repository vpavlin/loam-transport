// SharedNodeBanner — the SDK-owned "shout" when the device-wide Loam node isn't usable.
//
// Every app on the shared node needs to tell the user the same two things — "Loam isn't
// running, tap to open it" and "this app isn't approved yet, tap to approve" — so this lives
// in the SDK instead of being hand-rolled per app (which is why some apps shouted and some
// stayed silent). Drop it in ONCE near the top of your screen:
//
//   import { SharedNodeBanner } from "<...>/loam-transport-pkg/src/SharedNodeBanner";
//   <SharedNodeBanner appName="Scala" />
//
// It renders nothing when the node is healthy (or when the app is on its own embedded node),
// polls health on a timer, and taps through to launch the Loam app. React-only — kept in its
// own module so headless/Node consumers of the transport never pull react-native.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { usingServiceBackend, serviceNodeDown, serviceAwaitingApproval, serviceNoPeers, launchSharedService, refreshDebug } from "./logos-transport";

// A confirmed 0-peer node must stay that way this long before we shout "not connected" — a freshly
// launched node legitimately sits at 0 peers for a few seconds while it meshes. Below this it's just
// "connecting…" (the SharedNodeStatus dot covers that); above it, the mesh has genuinely dropped.
const NO_PEERS_STUCK_MS = 15000;

export function SharedNodeBanner({ appName, pollMs = 2000, style }: { appName?: string; pollMs?: number; style?: any }) {
  const [, force] = useState(0);
  const noPeersSince = useRef(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { await refreshDebug(); } catch { /* */ } // pull live peers before judging the 0-peer case
      if (!alive) return;
      if (serviceNoPeers()) { if (!noPeersSince.current) noPeersSince.current = Date.now(); }
      else noPeersSince.current = 0;
      force((n) => n + 1);
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [pollMs]);

  if (!usingServiceBackend()) return null;           // on its own embedded node — nothing to shout
  const down = serviceNodeDown();
  const waiting = serviceAwaitingApproval();
  // The peer-drop: bound + running + approved but 0 peers for a sustained window (not a startup blip).
  const stuck = !down && !waiting && noPeersSince.current > 0 && Date.now() - noPeersSince.current > NO_PEERS_STUCK_MS;
  if (!down && !waiting && !stuck) return null;      // shared node healthy + approved + has peers

  const who = appName || "This app";
  const title = down ? "Loam isn't running" : waiting ? `${who} isn't approved yet` : "Not connected to Loam";
  const sub = down
    ? `Tap to open it — ${who} can't sync until Loam is running.`
    : waiting
      ? "Tap to open Loam and approve this app."
      : `The Loam node has no peers — changes save on this device but won't sync. Tap to open Loam, then restart it to reconnect.`;
  const icon = down ? "⚠️" : waiting ? "🔒" : "📡";
  return (
    <TouchableOpacity style={[st.banner, style]} activeOpacity={0.85} onPress={() => launchSharedService()}>
      <Text style={st.icon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={st.title}>{title}</Text>
        <Text style={st.sub}>{sub}</Text>
      </View>
      <Text style={st.cta}>OPEN ›</Text>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  banner: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#c2410c", borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 10 },
  icon: { fontSize: 24 },
  title: { color: "#fff", fontWeight: "700", fontSize: 14 },
  sub: { color: "rgba(255,255,255,0.85)", fontSize: 12, marginTop: 2 },
  cta: { color: "#fff", fontWeight: "700", fontSize: 13 },
});
