package co.logos.delivery;
import co.logos.delivery.ILogosDeliveryCallback;
interface ILogosDelivery {
    void registerClient(String appId, ILogosDeliveryCallback cb);
    void subscribe(String appId, String topic);
    void send(String appId, String topic, in byte[] sealed);
    // Fire-and-forget: ask the shared node to pull cold-start history (waku_store_query) for this
    // client's joined topics. Results are delivered back through the normal onReceive callback, so
    // no synchronous response channel is needed — the client folds them like live messages. This is
    // the shared-node equivalent of RealNode.storeSync (the embedded-node history pull).
    void requestStoreSync(String appId);
    void unregisterClient(String appId);
    String metrics();
}
