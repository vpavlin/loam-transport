package co.logos.delivery.client

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Base64
import android.util.Log
import co.logos.delivery.ILogosDelivery
import co.logos.delivery.ILogosDeliveryCallback
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

// Client side of the shared delivery service. Binds co.logos.delivery's AIDL service and
// routes subscribe/send/receive through it, so this app uses the ONE device-wide node
// instead of embedding its own. Received messages are re-emitted as a JS event.
class LogosDeliveryClientModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "LogosDeliveryClient"
  private var svc: ILogosDelivery? = null
  private var appId: String = "app"
  @Volatile private var lastDiag: String = "connect() not called"
  private var pending: Promise? = null

  private val callback = object : ILogosDeliveryCallback.Stub() {
    override fun onMessage(topic: String, candidatesJson: String) {
      val p = Arguments.createMap().apply { putString("topic", topic); putString("candidatesJson", candidatesJson) }
      try { ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("logosDeliveryMessage", p) } catch (_: Throwable) {}
    }
  }
  private fun emit(event: String) {
    try { ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, null) } catch (_: Throwable) {}
  }
  // The shared node is hosted by the Loam app (applicationId xyz.vpavlin.loam); the service
  // CLASS kept the co.logos.delivery.svc namespace. Bind to that component explicitly.
  private fun intentFor() = Intent().apply { component = ComponentName("xyz.vpavlin.loam", "co.logos.delivery.svc.LogosDeliveryService") }

  private val conn = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      svc = ILogosDelivery.Stub.asInterface(binder)
      pending?.resolve(true); pending = null
      // On a RE-connect (service updated/restarted) re-register so the service re-knows us;
      // the owner's grant persists, so no re-prompt. The JS side re-subscribes on "connected".
      if (appId != "app") { try { svc?.registerClient(appId, callback) } catch (_: Throwable) {} }
      emit("logosDeliveryConnected")
    }
    override fun onServiceDisconnected(name: ComponentName?) { svc = null; emit("logosDeliveryDisconnected") }
  }

  @ReactMethod fun connect(promise: Promise) {
    if (svc != null) { promise.resolve(true); return }
    val intent = intentFor()
    // Does the target service even RESOLVE for us? (component correct + visible via <queries>)
    val ri = try { ctx.packageManager.resolveService(intent, 0) } catch (_: Throwable) { null }
    pending = promise
    val ok = try { ctx.bindService(intent, conn, Context.BIND_AUTO_CREATE) } catch (t: Throwable) { lastDiag = "bind threw: ${t.message}"; false }
    lastDiag = "target=${intent.component?.flattenToShortString()} resolves=${ri?.serviceInfo?.let { it.packageName + "/" + it.name } ?: "NULL (not visible/installed)"} bindReturned=$ok"
    Log.i("LOAMBIND", lastDiag)
    if (!ok) { pending = null; promise.resolve(false) }
  }
  // Read the last bind attempt's outcome (surfaced in-app so we can see why sync fell back).
  @ReactMethod fun diag(promise: Promise) { promise.resolve("$lastDiag connected=${svc != null} appId=$appId") }
  // Re-bind after the service went away (update/kill). No-op if already bound.
  @ReactMethod fun reconnect() { if (svc == null) try { ctx.bindService(intentFor(), conn, Context.BIND_AUTO_CREATE) } catch (_: Throwable) {} }

  // Is the Logos Delivery app installed at all?
  @ReactMethod fun isInstalled(promise: Promise) {
    promise.resolve(try { ctx.packageManager.getLaunchIntentForPackage("xyz.vpavlin.loam") != null } catch (_: Throwable) { false })
  }
  // Bring Logos Delivery to the foreground so its node + foreground service start. Allowed
  // because qaku is itself in the foreground when it calls this (no background-launch limit).
  @ReactMethod fun launchService() {
    try {
      val i = ctx.packageManager.getLaunchIntentForPackage("xyz.vpavlin.loam")
      i?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); i?.let { ctx.startActivity(it) }
    } catch (_: Throwable) {}
  }
  @ReactMethod fun register(id: String) { appId = id; try { svc?.registerClient(id, callback) } catch (_: Throwable) {} }
  @ReactMethod fun subscribe(topic: String) { try { svc?.subscribe(appId, topic) } catch (_: Throwable) {} }
  @ReactMethod fun send(topic: String, sealedB64: String) { try { svc?.send(appId, topic, Base64.decode(sealedB64, Base64.NO_WRAP)) } catch (_: Throwable) {} }
  @ReactMethod fun metrics(promise: Promise) { promise.resolve(try { svc?.metrics() ?: "{}" } catch (_: Throwable) { "{}" }) }
  @ReactMethod fun disconnect() { try { svc?.unregisterClient(appId); ctx.unbindService(conn) } catch (_: Throwable) {}; svc = null }
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}
