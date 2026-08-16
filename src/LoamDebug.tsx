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

// Optional clipboard — resolved at load so the shared component keeps zero HARD deps: if the
// consuming app has expo-clipboard, the "copy" button appears; if not, rows stay long-press-copy.
let Clipboard: any = null;
try { Clipboard = require("expo-clipboard"); } catch { /* no clipboard in this app — degrade */ }

type Rows = Record<string, string | number>;

// Flatten the diagnostic sections into a paste-ready text block (for on-device bug reports).
function dumpText(appName: string | undefined, sections: Array<[string, Rows]>): string {
  const lines = [`🌱 loam debug${appName ? ` · ${appName}` : ""}  ${new Date().toISOString()}`];
  for (const [name, rows] of sections) {
    lines.push(`[${name}]`);
    for (const [k, v] of Object.entries(rows)) lines.push(`  ${k}: ${String(v)}`);
  }
  return lines.join("\n");
}

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
  const [copied, setCopied] = useState(false);
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
  const tele = safe(() => (t as any).telemetryStatus?.()) as any;
  if (tele && tele.enabled) sections.push(["telemetry", {
    buffered: tele.buffered, "last flush": tele.lastFlush || "—", "last err": tele.lastError || "—", topic: tele.topic || "—",
  }]);

  let ex: Rows | null = null;
  try { ex = extra ? extra() : null; } catch { ex = null; }
  if (ex && Object.keys(ex).length) sections.push([`${appName || "app"} sync`, ex]);

  const doCopy = async () => {
    try { await Clipboard.setStringAsync(dumpText(appName, sections)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  };

  return (
    <View style={[st.panel, style]}>
      <View style={st.head}>
        <Text style={st.title}>🌱 loam debug{appName ? ` · ${appName}` : ""}</Text>
        <View style={st.headBtns}>
          {Clipboard ? <TouchableOpacity onPress={doCopy}><Text style={[st.close, copied && { color: C.green }]}>{copied ? "copied ✓" : "copy ⧉"}</Text></TouchableOpacity> : null}
          <TouchableOpacity onPress={() => setOpen(false)}><Text style={st.close}>close ✕</Text></TouchableOpacity>
        </View>
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
  headBtns: { flexDirection: "row", alignItems: "center", gap: 14 },
  title: { color: C.green, fontSize: 12, fontFamily: "monospace", fontWeight: "700" },
  close: { color: C.faint, fontSize: 11, fontFamily: "monospace" },
  body: { paddingHorizontal: 12, paddingBottom: 8 },
  sec: { marginTop: 10 },
  secH: { color: C.faint, fontSize: 10, fontFamily: "monospace", letterSpacing: 1.2, marginBottom: 4 },
  row: { flexDirection: "row", paddingVertical: 2, gap: 8 },
  k: { color: C.soft, fontSize: 11, fontFamily: "monospace", width: 96 },
  v: { color: C.ink, fontSize: 11, fontFamily: "monospace", flex: 1 },
});
