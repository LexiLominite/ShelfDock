# DropHarbor

Shake to collect. Drop onto a machine to send.

Version 0.4.1 restores the original soft lavender and purple palette, with clearer secondary text, quieter shadows and visible control boundaries. It also makes Clipboard tools optional in Settings and adds a reviewed SSH installation flow between compatible Macs. See [palette and readability details](BRAND.md) and [the update notes](docs/palette.md).

DropHarbor is a desktop shelf for files, folders, and text. A deliberate, fast back-and-forth cursor motion toggles the shelf beside your cursor. Shake again after a short pause to hide it. Gestures keep the shelf visible while dragging or editing; the shortcut can hide it deliberately. Hover over **Machines**, then drop a held item onto a ready destination to copy it to that machine's Desktop. Clicking a machine only selects it; it never sends anything.

## Use it

1. Open DropHarbor and let the first SSH check finish.
2. Shake the cursor quickly back and forth, or use **Command/Ctrl + Shift + Space**. The shortcut and menu-bar/tray icon also toggle the shelf.
3. Drop a file, folder, or selected text into the shelf. Use **Paste from clipboard** or **Command/Ctrl + V** to add plain text, a copied screenshot/image, or copied local files. Transfer-shelf Paste captures only when requested. Optional Clipboard tools can be enabled in Settings; automatic history has its own separate opt-in and never sends a copied item automatically. You can also use the file picker.
4. Hover over Machines. The list keeps LAN, Tailscale, and other SSH routes visible and separately labelled. You can search, filter, edit a destination, or add a machine manually.
5. Drag an item onto a machine labelled Ready to send it. The highlighted target shows the destination. The transfer receipt confirms success or explains a failure. Held items stay available for sending to another machine.

Every send creates a new `Drift-<timestamp>-<random>` folder inside the chosen Desktop folder. Existing remote files are not replaced. Text is sent as a UTF-8 `.txt` file. Removing an ordinary file from the shelf does not remove the original file. Text notes are stored privately in DropHarbor's app-data folder until removed.

## Clipboard and Transfers

**Transfers** is always available. Clipboard tools start **disabled on new installations**. Use **Settings → Enable Clipboard tools** to add the Clipboard workspace beside Transfers. Enabling tools alone does not record the system clipboard. Transfers retains the drag-to-machine shelf. Clipboard provides full-text search, type filters, favourites, reusable text snippets, text/image/file previews, Copy with original HTML formatting or Copy as plain text, and **Add to Transfers**. Copy never sends; adding to Transfers only stages the item. File history holds references to the originals, not backup copies.

**Settings → Show Clipboard tab** controls visibility independently. Hiding the tab returns to Transfers and does not pause automatic history that you previously enabled. Turning **Enable Clipboard tools** off stops recording and blocks native history actions, keeps saved items, and returns to Transfers. Re-enabling tools leaves recording off until you explicitly enable it again. Existing installations retain a valid prior automatic-history opt-in; missing or corrupt preferences never create a new opt-in. These choices stay on this device and are not included in portable configuration.

History starts **off**. Enable it explicitly in Clipboard; Pause stops background capture. The default cap is 200 entries, 30 days, and 32 MB total, with up to 1 MB of text and 8 MB of PNG data per item. While tools are enabled, unpinned entries expire; favourites survive expiry and Clear unpinned, but still count toward capacity. Delete favourites individually when needed. History payloads are encrypted with AES-256-GCM and a key protected by the operating system secret store. Saving history and remembered passwords require a secure secret store; Linux plaintext fallback is refused. Configuration exports exclude Clipboard tools preferences, capture consent, clipboard history and all credentials.

The app skips recognised private/transient clipboard markers and suspends automatic capture while its editors or password setup are active. Some applications and browser extensions do not mark sensitive content: pause history before copying secrets. Monitoring samples the clipboard; very rapid changes and compositor restrictions, especially Wayland, can limit capture. Source-app exclusions, direct paste into other apps, OCR, and cross-device clipboard sync are roadmap features, not part of this release. See [product design and research](PRODUCT_DESIGN.md).

## Password access and one-time key setup

Open **Access / Set up access** on a machine, then choose:

- **Existing SSH key:** use configured keys or the local SSH agent.
- **Use password once:** authenticate to the already trusted SSH server, generate a dedicated local Ed25519 key, append only its public key to the target account, and verify key-only access before saving the connection. The password is not saved. If a connection drops after installation may have begun, the same private key is retained for recovery and reused on retry.
- **Save password securely:** verify access, then store only encrypted ciphertext bound to that address, username, port, and SSH alias. Forget password removes the saved credential. Background probes never try saved passwords; a rejected password pauses further attempts until explicitly replaced.

SSH must already be enabled, reachable, and trusted in your existing known_hosts. Connect once through your terminal and verify the fingerprint against the machine before setup. The app never silently accepts an unknown or changed host key and cannot remotely enable an unreachable SSH server. No password is requested in configuration exports or logs. One-time setup prepares access; it does not send shelf content until you explicitly send or drop it.

## Send to several machines

Select shelf items and tick the target machines, then review **Send N items to M machines**. The confirmation lists destinations and counts. Up to 20 machines and 500 items can be selected; two destinations run concurrently. Each destination receives a fresh connection check and a collision-safe folder under its chosen Desktop. Activity shows independent progress/results. Selecting a machine alone never sends, and dropping onto a single machine still targets only that machine.

**More deliberate** is the default shake sensitivity. Existing installations retain their saved preference unless changed in Settings.

## View modes and portable configuration

The visible **View** selector and Settings provide **Compact**, **Balanced** (default), and **Expanded** views. Compact uses dense rows; Balanced keeps everyday actions visible; Expanded gives more room and adds a per-machine Details button for recent transfers. Device details and forwarding controls stay closed until you open them. The app resizes to the available screen space and remembers your choice. Existing Expanded/Large preferences map to Balanced/Expanded without changing the configuration format.

Use **Settings → Export configuration** to save a versioned `DropHarbor-config.json`, then **Import configuration** on another device. See [the example file](config/lex-drift-config.example.json). Import validates the entire file before applying it, merges endpoints instead of deleting existing machines, and preserves local authentication only for an exact address/username/port match. Imported hosts need a fresh SSH check.

Exports contain machine addresses/usernames/destinations and shake/view settings. They exclude private keys, passwords, SSH key paths/aliases, Clipboard tools preferences and capture consent, clipboard contents, shelf files, and transfer history. A machine list can still reveal private network details: share only a reviewed example, and keep your own export private.

The **clean edition** contains no personal preset. The separate **personal edition** preloads its bundled machine routes once on first launch, while keeping credentials on the device. Both repositories are private during testing. The clean repository can be made public independently after release checks; keep the personal repository and its builds private.

## Connections and authentication

DropHarbor reads your local Wave `connections.json`, SSH configuration (including Include files), and the online Tailscale peer list. It does not edit Wave or SSH configuration and does not read Wave's encrypted passwords. Exact duplicate endpoints are combined. Different LAN and Tailscale routes remain separate. This machine is retained if explicitly saved in Wave or SSH; it is not automatically added as a new remote peer. NVIDIA Sync client endpoints are not automatically imported as SSH destinations.

The app checks actual SSH command access, not only Tailscale online status. Ready means a noninteractive SSH check succeeded. Offline means the route could not connect. Authentication required means a username, working key, unlocked SSH agent, or verified host fingerprint is missing.

Imported SSH aliases retain their configured connection behavior. Manual machines need an address, SSH username, port, and optionally a local private-key path. Keys remain in your existing SSH folder; DropHarbor stores only their paths. Use the same SSH login that already works in your terminal. For a new server, connect in your terminal and verify its fingerprint before checking it in DropHarbor. The app never disables host-key checking.

## Install the app on another Mac

The **Install on another Mac** flow is available from an installed, packaged macOS app. Choose an existing saved SSH machine and select **Check Mac** to review its account, address, processor, version and destination. The destination must be macOS with the same architecture as the sending app; the current Mac release is Apple Silicon. This flow does not create arbitrary hosts or install Windows/Linux packages. Normal transfers remain available across supported desktop platforms.

Confirm the reviewed plan to send only this app bundle to the destination account's `~/Applications` folder. The preview expires after five minutes and can be used once. SSH trust and credentials come from the existing saved route; no new password or host-key bypass is introduced. A personal edition requires a separate acknowledgement that its bundled machine preset will be included. Local clipboard history, shelf data, passwords, private keys and the sender's application profile are not copied.

The installer rechecks the saved endpoint, app bundle and destination, verifies the uploaded archive's SHA-256 and app identity/version, and refuses to replace an existing destination app. It preserves bundle metadata, reports progress and any staging cleanup that still needs attention, and leaves the installed app closed. Open it yourself on the receiving Mac when ready; existing OS security prompts still apply. This is a first-install convenience, not an automatic updater or a way to enable Remote Login. Existing installations should be updated manually.

The flow has no completed live remote-install validation yet. Native macOS-to-macOS installation remains a release-test requirement; packaged Windows/Linux sender and receiver validation remains separate.

## What each device needs

- **Sender:** the DropHarbor desktop app and the OpenSSH client (`ssh` and `scp`). Tailscale is needed only for Tailscale destinations.
- **Receiver:** an SSH server with file-transfer support, trusted key/agent access or a configured password route, and permission to write to the selected Desktop folder. The receiver does not need DropHarbor or Wave installed. Linux/macOS use the traditional SCP protocol; Windows uses SFTP.
- **macOS:** allow Desktop/file access if macOS asks. A receiving Mac needs Remote Login enabled for the intended account. Remote Login/file access permissions must be approved by the machine's owner.
- **Windows:** install the OpenSSH Client for sending and OpenSSH Server for receiving. Sending to a native Windows destination requires OpenSSH 9 or newer on the sender. For a manual Windows server choose Windows as its operating system. Set its proper login username and trust the host in SSH first. Windows destination support uses the OS Desktop path, including OneDrive redirection, but has not yet been tested on a live Windows server.
- **Linux:** sending requires a graphical desktop. Headless machines, including Spark, can receive using their SSH server.

## Platform scope

The current packages provide macOS Apple Silicon `.app` in a ZIP, Windows x64 portable `.exe`, and Linux x64/ARM64 archive bundles.

The desktop code targets macOS, Windows, and Linux, including ARM64. Linux X11 supports cursor shaking. Wayland does not expose global cursor coordinates to Electron, so use the tray or keyboard shortcut there; the compositor may ask you to allow the shortcut. Windows and Linux builds require validation on those operating systems before a production release.

Android/iOS do not run this Electron desktop application. Mobile devices can be SSH destinations if they expose a supported SSH/SFTP service, but a native mobile client and system-wide shake gesture are not included. This build is unsigned and not notarized; trusted public distribution requires the owner's signing accounts/certificates.

## Development

Use Node.js 22.12 or newer and npm.

```sh
npm ci
npm test
npm start
```

`npm run dev` opens the interface as a browser preview with clearly labelled sample data. It does not access real hosts or transfer files. `npm start` builds and runs the actual desktop app.

```sh
npm run package:mac
npm run package:win
npm run package:linux
npm run package:linux-arm
```

The Windows portable EXE can be built with the provided target; a signed Windows installer and macOS DMG are recommended for a public release. Build and exercise releases on native operating-system runners. The source contains platform targets, but build targets alone do not establish tested support.

DropHarbor's own settings, queued item references, text notes, and receipts live in Electron's per-user application-data directory named `lex-drift`. Machine credentials and user-specific host lists are not bundled with the application. Closing the shelf hides it; use the tray menu to quit. A shared worker lock prevents clean/personal builds or different profiles from creating duplicate app instances. Launching with `--background` keeps the shelf hidden until requested. Automated native tests use `LEX_DRIFT_BACKGROUND_TEST=1`, which disables showing/focusing windows, always-on-top, tray icons, shortcuts, and cursor polling; headless controller tests exercise the toggles without touching your screen.

See [the Grok review summary](GROK_REVIEW.md) and [public-release preparation](PUBLIC_RELEASE.md).

## Current limits

- File contents are copied from the original path at send time. Moving or deleting a queued original requires adding it again.
- Symbolic links, sockets/devices, paths with control characters, and folders containing symbolic links are refused to avoid transferring unexpected files. Archive such folders first.
- The shelf holds up to 500 items and individual text notes up to 20 MB. There is no artificial ordinary-file size limit, but each transfer has a one-hour timeout and requires available disk space.
- One send operation runs at a time. A multi-machine operation runs up to two destination transfers concurrently, with independent receipts. A failed destination can contain partially delivered files; retrying creates a new folder.
- Machine Access supports an existing SSH key, a password used once to install a dedicated public key, or a password saved in an OS-protected encrypted vault. Direct password routes require password authentication and SFTP on the destination. Proxy/jump-host and certificate-based trust routes retain their existing OpenSSH key workflow.
- The app does not enable SSH servers, alter firewall rules, change Tailscale access policies, or register itself to launch at login automatically. One-time password setup installs a public key through an existing trusted SSH connection.

## References

- [Electron cursor-position API and Wayland limitation](https://www.electronjs.org/docs/latest/api/screen)
- [Wave connection settings](https://docs.waveterm.dev/connections)
- [Apple Remote Login](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac)
- [Microsoft OpenSSH setup](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)

## Product editions

The standard edition is **DropHarbor**. The personal edition remains **lex-drift** and bundles only the owner's private machine preset. Both repositories remain private during testing. The existing `lex-drift` settings directory, configuration schema, app ID, and worker lock remain stable so upgrading or switching editions preserves data and cannot start a second worker.

## Clearing and Undo

Clear shelf offers a 10-second Undo, restoring the exact cleared items alongside anything added afterward. Original files remain on disk; app-created text/image staging is cleaned up only after the recovery window expires. A pending clear survives an app restart for the remainder of that same window.

## Port forwarding

Choose the globe on a machine and enter a URL such as `http://localhost:1331`, then choose **Go**. A saved website reopens with one click on that globe. **Advanced** reveals Local/Remote direction and destination/listening ports; Advanced stays closed by default in every view, including Expanded. Local listens on this device and reaches the URL through the SSH machine. Remote listens on the SSH machine and reaches the destination through this device. Local live websites can open in your browser; Remote forwards do not open as local sites. A live chip on the machine stops that connection. Right-click or the three-dot menu retains advanced setup, history, access, editing and removal.

Go reports Forwarding or Live inline. Connections shows starting/running/failed status, the owned OpenSSH process ID where applicable, and Stop. Save a plan to History to repeat it later; each saved plan can have a note. Plans never restart automatically. Website scheme and pathname are remembered locally for saved plans; query strings and fragments are not persisted. These website preferences are currently excluded from configuration exports. HTTPS sites still need certificates and routing that work at the forwarded local address. Editing a machine's endpoint invalidates an old plan until you review a new one. Quitting closes the app's own tunnels.

Listeners bind to loopback. Remote forwarding verifies the actual remote listener before reporting Running, because SSH GatewayPorts settings can override requested bindings. Remote machines need `ss`, `lsof`, or Windows `Get-NetTCPConnection` for that check. An SSH alias with existing forwarding rules is refused to prevent opening additional ports unintentionally. Existing trusted key access and encrypted saved-password access are supported. Running means the SSH tunnel/listener is established; the destination service must also be available when used.
