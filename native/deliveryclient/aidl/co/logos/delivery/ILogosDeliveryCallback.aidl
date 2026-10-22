package co.logos.delivery;
interface ILogosDeliveryCallback {
    // Service -> client. candidatesJson = JSON array of base64 payload candidates
    // (the client tries each with its key). oneway so a slow client can't block dispatch.
    oneway void onMessage(String topic, String candidatesJson);
    // APPENDED (see ILogosDelivery.setClientFeatures): the same message plus metaJson =
    // {"ts": <network timestamp, ns, 0 = none>, "source": "live"|"history"|"", "bearer": "delivery"|"ble"}.
    // Only sent to a client that asked for it, so an older client never gets a call it can't handle.
    oneway void onMessageMeta(String topic, String candidatesJson, String metaJson);
}
