package co.logos.mesh

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
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
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

  // ── JS API ────────────────────────────────────────────────────────────────
  @ReactMethod fun start(promise: Promise) {
    try {
      val a = adapter ?: return promise.reject("no_bt", "no Bluetooth adapter")
      if (!a.isEnabled) return promise.reject("bt_off", "Bluetooth is off")
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

  // sendTo(peer, base64) — fragment and deliver over whichever link we have to `peer`.
  @ReactMethod fun sendTo(peer: String, dataB64: String, promise: Promise) {
    try {
      val bytes = Base64.decode(dataB64, Base64.NO_WRAP)
      sendFragments(peer, bytes)
      promise.resolve(true)
    } catch (e: Exception) { promise.reject("send_fail", e.message, e) }
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
      if (newState == BluetoothProfile.STATE_CONNECTED) { serverDevices[device.address] = device; emitPeers() }
      else if (newState == BluetoothProfile.STATE_DISCONNECTED) { serverDevices.remove(device.address); emitPeers() }
    }
    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice, requestId: Int, ch: BluetoothGattCharacteristic,
      preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray,
    ) {
      if (ch.uuid == CHAR_UUID) onFragment(device.address, value)
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
    }
    override fun onMtuChanged(device: BluetoothDevice, m: Int) { mtu[device.address] = m }
  }

  private fun startAdvertising(a: BluetoothAdapter) {
    val adv = a.bluetoothLeAdvertiser ?: return
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setConnectable(true)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .build()
    val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE_UUID)).build()
    adv.startAdvertising(settings, data, advCallback)
    advertiser = adv
  }
  private val advCallback = object : AdvertiseCallback() {}

  // ── central (scan + GATT client) ────────────────────────────────────────────
  private fun startScanning(a: BluetoothAdapter) {
    val s = a.bluetoothLeScanner ?: return
    val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build())
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    s.startScan(filters, settings, scanCallback)
    scanner = s
  }
  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      val dev = result.device
      val addr = dev.address
      if (clientGatts.containsKey(addr) || serverDevices.containsKey(addr) || connecting[addr] == true) return
      // Tiebreak so two devices don't each open a client link: only the LOWER address dials.
      val self = adapter?.address ?: ""
      if (self != "" && self != "02:00:00:00:00:00" && self > addr) return // the higher address waits to be dialed
      connecting[addr] = true
      dev.connectGatt(ctx, false, clientCallback)
    }
  }
  private val clientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      val addr = gatt.device.address
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        clientGatts[addr] = gatt; connecting.remove(addr)
        gatt.requestMtu(DEFAULT_MTU)
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        clientGatts.remove(addr); connecting.remove(addr); mtu.remove(addr)
        try { gatt.close() } catch (_: Exception) {}
        emitPeers()
      }
    }
    override fun onMtuChanged(gatt: BluetoothGatt, m: Int, status: Int) { mtu[gatt.device.address] = m; gatt.discoverServices() }
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      val ch = gatt.getService(SERVICE_UUID)?.getCharacteristic(CHAR_UUID) ?: return
      gatt.setCharacteristicNotification(ch, true)
      ch.getDescriptor(CCCD_UUID)?.let {
        it.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        gatt.writeDescriptor(it)
      }
      emitPeers() // usable now
    }
    override fun onCharacteristicChanged(gatt: BluetoothGatt, ch: BluetoothGattCharacteristic) {
      if (ch.uuid == CHAR_UUID) onFragment(gatt.device.address, ch.value)
    }
  }

  // ── fragmentation ───────────────────────────────────────────────────────────
  // [ msgId hi, msgId lo, idx, count, chunk… ]. Reassemble per (addr,msgId); deliver when
  // all `count` fragments have arrived.
  private fun sendFragments(peer: String, bytes: ByteArray) {
    val cap = ((mtu[peer] ?: 23) - 3 - 4).coerceAtLeast(16) // ATT header(3) + our header(4)
    val count = ((bytes.size + cap - 1) / cap).coerceAtLeast(1)
    val id = (msgSeq++ and 0xffff)
    var off = 0
    for (idx in 0 until count) {
      val end = (off + cap).coerceAtMost(bytes.size)
      val chunk = bytes.copyOfRange(off, end); off = end
      val frame = ByteArray(4 + chunk.size)
      frame[0] = ((id shr 8) and 0xff).toByte(); frame[1] = (id and 0xff).toByte()
      frame[2] = idx.toByte(); frame[3] = count.toByte()
      System.arraycopy(chunk, 0, frame, 4, chunk.size)
      writeToPeer(peer, frame)
    }
  }
  private fun writeToPeer(peer: String, frame: ByteArray) {
    clientGatts[peer]?.let { g ->
      val ch = g.getService(SERVICE_UUID)?.getCharacteristic(CHAR_UUID) ?: return
      ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
      ch.value = frame; g.writeCharacteristic(ch); return
    }
    serverDevices[peer]?.let { d ->
      val ch = characteristic ?: return
      ch.value = frame
      gattServer?.notifyCharacteristicChanged(d, ch, false)
    }
  }
  private fun onFragment(addr: String, frame: ByteArray) {
    if (frame.size < 4) return
    val id = ((frame[0].toInt() and 0xff) shl 8) or (frame[1].toInt() and 0xff)
    val idx = frame[2].toInt() and 0xff
    val count = frame[3].toInt() and 0xff
    val chunk = frame.copyOfRange(4, frame.size)
    val key = "$addr/$id"
    if (count <= 1) { deliver(addr, chunk); return }
    val parts = reasm.getOrPut(key) { ConcurrentHashMap() }
    parts[idx] = chunk; reasmCount[key] = count
    if (parts.size >= count) {
      val whole = java.io.ByteArrayOutputStream()
      for (i in 0 until count) parts[i]?.let { whole.write(it) }
      reasm.remove(key); reasmCount.remove(key)
      deliver(addr, whole.toByteArray())
    }
  }

  private fun connectedPeers(): List<String> = (clientGatts.keys + serverDevices.keys).toSet().toList()

  private fun deliver(peer: String, data: ByteArray) {
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
