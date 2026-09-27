# DropHarbor

Shake to collect. Drop onto a machine to send.

The interface uses the deep teal, electric cyan, and yellow palette from lexilominite.com. See [brand colours](BRAND.md).

DropHarbor is a desktop shelf for files, folders, and text. A deliberate, fast back-and-forth cursor motion toggles the shelf beside your cursor. Shake again after a short pause to hide it. Gestures keep the shelf visible while dragging or editing; the shortcut can hide it deliberately. Hover over **Machines**, then drop a held item onto a ready destination to copy it to that machine's Desktop. Clicking a machine only selects it; it never sends anything.

## Use it

1. Open DropHarbor and let the first SSH check finish.
2. Shake the cursor quickly back and forth, or use **Command/Ctrl + Shift + Space**. The shortcut and menu-bar/tray icon also toggle the shelf.
3. Drop a file, folder, or selected text into the shelf. Use **Paste from clipboard** or **Command/Ctrl + V** to add plain text, a copied screenshot/image, or copied local files. Clipboard capture happens only when you request it; no clipboard history is monitored. You can also use the file picker.
4. Hover over Machines. The list keeps LAN, Tailscale, and other SSH routes visible and separately labelled. You can search, filter, edit a destination, or add a machine manually.
5. Drag an item onto a machine labelled Ready to send it. The highlighted target shows the destination. The transfer receipt confirms success or explains a failure. Held items stay available for sending to another machine.

Every send creates a new `Drift-<timestamp>-<random>` folder inside the chosen Desktop folder. Existing remote files are not replaced. Text is sent as a UTF-8 `.txt` file. Removing an ordinary file from the shelf does not remove the original file. Text notes are stored privately in DropHarbor's app-data folder until removed.

## View modes and portable configuration

Settings provides **Compact**, **Expanded**, and **Large** views. The app resizes to the available screen space and remembers your choice.

Use **Settings → Export configuration** to save a versioned `DropHarbor-config.json`, then **Import configuration** on another device. See [the example file](config/lex-drift-config.example.json). Import validates the entire file before applying it, merges endpoints instead of deleting existing machines, and preserves local authentication only for an exact address/username/port match. Imported hosts need a fresh SSH check.

Exports contain machine addresses/usernames/destinations and shake/view settings. They exclude private keys, passwords, SSH key paths/aliases, clipboard contents, shelf files, and transfer history. A machine list can still reveal private network details: share only a reviewed example, and keep your own export private.

The **clean edition** contains no personal preset. The separate **personal edition** preloads its bundled machine routes once on first launch, while keeping credentials on the device. Both repositories are private during testing. The clean repository can be made public independently after release checks; keep the personal repository and its builds private.

## Connections and authentication

DropHarbor reads your local Wave `connections.json`, SSH configuration (including Include files), and the online Tailscale peer list. It does not edit Wave or SSH configuration and does not read Wave's encrypted passwords. Exact duplicate endpoints are combined. Different LAN and Tailscale routes remain separate. This machine is retained if explicitly saved in Wave or SSH; it is not automatically added as a new remote peer. NVIDIA Sync client endpoints are not automatically imported as SSH destinations.

The app checks actual SSH command access, not only Tailscale online status. Ready means a noninteractive SSH check succeeded. Offline means the route could not connect. Authentication required means a username, working key, unlocked SSH agent, or verified host fingerprint is missing.

Imported SSH aliases retain their configured connection behavior. Manual machines need an address, SSH username, port, and optionally a local private-key path. Keys remain in your existing SSH folder; DropHarbor stores only their paths. Use the same SSH login that already works in your terminal. For a new server, connect in your terminal and verify its fingerprint before checking it in DropHarbor. The app never disables host-key checking.

## What each device needs

- **Sender:** the DropHarbor desktop app and the OpenSSH client (`ssh` and `scp`). Tailscale is needed only for Tailscale destinations.
- **Receiver:** an SSH server with file-transfer support, a working noninteractive key/agent login, and permission to write to the selected Desktop folder. The receiver does not need DropHarbor or Wave installed. Linux/macOS use the traditional SCP protocol; Windows uses SFTP.
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
- One send runs at a time. A failed batch can contain partially delivered files; its receipt identifies the destination, and a retry creates a new folder.
- Password prompts are intentionally not handled inside DropHarbor. Set up SSH keys or an unlocked SSH agent in your terminal.
- The app does not enable SSH servers, alter firewall rules, change Tailscale access policies, or register itself to launch at login automatically.

## References

- [Electron cursor-position API and Wayland limitation](https://www.electronjs.org/docs/latest/api/screen)
- [Wave connection settings](https://docs.waveterm.dev/connections)
- [Apple Remote Login](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac)
- [Microsoft OpenSSH setup](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)

## Product editions

The standard edition is **DropHarbor**. The personal edition remains **lex-drift** and bundles only the owner's private machine preset. Both repositories remain private during testing. The existing `lex-drift` settings directory, configuration schema, app ID, and worker lock remain stable so upgrading or switching editions preserves data and cannot start a second worker.
