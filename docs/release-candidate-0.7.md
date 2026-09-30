# ShelfDock and LexBridge 0.7 release qualification

This is a local feature candidate on `codex/shelfdock-v070`, based on the 0.6 clipboard-sync implementation and subsequent Opus changes. It is not a declaration of complete native platform qualification or a published production release.

## Included behavior

- Existing protocol-1 clipboard sync is preserved: explicitly paired text/URL/PNG exchange, directional consent, history-first reception, separate system-clipboard replacement, pause/reconnect/revoke, freshness and loop protection. Clipboard tools and sync remain off by default. Pairing codes expire visibly and peer status is announced accessibly.
- Remote screen adds bundled noVNC with View/Control, scaling, fullscreen, Disconnect and a main-owned loopback bridge with a single-use session capability. Linux X11 temporary sharing and existing Mac/Windows servers have separate provider paths. VNC credentials and VNC clipboard exchange remain separate from app clipboard sync.
- Install on this device now reviews the actual destination OS/processor for Linux x64/arm64, Windows x64 and delegated matching Mac bundles. Five-minute single-use plans, private-preset consent, package/identity/checksum verification, cancellable checks/uploads and owned staging cleanup protect installation. User launchers/shortcuts are created without opening the app. Public version-pinned bootstraps are included; private assets remain sender-authenticated.
- New profiles check and download updates quietly; valid saved choices are retained and malformed preferences fail closed. Restart/installation requires an explicit idle action. Startup acknowledgement follows native initialization and renderer initial state; helpers retain the old application and restore it on early failure or timeout.
- Existing transfers, Received, local clipboard tools, shelf Undo, batch transfer, forwarding, deliberate shake, shared-worker behavior and density modes remain. Opus macOS glass styling is preserved. The quick-start remains four short steps; the optional feature guide now covers sync, remote screen, broader installation and update defaults.

## Source verification on 2026-09-30

The final source pass recorded 406 passing tests, zero failures/cancellations/skips, eleven passing headless UI flow scripts, and a successful production build. Tests include real OpenSSH loopback clipboard text/PNG exchange, file/folder receipts and forwarding; actual noVNC/RFB traffic over the local native bridge; owned cancellation/cleanup fixtures; POSIX updater rollback helper execution; and opt-in/focus/keyboard regressions across the three density modes. Real OpenSSH-generated fixture keys replace a faulty random key generator.

Headless fixtures never touch a real system clipboard or change a saved remote machine. These tests do not establish native cross-platform desktop behavior. The eight expected candidate artifacts are public ShelfDock and private LexBridge builds for Mac ARM64 ZIP, Windows x64 portable EXE, and Linux ARM64/x64 TAR.GZ. Their separate build/ASAR/dependency/architecture/checksum reports must pass before they are shared as verified candidates.

## Outstanding production qualification

- Actual two-computer copy/delivery/paste of text, URLs and PNGs, including receive modes, directions, pause/disable/revoke/reconnect, upgrade persistence and native credential stores.
- Native macOS/Linux/Windows VNC provider/authentication/input/cleanup checks. **Windows TightVNC automatic provisioning is disabled and is a required release blocker** until the pinned installer, signature, secret-safe configuration, loopback/authentication and rollback pass on a disposable Windows host.
- Native remote installation, launchers/shortcuts, bootstrap execution and update replacement/rollback on supported platforms. Existing Mac installation cannot be cancelled after its commit begins.
- Code signing/notarization and public/private GitHub publication remain separate release steps. Preview builds are unsigned.

## Recovery

Development stays on the isolated branch and retains the existing source snapshot, original application and prior packages. Do not replace the working app merely to exercise tests. Remote installation refuses an existing destination; remove only the newly installed app and its owned launcher/shortcut to undo a fresh install. Failed staging cleanup is reported with its exact destination path. Update helpers retain the previous application; user profiles, saved access and clipboard data are not part of an application swap.

See [remote desktop](remote-desktop.md), [remote installation](remote-install.md), [public bootstraps](bootstrap.md), [clipboard sync](clipboard-sync.md) and [updates](../UPDATES.md) for operational details and limits.
