# Grok review and changes

The installed Grok CLI completed a read-only review of the clipboard, configuration, service, preload, and native controller source. It received a source-only snapshot without personal configuration or clipboard data. Web access, subagents, and tools were disabled for that review.

The review prompted these changes:

- A failed personal preset now produces a recoverable discovery notice rather than preventing the app from opening.
- A partial imported settings document preserves preferences that were not supplied.
- Automatic Tailscale route inference is limited to the carrier-grade NAT range, rather than every 100.x address.
- Shelf mutations serialize additions/removals, enforce capacity across concurrent additions, and clean up staged notes/images when a save fails.
- Configuration import waits for existing shelf changes and guards mutations started while clipboard reading was still pending.

The review also recommended a disk write queue, which already existed, and made a concurrency claim about simultaneous configuration imports that was not established. Those claims were checked against the code rather than accepted automatically.

An independent review additionally found and fixed atomic upgrade migration and configuration rollback/probe timing. Shared worker locking and show/hide toggles were added after the Grok snapshot and have their own headless controller/worker regression tests.

Native Windows and Linux sender validation, Windows receiver tests, signing/notarization, installer distribution, and a signed update process remain public-release work. macOS native clipboard text/file/image samples and Linux/macOS receiver transfers have been verified locally.


## 2026-09-27: Grok 4.6 password and gesture design review

The installed Grok CLI 1.0.41 listed `grok-4.6` as available. A completed request explicitly selected that model; its returned usage metadata identified the backing model as `grok-4.6-build`. The review received a bounded snapshot of six application source files and the proposed password-authentication architecture. It did not receive personal presets, application state, clipboard contents, credentials, or a real machine inventory. Local tools, web access, MCP execution, and subagents were disabled for the completed review.

The useful recommendations were:

- Verify an already trusted SSH host key before transmitting a password, and fail closed for unknown/revoked keys or unsupported connection configuration.
- Generate dedicated client-side keys, install only the public key for the selected target account, make retries idempotent, and verify key-only login before calling one-time setup successful.
- Keep permanent-password ciphertext separate from exported application state; require OS-backed encryption and refuse Linux plaintext fallback.
- Make saved-password attempts explicit to avoid background retries contributing to account lockout, and distinguish a trust problem from a login problem in the UI.
- Coordinate authentication setup, configuration import, transfers, host edits, and refresh operations. The existing tray refresh path could replace the live host objects during a transfer; an error later applied to a captured host object would then miss the current list.
- Apply the deliberate gesture default consistently while preserving a user's explicitly saved sensitivity.

Grok also described lookup of a transfer receipt by machine name as a proven defect. That claim was not established by this review: transfers are serialized and the current receipt is inserted at the front of history. Stable receipt IDs remain a useful future improvement, but this claim was not treated as a confirmed bug.

This was a source and architecture review, not native platform validation or a test of real credentials. Proposed password behavior requires its own automated coverage and native receiver validation.


## 2026-09-27: Clipboard research and implementation follow-ups

Grok 4.6 public-web product research completed in five model calls. The source-only clipboard implementation review completed separately in one call; both returned backing model `grok-4.6-build`. The product brief and authorized public sources were the only research inputs. The implementation review received clipboard-history source/tests and relevant main-process wiring, without real history or machine data. The resulting design, platform boundaries, and primary-source references are in `PRODUCT_DESIGN.md`.

Validated clipboard findings resulted in metadata-only renderer lists with main-process full-text search, preservation of existing history when preferences are missing or corrupt, recoverable expiry-write errors instead of mislabelled decryption failures, and removal of the full-store write on Copy. Serialization and AES encryption now run in a worker. Independent regression checks also addressed immediate recapture after Clear unpinned, unnecessary deep copies, and hidden search focus incorrectly blocking background history. Password editing still blocks automatic capture when the window is hidden.

Two Grok API claims were rejected after checking the installed Electron 44 definitions: `safeStorage.encryptString` returns a Buffer, and `clipboard.has` accepts the documented `electron application/osclipboard;format="..."` wrapper. Changing either to the proposed alternative would have broken the implementation. No review output was accepted as proof without checking the API or code.

The targeted authentication follow-up initially produced no response and was stopped after a bounded wait. A smaller retry completed in one model call, again selecting `grok-4.6` and returning `grok-4.6-build`. Its confirmed Windows edge is that `WindowsPrincipal.IsInRole(Administrator)` can be false for a filtered token even when the account belongs to Administrators. The bootstrap now checks group membership separately before choosing the OpenSSH authorized-keys path and rejects a non-elevated administrator before writing. A command-generation regression covers the ordering; this is not a native Windows execution test. Microsoft documents both the [UAC behavior](https://learn.microsoft.com/en-us/dotnet/api/system.security.principal.windowsprincipal.isinrole?view=net-10.0) and [administrator-specific key file](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration). Grok's uncertainty about `IdentitiesOnly` was resolved by the existing service SSH argument builder, which adds it for an explicit identity.

These are bounded source reviews, not a formal security audit. Successful package builds and headless tests still do not establish native Windows or Linux UX, credential-store behavior, or receiver compatibility.


## 2026-09-27: Forwarding implementation review

A final bounded, source-only forwarding review explicitly requested `grok-4.6` with no local tools or web access. It completed in one model call and reported backing model `grok-4.6-build`. The snapshot contained only the tunnel module and a short description of the service authentication contract.

The five proposed findings were checked against the source and did not establish a defect. The duplicate-start and shutdown claims assumed interleaving between synchronous uniqueness/closed checks and insertion into the active map. The native-stop claim overlooked the stopped check immediately after SSH configuration resolution. The password lifecycle claim also assumed an asynchronous gap before the release callback was assigned. The suggested destination restriction conflicted with the intentional, explicitly selected SSH forwarding target. The listener-output claim missed the Windows command's port filter and supplied no reproducible parser bypass; wildcard listeners are rejected.

This review was advisory evidence, not proof of security or native compatibility. Existing lifecycle, duplicate-port, loopback-listener, saved-plan, and cancellation tests remain the relevant automated checks. Real Windows/Linux behavior and SSH-server-specific forwarding policies still require native validation.

## Compilation handoff

The user-requested Grok build operator runs in a separate driver directory. An exact-command gate permits only a one-time detached build launcher and a bounded status reader; source edits, application launches, account access, uploads, and unrelated commands are excluded. The local script runs the full test suite, builds the renderer, and packages the clean and personal editions for macOS ARM64, Windows x64, Linux ARM64, and Linux x64 with publication disabled. Personal presets stay local and are not printed to the model. Earlier candidates and their logs are preserved separately when new requested features require rebuilding. The final Undo-enabled run passed all 148 tests and the renderer build before packaging. Package contents, privacy separation, architecture, and release hashes receive independent verification before publication.


## 2026-09-28: Delegated release compilation

At the user's request, Grok performed the routine compilation through a reviewed, isolated launcher. The CLI explicitly selected `grok-4.6`; final metadata reported `grok-4.6-build` and normal completion. A tool hook allowed only one exact launch command and repeated sanitized status commands. The supervisor prevented duplicate builds and did not open the app, edit source, contact target machines, or publish artifacts.

The final Undo-enabled v0.3.0 run passed all 148 automated tests, built the renderer, and built eight packages: DropHarbor and lex-drift each for macOS ARM64, Windows x64, Linux ARM64, and Linux x64. Earlier partial and superseded candidate logs were preserved separately. Package-content verification and release checks remain separate from compilation; these cross-build results do not imply native Windows/Linux validation or code signing.
