# LexBridge Mobile 0.1.0 release and device checklist

This is a personal Android companion preview, minimum Android 10/API 29 and target API 36. The installed desktop app remains a separate product. Phone alerts require an explicit user request; ordinary task completion does not authorize an alert. The Paperclip adapter is available as an explicit tool; this release does not deploy it into an existing Paperclip service.

## Verified readiness

- The Node bridge's 14 disposable fixture tests passed, including credential scope, one-time pairing, streamed file verification, existing desktop Received receipt compatibility, restart persistence, interrupted-upload cleanup, quotas, actual acknowledgement states, and notification progress during a paused upload.
- The separate HTTP interoperability fixture's two smoke tests passed. Six native Android protocol fixtures passed on the Android 16/API 36 emulator. Eight JVM tests and lint/build checks passed.
- Actual native Android-to-Node interoperability passed on that emulator against the real backend on isolated loopback port 18475. The uploaded synthetic file was 41 bytes with SHA-256 `20cbcb91aec0489e01828e32e3f782bcd991710a63a6a63b6d360bf36ce811ff`; the 43-byte download had SHA-256 `adfefb744601c66698ca0f6c0cf73faf557b121b9fc3dfcb2d3c857aa374046b`. The outgoing file had an exact-hash acknowledgement, the incoming batch had a compatible Received receipt, and the explicit alert reported one received/displayed recipient. These were synthetic fixture artifacts, not a physical phone or production pairing.
- The root task confirmed the production Mac companion was installed and healthy through both loopback and its Tailscale IPv4 endpoint, and that Codex/Claude skill and MCP registration preserved their other configuration. The source audit did not restart, stop, or mutate that service.
- The final `LexBridge-Android-0.1.0.apk` was independently read for its checksum and ZIP integrity: SHA-256 `84c260102a63299d699df671912f3411232b3920757b7bfa2460f897eb4af72b`; its eight ZIP entries passed the integrity check with no runtime configuration or signing-key entries. Root also verified signature scheme v2, application ID, minimum API 29 and target API 36. Use the final release's checksum file and verification record; a previous build's hash is not evidence for this rebuilt APK.

Read [Android verification](android-verification.md), [independent review](independent-review.md), and [bridge operation](../bridge/README.md) for evidence and boundaries. Emulator results establish the tested native protocol behavior; they do not establish a manufacturer's battery policy, a physical Tailscale route, or Android API 29 runtime behavior.

## Packaging audit

Distribute the signed APK and a clean companion source archive. A usable extracted source bundle must retain this relative layout:

```text
desktop/received.cjs
mobile/README.md
mobile/PROTOCOL.md
mobile/bridge/{main.cjs,server.cjs,README.md}
mobile/integrations/{mcp_server.py,notify.py,paperclip_adapter.py}
mobile/skills/lexbridge-notify/
mobile/tools/{install_macos.py,mac_actions.py}
mobile/android/{gradlew,gradlew.bat,gradle/wrapper/,build.gradle,settings.gradle,app/}
mobile/docs/
```

The backend imports `desktop/received.cjs`; the Mac installer also preflights and copies that helper. Archiving only the `mobile` directory makes that install incomplete. Preserve the Gradle wrapper JAR/properties and executable mode of `gradlew`, or run `chmod +x mobile/android/gradlew` after extraction if the archive tool did not preserve it. The wrapper pins Gradle 8.13 and its distribution checksum. Rebuilding Android still requires Java 17, Android SDK/platform 36, build tools, accepted SDK licenses, and initial access to the pinned dependencies. Release signing additionally requires the owner's external signing identity.

The source archive must exclude real `agent.json`, `config.json`, `state.json`, pairing instructions, `installation.json`, recovery backups, service logs, spool bytes, native fixture `verification.json`, and real device receipt data. Also exclude signing keys/properties, local SDK paths, Gradle/build caches, Python caches, and generated APKs from the source archive. The APK is a separate release artifact. Test source files that generate synthetic fixtures are safe to include; populated fixture runtimes are not. Do not include any private signing key in the APK or source archive.

Before publishing or handing over the release, inspect archive entries for absolute paths, `..` components, symlinks, unexpected generated data, and the private artifacts listed above. Confirm the archive passes its integrity check, contains the required helper and wrapper, and matches its checksum. Verify the final APK's application ID, version, minimum SDK, signature, and checksum. Packaging checks do not substitute for native runtime tests.

## Limits recorded in source

| Resource | Default/bound | Behavior at the bound |
| --- | --- | --- |
| Individual file | 1 GiB | Reject oversized declared or streamed content; remove partial staging |
| Pending outgoing spool | 2 GiB per phone | Reject beyond available/reserved capacity |
| Incoming file volume | Separate 2 GiB per phone per UTC day | Persist daily usage; reject overflow |
| Simultaneous uploads | 2 globally | Return 429 while both slots are occupied; alerts do not wait for their streams |
| Paired phones | 32 | Refuse additional pairing |
| File history | 500 per phone / 8000 globally | Prune received metadata; preserve queued transfers or refuse new work |
| Alert history | 500 per phone / 1000 globally | Prune acknowledged history; preserve queued alerts or refuse new work |
| Alert byte storage | 1 MiB per phone / 4 MiB global UTF-8 JSON | Reserve acknowledgement growth; prune acknowledged history or return 429 |
| Journal | 12 MiB maximum before every mutation write | Return 429 rather than write an oversized journal; reader is bounded to 16 MiB |
| JSON request/ordinary response | 64 KiB | Reject oversized input or client response |
| Device state / owner state | 2 MiB / 8 MiB | Explicit response bounds; owner state omits alert bodies |
| Pairing | 144 random bits / ten minutes / one use | Expired or reused codes fail |
| Event connections | 2 per phone / heartbeat every 20 seconds | Reject excess connections; disconnect backpressured readers; refresh state on reconnect |

`maxFileBytes` and `quotaBytes` are configurable in the owner's private bridge configuration while stopped. The other bounds are code constants for this release. Incoming volume is a transfer quota, not an instruction to delete completed Desktop files. History pruning does not delete user-owned Desktop files or published phone downloads. File acknowledgement deletes only the private outgoing spool copy. Idempotency is retained while the corresponding bounded alert record remains in history.

## Install and recovery

From the complete extracted source bundle, run `python3 mobile/tools/install_macos.py` on macOS with Node 22+ and Python 3.10+. The installer creates a separate versioned companion bundle, login service, command wrapper, and native Pair/Send shortcuts. It preserves existing runtime credentials and the installed desktop application. Existing MCP entries must be retained when registering the explicit notification tools. See [mobile installation](../README.md) for pairing and send instructions.

The private runtime is `~/.config/lexbridge-mobile` with 0700 directory permissions; configuration and pairing instructions are 0600. Keep any recovery backups there private. Failed installer publication has rollback logic and an owner-only backup manifest. Do not distribute those backups. A successful installer invocation is followed by checking actual service health; source staging alone is not installation success.

`python3 mobile/tools/install_macos.py --stop` stops only the optional phone companion and preserves its data. Reinstall using the same complete source bundle to enable it again. Do not delete the runtime merely to restart the service. `lexbridge-mobile revoke DEVICE_UUID` removes a phone's API credential and disconnects its streams/transfers. Completed Desktop files remain. Android Disconnect disables the connection; Forget removes the local pairing. Published Downloads remain available. APK updates must retain the same application ID and signing identity; a newly generated signing key cannot update an installed APK signed by the prior key.

Never place port 18474 behind a public proxy, forward it to the Internet, or expose owner credentials to the phone. Native tailnet HTTP relies on Tailscale's encrypted transport; the bridge accepts source addresses only from loopback or Tailscale 100.64/10 and ignores forwarded-address headers. Owner operations require loopback. `queued`, `received`, and `displayed` describe different actual receipts. No paired recipient returns `Pair a phone first.` rather than a delivery claim.

## Remaining physical-phone gates

After the owner installs and pairs a physical phone, manually check:

1. Tailscale reachability, fresh one-use pairing, and foreground/background connection toggles. Confirm the intended host is awake and reachable.
2. An explicitly requested alert: allow notifications, open it by tapping the notification, and confirm the Alerts screen and actual received/displayed receipt. Also test denied permission and a disabled channel; those must retain the in-app alert and report received without claiming display.
3. Deliberate multi-file selection and Android Share uploads, desktop sends, saved `Downloads/LexBridge` content, and matching file bytes/hashes. Allow Desktop permission on macOS if requested.
4. Offline catch-up, app/process restart and stable-ID deduplication; interrupted unpublished downloads and recovery after verified publication but before acknowledgement.
5. Disconnect/Forget during an active alert and file transfer, device revocation, a blocking cloud document provider, and finite transfer timeout/cancellation. The quiet ongoing connection must offer Disconnect.
6. Screen-off/Doze and the phone manufacturer's battery restrictions. Exercise an actual API 29 device/emulator before claiming minimum-version runtime verification; API 29 has currently been checked through source/build/lint compatibility only.

These checks authorize only deliberately invoked test messages and file transfers. They do not authorize automatic completion hooks, session scanning, clipboard synchronization, or changes to an existing Paperclip deployment.
