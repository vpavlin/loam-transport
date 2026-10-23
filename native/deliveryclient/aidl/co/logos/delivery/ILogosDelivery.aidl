package co.logos.delivery;
import co.logos.delivery.ILogosDeliveryCallback;
import co.logos.delivery.IHdCallback;
interface ILogosDelivery {
    void registerClient(String appId, ILogosDeliveryCallback cb);
    void subscribe(String appId, String topic);
    void send(String appId, String topic, in byte[] sealed);
    void unregisterClient(String appId);
    String metrics();
    // APPEND ONLY: Binder numbers methods by position, so a method inserted before metrics() shifts
    // every later transaction id and breaks every client built against the old order.
    // Fire-and-forget: ask the shared node to pull cold-start history (waku_store_query) for this
    // client's joined topics. Results come back through the normal onReceive callback.
    void requestStoreSync(String appId);
    // HD identities (loam-keycard ADR 0001), APPENDED. requestJson = {op:"status"} | {op:"identity", contextId}
    // | {op:"sign", contextId, digestHex}; contextId "" = the main identity. The answer comes on cb.
    void hdCall(String appId, String requestJson, IHdCallback cb);
    // Network timestamps (WhisperBox deadlines), APPENDED — never insert above: Binder txn ids are positional.
    // The client asks for features (bit 1 = deliver via ILogosDeliveryCallback.onMessageMeta with the
    // network timestamp + source); the service answers with the features it will use. An older Loam
    // without this method replies empty, which reads as 0: the client stays on onMessage.
    int setClientFeatures(String appId, int features);
    // Logos Storage (loam-transport ADR 0020, amended 2026-10-23), APPENDED — never insert above.
    // Loam fetches CIDs in the background as jobs keyed by CID; the calling app may close meanwhile.
    // Returns are JSON: {cid, state: none|queued|fetching|done|failed|cancelled, bytes, total, error?}.
    // An older Loam without these methods replies empty (null): the client falls back to its own node.
    String storageFetch(String appId, String cid, String peersJson);
    String storageStatus(String appId, String cid);
    String storageCancel(String appId, String cid);
    // A read-only descriptor to the finished file (state done), or null.
    ParcelFileDescriptor storageOpen(String appId, String cid);
    // {running, online, cacheBytes, cacheFiles, cacheCap, jobs:[…]}
    String storageInfo(String appId);
}
