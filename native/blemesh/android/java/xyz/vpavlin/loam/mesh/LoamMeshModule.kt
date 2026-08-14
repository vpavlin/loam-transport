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
    // GATT payload type byte (ADR 0014): 'A' announce (payload = node id), 'F' fragment.
    const val T_ANNOUNCE = 0x41
    const val T_FRAG = 0x46
    const val REASM_TIMEOUT_MS = 30000L
  }

  override fun getName() = "LoamMesh"

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
  private val addrToNode = ConcurrentHashMap<String, String>()               // BLE address -> peer node id
  private val nodeToAddrs = ConcurrentHashMap<String, MutableSet<String>>()  // node id -> its link addresses
  private val reasmTime = ConcurrentHashMap<String, Long>()                  // reassembly key -> first-seen ms

  // ── JS API ────────────────────────────────────────────────────────────────
  // Set our stable node id (the app's deviceId). MUST be called before start() so our first
  // announce carries it. Idempotent.
  @ReactMethod fun setNodeId(id: String, promise: Promise) { myNodeId = id; Log.i(TAG, "nodeId=$id"); promise.resolve(true) }

  @ReactMethod fun start(promise: Promise) {
    try {
      val a = adapter ?: return promise.reject("no_bt", "no Bluetooth adapter")
      if (!a.isEnabled) return promise.reject("bt_off", "Bluetooth is off")
      Log.i(TAG, "start: ${Build.MANUFACTURER} ${Build.MODEL} api=${Build.VERSION.SDK_INT} peripheralAdvSupported=${a.isMultipleAdvertisementSupported} self=${a.address}")
      startServer(a)
      startAdvertising(a)
      startScanning(a)
      promise.resolve(true)
    } catch (e: Exception) { promise.reject("start_fail", e.message, e) }
  }

  @ReactMethod fun stop(promise: Promise) {
    try {
      advertiser?.stopAdvertising(advCallback)
      scanner?.stopScan(scanCallback)
      for (g in clientGatts.values) try { g.close() } catch (_: Exception) {}
      clientGatts.clear(); serverDevices.clear(); mtu.clear(); connecting.clear()
      gattServer?.close(); gattServer = null
      promise.resolve(true)
    } catch (e: Exception) { promise.reject("stop_fail", e.message, e) }
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
    val me = if (myNodeId.length >= 6) myNodeId.substring(0, 6) else myNodeId
    promise.resolve("node=$me nodes=${connectedPeers().size} cli=${clientGatts.size} srv=${serverDevices.size} pend=$pend mtu=$mtus " +
      "sent=$stFragSent wOk=$stWriteOk wFail=$stWriteFail recv=$stFragRecv deliv=$stDelivered reasm=${reasm.size} lastFrag=$stLastFrag" +
      (if (stLastErr.isNotEmpty()) " err=$stLastErr" else ""))
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
  private fun sendAnnounce(addr: String) {
    if (myNodeId.isEmpty()) return
    val idb = myNodeId.toByteArray(Charsets.UTF_8)
    val frame = ByteArray(1 + idb.size); frame[0] = T_ANNOUNCE.toByte(); System.arraycopy(idb, 0, frame, 1, idb.size)
    val q = sendQ.getOrPut(addr) { java.util.ArrayDeque() }
    synchronized(q) { q.addFirst(frame) }
    Log.d(TAG, "announce -> $addr (node ${myNodeId.take(6)})")
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
      Log.d(TAG, "server<-write ${device.address} ${value.size}B match=${ch.uuid == CHAR_UUID}")
      if (ch.uuid == CHAR_UUID) onFragment(device.address, value)
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
    }
    // A central enabling notifications writes our CCCD. If we never answer, the client's
    // writeDescriptor never completes and notifications stay OFF — the server->central
    // direction silently dies. Always acknowledge.
    override fun onDescriptorWriteRequest(
      device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray,
    ) {
      Log.d(TAG, "server<-cccd ${device.address} (notify enable)")
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      sendAnnounce(device.address)   // central can now receive notifications → tell it who we are
    }
    override fun onMtuChanged(device: BluetoothDevice, m: Int) { mtu[device.address] = m }
    // A notification finished sending — send the next queued fragment to this central.
    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
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
      dev.connectGatt(ctx, false, clientCallback)
    }
  }
  private val clientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val addr = gatt.device.address
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        clientGatts[addr] = gatt; connecting.remove(addr); emitPeers()
        Log.d(TAG, "client connected $addr — requestMtu + discoverServices")
        gatt.requestMtu(DEFAULT_MTU)
        // Discover DIRECTLY on connect — do NOT gate on onMtuChanged. If the MTU callback
        // never fires (common on many stacks) services are never discovered, getCharacteristic
        // returns null, and every write is silently dropped: the entire data path is dead.
        gatt.discoverServices()
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        Log.d(TAG, "client disconnected $addr status=$status")
        clientGatts.remove(addr); connecting.remove(addr); forgetAddr(addr)
        try { gatt.close() } catch (_: Exception) {}
        emitPeers()
      }
    }
    override fun onMtuChanged(gatt: BluetoothGatt, m: Int, status: Int) { mtu[gatt.device.address] = m; Log.d(TAG, "client mtu ${gatt.device.address}=$m") }
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val ch = gatt.getService(SERVICE_UUID)?.getCharacteristic(CHAR_UUID)
      if (ch == null) { Log.e(TAG, "client services ${gatt.device.address} status=$status — Loam char NOT FOUND"); return }
      Log.d(TAG, "client services ${gatt.device.address} — enabling notify")
      gatt.setCharacteristicNotification(ch, true)
      ch.getDescriptor(CCCD_UUID)?.let {
        it.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        gatt.writeDescriptor(it)
      }
      emitPeers() // usable now
      sendAnnounce(gatt.device.address)   // link is writable → tell the peer who we are
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
      inFlight[gatt.device.address] = false
      pump(gatt.device.address)
    }
  }

  // ── fragmentation ───────────────────────────────────────────────────────────
  // [ msgId hi, msgId lo, idx, count, chunk… ]. Reassemble per (addr,msgId); deliver when
  // all `count` fragments have arrived.
  private fun sendFragments(addr: String, bytes: ByteArray) {
    val cap = ((mtu[addr] ?: 23) - 3 - 5).coerceAtLeast(16) // ATT(3) + type(1) + frag header(4)
    val count = ((bytes.size + cap - 1) / cap).coerceAtLeast(1)
    val id = (msgSeq++ and 0xffff)
    val q = sendQ.getOrPut(addr) { java.util.ArrayDeque() }
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
      }
      stFragSent++
      val ok = writeToPeer(peer, frame!!)
      if (ok) { stWriteOk++; return }        // wait for the completion callback to pump next
      stWriteFail++; inFlight[peer] = false   // couldn't initiate — drop it and try the next
    }
  }
  @Suppress("DEPRECATION")   // pre-33 fallbacks use the deprecated setValue()/write forms
  private fun writeToPeer(peer: String, frame: ByteArray): Boolean {
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
    if (node.isEmpty() || node == myNodeId) return
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
    addrToNode.remove(addr)?.let { node -> nodeToAddrs[node]?.let { it.remove(addr); if (it.isEmpty()) nodeToAddrs.remove(node) } }
    inFlight.remove(addr); sendQ.remove(addr); mtu.remove(addr)
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
