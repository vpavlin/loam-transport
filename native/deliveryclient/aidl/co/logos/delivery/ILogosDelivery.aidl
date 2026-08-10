package co.logos.delivery;
import co.logos.delivery.ILogosDeliveryCallback;
interface ILogosDelivery {
    void registerClient(String appId, ILogosDeliveryCallback cb);
    void subscribe(String appId, String topic);
    void send(String appId, String topic, in byte[] sealed);
    void unregisterClient(String appId);
    String metrics();
}
