# Android verification — 2026-10-02

Application `com.lexilominite.lexbridge`, native Java, minimum API 29,
compile/target 36. Built with Java 17, Gradle 8.13, AGP 8.11.1.

Verified build tasks: testDebugUnitTest, lintDebug, assembleDebug,
assembleRelease, assembleDebugAndroidTest. Eight JVM tests passed with zero
failures/errors. Lint passed with no errors; advisory warnings concern deliberate
synchronous durability, runtime-gated cleartext for Tailscale literals, pinned
test dependencies and English labels.

The signed release APK passed APK Signature Scheme v2 verification with one
signer. SHA256:
`84c260102a63299d699df671912f3411232b3920757b7bfa2460f897eb4af72b`.
All generated outputs and caches are on the external build volume.

Six Android instrumentation fixtures passed on headless AOSP Android 16 / API 36
arm64 emulator `LexBridge-QA-36`, serial emulator-5554. The synthetic loopback
fixture exercised actual secure pairing, Keystore encryption, SSE foreground
connection, automatic file receive, MediaStore verified publication, explicit
alert persistence/ack/dedup, upload, failed ACK retry, corruption cleanup,
redirect rejection, and state above 64 KiB. No physical phone was attached.

Evidence lives under `/Volumes/Transcend/CodexBuilds/lexbridge-mobile-20261002/`:

- `android-fixture-run.log` — Gradle instrumentation run, six tests passed.
- `native-fixture-results/` — retained XML/protobuf/logcat results.
- `native-fixture-reports/` — retained HTML report before other test runs.
- `android-build/app/test-results/testDebugUnitTest/` — eight JVM test results.
- `android-build/app/reports/lint-results-debug.html` — lint report.
- `android-build/app/outputs/apk/release/app-release.apk` — signed release APK.

Real Node bridge interoperability is a separate optional instrumentation test
`RealBridgeInteropTest`. It consumes root-provided synthetic pairing JSON only
from app-private `files/interop-pairing.json`, removes it, pairs using the real
Node API, sends a synthetic MediaStore text file, and starts the actual connection
service to receive a root-queued file/explicit alert. It checks exact bytes and
server receipt statuses and cleans test credentials/downloads afterward.
This test passed directly through adb instrumentation on the same API 36 emulator
in 2.909 seconds. It used the actual Node bridge on loopback port 18475 via adb reverse,
not the Java mock server. Native code verified exact downloaded bytes, persisted
alert receipt, and real server file/notification acknowledgement status.

The Node fixture independently recorded complete=true at
2026-10-01T22:28:56.108Z:

- Phone-to-desktop: phone-to-desktop.txt,41 bytes, received, compatible desktop
  receipt, SHA256 20cbcb91aec0489e01828e32e3f782bcd991710a63a6a63b6d360bf36ce811ff.
- Desktop-to-phone: desktop-to-phone.txt,43 bytes, received, exact hash ack,
  SHA256 adfefb744601c66698ca0f6c0cf73faf557b121b9fc3dfcb2d3c857aa374046b.
- Explicit synthetic alert: status displayed, recipientCount 1, receivedCount 1,
  displayedCount 1.

Interop evidence in the same external build root:
`android-real-node-interop.log`, `real-interop/verification.json`,
`interop-files.png`, `interop-alerts.png`. Screenshots were captured from the
actual native Activity before test cleanup and visually inspected. They show
verified Received/Sent cards and the explicitly sent alert. Private pairing input
was consumed/deleted, test credentials removed, and test MediaStore rows cleaned.
No physical phone, live desktop runtime or live pairing credential was used.

These checks prove native behavior on an API 36 emulator, synthetic Java fixtures,
and actual Node bridge protocol interoperability with a synthetic private runtime.
They do not prove a physical Tailscale phone connection, manufacturer battery
policy behavior, or actual API 29-device runtime. API 29 compatibility was reviewed
and guarded with build/lint checks; no API 29 emulator was executed.


A final notification navigation fix now opens Alerts when an agent alert is
tapped. Its immutable explicit PendingIntent has a distinct action and only
accepts the whitelisted Alerts tab. MainActivity honors it during cold launch
and onNewIntent; existing connection and transfer destinations stay intact.

The focused native test `alertNotificationTapOpensAlertsWithoutDuplicateCards`
passed in 2.039 seconds on the same API 36 emulator. It asserted one card after
repeated same-ID posts, cold notification-intent launch into Alerts, then sent
the actual posted notification PendingIntent after switching to Files and
verified that Alerts reopened. Evidence: `android-alert-tap-fixture.log`.
The eight JVM tests, lintDebug and debug/release/test APK builds passed again;
build evidence is `android-final-alert-build.log`. The final release signature
was verified again and its current SHA256 is recorded above. The previously
verified real Node transport contract was unchanged by this navigation fix.
