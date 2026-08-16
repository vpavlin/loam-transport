# loam-telemetry observability pipeline

Capture, compare and visualize Loam node health across phones **and** Basecamp/desktop nodes — including
the offline periods, because publishers buffer and flush when the fleet returns.

```
 Android Loam ──seal──┐
 (transport feature)  ├─▶ delivery: /loam-telemetry/1/<hash>/proto ─▶ hub loam_core (subscribed)
 Basecamp loam_core ──┘                                                     │  events
   (via loam-telemetry-publish.mjs)                                         ▼
                                            loam-telemetry-exporter.mjs (decode, latest-per-device)
                                                                            │
                                                             Prometheus /metrics ──▶ Grafana
```

All payloads are **sealed** (chacha20poly1305; topic + key derive from a pre-shared `TELEMETRY_SECRET`
via hkdf/hmac). Nothing without the secret can read or even locate the topic.

## Publishers

- **Android:** built into the transport — `transport.enableTelemetry(secret)` (opt-in via
  `EXPO_PUBLIC_TELEMETRY_SECRET`). The node buffers its own snapshots offline and flushes on reconnect.
- **Basecamp / headless:** `loam-telemetry-publish.mjs` reads a node's `metricsJson()` and publishes a
  sealed snapshot via its `sendSealed()` — no C++ crypto needed:
  ```
  TELEMETRY_SECRET=S node loam-telemetry-publish.mjs --dev basecamp-hub \
    --metrics-cmd 'logos-hub call loam loam_core metricsJson' \
    --publish-cmd 'logos-hub call loam loam_core sendSealed {topic} {payload}'
  ```

## Capture + expose

Via the hub (loam_core is the capture point):
```
logos-hub telemetry loam --secret S \
  --exporter .../tools/loam-telemetry-exporter.mjs --port 9109
```
Then point Prometheus at `host:9109/metrics`. Metrics are labeled `dev` + `src` (`android`|`basecamp`),
so Grafana can compare nodes and platforms. Bearer stats a publisher sends but the exporter doesn't name
explicitly appear as `loam_x_<field>` gauges automatically.

Run the Node tools from an app dir so `@noble` resolves. `--topic` on either tool prints the topic to
subscribe. Seal↔open byte-parity and the full publish→decode→/metrics loop are verified in Node.
