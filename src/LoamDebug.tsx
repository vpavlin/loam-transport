// LoamDebug — an embeddable, collapsible diagnostics panel for any Loam app. Drop it behind a
// dev button and it surfaces everything the shared node + transport + BLE mesh know, in Loam
// style. Zero extra deps (no Clipboard/Modal): a tap-to-expand inline panel with selectable
// rows so you can long-press-copy on device.
//
//   import { LoamDebug } from "<...>/loam-transport-pkg/src/LoamDebug";
//   {devMode && <LoamDebug appName="KYM" extra={() => ({ "sync behind": String(behind) })} />}
//
// `extra` lets an app inject its own rows (e.g. a logos-sync summary) — merged under a section.
// React-only; kept out of the transport's main entry so headless/Node consumers skip react.
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import * as t from "./logos-transport";

type Rows = Record<string, string | number>;

export function LoamDebug({
  appName,
  extra,
  pollMs = 1500,
  defaultOpen = false,
  style,
}: {
  appName?: string;
  extra?: () => Rows;
  pollMs?: number;
  defaultOpen?: boolean;
  style?: any;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [, force] = useState(0);
  const [diag, setDiag] = useState("");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const tick = async () => {
      try { await t.refreshPeerInfo(); } catch { /* */ }
      try { setDiag(await t.serviceDiag()); } catch { /* */ }
      if (alive) force((n) => n + 1);
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [open, pollMs]);

  if (!open) {
    return (
      <TouchableOpacity style={[st.tab, style]} onPress={() => setOpen(true)}>
        <Text style={st.tabT}>🌱 loam debug</Text>
      </TouchableOpacity>
    );
  }

  const c = t.counters as any;
  const backend = (() => {
    try {
      if (!t.deliveryAvailable()) return "none";
      if (t.usingServiceBackend()) return t.serviceNodeDown() ? "shared · DOWN" : t.serviceAwaitingApproval() ? "shared · awaiting approval" : "shared node";
      return "own node";
    } catch { return "?"; }
  })();

  const sections: Array<[string, Rows]> = [
    ["shared node", {
      backend,
      mode: safe(() => t.getNodeMode()),
      "diag": diag || "—",
      store: safe(() => t.getStoreInfo()) || "—",
    }],
    ["transport", {
      peers: c.peers, mesh: c.mesh,
      "rx raw": c.rxRaw, "rx new": c.rxNew, "rx dup": c.rxDup, "rx openfail": c.rxOpenFail,
      "tx total": c.txTotal, "tx fail": c.txFail,
      "tx err": c.txErr || "—", "rx sample": safe(() => t.getRxSample()) || "—",
    }],
    ["ble mesh (offline)", {
      armed: safe(() => t.meshEnabled()) ? "yes" : "no",
      "ble peers": safe(() => t.meshPeers()),
      forced: safe(() => t.meshForcedOn()) ? "yes" : "no",
      "ble tx": c.bleTx, "ble rx": c.bleRx,
    }],
  ];
  let ex: Rows | null = null;
  try { ex = extra ? extra() : null; } catch { ex = null; }
  if (ex && Object.keys(ex).length) sections.push([`${appName || "app"} sync`, ex]);

  return (
    <View style={[st.panel, style]}>
      <View style={st.head}>
        <Text style={st.title}>🌱 loam debug{appName ? ` · ${appName}` : ""}</Text>
        <TouchableOpacity onPress={() => setOpen(false)}><Text style={st.close}>close ✕</Text></TouchableOpacity>
      </View>
      <ScrollView style={st.body} nestedScrollEnabled>
        {sections.map(([name, rows]) => (
          <View key={name} style={st.sec}>
            <Text style={st.secH}>{name}</Text>
            {Object.entries(rows).map(([k, v]) => (
              <View key={k} style={st.row}>
                <Text style={st.k}>{k}</Text>
                <Text style={st.v} selectable numberOfLines={3}>{String(v)}</Text>
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function safe<T>(f: () => T): T | "" { try { return f(); } catch { return "" as any; } }

const C = { surface: "#1E1813", tile: "#2C2318", line: "#3A2E20", ink: "#ECE5D6", soft: "#A08E76", faint: "#7C6D58", green: "#8ECB6F" };
const st = StyleSheet.create({
  tab: { alignSelf: "flex-start", borderColor: C.line, borderWidth: 1, borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10, backgroundColor: C.surface },
  tabT: { color: C.green, fontSize: 11, fontFamily: "monospace" },
  panel: { backgroundColor: C.surface, borderColor: C.green, borderWidth: 1, borderRadius: 12, overflow: "hidden", maxHeight: 340, width: "100%" },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 9, borderBottomColor: C.line, borderBottomWidth: 1 },
  title: { color: C.green, fontSize: 12, fontFamily: "monospace", fontWeight: "700" },
  close: { color: C.faint, fontSize: 11, fontFamily: "monospace" },
  body: { paddingHorizontal: 12, paddingBottom: 8 },
  sec: { marginTop: 10 },
  secH: { color: C.faint, fontSize: 10, fontFamily: "monospace", letterSpacing: 1.2, marginBottom: 4 },
  row: { flexDirection: "row", paddingVertical: 2, gap: 8 },
  k: { color: C.soft, fontSize: 11, fontFamily: "monospace", width: 96 },
  v: { color: C.ink, fontSize: 11, fontFamily: "monospace", flex: 1 },
});
