# Public release preparation

The clean `LexiLominite/lex-drift` repository is currently private for testing. The separate `lex-drift-personal` repository, route preset, and personalized release assets should remain private.

Before making the clean edition public:

1. Validate native install, launch, clipboard text/image/copied-file capture, cursor shake, mode resizing, configuration round trips, and actual SSH transfers on macOS, Windows x64, Linux x64, and Linux ARM64. Exercise Linux X11 and the Wayland shortcut/tray fallback. The current local proof is macOS; Linux receivers were exercised, while Windows/native Linux sender builds still need device testing.
2. Sign and notarize macOS builds with your Apple Developer account. Publish a DMG with an Applications shortcut. Sign Windows installer/portable binaries with a code-signing certificate or eligible Microsoft signing service; use an installer for normal users. Keep signing credentials in protected CI secrets, never in source or config exports.
3. Choose a distribution license. The project remains UNLICENSED until the owner decides. Publish terms only where necessary and a short privacy statement that accurately describes explicit clipboard reads, local shelf storage, SSH transfers, and host discovery.
4. Publish checksums, release notes, minimum OS requirements, a troubleshooting guide, and a support/security contact. Do not publish private network presets, machine routes, SSH files, test receipts, personal screenshots, or signing credentials.
5. Use native GitHub Actions build jobs and a protected version-tag release process. Add update checking first; ship automatic updates only after a signed update chain and rollback strategy are tested. Publish one versioned release rather than committing binaries to Git history.
6. Provide first-run SSH setup guidance. The receiver needs SSH/file-transfer access and verified host trust; the app should explain these requirements before users attempt a send. Password-only setup and native mobile clients are separate product work.

Keep clipboard capture opt-in. Do not add background clipboard synchronization as a default: it can copy passwords or other sensitive content without a deliberate send.

Current packages are unsigned test releases. Configuration export does not include secrets, but machine addresses/usernames are still private information. The clean and personal editions share application data so switching between them keeps the shelf/settings; a personal preset applies once, and later route changes can be imported explicitly.
