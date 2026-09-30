# Remote Desktop

The machine menu's **Remote screen** opens the existing desktop through the saved, trusted SSH route. The renderer runs noVNC; the native process creates a single-session WebSocket listener on an ephemeral **127.0.0.1** port and connects SSH to **remote 127.0.0.1:5900**. The remote VNC port is never exposed by ShelfDock to the LAN or Internet.

The viewer starts in **View mode**. Switch explicitly to **Control mode** to forward mouse and keyboard events. Fit to window / actual size and fullscreen preserve the remote screen dimensions. Disconnect works while connecting and removes the session. VNC credentials are requested when the server requires them and are passed directly to noVNC. Password fields are cleared after submission. Clipboard synchronization is not part of this viewer.

## Providers and setup

- **Linux:** ShelfDock probes `uname -s`, then checks an active Ubuntu/Debian **X11** login and an authentication file readable by the saved SSH user. Wayland, virtual displays and unreadable display authentication are unavailable. Review temporary sharing setup to install the distribution `x11vnc` package (only with existing non-interactive administrator access), create a private temporary password file and start a loopback server for the active desktop. Setup uses a 6–8 character printable VNC password. Disconnect removes ShelfDock's temporary server and password. Installing the distribution package persists after Disconnect.
- **macOS:** The live kernel probe selects the Mac provider even when the saved machine's OS is `posix`. Existing Screen Sharing must already be enabled locally in System Settings. ShelfDock does not change Remote Management, account access or permissions. A VNC password or username may be requested by the existing server.
- **Windows:** Existing TightVNC servers may be connected through SSH. **Automatic TightVNC provisioning is unavailable and remains a release blocker**: the pinned installer, signature/hash, secret-safe Windows Installer API properties, loopback/authentication state and rollback require a Windows validation host before the feature can be released as complete.

## Security and lifecycle

The listener rejects unknown origins, missing/incorrect capabilities, an incorrect path and additional clients. Its random capability travels in the WebSocket subprotocol header, never in a URL. Packaged Electron uses the `null` origin; native IPC additionally authorizes the actual application window. A capability is single-use and is erased during cleanup. Unexpected disconnects, startup timeout and shutdown destroy streams, sockets and listeners.

SSH uses saved authentication and strict host-key checking. Key authentication runs OpenSSH with forwarding/session hardening, no interactive prompts and a private stdin pipe. Password authentication uses the existing trusted ssh2 session. The shared `desktopExec(service, host, command, { stdin, timeout, signal, maxBuffer })` adapter bounds output and command duration, supports cancellation, discards stderr, and never puts secret input in process arguments or failure messages.

Setup reviews expire after two minutes, are single-use and bind to the saved SSH endpoint. Active setup uses its own mutation lock; the main IPC gate blocks competing native mutations. Cancellation invalidates plans, aborts command input and cleans up a late successful server start. Cleanup signals only a PID whose command line includes the unique ShelfDock password-file path. A failed cleanup retains ownership so Disconnect can retry, instead of losing the server record.

## Validation

`node --test tests/remote-desktop*.test.cjs` exercises provider selection, secret stdin, cancellation, review expiry and endpoint changes, cleanup retries, and real local WebSocket/TCP binary traffic with rejected origin/token/reuse attempts. `tests/ui/remote-desktop.cjs` connects the actual noVNC renderer and native bridge to a bounded local RFB fixture, checks that View suppresses mouse messages and Control forwards them, switches display scaling, and disconnects. These fixtures do not establish native remote-provider compatibility or Windows provisioning validation.
