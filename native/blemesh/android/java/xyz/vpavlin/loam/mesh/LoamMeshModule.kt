package xyz.vpavlin.loam.mesh

// Loam BLE mesh radio (ADR 0012) — the native MeshRadio the portable BleMeshBearer drives.
// Dual-role: each device runs a GATT SERVER (peripheral: advertises the Loam service +
// exposes one write/notify characteristic) AND a scanner+GATT CLIENT (central: connects to
// other Loam devices, subscribes to their characteristic). A "peer" is a connected device by
// address, in either role. sendTo(peer,bytes) fragments to the negotiated MTU and delivers
// via write (if we're that peer's central) or notify (if it's a central connected to us).
//
// This is a LINK layer only — no gossip/dedup/TTL here; that all lives in the portable
// BleMeshBearer. JS receives ("loamMeshRx" {peer, data:base64}) and peer changes
// ("loamMeshPeers" {peers:[…]}) as DeviceEventEmitter events.
//
// STATUS: written against Android BLE norms but NOT yet device-verified — expect on-hardware
// iteration (connection races, MTU, background). Prototype with 2 phones in foreground first.
import android.bluetooth.*
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class LoamMeshModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  companion object {
    // One fixed service+characteristic identifies the Loam mesh. All Loam apps share the
    // ONE device-wide mesh (mirrors the one shared Waku node), so the UUID is app-agnostic.
    val SERVICE_UUID: UUID = UUID.fromString("10a11052-0000-4c6f-616d-6d6573680001") // "Loammesh"
    val CHAR_UUID: UUID = UUID.fromString("10a11052-0000-4c6f-616d-6d6573680002")
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    const val DEFAULT_MTU = 512
    const val TAG = "LOAMMESH"
    // GATT payload type byte (ADR 0014): 'A' announce (payload = node id), 'Q' announce and ask the
    // peer to announce back (sent while we still don't know who is on a link), 'F' fragment.
    const val T_ANNOUNCE = 0x41
    const val T_ANNOUNCE_REQ = 0x51
    const val T_FRAG = 0x46
    const val WIRE_ID_BYTES = 12   // node id on the wire = base64url(sha256(deviceId)[0..12]) = 16 chars
    const val REASM_TIMEOUT_MS = 30000L
    // Android caps one attribute value at 512 bytes whatever the MTU: a write/notify longer than that is
    // rejected by the peer (API < 33) or throws IllegalArgumentException (API 33+). MTU 517 allows 514.
    const val MAX_ATTR_LEN = 512
  }

  override fun getName() = "LoamMesh"

  // Breadcrumb trail (debug): JS marks node lifecycle steps; the file survives a native crash, and the
  // previous run's trail is shown by lastCrash(). Rotated once per process start.
  private val trail = java.util.ArrayDeque<String>()
  private val trailFile by lazy { java.io.File(ctx.filesDir, "loam-trail.txt") }
  init {
    try {
      val f = java.io.File(ctx.filesDir, "loam-trail.txt")
      if (f.exists()) f.renameTo(java.io.File(ctx.filesDir, "loam-trail-prev.txt"))
    } catch (_: Exception) {}
  }
  @ReactMethod fun mark(s: String) {
    try {
      synchronized(trail) {
        val t = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
        trail.addLast("$t $s"); while (trail.size > 80) trail.removeFirst()
        trailFile.writeText(trail.joinToString("\n"))
      }
    } catch (_: Exception) {}
  }

  private val adapter: BluetoothAdapter? by lazy {
    (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
  }
  private var gattServer: BluetoothGattServer? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var scanner: BluetoothLeScanner? = null
  private var characteristic: BluetoothGattCharacteristic? = null

  // peers we are CENTRAL to (we hold the client GATT) and peers that are CENTRAL to us
  // (connected to our server). A device address in either map is a reachable peer.
  private val clientGatts = ConcurrentHashMap<String, BluetoothGatt>()
  private val serverDevices = ConcurrentHashMap<String, BluetoothDevice>()
  private val mtu = ConcurrentHashMap<String, Int>()
  private val connecting = ConcurrentHashMap<String, Boolean>()
  // reassembly buffers keyed by "addr/msgId"
  private val reasm = ConcurrentHashMap<String, MutableMap<Int, ByteArray>>()
  private val reasmCount = ConcurrentHashMap<String, Int>()
  private var msgSeq = 0
  // Per-peer send queue + in-flight flag. BLE allows ONE outstanding GATT op per link, so
  // fragments MUST go one at a time, each after the previous completes (onCharacteristicWrite
  // / onNotificationSent). Firing them back-to-back drops all but one -> reassembly never
  // completes -> nothing is ever received (the bleTx>0, bleRx=0 symptom).
  private val sendQ = ConcurrentHashMap<String, java.util.ArrayDeque<ByteArray>>()
  private val inFlight = ConcurrentHashMap<String, Boolean>()
  private val inFlightSince = ConcurrentHashMap<String, Long>()
  private val IN_FLIGHT_TIMEOUT_MS = 5000L   // a completion callback that never comes must not wedge the link
  private val MAX_QUEUE_FRAMES = 1500        // refuse new messages past this backlog instead of growing forever
  private val setupDone = ConcurrentHashMap<String, Boolean>()   // client link finished MTU → discover → CCCD
  // on-screen diagnostics (surfaced via stats(); no adb needed)
  @Volatile private var stFragSent = 0
  @Volatile private var stWriteOk = 0
  @Volatile private var stWriteFail = 0
  @Volatile private var stFragRecv = 0
  @Volatile private var stDelivered = 0
  @Volatile private var stLastFrag = ""
  @Volatile private var stLastErr = ""
  // Stable-identity layer (ADR 0014). Peers/routing/dedup/count are keyed by NODE ID, not the
  // rotating BLE MAC — this collapses RPA "ghost" peers to one logical device. The node id is
  // the app's stable deviceId, set by JS before start() and announced on every link.
  @Volatile private var myNodeId: String = ""
  // What we announce: a fixed 16-char hash of the node id. An announce is 1 + id bytes and has to
  // fit one GATT write/notify (MTU - 3 = 20 bytes if MTU negotiation fails); the raw deviceId
  // ("dev-…", ~24 chars) did not. Peers only use the id as an opaque key.
  @Volatile private var wireId: String = ""
  private val addrToNode = ConcurrentHashMap<String, String>()               // BLE address -> peer node id
  private val nodeToAddrs = ConcurrentHashMap<String, MutableSet<String>>()  // node id -> its link addresses
  private val reasmTime = ConcurrentHashMap<String, Long>()                  // reassembly key -> first-seen ms
  // Connection setup must be SERIALIZED (BLE allows one GATT op per link): MTU -> discover -> CCCD
  // write -> announce, each step driven by the previous op's completion callback. Firing them
  // back-to-back was the root bug — the announce collided with the in-flight CCCD write, got
  // dropped, and the peer stayed unannounced -> unrouted -> silent (ADR 0014). We also re-announce
  // periodically until the peer is learned, per ADR 0014's "send on connect and periodically".
  private val mainHandler = Handler(Looper.getMainLooper())
  private val discovered = ConcurrentHashMap<String, Boolean>()   // discoverServices already issued for this link?
  private val announceTries = ConcurrentHashMap<String, Int>()    // bounded re-announce attempts per link
  private val ANNOUNCE_RETRY_MS = 2500L
  private val ANNOUNCE_MAX_TRIES = 8
  // While we don't know who is on a link (client OR server side), ask: an announce-REQ makes the
  // peer announce back. (Re-sending only OUR id never taught us THEIRS, and a server link used to
  // announce exactly once, so one lost frame left the link one-way for good.) A link that stays
  // anonymous for ANNOUNCE_MAX_TRIES ticks is dropped so the scanner re-dials it from scratch;
  // that also clears zombie links whose setup silently failed.
  private val announceRetry = object : Runnable {
    override fun run() {
      if (wireId.isNotEmpty()) try {
        val now = System.currentTimeMillis()
        for ((addr, since) in inFlightSince) {
          if (inFlight[addr] == true && now - since > IN_FLIGHT_TIMEOUT_MS) {
            inFlight[addr] = false; inFlightSince.remove(addr); stWriteFail++; stLastErr = "send timeout"
            pump(addr)
          }
        }
        for (addr in (clientGatts.keys + serverDevices.keys).toSet()) {
          // A client link still in setup has a GATT op in flight: a Q now would collide with it.
          if (clientGatts.containsKey(addr) && setupDone[addr] != true && !serverDevices.containsKey(addr)) continue
          if (addrToNode.containsKey(addr)) { announceTries.remove(addr); continue }  // peer known on this link
          val n = announceTries[addr] ?: 0
          if (n < ANNOUNCE_MAX_TRIES) { announceTries[addr] = n + 1; sendAnnounce(addr, askBack = true) }
          else { dropLink(addr, "no announce after ${n} tries") }
        }
      } catch (e: Exception) { Log.e(TAG, "announceRetry", e) }
      mainHandler.postDelayed(this, ANNOUNCE_RETRY_MS)
    }
  }

  // ── JS API ────────────────────────────────────────────────────────────────
  // Set our stable node id (the app's deviceId). MUST be called before start() so our first
  // announce carries it. Idempotent.
  @ReactMethod fun setNodeId(id: String, promise: Promise) {
    myNodeId = id
    val h = java.security.MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).copyOf(WIRE_ID_BYTES)
    wireId = Base64.encodeToString(h, Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE)
    Log.i(TAG, "nodeId=$id wire=$wireId"); promise.resolve(true)
  }

  @ReactMethod fun start(promise: Promise) {
    try {
      val a = adapter ?: return promise.reject("no_bt", "no Bluetooth adapter")
      if (!a.isEnabled) return promise.reject("bt_off", "Bluetooth is off")
      Log.i(TAG, "start: ${Build.MANUFACTURER} ${Build.MODEL} api=${Build.VERSION.SDK_INT} peripheralAdvSupported=${a.isMultipleAdvertisementSupported} self=${a.address}")
      stopInternal()   // idempotent: a start after a partial/failed start begins clean
      startServer(a)
      startAdvertising(a)
      startScanning(a)
      mainHandler.postDelayed(announceRetry, ANNOUNCE_RETRY_MS)   // ADR 0014: ask until learned
      promise.resolve(true)
    } catch (e: Exception) {
      // e.g. SecurityException (Nearby devices denied) after the GATT server was already open: release
      // it, or every retry would open another server with a duplicate Loam service.
      try { stopInternal() } catch (_: Exception) {}
      promise.reject("start_fail", e.message, e)
    }
  }

  @ReactMethod fun stop(promise: Promise) {
    try { stopInternal(); promise.resolve(true) } catch (e: Exception) { promise.reject("stop_fail", e.message, e) }
  }

  // Tear down radios AND every per-link table. close() fires no disconnect callback, so forgetAddr never
  // ran for these links; stale inFlight/sendQ/identity entries then muted a re-formed link to the same
  // address (pump() saw inFlight=true forever).
  private fun stopInternal() {
    mainHandler.removeCallbacks(announceRetry)
    try { advertiser?.stopAdvertising(advCallback) } catch (_: Exception) {}
    try { scanner?.stopScan(scanCallback) } catch (_: Exception) {}
    for (g in clientGatts.values) try { g.close() } catch (_: Exception) {}
    try { gattServer?.close() } catch (_: Exception) {}
    gattServer = null
    clientGatts.clear(); serverDevices.clear(); mtu.clear(); connecting.clear()
    discovered.clear(); announceTries.clear()
    inFlight.clear(); inFlightSince.clear(); setupDone.clear(); sendQ.clear(); addrToNode.clear(); nodeToAddrs.clear()
    reasm.clear(); reasmCount.clear(); reasmTime.clear()
  }

  // Drop a link we can't use (anonymous, or services missing) so the scanner re-dials it cleanly.
  private fun dropLink(addr: String, why: String) {
    Log.w(TAG, "dropping link $addr: $why")
    stLastErr = "drop $why"
    announceTries.remove(addr)
    clientGatts[addr]?.let { try { it.disconnect() } catch (_: Exception) {} }
    serverDevices[addr]?.let { d -> try { gattServer?.cancelConnection(d) } catch (_: Exception) {} }
  }

  @ReactMethod fun peers(promise: Promise) {
    val arr = Arguments.createArray()
    for (p in connectedPeers()) arr.pushString(p)
    promise.resolve(arr)
  }

  // Compact on-screen diagnostic (App.tsx polls this) so we can localize the BLE data path
  // without adb: sent/wOk/wFail = fragments we tried/succeeded/failed to send; recv/deliv =
  // fragments received / whole messages delivered up to JS; mtu = negotiated per peer.
  @ReactMethod fun stats(promise: Promise) {
    val mtus = if (mtu.isEmpty()) "-" else mtu.values.toSet().joinToString(",")
    val links = (clientGatts.keys + serverDevices.keys).toSet()
    val pend = links.count { !addrToNode.containsKey(it) }
    val me = wireId.take(6)
    val backlog = sendQ.values.sumOf { q -> synchronized(q) { q.size } }
    promise.resolve("node=$me nodes=${connectedPeers().size} cli=${clientGatts.size} srv=${serverDevices.size} pend=$pend q=$backlog mtu=$mtus " +
      "sent=$stFragSent wOk=$stWriteOk wFail=$stWriteFail recv=$stFragRecv deliv=$stDelivered reasm=${reasm.size} lastFrag=$stLastFrag" +
      (if (stLastErr.isNotEmpty()) " err=$stLastErr" else ""))
  }

  // Last crash report for on-screen display: the JVM/JS crash file the app's uncaught handler writes
  // (loam-last-crash.txt), plus Android's own record of recent process exits (API 30+), which also
  // covers native crashes and ANRs the JVM handler never sees.
  // Crash report for on-screen display — "" unless there's a crash the user hasn't dismissed yet.
  // Sources: the JVM/JS crash file the app's uncaught handler writes (loam-last-crash.txt), and
  // Android's record of process exits (API 30+) filtered to real crashes (JVM crash, native crash,
  // ANR, or killed by a fatal signal) newer than the last dismiss. The previous run's breadcrumb
  // trail is attached for context. Each section is truncated on its own, head first.
  private val crashPrefs by lazy { ctx.getSharedPreferences("loam-crash", Context.MODE_PRIVATE) }
  @ReactMethod fun lastCrash(promise: Promise) {
    val seen = crashPrefs.getLong("seenTs", 0L)
    val sb = StringBuilder()
    var crashed = false
    try {
      val f = java.io.File(ctx.filesDir, "loam-last-crash.txt")
      if (f.exists()) { crashed = true; sb.append("JVM crash:\n").append(f.readText().take(4000)).append("\n") }
    } catch (_: Exception) {}
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        for (x in am.getHistoricalProcessExitReasons(ctx.packageName, 0, 6)) {
          if (x.timestamp <= seen) continue
          val fatalSignal = x.reason == android.app.ApplicationExitInfo.REASON_SIGNALED && x.status in setOf(4, 6, 7, 8, 11)
          val crash = fatalSignal || x.reason == android.app.ApplicationExitInfo.REASON_CRASH ||
            x.reason == android.app.ApplicationExitInfo.REASON_CRASH_NATIVE || x.reason == android.app.ApplicationExitInfo.REASON_ANR
          if (!crash) continue
          crashed = true
          sb.append("exit ${java.util.Date(x.timestamp)} proc=${x.processName} reason=${x.reason} status=${x.status} ${x.description ?: ""}\n")
          // ANR traces are text. Native-crash traces (API 31+) are binary tombstones that can include raw
          // memory, so they are never shown or copied.
          if (x.reason == android.app.ApplicationExitInfo.REASON_ANR) try {
            x.traceInputStream?.use { ins -> sb.append(ins.bufferedReader().lineSequence().take(40).joinToString("\n") { it.take(200) }).append("\n") }
          } catch (_: Exception) {}
        }
      }
    } catch (e: Exception) { sb.append("exit info unavailable: ${e.message}\n") }
    if (!crashed) { promise.resolve(""); return }
    try {
      val f = java.io.File(ctx.filesDir, "loam-trail-prev.txt")
      if (f.exists()) sb.append("previous run, last steps:\n").append(f.readText().lines().takeLast(40).joinToString("\n") { it.take(200) }).append("\n")
    } catch (_: Exception) {}
    promise.resolve(sb.toString().take(16000))
  }

  // Is there any network that claims internet? The node re-dial and renewal are skipped when not:
  // dialing with no network is pointless, and touching the node's networking offline has crashed it.
  // NOT "validated": Android leaves that false behind a Wi-Fi login page, on some VPNs and on mesh
  // networks, where the fleet may well be reachable, and skipping renewal there silently stops receive.
  @ReactMethod fun online(promise: Promise) {
    try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
      val caps = cm.getNetworkCapabilities(cm.activeNetwork)
      promise.resolve(caps?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true)
    } catch (_: Exception) { promise.resolve(true) }   // unknown: behave as before
  }

  // Dismiss: hide everything up to now (exits are Android's record, so remember a timestamp).
  @ReactMethod fun clearCrash(promise: Promise) {
    try { crashPrefs.edit().putLong("seenTs", System.currentTimeMillis()).apply() } catch (_: Exception) {}
    try { java.io.File(ctx.filesDir, "loam-last-crash.txt").delete() } catch (_: Exception) {}
    promise.resolve(true)
  }

  // sendTo(nodeId, base64) — pick ONE live link for that node and send. `peer` is a stable
  // NODE ID (ADR 0014), not a MAC — so duplicate ghost links are collapsed to a single send.
  @ReactMethod fun sendTo(peer: String, dataB64: String, promise: Promise) {
    try {
      val bytes = Base64.decode(dataB64, Base64.NO_WRAP)
      val addr = addrForNode(peer)
      if (addr == null) { Log.d(TAG, "sendTo node=$peer — no live link"); promise.resolve(false); return }
      Log.d(TAG, "sendTo node=$peer via $addr ${bytes.size}B")
      sendFragments(addr, bytes)
      promise.resolve(true)
    } catch (e: Exception) { promise.reject("send_fail", e.message, e) }
  }
  // One link per node: prefer a client link (write path has the onCharacteristicWrite
  // flow-control callback); fall back to a server link (notify).
  private fun addrForNode(node: String): String? {
    val addrs = nodeToAddrs[node] ?: return null
    return addrs.firstOrNull { clientGatts.containsKey(it) } ?: addrs.firstOrNull { serverDevices.containsKey(it) }
  }
  // Announce our node id over a link (jumps the send queue so peers learn identity first).
  // askBack = also ask the peer to announce itself (we don't know who is on this link yet).
  private fun sendAnnounce(addr: String, askBack: Boolean = false) {
    if (wireId.isEmpty()) return
    val idb = wireId.toByteArray(Charsets.UTF_8)
    val frame = ByteArray(1 + idb.size); frame[0] = (if (askBack) T_ANNOUNCE_REQ else T_ANNOUNCE).toByte(); System.arraycopy(idb, 0, frame, 1, idb.size)
    val q = sendQ.getOrPut(addr) { java.util.ArrayDeque() }
    synchronized(q) { q.addFirst(frame) }
    Log.d(TAG, "announce -> $addr (wire ${wireId.take(6)}, ${frame.size}B)")
    pump(addr)
  }

  // ── peripheral (GATT server) ────────────────────────────────────────────────
  private fun startServer(a: BluetoothAdapter) {
    val mgr = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    val server = mgr.openGattServer(ctx, serverCallback)
    val svc = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    val ch = BluetoothGattCharacteristic(
      CHAR_UUID,
      BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    ch.addDescriptor(BluetoothGattDescriptor(CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
    svc.addCharacteristic(ch)
    server.addService(svc)
    gattServer = server
    characteristic = ch
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      Log.d(TAG, "server conn ${device.address} state=$newState status=$status")
      if (newState == BluetoothProfile.STATE_CONNECTED) { serverDevices[device.address] = device; emitPeers() }
      else if (newState == BluetoothProfile.STATE_DISCONNECTED) { serverDevices.remove(device.address); forgetAddr(device.address); emitPeers() }
    }
    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice, requestId: Int, ch: BluetoothGattCharacteristic,
      preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray,
    ) {
      Log.d(TAG, "server<-write ${device.address} ${value.size}B match=${ch.uuid == CHAR_UUID} prepared=$preparedWrite")
      // Frames are sized to fit one write; a prepared (long) write would arrive as unrelated chunks
      // and needs onExecuteWrite, which we don't implement. Refuse it rather than corrupt a frame.
      if (preparedWrite) { if (responseNeeded) try { gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null) } catch (_: Exception) {}; return }
      if (ch.uuid == CHAR_UUID) onFragment(device.address, value)
      if (responseNeeded) try { gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null) } catch (_: Exception) {}
    }
    // A central enabling notifications writes our CCCD. If we never answer, the client's
    // writeDescriptor never completes and notifications stay OFF — the server->central
    // direction silently dies. Always acknowledge.
    override fun onDescriptorWriteRequest(
      device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray,
    ) {
      Log.d(TAG, "server<-cccd ${device.address} (notify enable)")
      if (responseNeeded) try { gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null) } catch (_: Exception) {}
      sendAnnounce(device.address)   // central can now receive notifications → tell it who we are
    }
    override fun onMtuChanged(device: BluetoothDevice, m: Int) { mtu[device.address] = m }
    // A notification finished sending — send the next queued fragment to this central.
    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) { stWriteOk--; stWriteFail++; stLastErr = "notify status $status" }
      inFlightSince.remove(device.address)
      inFlight[device.address] = false
      pump(device.address)
    }
  }

  private fun startAdvertising(a: BluetoothAdapter) {
    val adv = a.bluetoothLeAdvertiser
    if (adv == null) { Log.e(TAG, "NO BLE advertiser — phone can't be a peripheral (won't be discovered; can still dial+write as central)"); return }
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setConnectable(true)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .build()
    val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE_UUID)).build()
    adv.startAdvertising(settings, data, advCallback)
    advertiser = adv
  }
  private val advCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings) { Log.i(TAG, "advertise started") }
    override fun onStartFailure(errorCode: Int) { Log.e(TAG, "advertise FAILED err=$errorCode") }
  }

  // ── central (scan + GATT client) ────────────────────────────────────────────
  private fun startScanning(a: BluetoothAdapter) {
    val s = a.bluetoothLeScanner
    if (s == null) { Log.e(TAG, "NO BLE scanner — phone can't be a central (won't dial; can still be discovered as peripheral)"); return }
    val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build())
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    s.startScan(filters, settings, scanCallback)
    scanner = s
  }
  private val scanCallback = object : ScanCallback() {
    override fun onScanFailed(errorCode: Int) { Log.e(TAG, "scan FAILED err=$errorCode") }
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      val dev = result.device
      val addr = dev.address
      // No MAC tie-break (RPA makes adapter.address useless, ADR 0014): always establish OUR
      // client link (reliable write path) to any peer we don't already dial. Redundant links to
      // the same physical device are harmless — routing dedups by node id (addrForNode).
      if (clientGatts.containsKey(addr) || connecting[addr] == true) return
      Log.d(TAG, "scan saw $addr — dialing")
      connecting[addr] = true
      // TRANSPORT_LE: without it dual-mode phones may try BR/EDR and fail with status 133.
      try {
        if (Build.VERSION.SDK_INT >= 23) dev.connectGatt(ctx, false, clientCallback, BluetoothDevice.TRANSPORT_LE)
        else dev.connectGatt(ctx, false, clientCallback)
      } catch (e: Exception) { connecting.remove(addr); stLastErr = "connect threw"; Log.e(TAG, "connectGatt $addr threw", e) }
    }
  }
  private val clientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val addr = gatt.device.address
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        clientGatts[addr] = gatt; connecting.remove(addr); discovered[addr] = false; emitPeers()
        Log.d(TAG, "client connected $addr — requestMtu then discover")
        // Serialize: request MTU, then discover in onMtuChanged (one GATT op at a time). If the MTU
        // callback never fires (some stacks are silent), a fallback timer discovers anyway — so we
        // neither collide the two ops NOR stall discovery on a silent stack. discoverOnce() guards
        // against the two paths both firing.
        if (!gatt.requestMtu(DEFAULT_MTU)) discoverOnce(gatt)     // couldn't queue MTU → discover now
        mainHandler.postDelayed({ discoverOnce(gatt) }, 1200)     // fallback if onMtuChanged is silent
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        Log.d(TAG, "client disconnected $addr status=$status")
        clientGatts.remove(addr); connecting.remove(addr); forgetAddr(addr)
        try { gatt.close() } catch (_: Exception) {}
        emitPeers()
      }
    }
    override fun onMtuChanged(gatt: BluetoothGatt, m: Int, status: Int) {
      mtu[gatt.device.address] = m; Log.d(TAG, "client mtu ${gatt.device.address}=$m")
      discoverOnce(gatt)   // MTU op settled → now discover (serialized, no collision)
    }
    @Suppress("DEPRECATION")   // 1-arg writeDescriptor(it) with it.value= works on all APIs
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val addr = gatt.device.address
      val ch = gatt.getService(SERVICE_UUID)?.getCharacteristic(CHAR_UUID)
      // No Loam characteristic (discovery failed, or we connected before the peer's service was up):
      // disconnect so the scanner re-dials, instead of keeping a link that can never carry data.
      if (ch == null) { Log.e(TAG, "client services $addr status=$status — Loam char NOT FOUND"); dropLink(addr, "no Loam char"); return }
      Log.d(TAG, "client services $addr — enabling notify")
      try { gatt.setCharacteristicNotification(ch, true) } catch (e: Exception) { dropLink(addr, "notify setup threw"); return }
      // Enable notifications by writing the CCCD. That write is now the in-flight GATT op, so we
      // must NOT send the announce here — doing so collided with this write and the announce was
      // dropped (the root cause). The announce is sent in onDescriptorWrite once this completes.
      // Fallback: if the CCCD write can't even be queued (or there's no CCCD), announce directly.
      val cccd = ch.getDescriptor(CCCD_UUID)
      val queued = try { cccd?.let { it.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; gatt.writeDescriptor(it) } ?: false } catch (_: Exception) { false }
      emitPeers() // link usable now
      if (!queued) { Log.d(TAG, "cccd not queued for $addr — announcing directly"); setupDone[addr] = true; sendAnnounce(addr) }
    }
    // CCCD write finished: notifications are on AND the link is free — NOW announce our identity.
    // (Announcing before this completed is exactly what dropped the frame — one GATT op per link.)
    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      if (descriptor.uuid == CCCD_UUID) {
        // Ask for a short connection interval: the default balanced one caps a write-with-response
        // link at a few KB/s, which a catch-up burst saturates. Not a queued GATT op, so no collision.
        setupDone[gatt.device.address] = true
        try { gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH) } catch (_: Exception) {}
        Log.d(TAG, "client cccd written ${gatt.device.address} status=$status — announcing")
        sendAnnounce(gatt.device.address)
      }
    }
    // Peer NOTIFIED us. Android 13+ (API 33) delivers to the 3-arg override with `value` and
    // NEVER calls the deprecated 2-arg one — so on modern phones the old override alone
    // silently dropped every notification. Keep both: 3-arg for 33+, 2-arg for <33.
    override fun onCharacteristicChanged(gatt: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) {
      if (ch.uuid == CHAR_UUID) onFragment(gatt.device.address, value)
    }
    @Deprecated("pre-33 delivery path")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, ch: BluetoothGattCharacteristic) {
      @Suppress("DEPRECATION")
      if (ch.uuid == CHAR_UUID) onFragment(gatt.device.address, ch.value)
    }
    // Our write completed (write-WITH-response gives this callback) — send the next queued
    // fragment. This one-at-a-time pacing is what makes multi-fragment delivery work at all.
    override fun onCharacteristicWrite(gatt: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
      // The peer can still reject a write we queued fine (e.g. too long): count it, don't call it sent.
      if (status != BluetoothGatt.GATT_SUCCESS) { stWriteOk--; stWriteFail++; stLastErr = "write status $status" }
      inFlightSince.remove(gatt.device.address)
      inFlight[gatt.device.address] = false
      pump(gatt.device.address)
    }
  }

  // Issue discoverServices exactly once per link. Both onMtuChanged AND the fallback timer call
  // this; the guard makes the loser a no-op. Serializing MTU->discover (instead of firing them
  // together) stops the discover from being lost to the in-flight MTU op on strict stacks.
  private fun discoverOnce(gatt: BluetoothGatt) {
    val addr = gatt.device.address
    if (clientGatts[addr] !== gatt) return           // stale/closed link
    if (discovered.put(addr, true) == true) return   // already discovering
    Log.d(TAG, "discoverServices $addr")
    try { if (!gatt.discoverServices()) dropLink(addr, "discover not started") } catch (e: Exception) { Log.e(TAG, "discoverServices $addr threw", e); dropLink(addr, "discover threw") }
  }

  // ── fragmentation ───────────────────────────────────────────────────────────
  // [ msgId hi, msgId lo, idx, count, chunk… ]. Reassemble per (addr,msgId); deliver when
  // all `count` fragments have arrived.
  private fun sendFragments(addr: String, bytes: ByteArray) {
    // Each fragment must fit ONE write/notify: MTU - 3 (ATT) - 5 (type + msgId + idx + count). No
    // floor: the old floor of 16 made 21-byte frames at the default MTU 23, which only carries 20.
    val cap = (minOf((mtu[addr] ?: 23) - 3, MAX_ATTR_LEN) - 5).coerceAtLeast(1)
    val count = ((bytes.size + cap - 1) / cap).coerceAtLeast(1)
    if (count > 255) {   // idx/count are one byte each; more would silently wrap and corrupt reassembly
      stLastErr = "too big ${bytes.size}B"; Log.e(TAG, "sendFragments $addr ${bytes.size}B needs $count frags (max 255) — dropped"); return
    }
    val q = sendQ.getOrPut(addr) { java.util.ArrayDeque() }
    if (synchronized(q) { q.size } + count > MAX_QUEUE_FRAMES) {
      stLastErr = "queue full"; Log.e(TAG, "sendFragments $addr backlog full — message dropped"); return
    }
    val id = (msgSeq++ and 0xffff)
    var off = 0
    for (idx in 0 until count) {
      val end = (off + cap).coerceAtMost(bytes.size)
      val chunk = bytes.copyOfRange(off, end); off = end
      val frame = ByteArray(5 + chunk.size)
      frame[0] = T_FRAG.toByte()
      frame[1] = ((id shr 8) and 0xff).toByte(); frame[2] = (id and 0xff).toByte()
      frame[3] = idx.toByte(); frame[4] = count.toByte()
      System.arraycopy(chunk, 0, frame, 5, chunk.size)
      synchronized(q) { q.addLast(frame) }
    }
    Log.d(TAG, "sendFragments $addr ${bytes.size}B -> $count frag(s) cap=$cap")
    pump(addr)
  }
  // Send exactly ONE fragment at a time; the completion callback (onCharacteristicWrite /
  // onNotificationSent) pumps the next. Loops only to skip frames that fail to even initiate,
  // so a bad frame never stalls the queue.
  private fun pump(peer: String) {
    val q = sendQ[peer] ?: return
    while (true) {
      var frame: ByteArray? = null
      synchronized(q) {
        if (inFlight[peer] == true) return
        frame = q.pollFirst()
        if (frame == null) return
        inFlight[peer] = true
        inFlightSince[peer] = System.currentTimeMillis()
      }
      stFragSent++
      val ok = writeToPeer(peer, frame!!)
      if (ok) { stWriteOk++; return }        // wait for the completion callback to pump next
      stWriteFail++; inFlight[peer] = false   // couldn't initiate — drop it and try the next
    }
  }
  @Suppress("DEPRECATION")   // pre-33 fallbacks use the deprecated setValue()/write forms
  private fun writeToPeer(peer: String, frame: ByteArray): Boolean =
    // Never let a radio call throw into a Binder/main-thread callback — that kills the whole app.
    try { writeToPeerUnsafe(peer, frame) } catch (e: Exception) {
      stLastErr = "write threw ${e.javaClass.simpleName}"; Log.e(TAG, "writeToPeer $peer threw", e); false
    }
  @Suppress("DEPRECATION")
  private fun writeToPeerUnsafe(peer: String, frame: ByteArray): Boolean {
    clientGatts[peer]?.let { g ->
      val ch = g.getService(SERVICE_UUID)?.getCharacteristic(CHAR_UUID)
      if (ch == null) { stLastErr = "cli char null"; Log.e(TAG, "writeToPeer $peer — client char null (services not discovered)"); return false }
      // WITH response (not NO_RESPONSE): delivers onCharacteristicWrite for flow control. On
      // API 33+ pass bytes explicitly so nothing shares characteristic.value across links.
      val ok = if (Build.VERSION.SDK_INT >= 33) {
        g.writeCharacteristic(ch, frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
      } else {
        ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT; ch.value = frame; g.writeCharacteristic(ch)
      }
      if (!ok) stLastErr = "write fail"
      Log.d(TAG, "writeToPeer $peer WRITE ${frame.size}B ok=$ok"); return ok
    }
    serverDevices[peer]?.let { d ->
      val ch = characteristic ?: run { stLastErr = "no char"; return false }
      // CRITICAL with >1 server link: on API 33+ pass the value per-call. The old setValue()+
      // notify shares ONE characteristic.value across every link, so concurrent notifies clobber
      // each other → corrupt fragments arrive → reassembly never completes (recv high, deliv 0).
      val ok = if (Build.VERSION.SDK_INT >= 33) {
        (gattServer?.notifyCharacteristicChanged(d, ch, false, frame) ?: -1) == BluetoothStatusCodes.SUCCESS
      } else {
        ch.value = frame; gattServer?.notifyCharacteristicChanged(d, ch, false) == true
      }
      if (!ok) stLastErr = "notify fail"
      Log.d(TAG, "writeToPeer $peer NOTIFY ${frame.size}B ok=$ok"); return ok
    }
    stLastErr = "no link"; Log.e(TAG, "writeToPeer $peer — NO link (not client or server)"); return false
  }
  private fun onFragment(addr: String, frame: ByteArray) {
    if (frame.isEmpty()) return
    when (frame[0].toInt() and 0xff) {
      T_ANNOUNCE -> { onAnnounce(addr, frame); return }
      T_ANNOUNCE_REQ -> { onAnnounce(addr, frame); sendAnnounce(addr); return }   // they don't know us yet: answer
      T_FRAG -> { /* fall through */ }
      else -> return
    }
    if (frame.size < 5) return
    stFragRecv++
    val id = ((frame[1].toInt() and 0xff) shl 8) or (frame[2].toInt() and 0xff)
    val idx = frame[3].toInt() and 0xff
    val count = frame[4].toInt() and 0xff
    stLastFrag = "$idx/$count"
    val chunk = frame.copyOfRange(5, frame.size)
    val node = addrToNode[addr] ?: addr   // deliver under the stable node id if we know it
    if (count <= 1) { deliver(node, chunk); return }
    val key = "$addr/$id"
    val parts = reasm.getOrPut(key) { ConcurrentHashMap() }
    parts[idx] = chunk; reasmCount[key] = count; reasmTime[key] = System.currentTimeMillis()
    if (parts.size >= count) {
      val whole = java.io.ByteArrayOutputStream()
      for (i in 0 until count) parts[i]?.let { whole.write(it) }
      reasm.remove(key); reasmCount.remove(key); reasmTime.remove(key)
      deliver(node, whole.toByteArray())
    }
    sweepReasm()
  }

  // Learn a peer's stable node id from its announce; map address<->node so ghosts collapse.
  private fun onAnnounce(addr: String, frame: ByteArray) {
    val node = String(frame, 1, frame.size - 1, Charsets.UTF_8)
    if (node.isEmpty() || node == wireId) return
    val prev = addrToNode.put(addr, node)
    nodeToAddrs.getOrPut(node) { java.util.concurrent.ConcurrentHashMap.newKeySet<String>() }.add(addr)
    if (prev != node) Log.d(TAG, "announce <- $addr is node ${node.take(6)} (links=${nodeToAddrs[node]?.size})")
    emitPeers()
  }

  // Drop partial assemblies older than the timeout so one lost fragment can't wedge a buffer.
  private fun sweepReasm() {
    val now = System.currentTimeMillis()
    for (k in reasmTime.filterValues { now - it > REASM_TIMEOUT_MS }.keys) {
      reasm.remove(k); reasmCount.remove(k); reasmTime.remove(k)
    }
  }

  // A link to `addr` is gone — forget its identity mapping, queue, mtu, and reasm buffers.
  private fun forgetAddr(addr: String) {
    // One role of a dual-role link went away, but the other (client or server) to the same address is still
    // up: keep its identity, MTU and queue. Wiping them dropped the fragment cap to 15 B for good.
    if (clientGatts.containsKey(addr) || serverDevices.containsKey(addr)) { inFlight[addr] = false; inFlightSince.remove(addr); pump(addr); return }
    setupDone.remove(addr); inFlightSince.remove(addr)
    addrToNode.remove(addr)?.let { node -> nodeToAddrs[node]?.let { it.remove(addr); if (it.isEmpty()) nodeToAddrs.remove(node) } }
    inFlight.remove(addr); sendQ.remove(addr); mtu.remove(addr); discovered.remove(addr); announceTries.remove(addr)
    for (k in reasm.keys.filter { it.startsWith("$addr/") }) { reasm.remove(k); reasmCount.remove(k); reasmTime.remove(k) }
  }

  // Distinct NODE ids reachable over a live link (client or server) that have announced.
  private fun connectedPeers(): List<String> =
    (clientGatts.keys + serverDevices.keys).mapNotNull { addrToNode[it] }.toSet().toList()

  private fun deliver(peer: String, data: ByteArray) {
    stDelivered++
    Log.d(TAG, "deliver <- $peer ${data.size}B -> JS")
    val m = Arguments.createMap()
    m.putString("peer", peer)
    m.putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
    emit("loamMeshRx", m)
  }
  private fun emitPeers() {
    val m = Arguments.createMap()
    val arr = Arguments.createArray(); for (p in connectedPeers()) arr.pushString(p)
    m.putArray("peers", arr)
    emit("loamMeshPeers", m)
  }
  private fun emit(name: String, params: WritableMap) {
    try { ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, params) } catch (_: Exception) {}
  }
}
