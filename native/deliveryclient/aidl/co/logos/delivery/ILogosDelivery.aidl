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
}
