# DropHarbor: Clipboard and Transfers

Design and research record, 27 September 2026. DropHarbor is the standard edition; lex-drift is the personal edition. Both share the same core. This document separates the v0.3.0 release scope from future recommendations. Building a package for an operating system does not establish that every native interaction has been tested there.

DropHarbor should give **Clipboard** and **Transfers** equal space. Clipboard helps recover and reuse something copied earlier. Transfers sends deliberately selected content to deliberately selected machines. Copying an item must never create a network transfer. Adding a clipboard entry to the shelf must never send it by itself.

## The v0.3.0 core

Two persistent, equally prominent workspace controls open Clipboard and Transfers. The application remembers the selected workspace. Machines remains a shared entry, and Compact, Expanded, and Large views apply to both workspaces. A deliberate cursor shake shows the shelf without taking keyboard focus; another shake hides it after the cooldown, except while dragging or editing. “More deliberate” is the default sensitivity for new settings; an existing chosen sensitivity remains meaningful.

The Clipboard workspace provides explicit Capture, optional automatic history, Pause/Resume, full-text search, kind filters, favourites, titled text snippets, individual deletion, and Clear unpinned. Its detail pane supports readable text, PNG previews, and copied-file names. Copy restores supported original text/HTML formats, while Copy as plain text removes HTML formatting. Add to shelf stages the selected entry for the existing transfer workflow. Clipboard HTML is retained as data for copying; it is never rendered as an active webpage.

Automatic history starts **off**. Choosing Capture while history is off or paused is a single explicit capture. Automatic reads stop while paused, while a visible app window is editing, while a password form is open, or during connection setup. Known private/transient markers are checked before payload capture. This is a useful filter, not universal password recognition: Paste itself documents that some password-manager browser extensions cannot be identified reliably. [Paste exclusions](https://pasteapp.io/help/exclude-apps)

The initial limits are intentionally modest:

| Setting | v0.3.0 scope |
|---|---|
| Automatic history | Off until enabled |
| History length | 200 entries by default; configurable from 20 to 500 |
| Unpinned retention | 30 days by default; choices of 1, 7, 30, or 90 days |
| Stored-content budget | 32 MB across history, including favourites |
| Text / HTML | Up to 1 MB for each supported representation |
| PNG capture | Up to 8 MB of PNG input, subject to total storage limits |
| Copied files | References to up to 500 local files, not a backup of their bytes |
| Clearing | Clear unpinned preserves favourites and does not immediately re-add the cleared current clip |

Favourites survive ordinary expiry, but they still count toward capacity. When favourites fill the limit, the user must remove or unpin something. File references can stop working if the original files move or disappear. Sending checks the source again; neither clipboard capture nor Add to shelf should be described as an immutable file snapshot.

History uses authenticated AES-256-GCM encryption with a random application key protected by the operating system secret store. A failed decryption preserves the existing files. Linux plaintext fallback is refused. Search, previews, copied text, passwords, and key material are not included in portable machine configuration. Encryption protects stored history; it does not promise protection from every program running in the same unlocked account. Electron documents different guarantees for Keychain, Windows DPAPI, and Linux secret stores. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

Transfers retains explicit drag-to-machine sending and separate LAN/Tailscale routes. Bulk send targets up to 20 selected machines, runs at most two target transfers concurrently, and records a receipt for each destination. Each payload contains up to 500 selected shelf items. A failure on one target must not turn successful deliveries into failures or silently retry other machines. Selection and hover never send.

Clear shelf offers a visible 10-second Undo action. During that period, cleared items and their staged note/image data remain recoverable. Undo restores the exact cleared batch and keeps new arrivals. Recovery is local, expires at the same deadline after a restart, and never deletes the original user files. A second Clear replaces the prior recovery batch. Clipboard Clear unpinned is a separate action and uses its existing deliberate confirmation.

Connection setup offers existing keys, a one-time-use password workflow, and a saved password. One-time setup creates a dedicated private key on the sending device, installs only its public key for the chosen remote account, verifies key-only access, and discards the supplied password. An uncertain remote result retains the local key for recovery and retry. Saved passwords remain encrypted locally until removed or replaced; they are not exported, and background discovery does not repeatedly try them. The target must already have reachable SSH/SFTP and an independently trusted host key. The feature does not silently install system services or change firewalls.

**Connections** adds local and remote SSH port forwarding from each machine’s menu or right-click menu. Local forwarding listens on this device and reaches a service through the SSH machine; remote forwarding listens on the SSH machine and reaches a service through this device. Both request loopback-only listening. Remote forwarding verifies the actual listener and stops if it cannot confirm that restriction. A tunnel is started explicitly, shows its status, and can be stopped individually. Up to 20 forwards may run together, with duplicate listening ports rejected.

Remembering a plan is optional. Saved plans contain the ports, direction, target, machine reference, and an editable note; they do not contain credentials. Restart is always manual, and changed machine connection details require a new plan. Quitting closes application-owned sessions. Remote inspection requires the target’s listener tools and SSH forwarding policy; this feature does not alter either.

## Journeys and interaction rules

**Recover something copied earlier.** Open Clipboard, search, select an entry, inspect it, then Copy. Selection only changes the preview. The user pastes into the intended application with the normal system shortcut. Automatic direct paste is a later feature because focus restoration and operating-system permissions need separate validation.

**Send a clipboard image or note.** Select the entry and choose Add to shelf. Open Transfers, inspect the staged item, and drop it on a Ready machine. For several machines, review the selected recipients before starting the batch. Keep the recipient list stable while dragging and retain a separate result for each destination.

**Work with sensitive material.** Pause automatic history before the session. The pause state remains visible. Marked private copies are skipped, but an unmarked password may look like ordinary text. Existing saved entries are not retroactively removed by pausing; deletion remains an explicit separate action. CopyQ documents different secret markers on macOS, Windows, and Linux. [CopyQ security](https://copyq.readthedocs.io/en/latest/security.html)

These journeys keep the same visual hierarchy: two primary workspaces, a shared Machines control, a workspace-specific list and detail pane, and distinct Copy and Send actions. Neither workspace becomes a hidden settings page for the other.

## Platform boundaries

| Capability | macOS | Windows | Linux |
|---|---|---|---|
| Core text/HTML/image clipboard formats | Electron API; native validation required | Electron API; native validation required | Depends on display server/compositor and available formats |
| Efficient change monitoring | Native pasteboard change counter available | Native clipboard update listener available | X11 selection events or supported Wayland protocols |
| Encrypted persistence | Requires working system secret store | Uses OS protection with account-level limits | Requires a supported secure backend; no plaintext fallback |
| Gesture / always-on-top | Existing native path | Native verification pending | X11 and Wayland differ; global cursor tracking and always-on-top cannot be assumed on Wayland |
| Direct paste / source-app exclusions | Future native integration | Future native integration | Particularly limited on Wayland |

Electron documents asynchronous clipboard representations and platform-specific file-format translation. These APIs are the implementation contract; arbitrary application clipboard formats are not all promised. [Electron clipboard](https://www.electronjs.org/docs/latest/api/clipboard), [ClipboardItem](https://www.electronjs.org/docs/latest/api/clipboard-item)

Apple exposes a pasteboard change count; Windows exposes clipboard update notifications. These support a future move away from repeatedly reading unchanged payloads. [Apple changeCount](https://developer.apple.com/documentation/appkit/nspasteboard/changecount), [Microsoft clipboard listener](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-addclipboardformatlistener)

Wayland support must be stated per capability. CopyQ documents compositor-dependent monitoring and a separate GNOME extension; Electron says always-on-top is unsupported on Wayland. A working Linux package alone does not establish those features. Global-shortcut portal support and a reachable manual window are the appropriate fallback direction. [CopyQ platform limitations](https://copyq.readthedocs.io/en/latest/known-issues.html), [Electron window options](https://www.electronjs.org/docs/latest/api/base-window), [Electron global shortcuts](https://www.electronjs.org/docs/latest/api/global-shortcut)

## Roadmap: researched recommendations, not shipped features

1. **Native reliability and efficient monitoring.** Add native change notifications, capability detection, clipboard-access permission handling, lock-screen privacy, and tested tray/shortcut fallbacks. Measure idle CPU and memory before increasing history limits. The current portable polling path is an initial implementation, not an event-driven native watcher.
2. **Optional direct paste and app exclusions.** Keep Copy as the default. Direct paste needs explicit permission, a verified target window, and a safe Copy fallback. App exclusions require native source identification and must acknowledge that provenance can be absent or wrong. Never label them universal password protection.
3. **Small local productivity tools.** Timed Pause, trim/case transforms, per-entry expiry, named groups or tags, and reusable templates can follow reliable search and favourites. Variable expansion and multi-item paste queues need a separate interaction design so they do not overwhelm the transfer workflow.
4. **Local OCR and image tools.** Offer on-device OCR as an explicit action, retain the original image, and label extracted text as editable. Resizing/compression belongs in an intentional preparation step. Automatic screenshot analysis and annotation editing are outside this core.
5. **Explicit backup and carefully scoped sync research.** Encrypted history export/import needs a separate user-chosen passphrase and recovery story. End-to-end encrypted clipboard sync is not implemented or scheduled: pairing, key verification, device revocation, retention, exclusions, and recovery must be designed first. Existing addressed transfers already provide a deliberate cross-device route. Copying must never become an automatic broadcast.

Maccy's compact keyboard-oriented history, Ditto's format support, and Windows' opt-in history and pins provide useful precedents. [Maccy](https://github.com/p0deje/Maccy/blob/master/README.md), [Ditto](https://ditto-cp.sourceforge.io/), [Windows clipboard history](https://support.microsoft.com/en-US/Windows/Apps/using-the-clipboard)

## Quality gates and research provenance

Release checks should prove zero automatic clipboard reads when history is off or paused; private-marker rejection before payload; no network transfer caused by Copy or Add to shelf; no repeated history writes for unchanged content; safe pause during an in-flight read; encrypted restart recovery; retention that preserves favourites; and separate batch receipts despite partial failure. Native tests must exercise real copied text, HTML, PNG, files, keychain availability, focus, and shortcuts on each supported desktop environment. Search latency and idle CPU need measurement at configured capacity.

Grok CLI 1.0.41 explicitly selected `grok-4.6` for the source reviews and five-call public-web research on 27 September 2026; completed responses identified `grok-4.6-build`. Research used a product brief and public sources. Code reviews used bounded source-only snapshots without personal presets, application state, real hosts, clipboard contents, or credentials. Recommendations were checked against primary documentation and code. Proposed extras remain roadmap items.

