# Clipboard sync

ShelfDock and LexBridge can share plain text, URLs, and PNG images between your own running installs. **Continuity clipboard** gives you a copy-here, paste-on-another-device flow: after explicit opt-in, it connects ready saved machines automatically and places fresh received items on the system clipboard. Clipboard tools, sync, and Continuity remain off on fresh installs. Existing manual sync preferences are preserved during upgrade. Merely viewing or selecting a machine never enables sharing.

## Transport

The running app listens only on `127.0.0.1:47635`. A peer reaches that port through OpenSSH `ssh -W`, using the machine's existing SSH route. SSH encrypts the connection and authenticates the host. For your own saved machines, Continuity or the manual **Connect device** action uses trusted existing SSH key access to establish clipboard authorization without a pairing-code prompt. Both running apps must have Clipboard tools and sync enabled and resumed.

After the tunnel connects, the initial handshake authenticates a device token created with `crypto.randomBytes` and stored with Electron `safeStorage`. The SSH private key is never read as an application secret. Connections without a valid token are closed. If secure storage is unavailable, pairing is refused and nothing is written in plaintext.

There is no cloud account and no extra npm dependency. `ssh2` stays the library for the app's own SSH features. The sync tunnel starts `ssh` with `spawn` and argument arrays only; it does not invoke a shell.

If the remote ShelfDock listener is not accepting connections, the UI says that computer does not have a ready ShelfDock sync endpoint. SSH success alone is not described as sync support.

## Frames

Messages are versioned UTF-8 JSON, length-prefixed with a 4-byte big-endian length. Maximum frame is 12 MiB, allowing the base64 representation of an 8 MiB PNG with metadata. Protocol version is `1`. Unknown versions produce a `reject` frame and the socket closes.

Content kinds in v1: `text`, `url`, and `png`. Reconnects require an authenticated hello acknowledgement before sending. Delivery acknowledgements retain only the newest pending copy until it is received. HTML is reduced to its plain-text fallback before send. File lists and unknown formats are refused. Payloads are not put in errors, logs, or exports.

An item older than 120 seconds is dropped. Peers do not replay history on reconnect. At most one unsent local item is remembered per peer, and it is dropped when it expires. Deliveries use a serialized queue. In Continuity mode, events are ordered by their original timestamp and event ID; older fresh events enter history without replacing a newer clipboard. Clock skew between computers can affect that order. A pre-delivery capture and native snapshot comparison protect a newer local copy, including one the regular polling timer has not yet observed. Native text and PNG writes use the supported asynchronous Electron ClipboardItem API and are acknowledged after completion. Private or unsupported native clipboard formats are left untouched. An incoming item blocked by editing, authentication setup, or pause is not acknowledged; it can be retried while still fresh. The same `eventId` is stored once. A local write caused by sync records that `eventId` so the capture poll does not send it back. Copying a history item explicitly creates a new event. Native polling observes changed contents; an identical copy with no intervening clipboard change cannot always be detected.

## How to turn it on

1. On each computer, open Settings and turn on **Clipboard tools**. This alone does not start sync.
2. Turn on **Continuity clipboard** on each compatible running app. This explicit choice enables/resumes sync and selects system-clipboard delivery. Ready saved machines with trusted SSH key access are connected quietly in the background. No separate Connect action is needed for the usual flow.
3. Copy new plain text, a URL, or a PNG on one linked device, then paste normally on another. Incoming items are also available in clipboard history. Local automatic history capture is still optional. Normal capture polls every 1.5 seconds; this is not a zero-latency OS service.
4. Use **Pause** to stop sharing. Disabling Continuity restores the previous manual receive preference; it does not revoke devices or disable an already-enabled manual sync choice. **Advanced clipboard sync** retains send-only/receive-only/both, per-device pause, manual linking, and history-only receive controls.
5. **Remove** revokes the identity on both endpoints and prevents automatic rejoining through another alias. **Allow again** is explicit on each endpoint; an intentional replacement of an existing approval requires Remove, Allow again, then linking. Re-enabling tools after turning them off leaves sharing stopped until **Resume Continuity clipboard** is chosen.

Each app must be running with tools and sync enabled and resumed. To replace that device's OS clipboard, enable Continuity there or explicitly choose manual system-clipboard receive. A history-only receiver remains history-only. Remote settings are never silently enabled. Apps using a nonstandard data profile need a manual compatible route; automatic owner bootstrap expects the standard app profile.

Ready saved SSH routes are checked serially every 30 seconds, with bounded quiet retry backoff, up to 32 connected devices. Existing approval tokens, directions, and paused choices are retained. The initiating computer needs trusted key-based OpenSSH access; a saved password by itself is not sufficient for unattended background transport. SSH trust and credentials are never bypassed or copied.

In a linked star or triangle, Continuity devices relay to other approved send-capable peers. The event UUID, original timestamp, and payload are preserved; each immediate hop is authenticated. Received history labels describe the immediate sending device, including when it relayed the item. Duplicates and returned copies do not rewrite the clipboard. Manual sync does not relay.

Items older than two minutes are not delivered after a reconnect. Only the latest fresh pending copy is retained; history is never uploaded. Enabling/resuming establishes a baseline so the clipboard already present is not broadcast. Identical copies without an intervening content change may not be detected. File lists and rich formatting are outside the v1 sync protocol; use the shelf for files.

## Defaults

- Clipboard tools stay off, and the tab stays hidden, until the existing Settings choice.
- Sync and Continuity stay off. Enabling tools does not enable either. Enabling Continuity explicitly selects native clipboard receive and resumes sync.
- Default receive mode is `history`: incoming items are stored in clipboard history and are not written to the system clipboard.
- Receive mode `clipboard` also writes the OS clipboard. That write is marked so it is not recaptured.
- Automatic clipboard history is optional independently of sync. With only sync enabled, new copies are sent without recording every local copy in history. Explicit incoming items are saved even when automatic history is off.
- Enabling or resuming sync establishes a new baseline: the clipboard contents already present are not sent. Creating a snippet does not send it; copying it can, when sync is enabled.
- Pause stops sync send and receive and discards pending sends. Shelf, transfers, and port forwarding keep working.
- Turning Clipboard tools off closes the listener and stops sync. Saved history and pair records remain. Remove revokes the saved peer before reporting success. A failed save keeps the peer visibly paused and asks you to retry before restarting.
- Existing history is not uploaded when sync is turned on. The initiating computer reconnects with bounded backoff; the accepting computer uses that authenticated connection in both directions. Both apps must remain running.
- Both computers need compatible ShelfDock/LexBridge builds, and the initiating computer needs key-based OpenSSH access to the other. Pairing through a saved password alone is not supported by the background SSH tunnel. On Linux, a supported libsecret/KWallet backend is required; the basic_text fallback is refused.

## Rollback

The v0.7.3 continuation branch is `codex/shelfdock-v073-continuity`; its verified v0.7.2 baseline is `de6e812e604a135ae33168442353760da13e3e24`. Keep the previous same-edition app and its private profile backup. The local installer swaps the app only after package verification and restores the previous app if the new renderer does not confirm startup. Source rollback uses a separate checkout at the baseline, without resetting a working tree. Keep the existing user-data path and shared worker identity.

The protocol remains v1. The optional Continuity preference and encrypted exclusions are additive. Older compatible apps continue manual sync but do not implement auto-link/relay. Do not downgrade after removing devices unless the disabled sync preference and private profile snapshot are restored: an older binary does not understand the new automatic-rejoin exclusion policy. Pausing or disabling tools is the quickest reversible recovery path and retains saved history.

## Verification and platform limits

The verification report in `docs/clipboard-sync-verification.md` records the actual tested source and coverage. Local tests use synthetic content and isolated profiles. The transport fixture exercises the real OpenSSH client against a temporary SSH server and the same sync service; it does not read the user's clipboard. Native cross-device OS clipboard testing remains a separate coverage boundary.
