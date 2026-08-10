package co.logos.delivery;
interface ILogosDeliveryCallback {
    // Service -> client. candidatesJson = JSON array of base64 payload candidates
    // (the client tries each with its key). oneway so a slow client can't block dispatch.
    oneway void onMessage(String topic, String candidatesJson);
}
