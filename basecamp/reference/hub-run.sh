#!/usr/bin/env bash
# scala headless-hub launcher (adapted from KYM's hub/kym-hub.sh). Starts the logoscore
# daemon with scala's modules + a Delivery config that PINS the logos.dev fleet, then
# loads scala_core (its manifest dep pulls delivery_module). Pair with a systemd unit
# (hub.service) for auto-restart.
#
# PREREQUISITES (the "load the modules" part):
#   1. logoscore binary built on cpp-sdk >= d77c3dd (PR #68) — REQUIRED, else the hub
#      connects + sends but RECEIVES NOTHING (Qt Remote Objects drops the off-thread
#      messageReceived signal). The newer daemon-CLI logoscore embeds the fix.
#   2. A modules dir containing the BUILT portable .lgx of: scala_core, delivery_module,
#      capability_module. Get delivery_module + capability_module from `nix build` of
#      scala_core's flake (they're inputs) — or copy them from an existing KYM/qaku hub
#      modules dir (e.g. ~/kym-hub/lmods-new2). Stage scala_core's own .lgx too.
set -euo pipefail
LOGOSCORE="${LOGOSCORE:-$HOME/logoscore-new/result/bin/logoscore}"
SCALA_MODULES_DIR="${SCALA_MODULES_DIR:-$HOME/scala-hub/lmods}"
export SCALA_CORE_DATA="${SCALA_CORE_DATA:-$HOME/.scala-core}"
export SCALA_DEVICE_ID="${SCALA_DEVICE_ID:-scala-hub}"
export SCALA_HUB="${SCALA_HUB:-1}"          # arms scala_core's self-drive QTimer tick (event-loop thread!)
export QT_QPA_PLATFORM=offscreen
export EMIT_FROM_THREAD=1
# Delivery config with the logos.dev fleet pinned (a bare {mode,preset} => "No peers for
# topic"). scala_core should merge this env JSON over its default (no rebuild to retarget).
export SCALA_DELIVERY_CFG="${SCALA_DELIVERY_CFG:-$(cat <<'JSON'
{"logLevel":"INFO","mode":"Core","preset":"logos.dev","relay":true,"entryNodes":["/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby","/dns4/delivery-02.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmMK7PYygBtKUQ8EHp7EfaD3bCEsJrkFooK8RQ2PVpJprH","/dns4/delivery-01.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm4S1JYkuzDKLKQvwgAhZKs9otxXqt8SCGtB4hoJP1S397","/dns4/delivery-02.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8Y9kgBNtjxvCnf1X6gnZJW5EGE4UwwCL3CCm55TwqBiH","/dns4/delivery-01.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8YokiNun9BkeA1ZRmhLbtNUvcwRr64F69tYj9fkGyuEP","/dns4/delivery-02.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAkvwhGHKNry6LACrB8TmEFoCJKEX29XR5dDUzk3UT3UNSE"]}
JSON
)}"
log(){ echo "[scala-hub $(date -u +%H:%M:%SZ)] $*"; }
[[ -x "$LOGOSCORE" ]] || { log "logoscore not at $LOGOSCORE (set LOGOSCORE=)"; exit 1; }
[[ -d "$SCALA_MODULES_DIR" ]] || { log "modules dir missing: $SCALA_MODULES_DIR"; exit 1; }
"$LOGOSCORE" stop >/dev/null 2>&1 || true; sleep 1
log "starting daemon (modules: $SCALA_MODULES_DIR)"; "$LOGOSCORE" -D -m "$SCALA_MODULES_DIR" &
DAEMON_PID=$!; trap '"$LOGOSCORE" stop >/dev/null 2>&1 || kill $DAEMON_PID 2>/dev/null || true' EXIT INT TERM
for _ in $(seq 1 60); do "$LOGOSCORE" status >/dev/null 2>&1 && break
  kill -0 "$DAEMON_PID" 2>/dev/null || { log "daemon died on startup"; exit 1; }; sleep 1; done
log "daemon up; loading scala_core"
"$LOGOSCORE" load-module scala_core || log "load-module returned nonzero (likely already loaded)"
"$LOGOSCORE" status || true
wait "$DAEMON_PID"
