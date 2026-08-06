package com.receiverandroid

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.gson.Gson
import java.math.BigInteger
import org.json.JSONArray

class EventCallbackManager {
  companion object {

    lateinit var reactContext: ReactContext

    @JvmStatic
    fun execEventCallback(wakuPtr: Long, evt: String) {
      val params =
          Arguments.createMap().apply {
            putString("wakuPtr", wakuPtr.toString())
            putString("event", evt)
          }

      reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("logosMessage", params)
    }
  }
}

fun convertStringToArray(stringArray: String): WritableNativeArray {
  val writableArray = WritableNativeArray()
  val jsonArray = JSONArray(stringArray)
  for (i in 0 until jsonArray.length()) {
    writableArray.pushString(jsonArray.getString(i))
  }
  return writableArray
}

fun stringifyReadableMap(map: ReadableMap): String {
  val gson = Gson()
  return gson.toJson(readableMapToMap(map))
}

fun readableMapToMap(readableMap: ReadableMap): Map<String, Any?> {
  val map = mutableMapOf<String, Any?>()
  val iterator = readableMap.keySetIterator()
  while (iterator.hasNextKey()) {
    val key = iterator.nextKey()
    when (readableMap.getType(key)) {
      ReadableType.Null -> map[key] = null
      ReadableType.Boolean -> map[key] = readableMap.getBoolean(key)
      ReadableType.Number -> map[key] = readableMap.getInt(key)
      ReadableType.String -> map[key] = readableMap.getString(key)
      ReadableType.Map -> map[key] = readableMapToMap(readableMap.getMap(key)!!)
      ReadableType.Array -> map[key] = readableArrayToList(readableMap.getArray(key)!!)
    }
  }
  return map
}

fun readableArrayToList(readableArray: ReadableArray): List<Any?> {
  val list = mutableListOf<Any?>()
  for (i in 0 until readableArray.size()) {
    when (readableArray.getType(i)) {
      ReadableType.Null -> list.add(null)
      ReadableType.Boolean -> list.add(readableArray.getBoolean(i))
      ReadableType.Number -> list.add(readableArray.getInt(i))
      ReadableType.String -> list.add(readableArray.getString(i))
      ReadableType.Map -> list.add(readableMapToMap(readableArray.getMap(i)!!))
      ReadableType.Array -> list.add(readableArrayToList(readableArray.getArray(i)!!))
    }
  }
  return list
}

class WakuPtr(val error: Boolean, val errorMessage: String, val ptr: Long)

class WakuResult(val error: Boolean, val message: String)

class LogosMessagingModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  var reactContext = reactContext

  companion object {
    @Volatile private var libsLoaded = false

    // Loaded lazily (on setup()) rather than in a class-init block so that merely
    // registering this module on a non-arm64 device (e.g. the x86_64 emulator,
    // which ships no liblogosdelivery.so) does NOT crash the app at startup —
    // the UnsatisfiedLinkError surfaces only if sync is actually invoked.
    @Synchronized
    fun ensureLibsLoaded() {
      if (libsLoaded) return
      // Order matters. c++_shared FIRST — liblogosdelivery.so references __gxx_personality_v0 (C++
      // exception personality) from the shared C++ runtime; then RLN → the node → the JNI bridge.
      System.loadLibrary("c++_shared")
      System.loadLibrary("rln")
      System.loadLibrary("logosdelivery")
      System.loadLibrary("logos_messaging_jni")
      libsLoaded = true
    }
  }

  override fun getName() = "LogosMessaging"

  external fun wakuSetup()
  external fun wakuNew(configJson: String): WakuPtr
  external fun wakuStart(ctx: Long): WakuResult
  external fun wakuVersion(ctx: Long): WakuResult
  external fun wakuStop(ctx: Long): WakuResult
  external fun wakuDestroy(ctx: Long): WakuResult
  external fun wakuConnect(ctx: Long, peerMultiAddr: String, timeoutMs: Int): WakuResult
  external fun wakuListenAddresses(ctx: Long): WakuResult
  external fun wakuGetNodeInfo(ctx: Long, nodeInfoId: String): WakuResult
  external fun wakuSubscribeContentTopic(ctx: Long, contentTopic: String): WakuResult
  external fun wakuRelayPublish(
      ctx: Long,
      topic: String,
      wakuMsg: String,
      timeoutMs: Int
  ): WakuResult
  external fun wakuRelaySubscribe(ctx: Long, topic: String): WakuResult
  external fun wakuRelayUnsubscribe(ctx: Long, topic: String): WakuResult
  // Publish on a CONTENT topic via the high-level logosdelivery_send. messageJson
  // is the send envelope: { "contentTopic", "payload":"<base64>", "ephemeral" }.
  external fun wakuSend(ctx: Long, messageJson: String): WakuResult
  // Reliable Channel (SDS) create/send/close. channelId == contentTopic == the budget's
  // derived topic; senderId == this device. NOTE: channelCreate does NOT subscribe the
  // content topic — delivery.ts pairs it with subscribeContentTopic so recv_service
  // actually feeds the channel's ingress listener. Bound to the wakuChannel* JNI in
  // logos_messaging_ffi.c (liblogos_messaging_jni.so).
  external fun wakuChannelCreate(ctx: Long, channelId: String, contentTopic: String, senderId: String): WakuResult
  external fun wakuChannelSend(ctx: Long, channelId: String, messageJson: String): WakuResult
  external fun wakuChannelClose(ctx: Long, channelId: String): WakuResult
  // Store (history) query — pull half of catch-up. jsonQuery is an nwaku
  // StoreQueryRequest; peerAddr is the fleet store node to ask. Returns the
  // response JSON (messages[] + paginationCursor) for JS to decrypt.
  external fun wakuStoreQuery(
      ctx: Long,
      jsonQuery: String,
      peerAddr: String,
      timeoutMs: Int
  ): WakuResult
  external fun wakuSetEventCallback(ctx: Long)

  init {
    EventCallbackManager.reactContext = reactContext
  }

  @ReactMethod
  fun setup(promise: Promise) {
    try {
      ensureLibsLoaded()
    } catch (t: Throwable) {
      // No native node on this ABI (e.g. x86_64 emulator) — fail gracefully.
      promise.reject("loadlib", "Logos Delivery native library unavailable: ${t.message}")
      return
    }
    wakuSetup()
    promise.resolve(null)
  }

  @ReactMethod
  fun new(config: ReadableMap, promise: Promise) {
    val configStr = stringifyReadableMap(config)
    val response = wakuNew(configStr)
    if (response.error || response.ptr == 0L) {
      // ptr==0 means waku_new returned nil (config rejected) — reject instead of segfaulting on the callback.
      promise.reject("waku_new", if (response.error) response.errorMessage else "node creation returned null (config rejected)")
    } else {
      // With this we just indicate to waku_ffi that we have registered a
      // closure, for this wakuPtr. Later once a message is received the
      // callback manager will receive both the wakuPtr and the message,
      // and it will use these values to emit a JS event
      wakuSetEventCallback(response.ptr)

      promise.resolve(BigInteger.valueOf(response.ptr).toString())
    }
  }

  @ReactMethod
  fun start(ctx: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuStart(wakuPtr)
    if (response.error) {
      promise.reject("waku_start", response.message)
    } else {
      promise.resolve(null)
    }
  }

  /** Subscribe by CONTENT topic (auto-sharded). Use this, not relaySubscribe. */
  @ReactMethod
  fun subscribeContentTopic(ctx: String, contentTopic: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuSubscribeContentTopic(wakuPtr, contentTopic)
    if (response.error) {
      promise.reject("logosdelivery_subscribe", response.message)
    } else {
      promise.resolve(response.message)
    }
  }

  /** Node introspection (e.g. "Metrics" -> Prometheus text with peer gauges). */
  @ReactMethod
  fun getNodeInfo(ctx: String, nodeInfoId: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuGetNodeInfo(wakuPtr, nodeInfoId)
    if (response.error) {
      promise.reject("waku_get_node_info", response.message)
    } else {
      promise.resolve(response.message)
    }
  }

  @ReactMethod
  fun version(ctx: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuVersion(wakuPtr)
    if (response.error) {
      promise.reject("waku_version", response.message)
    } else {
      promise.resolve(response.message)
    }
  }

  @ReactMethod
  fun stop(ctx: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuStop(wakuPtr)
    if (response.error) {
      promise.reject("waku_stop", response.message)
    } else {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun destroy(ctx: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuDestroy(wakuPtr)
    if (response.error) {
      promise.reject("waku_destroy", response.message)
    } else {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun listenAddresses(ctx: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuListenAddresses(wakuPtr)
    if (response.error) {
      promise.reject("waku_listen_addresses", response.message)
    } else {
      promise.resolve(convertStringToArray(response.message))
    }
  }

  @ReactMethod
  fun connect(ctx: String, peerMultiAddr: String, timeoutMs: Int, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuConnect(wakuPtr, peerMultiAddr, timeoutMs)
    if (response.error) {
      promise.reject("waku_connect", response.message)
    } else {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun relaySubscribe(ctx: String, topic: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuRelaySubscribe(wakuPtr, topic)
    if (response.error) {
      promise.reject("waku_relay_subscribe", response.message)
    } else {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun relayUnsubscribe(ctx: String, topic: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuRelayUnsubscribe(wakuPtr, topic)
    if (response.error) {
      promise.reject("waku_relay_unsubscribe", response.message)
    } else {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun relayPublish(ctx: String, topic: String, msg: ReadableMap, timeoutMs: Int, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val msgStr = stringifyReadableMap(msg)
    val response = wakuRelayPublish(wakuPtr, topic, msgStr, timeoutMs)
    if (response.error) {
      promise.reject("waku_relay_publish", response.message)
    } else {
      promise.resolve(null)
    }
  }

  // Publish one message on a content topic. messageJson is the liblogosdelivery
  // send envelope: {"contentTopic","payload":"<base64>","ephemeral":false}.
  @ReactMethod
  fun send(ctx: String, messageJson: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuSend(wakuPtr, messageJson)
    if (response.error) {
      promise.reject("waku_send", response.message)
    } else {
      promise.resolve(null)
    }
  }

  // Reliable Channel API bridge. channelCreate builds the SDS channel + its ingress
  // listener; channelSend publishes a channel-framed message (messageJson =
  // {"payload":"<base64>","ephemeral":<bool>}). channelId == the budget's derived topic.
  @ReactMethod
  fun channelCreate(ctx: String, channelId: String, contentTopic: String, senderId: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuChannelCreate(wakuPtr, channelId, contentTopic, senderId)
    if (response.error) {
      promise.reject("logosdelivery_channel_create", response.message)
    } else {
      promise.resolve(response.message)
    }
  }

  @ReactMethod
  fun channelSend(ctx: String, channelId: String, messageJson: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuChannelSend(wakuPtr, channelId, messageJson)
    if (response.error) {
      promise.reject("logosdelivery_channel_send", response.message)
    } else {
      promise.resolve(response.message)
    }
  }

  @ReactMethod
  fun channelClose(ctx: String, channelId: String, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuChannelClose(wakuPtr, channelId)
    if (response.error) {
      promise.reject("logosdelivery_channel_close", response.message)
    } else {
      promise.resolve(null)
    }
  }

  // Query the fleet store for history on one or more content topics. jsonQuery is an
  // nwaku StoreQueryRequest; peerAddr is a store node multiaddr. Resolves with the
  // response JSON string (messages[] with base64 payloads + paginationCursor).
  @ReactMethod
  fun storeQuery(ctx: String, jsonQuery: String, peerAddr: String, timeoutMs: Int, promise: Promise) {
    val wakuPtr = BigInteger(ctx).toLong()
    val response = wakuStoreQuery(wakuPtr, jsonQuery, peerAddr, timeoutMs)
    if (response.error) {
      promise.reject("waku_store_query", response.message)
    } else {
      promise.resolve(response.message)
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // No impl required
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // No impl required
  }
}
