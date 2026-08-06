#include "liblogosdelivery_kernel.h"
#include "liblogosdelivery.h" // stable high-level API — declares logosdelivery_send
#include <android/log.h>
#include <jni.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <unistd.h>
#include <pthread.h>

// Wire the node's chronicles output (which goes to stdout/stderr) into logcat so waku_new's config-parse
// result is visible. Android drops app stdout by default; pipe it to __android_log (tag "logos-node").
static int _logos_logpipe[2];
static void *_logos_log_pump(void *arg) {
  (void)arg;
  char buf[2048];
  ssize_t n;
  while ((n = read(_logos_logpipe[0], buf, sizeof(buf) - 1)) > 0) {
    if (n > 0 && buf[n - 1] == '\n') n--;
    buf[n] = '\0';
    __android_log_write(ANDROID_LOG_INFO, "logos-node", buf);
  }
  return NULL;
}
static void logos_redirect_stdio_to_logcat(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  setvbuf(stderr, 0, _IONBF, 0);
  if (pipe(_logos_logpipe) != 0) return;
  dup2(_logos_logpipe[1], STDOUT_FILENO);
  dup2(_logos_logpipe[1], STDERR_FILENO);
  pthread_t t;
  pthread_create(&t, NULL, _logos_log_pump, NULL);
  pthread_detach(t);
}

#define APPNAME "waku-jni"
#define LOGD(TAG) __android_log_print(ANDROID_LOG_DEBUG , APPNAME,TAG);

// cb_result represents a response received when executing a callback.
// If `error` is true, `message` will contain the error message description
// otherwise, it will contain the result of the callback execution
typedef struct {
  bool error;
  char *message;
} cb_result;

// cb_env is a struct passed as userdata when setting up the event callback.
// This is so we can pass the pointer back to kotlin to indicate which instance
// of waku received the message, and also so we can have access to `env` from
// within the event callback
typedef struct {
  jlong wakuPtr;
  JNIEnv *env;
} cb_env;

// frees the results associated to the allocation of a cb_result
void free_cb_result(cb_result *result) {
  if (result != NULL) {
    if (result->message != NULL) {
      free(result->message);
      result->message = NULL;
    }
    free(result);
    result = NULL;
  }
}

// callback executed by libwaku functions. It expects user_data to be a
// cb_result*.
void on_response(int ret, const char *msg, size_t len, void *user_data) {
  if (ret != RET_OK) {
    char errMsg[300];
    snprintf(errMsg, 300, "function execution failed. Returned code: %d, %s\n", ret, msg);
    if (user_data != NULL) {
      cb_result **data_ref = (cb_result **)user_data;
      (*data_ref) = malloc(sizeof(cb_result));
      (*data_ref)->error = true;
      (*data_ref)->message = malloc(len * sizeof(char) + 1);
      (*data_ref)->message[0] = '\0';
      strncat((*data_ref)->message, msg, len);
    }
    return;
  }

  if (user_data == NULL)
    return;

  if (len == 0) {
    len = 14;
    msg = "on_response-ok";
  }

  cb_result **data_ref = (cb_result **)user_data;
  (*data_ref) = malloc(sizeof(cb_result));
  (*data_ref)->error = false;
  (*data_ref)->message = malloc(len * sizeof(char) + 1);
  (*data_ref)->message[0] = '\0';
  strncat((*data_ref)->message, msg, len);
}

// converts a cb_result into an instance of the kotlin WakuResult class
jobject to_jni_result(JNIEnv *env, cb_result *result) {
  jclass myStructClass = (*env)->FindClass(env, "com/receiverandroid/WakuResult");
  jmethodID constructor = (*env)->GetMethodID(env, myStructClass, "<init>",
                                              "(ZLjava/lang/String;)V");

  jboolean error;
  jstring message;
  if (result != NULL) {
    error = result->error;
    message = (*env)->NewStringUTF(env, result->message);
  } else {
    error = false;
    message = (*env)->NewStringUTF(env, "ok");
  }

  jobject response =
      (*env)->NewObject(env, myStructClass, constructor, error, message);

  // Free the intermediate message var
  (*env)->DeleteLocalRef(env, message);

  return response;
}

// converts a cb_result into an instance of the kotlin WakuPtr class
jobject to_jni_ptr(JNIEnv *env, cb_result *result, void *ptr) {
  jclass myStructClass = (*env)->FindClass(env, "com/receiverandroid/WakuPtr");
  jmethodID constructor = (*env)->GetMethodID(env, myStructClass, "<init>",
                                              "(ZLjava/lang/String;J)V");

  jboolean error;
  jstring message;
  jlong wakuPtr;
  // Only treat it as failure when on_response reported an ACTUAL error. on_response also fires on
  // success ("on_response-ok"), which must NOT discard the real node ctx returned by create_node.
  if (result != NULL && result->error) {
    error = true;
    message = (*env)->NewStringUTF(env, result->message);
    wakuPtr = -1;
  } else {
    error = false;
    message = (*env)->NewStringUTF(env, result != NULL ? result->message : "ok");
    wakuPtr = (jlong)ptr;
  }

  jobject response = (*env)->NewObject(env, myStructClass, constructor, error,
                                       message, wakuPtr);

  // Free the intermediate message var
  (*env)->DeleteLocalRef(env, message);

  return response;
}

// libwaku functions
// ============================================================================

// JVM, required for executing JNI functions in a third party thread.
JavaVM *jvm;
static jobject jClassLoader;
static jmethodID jLoadClass;

// Event-callback hardening: the node invokes wk_callback from ≥3 native threads (FFI, watchdog, libp2p).
// Cache a GLOBAL ref to the callback class + its method id (local refs / per-call lookups are unsafe /
// wasteful across threads), and use a per-thread key so each native thread attaches to the JVM ONCE and
// detaches on thread exit — never attach/detach per callback.
static jclass gEventCbClass;
static jmethodID gExecEventCb;
static pthread_key_t gDetachKey;
static void detach_current_thread(void *unused) {
  (void)unused;
  (*jvm)->DetachCurrentThread(jvm);
}

JNIEnv *getEnv() {
  JNIEnv *env;
  int status = (*jvm)->GetEnv(jvm, (void **)&env, JNI_VERSION_1_6);
  if (status < 0) {
    status = (*jvm)->AttachCurrentThread(jvm, &env, NULL);
    assert(status == JNI_OK && "could not obtain env");
  }
  return env;
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *pjvm, void *reserved) {
  jvm = pjvm; // cache the JavaVM pointer
  JNIEnv *env = getEnv();

  jclass jLibraryClass =
      (*env)->FindClass(env, "com/receiverandroid/EventCallbackManager");
  jclass jClassRef = (*env)->GetObjectClass(env, jLibraryClass);
  jclass jClassLoaderClass = (*env)->FindClass(env, "java/lang/ClassLoader");
  jmethodID getClassLoader = (*env)->GetMethodID(
      env, jClassRef, "getClassLoader", "()Ljava/lang/ClassLoader;");

  jobject jClassLoaderLocal =
      (*env)->CallObjectMethod(env, jLibraryClass, getClassLoader);
  jLoadClass = (*env)->GetMethodID(env, jClassLoaderClass, "loadClass",
                                   "(Ljava/lang/String;)Ljava/lang/Class;");
  jClassLoader = (*env)->NewGlobalRef(env, jClassLoaderLocal);

  (*env)->DeleteLocalRef(env, jClassLoaderLocal);
  (*env)->DeleteLocalRef(env, jClassLoaderClass);
  (*env)->DeleteLocalRef(env, jClassRef);
  (*env)->DeleteLocalRef(env, jLibraryClass);

  // Cache the event-callback class as a GLOBAL ref + its method id once, and set up the per-thread
  // detach key. The node calls wk_callback from its own (non-JVM) worker thread, so these must not
  // depend on any thread-local/local state.
  jclass cbLocal = (*env)->FindClass(env, "com/receiverandroid/EventCallbackManager");
  gEventCbClass = (*env)->NewGlobalRef(env, cbLocal);
  gExecEventCb = (*env)->GetStaticMethodID(env, gEventCbClass, "execEventCallback",
                                           "(JLjava/lang/String;)V");
  (*env)->DeleteLocalRef(env, cbLocal);
  pthread_key_create(&gDetachKey, detach_current_thread);

  return JNI_VERSION_1_6;
}

jclass loadClass(JNIEnv *env, const char *className) {
  jstring jName = (*env)->NewStringUTF(env, className);
  jclass jClass = (*env)->CallObjectMethod(env, jClassLoader, jLoadClass, jName);
  assert((*env)->ExceptionCheck(env) == JNI_FALSE && "class could not be loaded");
  (*env)->DeleteLocalRef(env, jName);
  return jClass;
}

void Java_com_receiverandroid_LogosMessagingModule_wakuSetup(JNIEnv *env, jobject thiz) {
  logos_redirect_stdio_to_logcat();
  LOGD("stdio redirected to logcat (tag: logos-node)")
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuNew(JNIEnv *env, jobject thiz,
                                           jstring configJson) {
  const char *config = (*env)->GetStringUTFChars(env, configJson, 0);
  __android_log_print(ANDROID_LOG_INFO, "logos-node", "waku_new config: %s", config);
  cb_result *result = NULL;
  void *wakuPtr = logosdelivery_create_node(config, on_response, (void *)&result);
  __android_log_print(ANDROID_LOG_INFO, "logos-node", "waku_new returned ptr=%p err=%s",
                      wakuPtr, result ? result->message : "(none)");
  jobject response = to_jni_ptr(env, result, wakuPtr);
  (*env)->ReleaseStringUTFChars(env, configJson, config);
  free_cb_result(result);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuStart(JNIEnv *env, jobject thiz,
                                             jlong wakuPtr) {
  cb_result *result = NULL;
  logosdelivery_start_node((void *)wakuPtr, on_response, &result);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuVersion(JNIEnv *env, jobject thiz,
                                               jlong wakuPtr) {
  cb_result *result = NULL;
  waku_version((void *)wakuPtr, on_response, (void *)&result);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuStop(JNIEnv *env, jobject thiz,
                                            jlong wakuPtr) {
  cb_result *result = NULL;
  // Use the unified high-level lifecycle (create/start/stop/destroy) — the raw
  // waku_stop/waku_destroy kernel symbols are not exported by the current
  // liblogosdelivery build; logosdelivery_stop_node/destroy share the same ABI.
  logosdelivery_stop_node((void *)wakuPtr, on_response, &result);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuDestroy(JNIEnv *env, jobject thiz,
                                               jlong wakuPtr) {
  cb_result *result = NULL;
  logosdelivery_destroy((void *)wakuPtr, on_response, &result);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuConnect(JNIEnv *env, jobject thiz,
                                               jlong wakuPtr,
                                               jstring peerMultiAddr,
                                               jint timeoutMs) {
  cb_result *result = NULL;
  const char *peer = (*env)->GetStringUTFChars(env, peerMultiAddr, 0);
  waku_connect((void *)wakuPtr, on_response, (void *)&result, peer, timeoutMs);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, peerMultiAddr, peer);
  return response;
}

// Node introspection: getNodeInfo("Metrics") returns Prometheus text carrying
// libp2p_peers / libp2p_gossipsub_peers_per_topic_mesh — the only way to tell a
// connected node from an isolated one. Mirrors kym_core's refreshPeerCount().
// Subscribe by CONTENT topic via the high-level API, which auto-shards to the
// right pubsub topic (/waku/2/rs/<cluster>/<shard>) exactly like the desktop
// delivery_module does. The low-level waku_relay_subscribe takes a PUBSUB topic;
// handing it a content topic silently subscribes to a shard that does not exist,
// so the node receives nothing. That was the sync bug.
jobject Java_com_receiverandroid_LogosMessagingModule_wakuSubscribeContentTopic(JNIEnv *env,
                                               jobject thiz,
                                               jlong wakuPtr,
                                               jstring contentTopic) {
  cb_result *result = NULL;
  const char *ct = (*env)->GetStringUTFChars(env, contentTopic, 0);
  logosdelivery_subscribe((void *)wakuPtr, on_response, (void *)&result, ct);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, contentTopic, ct);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuGetNodeInfo(JNIEnv *env, jobject thiz,
                                               jlong wakuPtr,
                                               jstring nodeInfoId) {
  cb_result *result = NULL;
  const char *id = (*env)->GetStringUTFChars(env, nodeInfoId, 0);
  logosdelivery_get_node_info((void *)wakuPtr, on_response, (void *)&result, id);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, nodeInfoId, id);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuListenAddresses(JNIEnv *env,
                                                       jobject thiz,
                                                       jlong wakuPtr) {
  cb_result *result = NULL;
  waku_listen_addresses((void *)wakuPtr, on_response, (void *)&result);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuRelayPublish(JNIEnv *env, jobject thiz,
                                                    jlong wakuPtr,
                                                    jstring pubsubTopic,
                                                    jstring jsonWakuMessage,
                                                    jint timeoutMs) {
  cb_result *result = NULL;
  const char *topic = (*env)->GetStringUTFChars(env, pubsubTopic, 0);
  const char *msg = (*env)->GetStringUTFChars(env, jsonWakuMessage, 0);
  waku_relay_publish((void *)wakuPtr, on_response, (void *)&result, topic, msg, timeoutMs);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, pubsubTopic, topic);
  (*env)->ReleaseStringUTFChars(env, jsonWakuMessage, msg);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuRelaySubscribe(JNIEnv *env, jobject thiz,
                                                      jlong wakuPtr,
                                                      jstring pubsubTopic) {
  cb_result *result = NULL;
  const char *topic = (*env)->GetStringUTFChars(env, pubsubTopic, 0);
  logosdelivery_subscribe((void *)wakuPtr, on_response, (void *)&result, topic);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, pubsubTopic, topic);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuRelayUnsubscribe(JNIEnv *env,
                                                        jobject thiz,
                                                        jlong wakuPtr,
                                                        jstring pubsubTopic) {
  cb_result *result = NULL;
  const char *topic = (*env)->GetStringUTFChars(env, pubsubTopic, 0);
  waku_relay_unsubscribe((void *)wakuPtr, on_response, (void *)&result, topic);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, pubsubTopic, topic);
  return response;
}

void wk_callback(int callerRet, const char *msg, size_t len, void *userData) {
  (void)callerRet;
  (void)len;
  cb_env *c = (cb_env *)userData;
  if (c == NULL) {
    return;
  }

  // The node invokes this from its own worker thread, which is NOT attached to the JVM. Attach it
  // (once — the pthread-key destructor detaches on thread exit). NOTE: the previous code did the
  // attach *inside* an assert(), so a release/NDEBUG build stripped the call and left env NULL →
  // SIGSEGV on the first JNI deref. Attach unconditionally.
  JNIEnv *env = NULL;
  jint st = (*jvm)->GetEnv(jvm, (void **)&env, JNI_VERSION_1_6);
  if (st == JNI_EDETACHED) {
    if ((*jvm)->AttachCurrentThread(jvm, &env, NULL) != JNI_OK || env == NULL) {
      return;
    }
    pthread_setspecific(gDetachKey, (void *)1); // arm detach-on-thread-exit for this thread
  } else if (st != JNI_OK || env == NULL) {
    return;
  }

  jstring message = (msg != NULL) ? (*env)->NewStringUTF(env, msg) : NULL;
  (*env)->CallStaticVoidMethod(env, gEventCbClass, gExecEventCb, c->wakuPtr, message);
  if ((*env)->ExceptionCheck(env)) {
    (*env)->ExceptionClear(env);
  }
  if (message != NULL) {
    (*env)->DeleteLocalRef(env, message);
  }
  // No DetachCurrentThread here — attach-once-per-thread; the pthread key detaches on thread exit.
}

// Publish on a CONTENT topic via the stable high-level API. messageJson is the
// liblogosdelivery send envelope: { "contentTopic": "...", "payload":
// "<base64>", "ephemeral": false }. This is the counterpart of
// wakuRelaySubscribe → logosdelivery_subscribe, so phone publishes and the
// desktop delivery_module (which subscribe()s the same content topic) receive.
jobject Java_com_receiverandroid_LogosMessagingModule_wakuSend(JNIEnv *env, jobject thiz,
                                                jlong wakuPtr,
                                                jstring messageJson) {
  cb_result *result = NULL;
  const char *msg = (*env)->GetStringUTFChars(env, messageJson, 0);
  logosdelivery_send((void *)wakuPtr, on_response, (void *)&result, msg);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, messageJson, msg);
  return response;
}

// --- Reliable Channels bridge -------------------------------------------------
// The SDS-channel counterpart of subscribe/send. channelCreate joins the channel
// (channelId == contentTopic == the household topic, senderId == this device id);
// channelSend publishes { "payload":"<base64>", "ephemeral":false } on it; received
// messages arrive through the SAME event callback as "onChannelMessageReceived".
// This is what lets the phone interoperate with a KYM_USE_CHANNELS desktop/hub —
// the raw subscribe/send path can't decode the SDS reliable-channel framing.
jobject Java_com_receiverandroid_LogosMessagingModule_wakuChannelCreate(JNIEnv *env, jobject thiz,
                                                jlong wakuPtr,
                                                jstring channelId,
                                                jstring contentTopic,
                                                jstring senderId) {
  cb_result *result = NULL;
  const char *cid = (*env)->GetStringUTFChars(env, channelId, 0);
  const char *ct = (*env)->GetStringUTFChars(env, contentTopic, 0);
  const char *sid = (*env)->GetStringUTFChars(env, senderId, 0);
  logosdelivery_channel_create((void *)wakuPtr, on_response, (void *)&result, cid, ct, sid);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, channelId, cid);
  (*env)->ReleaseStringUTFChars(env, contentTopic, ct);
  (*env)->ReleaseStringUTFChars(env, senderId, sid);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuChannelSend(JNIEnv *env, jobject thiz,
                                                jlong wakuPtr,
                                                jstring channelId,
                                                jstring messageJson) {
  cb_result *result = NULL;
  const char *cid = (*env)->GetStringUTFChars(env, channelId, 0);
  const char *msg = (*env)->GetStringUTFChars(env, messageJson, 0);
  logosdelivery_channel_send((void *)wakuPtr, on_response, (void *)&result, cid, msg);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, channelId, cid);
  (*env)->ReleaseStringUTFChars(env, messageJson, msg);
  return response;
}

jobject Java_com_receiverandroid_LogosMessagingModule_wakuChannelClose(JNIEnv *env, jobject thiz,
                                                jlong wakuPtr,
                                                jstring channelId) {
  cb_result *result = NULL;
  const char *cid = (*env)->GetStringUTFChars(env, channelId, 0);
  logosdelivery_channel_close((void *)wakuPtr, on_response, (void *)&result, cid);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, channelId, cid);
  return response;
}

// Store (history) query — the pull half of catch-up. liblogosdelivery exposes the
// kernel waku_store_query (the desktop delivery_module does NOT bridge it, but the
// phone only needs to READ history, and the fleet's store nodes retain relay
// traffic). jsonQuery is an nwaku StoreQueryRequest:
//   {"requestId","contentTopics":[...],"includeData":true,"paginationForward":true,
//    "paginationLimit":100,"paginationCursor":<opt>}
// peerAddr is the store node multiaddr to ask (a fleet bootstrap node). The reply
// JSON (messages[] with base64 payloads + paginationCursor) is returned verbatim to
// JS via on_response, which decrypts each payload exactly like a live receive.
jobject Java_com_receiverandroid_LogosMessagingModule_wakuStoreQuery(JNIEnv *env, jobject thiz,
                                                jlong wakuPtr,
                                                jstring jsonQuery,
                                                jstring peerAddr,
                                                jint timeoutMs) {
  cb_result *result = NULL;
  const char *q = (*env)->GetStringUTFChars(env, jsonQuery, 0);
  const char *peer = (*env)->GetStringUTFChars(env, peerAddr, 0);
  waku_store_query((void *)wakuPtr, on_response, (void *)&result, q, peer, timeoutMs);
  jobject response = to_jni_result(env, result);
  free_cb_result(result);
  (*env)->ReleaseStringUTFChars(env, jsonQuery, q);
  (*env)->ReleaseStringUTFChars(env, peerAddr, peer);
  return response;
}

void Java_com_receiverandroid_LogosMessagingModule_wakuSetEventCallback(JNIEnv *env, jobject thiz,
                                                     jlong wakuPtr) {
  cb_env *c = (cb_env *)malloc(sizeof(cb_env));
  c->wakuPtr = wakuPtr;
  c->env = env;
  logosdelivery_set_event_callback((void *)wakuPtr, wk_callback, (void *)c);
}
