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
import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { usingServiceBackend, serviceNodeDown, serviceAwaitingApproval, launchSharedService } from "./logos-transport";

export function SharedNodeBanner({ appName, pollMs = 2000, style }: { appName?: string; pollMs?: number; style?: any }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  if (!usingServiceBackend()) return null;           // on its own embedded node — nothing to shout
  const down = serviceNodeDown();
  const waiting = serviceAwaitingApproval();
  if (!down && !waiting) return null;                // shared node healthy + approved

  const who = appName || "This app";
  return (
    <TouchableOpacity style={[st.banner, style]} activeOpacity={0.85} onPress={() => launchSharedService()}>
      <Text style={st.icon}>{down ? "⚠️" : "🔒"}</Text>
      <View style={{ flex: 1 }}>
        <Text style={st.title}>{down ? "Loam isn't running" : `${who} isn't approved yet`}</Text>
        <Text style={st.sub}>
          {down
            ? `Tap to open it — ${who} can't sync until Loam is running.`
            : "Tap to open Loam and approve this app."}
        </Text>
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
