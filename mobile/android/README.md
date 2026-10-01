# LexBridge Android 0.1.0

Native Java companion, Android 10 (API 29) or newer. Compile/target API 36,
Java 17, Android Gradle Plugin 8.11.1, Gradle 8.13. No embedded credentials.

Pair using a one-time code and a private server URL. HTTP only accepts literal
Tailscale 100.64/10 or loopback peers. HTTPS also accepts `.ts.net` names and
uses system certificate validation. No redirect follows, userinfo, URL secrets,
public/LAN HTTP, certificate overrides or broad storage permissions.

Android cannot express CIDRs in network-security XML. The transport permits
cleartext at the platform layer and gates **every** socket through UrlPolicy.
The only mutable endpoint comes from encrypted pairing; routes are fixed.

The explicit background switch runs a connectedDevice + remoteMessaging
foreground service: own-desktop file exchange and explicitly sent agent alerts.
Incoming files automatically stream into unpublished MediaStore rows under
Downloads/LexBridge, verify size and SHA256, persist identity, publish and ack.
An interrupted unpublished row is cleaned at the next receive. A verified row
interrupted during publication is published before ack, preventing duplicates.
Downloads survive forgetting pairing; credentials and app receipts do not.

User initiated uploads and manual Receive use a finite dataSync service with
cancellation and Android 15 timeout cleanup. A shared transfer lock serializes
both paths. No boot receiver, background activity launch, SMS/location access,
conversation scanning or automatic agent notification hooks.

Notifications use stable IDs and durable receipt/display state. A quiet ongoing
connection card offers Disconnect. Agent alerts use a private lockscreen card
and generic public version. If notifications are denied, persisted Alerts UI
remains accessible and server ack is received rather than displayed.

Build using the pinned Gradle 8.13 wrapper: `./gradlew testDebugUnitTest lintDebug assembleDebug`.
Set ANDROID_HOME and JAVA_HOME (Java17). LEXBRIDGE_ANDROID_BUILD_ROOT places
all generated outputs outside source; --project-cache-dir and GRADLE_USER_HOME
can likewise place both Gradle caches on a volume with sufficient free space.
For release, root supplies `LEXBRIDGE_SIGNING_PROPERTIES` pointing to a private
properties file containing storeFile, storePassword, keyAlias, keyPassword.
Never place that file or the signing key in source. Credentials are AES-GCM
encrypted under Android Keystore and backups/device migration are disabled.

The seven synthetic Android instrumentation fixtures exercise secure pairing,
Keystore encryption, foreground SSE plus auto receive and alert dedup, verified
MediaStore download and upload, lost ACK retry, corrupt bytes cleanup, redirect
rejection, state responses above64KiB and alert notification taps opening Alerts
on both cold launch and onNewIntent without duplicate cards. Run on an emulator using
`./gradlew connectedDebugAndroidTest`; these fixtures never use live credentials.
Only GET /v1/state accepts responses up to2MiB; other JSON calls are64KiB.

JVM tests cover address boundaries, HTTPS private hostname allowlist, redirect
endpoint smuggling inputs, filename traversal/control characters, canonical UUIDs
and exact SHA256 including mismatch/truncation. Emulator tests should additionally
exercise actual pair, SSE alert delivery/ack, multi-file send and verified receive;
unit tests alone do not prove background delivery or a physical device install.
