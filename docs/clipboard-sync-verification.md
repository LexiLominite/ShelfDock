# Clipboard sync verification — 0.6.0 preview

Grok's starting implementation was commit `125b6a8860ee40a418cfc91cda52dd9ff88b850a`, based on public 0.5.0 commit `cb47a6d3b3bc87cb212858d854a3fdca65773e8e`. It provided the first protocol, pairing, settings UI, encrypted peer storage and history integration. The continuation fixes in this branch are separately recorded in Git history.

## Evidence

- The complete automated suite passed **352 tests**, with no failures or skips. It covers shelf and multi-machine transfers, worker locking, credentials, config, forwarding, received history, updates and the new sync paths.
- The renderer production build passed from a fresh local dependency installation.
- The headless UI suite passed all nine flows, including clipboard sync, optional tools, clipboard history, machine/forwarding controls, Mac install, received items, updates, focus and onboarding.
- The new SSH integration fixture uses the real OpenSSH client and an isolated authenticated SSH server. Two sync instances pair and exchange synthetic plain text and PNG images in both directions, then exercise revoke and disable cleanup. Temporary keys, host trust, listener ports and app profiles are removed afterward. It does not access a user's clipboard or remote hosts.
- Focused recovery tests cover disabled and paused gates, Linux `basic_text` rejection, reconnect with freshness expiry, delivery failure and retry, identity mismatch, failed credential persistence, durable removal and cancellation during pairing persistence.
- SSH adapter tests cover backpressure, child/pipe errors, synchronous spawn failure across an await boundary, asynchronous startup errors, and bounded child termination. A missing SSH client produces a safe connection error.

## Reviewed behavior

Clipboard tools remain optional and hidden by default. Sync is a separate explicit choice, requires approved pairing and starts off. Automatic local history is not required for synchronization. Incoming items are encrypted in history by default; replacing the system clipboard requires a separate setting. Existing contents are treated as a baseline when sync starts or resumes, and historical items are never uploaded automatically. Saving a snippet does not send it; copying it can send when sync is on.

The listener is loopback-only and starts only after controller consent gates. The SSH route supplies encrypted transport and host authentication; application pairing provides clipboard authorization. Peer secrets use the system secret store. Linux plaintext fallback is refused. No clipboard contents or pairing secrets are exported in machine configuration.

Delivery is acknowledged only after its asynchronous history write succeeds. Pending work is bounded to the newest item per device and expires after two minutes. Reconnect uses bounded backoff. Privacy markers, pause and sensitive editing gates stop capture and delivery. Peer save failures stop sync and report whether the off preference itself could be saved; they never report a completed removal when persistence failed.

## Packaging and native coverage boundary

The release process builds clean ShelfDock and private LexBridge packages for Mac ARM64, Windows x64 and Linux ARM64/x64. Independent verification checks archived source and renderer files, runtime dependencies, executable architecture, portable Windows payloads, archive integrity, updater identity/extraction and absence of the private preset from clean packages. Build status and package verification reports are stored with the local release artifacts, outside the public source.

Cross-compilation and synthetic transport tests do not establish native clipboard behavior on every operating system. Two physical computers' system clipboards have not been tested together in this continuation. Native Windows and Linux desktop testing remains incomplete. Preview packages remain unsigned and the Mac build is not notarized. Both devices must run compatible builds; the initiating computer needs a working trusted OpenSSH key route. A saved SSH password alone does not support this background tunnel.

## Small follow-ups

Connected/Offline labels are accessible text but their asynchronous changes do not yet use a dedicated live region. A pairing code can remain displayed after its expiry until another state update; its expiry time is shown and the backend rejects expired attempts. Regenerate the code if needed. These do not block the tested flow.

## Rollback

Turn sync off first, then quit the app using its tray/menu-bar control. Preserve the existing `lex-drift` user-data folder and reinstall the previous **same edition** 0.5.0 package. Older versions ignore the new `clipboard-sync` directory. Do not reset the current source checkout or delete saved clipboard history to roll back. Public ShelfDock packages must never include the private LexBridge machine preset.
