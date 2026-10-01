# LexBridge Mobile 0.1.0

A personal Android companion for exchanging files with your desktop and receiving brief alerts that you explicitly ask an AI agent to send. Android 10 or newer and a connected Tailscale network are required. This optional companion does not replace ShelfDock/LexBridge desktop or change clipboard settings.

## What it does

- Android **Files**: choose multiple files, or use Android's Share menu → LexBridge. Sending is deliberate. Files arrive in a unique Desktop folder and appear in the desktop app's existing Received tab.
- Desktop → Android: an explicit desktop send queues a file durably. While Background connection is enabled, the phone verifies and saves it in **Downloads/LexBridge**. The Files tab lists received and sent items and opens received files.
- Android **Alerts**: a private inbox and Android notifications for explicitly sent agent messages. A quiet ongoing connection notification has **Disconnect**. Denied notification permission still leaves messages in Alerts.
- Settings: background connection, notification preferences, refresh and forget pairing. Pairing uses a private, single-use ten-minute code. Device credentials are encrypted using Android Keystore; owner and agent credentials stay on the desktop.

There is no conversation scanning, automatic completion hook, remote shell execution, or Android clipboard synchronization. The desktop must be awake and reachable on Tailscale for live delivery. Queued messages and files survive a bridge restart. Android force-stop, a disconnected VPN or some phone battery restrictions can prevent background delivery until the app is reopened.

## Install and pair

1. Install the signed `LexBridge-Android-0.1.0.apk` on your phone. Android may ask you to allow APK installation from the browser or Files app. Keep Tailscale connected.
2. On the Mac, install Node.js 22+ and Python 3.10+ if needed, then run `python3 mobile/tools/install_macos.py` from the full source or companion bundle. This installs an optional login service and the `~/.local/bin/lexbridge-mobile` command. It preserves the installed desktop app, runtime credentials and previous companion bundles.
3. Generate a fresh pairing code:

   ```sh
   ~/.local/bin/lexbridge-mobile pair --endpoint http://YOUR_MAC_TAILSCALE_IP:18474
   ```

   The command prints the path of a private JSON file. Open that file locally to read its endpoint, code and expiry. Do not publish the file or send its contents to an agent. `pair --show` deliberately prints it in your own terminal if you prefer.
4. In Android, enter the endpoint, pairing code and phone name. Choose **Pair securely**. Allow notifications for agent alerts, or leave them disabled and read Alerts in the app. The Background connection toggle can be disabled at any time.
5. Run `~/.local/bin/lexbridge-mobile status` to see the paired device ID. Send a file:

   ```sh
   ~/.local/bin/lexbridge-mobile send /absolute/path/report.pdf --device DEVICE_UUID
   ```

The Mac installer also creates **Pair LexBridge Phone** and **Send Files to Phone** shortcuts under `~/Applications/LexBridge Phone Tools`. These open simple native dialogs only when you invoke them. Pairing generates a fresh code; sending opens a file picker and a device chooser when more than one phone is paired. The helper reports a queued receipt accurately rather than claiming that an offline phone received it.

The service uses private port 18474. Do not expose it through a public proxy or port forward. Default maximum file size is 1 GiB. Pending desktop-to-phone files and incoming daily phone uploads have separate 2 GiB per-device limits. Native Tailscale HTTP travels within Tailscale's encrypted connection; arbitrary public or LAN HTTP endpoints are refused. HTTPS private endpoints use normal certificate validation.

macOS may require allowing the service process Desktop access when a phone sends its first file. If the Mac is asleep or Desktop permission is denied, sending fails clearly and never claims receipt.

## Explicit agent alerts

Install the portable skill in `mobile/skills/lexbridge-notify` in your harness's skill folder. Add the stdio MCP server using Python and the absolute path to `mobile/integrations/mcp_server.py`. Keep existing MCP entries. [Integration instructions](skills/lexbridge-notify/references/integration.md) include Codex, Claude Code, Paperclip and direct Python use. For an installed Mac bridge, use the stable `~/Library/Application Support/LexBridge Mobile/current/mobile/integrations/mcp_server.py` path.

Agent tools are `send_phone_notification` and `get_phone_notification_status`. Ask, for example: “When this task finishes, send a brief success or failure alert to my LexBridge phone.” This authorizes that alert. Normal task execution alone does not. `queued`, `received` and `displayed` are distinct receipts; no paired phone returns a clear error.

Paperclip can import `mobile/integrations/paperclip_adapter.py` or invoke the same CLI/MCP tool explicitly. These files do not modify a Paperclip deployment or subscribe to all its events.

## Recovery and rollback

- Turn off Background connection or choose Disconnect to stop phone connectivity. Forget pairing removes local credentials; downloaded files stay available.
- Revoke a phone with `lexbridge-mobile revoke DEVICE_UUID`. It immediately loses API access; completed Desktop files remain.
- Stop only the optional Mac companion using `python3 mobile/tools/install_macos.py --stop`. It disables its launch agent and preserves credentials, files and previous bundles. The original desktop app continues running.
- Keep the Android signing identity outside source; updates must retain the application ID and signing key. Uninstalling the APK removes app credentials/inbox but not published Downloads.
- Do not copy `agent.json`, `config.json`, pairing files or signing keys into releases. Only the APK and clean source bundle are distributable.

## Build and checks

See [Android build instructions](android/README.md), [bridge protocol](PROTOCOL.md), and [bridge operation](bridge/README.md). Focused checks:

```sh
node --test mobile/bridge/test.cjs
python3 -m unittest discover -s mobile/integrations/tests -v
# In mobile/android, with Android SDK + Gradle 8.13 + Java 17:
gradle testDebugUnitTest lintDebug assembleDebug assembleRelease assembleDebugAndroidTest
```

Native instrumentation, package signature and actual phone/Tailscale delivery are separate verification gates. Consult the release verification notes for which were actually run. This preview is not a Play Store release.
