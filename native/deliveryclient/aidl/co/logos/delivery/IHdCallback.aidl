package co.logos.delivery;
interface IHdCallback {
    // Service -> client: the answer to one hdCall (JSON; {"error": ...} on failure).
    oneway void onResult(String resultJson);
}
