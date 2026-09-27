# DropHarbor / lex-drift v0.2.2 verification

Version 0.2.2 names the standard edition DropHarbor, retains lex-drift for personal builds, and changes the interface to the lexilominite.com palette and aligns the native startup background. All 83 automated tests and the production build passed for this version. Platform evidence below includes earlier v0.2.1 testing where indicated.

- All 83 automated tests passed, including host discovery/trust, exact drop payloads, transfer collisions and failures, clipboard text/file/image handling, shelf serialization/storage failures, atomic config import/rollback, upgrade migration, all view preferences, gesture toggle/controller behavior (including Settings closing during imports), and shared worker exclusivity.
- v0.2.2 headless browser checks passed for the brand palette, Settings, and Compact/Expanded/Large viewport sizing with no browser errors. The production renderer built successfully. Dependencies reported no known vulnerabilities in the checked npm audit.
- Earlier v0.2.1 native macOS clipboard samples succeeded for plain UTF-8 text, a copied local file, and a PNG image. The original clipboard was restored, and capture did not start a transfer.
- Earlier v0.2.1 native macOS application opened with the renamed product, clipboard controls, configuration controls, and view settings before the user requested all further testing remain in the background. Old/test app instances were stopped at that request.
- Background controller tests confirm no window show/focus, always-on-top, tray, shortcut, cursor polling, or error popup during silent tests. Shared worker tests elected one primary during 20 concurrent launches, verified silent secondary launches and real child-process crash recovery.
- Gesture tests exercise the actual controller: first shake reveals without taking focus, cooldown prevents flicker, later shake hides, dragging/editing protects the target, and shortcut/tray can toggle.
- Earlier live file/folder/Unicode text transfers succeeded to Linux and macOS receivers over Tailscale. Received contents matched, including filenames with spaces and apostrophes; a native mouse drop sent exactly its intended note. Temporary verification destinations were removed.
- Personal preset export contains 15 configured machine routes without SSH keys, passwords, local key paths, clipboard contents, shelf files, or receipts. The clean edition contains no personal preset.
- Grok CLI completed a source-only read-only review; substantiated findings were fixed and regression-tested. See GROK_REVIEW.md.

macOS ARM64 packages are locally exercised. Windows x64 and Linux x64/ARM64 packages are cross-built and still need native device validation. Windows receiving has simulated function/security tests, not a live server test. Cursor gestures are unavailable on Wayland; shortcut/tray access is the fallback. These are unsigned prerelease desktop packages, not mobile apps or a signed public release. Both GitHub repositories remain private during testing.

The v0.2.1 packaged macOS personal edition was also launched in silent test mode: its 15 machine routes loaded, a clean-edition launch with another profile exited as a secondary, and exactly one app worker ran. Both instances were stopped after the test.
