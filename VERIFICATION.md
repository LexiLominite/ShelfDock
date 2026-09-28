# ShelfDock / LexBridge 0.5.0 verification

Recorded on 2026-09-28. The public edition is ShelfDock; the private personal edition is LexBridge. Earlier records below retain their original product and version names.

- **310 Node checks passed** with no skipped tests. Coverage includes Received metadata validation/persistence, actual trusted OpenSSH/SCP loopback delivery into a second controller, edition-specific update feeds, private GitHub CLI transport, cancellation, hostile archive rejection, profile-drain guards, portable updater fixture replacement/recovery, one-session installation confirmation, obsolete update-journal cleanup missing-platform automatic-download guards, corrupt-cache recovery, durable settings saves, per-machine access isolation and filename validation before upload.
- **Headless UI checks passed** for machine actions, exact drag/drop and batches, forwarding, shelf Undo, optional Clipboard, Mac installation review, Received and Updates. Final GPT-6 Luna xhigh checks passed the affected machine/forwarding, focus and onboarding flows after the last functional fixes. Compact, Balanced and Expanded retain closed device details; no new arrival or update opens a native app window. See [0.5 screenshots](docs/v050/README.md).
- **67 rendered palette contrast checks passed**, reusing the original lavender/purple tokens and green/amber status system. This is targeted testing, not a whole-app accessibility certification.
- The standalone landing page passed interaction and no-JavaScript checks at 1440, 1024, 768, 390 and 320 pixels, with no horizontal overflow, browser errors, external tracking or network requests. GitHub Pages deployment is configured for `shelfdock.lexilominite.com`; deployment and HTTPS availability are checked separately.
- Forwarding was exercised against an existing trusted remote Mac using the production tunnel manager: occupied local port 8000 selected 8001 and returned the remote HTTP response; remote port 80 selected local 8080 and returned HTTP 200. Stop released both owned listeners. The browser adapter was not opened during this quiet test.
- First-run quick start is four short, skippable steps; Settings offers replay and a feature guide. It does not enable Clipboard, send items, or start connections.
- Grok 4.7 reviewed the two-device, update, whole-UI and naming plans. The observed backing model was `grok-4.7-build`. Grok also performs renderer compilation and platform packaging. [Design decisions](docs/design-v050.md) distinguish advice from adopted behavior.

For every release, package verification additionally compares embedded application code, renderer assets, dependency closure, executable architecture, edition identity and private-preset inclusion/absence. Source ZIPs are created from the frozen release commit and GitHub uploads are compared to local SHA-256 values before publication. Those build/upload checks are recorded separately from source tests.

## Practical limits

- Received discovers Desktop batches created by 0.5+, including redirected Windows Desktops; custom destination folders and older transfers do not appear automatically. Delivered does not mean read by another person.
- Update tests exercise a real detached replacement helper against temporary fixture applications. Native Windows/PowerShell execution, Linux desktop relaunch, and an actual future-version Mac update remain separate platform tests. The installed local app is verified separately after upgrade.
- The updater preserves a backup and rolls back failed swaps or launcher-command failures. It does not automatically recover an app that starts and later crashes. Unsigned packages remain subject to operating-system prompts and security policy.
- Private LexBridge updates require an existing authenticated GitHub CLI on that device. Automatic checks/downloads remain off until enabled. Public and personal editions have separate update consent and cache.
- A real remote-Mac deployment is not implied by installer-source, mocked UI, or package checks. Native Windows/Linux sender and receiver UX still need device validation. Mac ARM64, Windows x64 and Linux ARM64/x64 are the release targets.

## Historical verification

# DropHarbor / lex-drift v0.4.2 verification

Version 0.4.2 makes Clipboard opt-in after upgrades as well as new installs, moves installation into the selected machine’s menu, and replaces the confusing default Local headline with Remote service. See [workflow notes and screenshots in all three densities](docs/optional-tools.md).

- 213 automated Node tests passed. The new migration check verifies that v0.4.1 consent cannot enable tools or record, encrypted items are retained unchanged even beyond expiry while disabled, fresh Settings consent persists, and recording remains a separate choice.
- The headless UI suite covers three densities, correct SSH directions, URL drops, saved repeats, Stop, transfer shelf Undo and multi-machine sends; 11 Clipboard groups cover optional tools and tab visibility. Installer coverage includes the contextual destination, no Settings install button, OS/existing-app refusal, review, personal-preset consent, busy guards and failures.
- Additional keyboard and screenshot coverage checks the hidden Clipboard default, Remote service heading, collapsed details, viewport-bounded menu, a selected installer destination, no probe just from opening the dialog, and focus on entry and dismissal.
- 67 representative rendered contrast checks passed using the unchanged light palette. No new colour tokens were introduced.
- Grok 4.7 reviewed the bounded UX proposal and ran renderer/package commands; returned metadata identifies `grok-4.7-build`. Artifact integrity and exact packaged source/dependencies are verified independently before publication.

No remote Mac was installed during these tests. Windows/Linux remain cross-builds without native desktop execution. Existing real-host forwarding evidence below belongs to v0.4.0; the SSH contracts and underlying forwarding behavior are unchanged in this revision. Releases remain unsigned private prereleases.

# Earlier evidence: v0.4.1

# DropHarbor / lex-drift v0.4.1 verification

Version 0.4.1 restores the original lavender, off-white and purple palette, makes Clipboard tools optional, adds reviewed Mac-to-Mac installation, and keeps machine details collapsed in Expanded view. See [palette and workflow notes, including all six before/after comparisons](docs/palette.md).

- 212 automated Node tests passed. These include 20 installer cases covering real production shell commands against temporary fictional app bundles/home folders, with SSH and uploads intercepted locally. Coverage includes architecture/OS refusal, source bytes and endpoint binding, explicit personal-preset consent, no-overwrite races, single-use previews, guarded concurrency, checksum verification and owned cleanup.
- Clipboard privacy checks cover new-install defaults, previous opt-in migration, missing/corrupt preferences, capture already in progress, disabled startup without history expiry, separate visibility and renewed recording consent. Native controller checks preserve the single worker and quiet background behavior.
- Headless browser checks cover three machine densities, keyboard and drag/drop paths, quick-connect start/repeat/Stop, shelf Undo and batch transfer; 11 Clipboard groups include optional tools and visibility in every density. Mac installer checks cover destination review and preset consent, one pending install, disabled dialog dismissal, completion and failure, stale endpoints, existing app refusal, and absence on Windows/Linux.
- Expanded view starts with details and forwarding closed. A per-machine Details toggle reveals recent transfers, with a drag guard and keyboard-accessible disclosure. Returning to Expanded does not reopen details.
- 67 representative rendered contrast checks passed across three densities, including text, placeholders, control boundaries and keyboard focus. Browser/native startup colours match. This is targeted verification, not a whole-app accessibility certification.
- Actual Grok 4.7 reviewed the palette and ran the renderer builds. Its response metadata identified `grok-4.7-build`; source inspection, tests and package verification remain independent checks.

Package and installed-app results are recorded in the [v0.4.1 release notes](https://github.com/LexiLominite/DropHarbor/releases/tag/v0.4.1). No real remote Mac installation was performed: that convenience still needs a receiving-device trial. Windows/Linux packages are cross-built and need native desktop validation. Existing live-host forwarding/transfer evidence below was not repeated or relabeled as v0.4.1 evidence. Releases remain unsigned private prereleases.

# Earlier evidence: v0.4.0

Version 0.4.0 redesigns machine cards, adds the small website URL bar and one-click saved sites, and improves clipboard density, scrolling and keyboard actions. The final renderer build and all headless UI checks passed, including the last Balanced preview-height change. See [UI design, screenshots and verification](docs/UI_REDESIGN.md).

- 175 automated Node tests passed for the implementation, including native browser-opening guards, endpoint-bound repeat, forwarding races, clipboard/configuration, shelf Undo and worker exclusivity.
- Three density modes and eight Clipboard browser groups passed in headless Chrome. UI checks cover keyboard/context menus, reduced motion, URL drop isolation, per-host drafts, Stop during startup, saved repeat, exact shelf drop and batch selection, clear scope and workspace-state persistence.
- The new URL bar was exercised against a trusted live POSIX host over Tailscale with production SSH forwarding. Go and saved repeat each returned the expected HTTP nonce, Stop closed the listener, and the owned remote fixture and SSH processes were cleaned up. The browser adapter fetched the validated address to keep the desktop quiet; native validation/dispatch were separately tested.
- Grok 4.7 reviewed the design. The final renderer build was run directly after explicit user authorization following a blocked Grok wrapper execution.

Package and installed-app results are recorded in the [v0.4.0 release notes](https://github.com/LexiLominite/DropHarbor/releases/tag/v0.4.0). Cross-built Windows/Linux packages do not establish native desktop validation. Packages remain unsigned private prereleases; neither repository visibility nor clipboard opt-in defaults change.

## Earlier validated evidence: v0.3.0

This version adds an equally prominent encrypted Clipboard workspace, one-time and saved password access, multi-machine sends, local/remote SSH forwarding with saved history/notes, and More deliberate defaults. All 148 automated tests and the production renderer build passed for this revision. The release verification compares packaged source and architectures, checks archive integrity, and verifies uploaded SHA-256 hashes.

- Eight release packages passed independent source/renderer/version, executable architecture, archive-integrity, and edition-separation checks. Windows portable payloads were extracted for inspection without execution; their embedded app and 29 unpacked SSH dependency files match the verified package, and the embedded application is x64.
- The macOS personal app was installed and started with its background option. Its packaged source matches the verified release, its shared worker responds to a non-showing ping, exactly one app worker runs, More deliberate is selected, and clipboard history remains opt-in.
- Clear shelf Undo has nine backend regressions covering exact restoration, new arrivals, expiry, original-file preservation, repeated clears, failed-save rollback, restart recovery, retained staged-file ownership, capacity, and concurrency. Headless UI checks verify the countdown, action across workspaces, exact selection, expiry, and retry without sending.
- Headless renderer checks exercise password clearing, failed setup retries, secure-storage availability, saving/forgetting passwords, Clipboard opt-in and pause controls, safe HTML-as-text preview, keyboard isolation, snippets, retention preferences, exact two-item/two-machine batch selection, and all three view sizes.
- A loopback-only real SSH server test exercises password authentication, hashed known_hosts, non-destructive POSIX public-key installation, generated private-key permissions, and actual OpenSSH key-only authentication. This does not establish live remote or Windows bootstrap validation.
- Backend regressions cover encrypted password persistence, trusted host-key enforcement, failed-password lockout protection, key recovery after uncertain writes, settings rollback after failed persistence, SFTP exclusive writes, and bounded concurrent batch delivery with partial failures and discovery synchronization.
- Clipboard-history regressions cover zero background reads while disabled/paused, source privacy markers, AES-GCM encrypted persistence and restart, corrupt/missing-key fail-closed recovery, deduplication without repeated writes/emissions, favourite retention/capacity, clearing without recapture, rich/plain copy, and Add to Transfers without sending.
- Forwarding tests carry real bytes through temporary localhost SSH servers using native OpenSSH and saved-password SSH in both directions. They verify owned process/listener cleanup, refusal of unexpected public remote bindings, endpoint-bound repeat history, no automatic restart, and readiness timeouts. Controller tests keep Stop available during setup and close tunnels before releasing the singleton lock.
- Clipboard review fixes keep full-text searches in the backend, send metadata-only snapshots, serialize/encrypt history outside the UI thread, avoid disk rewrites on copy, and preserve decrypted history when preferences or expiry writes fail. Copied web links with URI-list and text representations correctly use text while remote file URIs remain refused.
- The production dependency audit reported zero known vulnerabilities.
- Grok 4.6 provided bounded source-only reviews and separate public-web product research. See GROK_REVIEW.md and PRODUCT_DESIGN.md. Actual model response metadata identifies the requested model's backing implementation as grok-4.6-build.

Native Windows/Linux sender behavior, native Windows bootstrap/receiving, and the new native clipboard-history interaction remain unvalidated on those devices. Builds remain unsigned private prereleases. Clipboard history starts off, known privacy markers cannot detect every secret, and polling/compositor limits may miss rapid clipboard changes. Neither direct paste, native source-app exclusions, OCR, nor automatic clipboard synchronization is included.

Clear shelf offers a 10-second Undo, restoring the exact cleared items alongside anything added afterward. Original files remain on disk; app-created text/image staging is cleaned up only after the recovery window expires. A pending clear survives an app restart for the remainder of that same window.

## Earlier validated evidence: v0.2.2

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
