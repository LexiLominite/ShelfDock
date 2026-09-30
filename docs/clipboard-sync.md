# Clipboard sync

ShelfDock can connect two of your own installs and copy plain text, URLs, and PNG images between them. Clipboard tools and sync start off. Connecting requires an explicit **Connect device** action; selecting a Ready SSH machine does not connect or enable sync.

## Transport

The running app listens only on `127.0.0.1:47635`. A peer reaches that port through OpenSSH `ssh -W`, using the machine's existing SSH route. SSH encrypts the connection and authenticates the host. For your own saved machines, **Connect device** uses trusted SSH key access to establish clipboard authorization. Both running apps must have Clipboard tools and sync enabled and resumed.

After the tunnel connects, the initial handshake authenticates a device token created with `crypto.randomBytes` and stored with Electron `safeStorage`. The SSH private key is never read as an application secret. Connections without a valid token are closed. If secure storage is unavailable, pairing is refused and nothing is written in plaintext.

There is no cloud account and no extra npm dependency. `ssh2` stays the library for the app's own SSH features. The sync tunnel starts `ssh` with `spawn` and argument arrays only; it does not invoke a shell.

If the remote ShelfDock listener is not accepting connections, the UI says that computer does not have a ready ShelfDock sync endpoint. SSH success alone is not described as sync support.

## Frames

Messages are versioned UTF-8 JSON, length-prefixed with a 4-byte big-endian length. Maximum frame is 12 MiB, allowing the base64 representation of an 8 MiB PNG with metadata. Protocol version is `1`. Unknown versions produce a `reject` frame and the socket closes.

Content kinds in v1: `text`, `url`, and `png`. Reconnects require an authenticated hello acknowledgement before sending. Delivery acknowledgements retain only the newest pending copy until it is received. HTML is reduced to its plain-text fallback before send. File lists and unknown formats are refused. Payloads are not put in errors, logs, or exports.

An item older than 120 seconds is dropped. Peers do not replay history on reconnect. At most one unsent local item is remembered per peer, and it is dropped when it expires. Near-simultaneous copies are applied in arrival order across a serialized delivery queue. An incoming item blocked by editing, authentication setup, or pause is not acknowledged; it can be retried while still fresh. The same `eventId` is stored once. A local write caused by sync records that `eventId` so the capture poll does not send it back. Copying a history item explicitly creates a new event. Native polling observes changed contents; an identical copy with no intervening clipboard change cannot always be detected.

## How to turn it on

1. On both computers, open Settings and turn on **Clipboard tools**. Sync stays off.
2. On both computers, turn on **Sync between devices** and ensure sync is resumed. Both compatible apps must remain running.
3. On one computer, select your saved machine, choose send, receive, or both, then choose **Connect device**. Existing SSH key access establishes the device link without entering a code. Machine and direction selection never connect automatically. Settings shows **Connecting…**, then **Connected** or an actionable inline error; fix the remote app, sync, secure storage, or SSH access and retry.
4. Choose whether incoming items are saved to clipboard history or also placed on the system clipboard. History is the default, so a sync does not replace what you have copied until you ask it to.
5. Pause stops sync only. Revoke removes that computer. Turning Clipboard tools off stops sync and keeps local history.

Items older than two minutes are not delivered after a reconnect. Existing clipboard history is not uploaded when sync is enabled.

## Defaults

- Clipboard tools stay off, and the tab stays hidden, until the existing Settings choice.
- Sync stays off. Enabling tools does not enable sync.
- Default receive mode is `history`: incoming items are stored in clipboard history and are not written to the system clipboard.
- Receive mode `clipboard` also writes the OS clipboard. That write is marked so it is not recaptured.
- Automatic clipboard history is optional independently of sync. With only sync enabled, new copies are sent without recording every local copy in history. Explicit incoming items are saved even when automatic history is off.
- Enabling or resuming sync establishes a new baseline: the clipboard contents already present are not sent. Creating a snippet does not send it; copying it can, when sync is enabled.
- Pause stops sync send and receive and discards pending sends. Shelf, transfers, and port forwarding keep working.
- Turning Clipboard tools off closes the listener and stops sync. Saved history and pair records remain. Remove revokes the saved peer before reporting success. A failed save keeps the peer visibly paused and asks you to retry before restarting.
- Existing history is not uploaded when sync is turned on. The initiating computer reconnects with bounded backoff; the accepting computer uses that authenticated connection in both directions. Both apps must remain running.
- Both computers need compatible ShelfDock/LexBridge builds, and the initiating computer needs key-based OpenSSH access to the other. Pairing through a saved password alone is not supported by the background SSH tunnel. On Linux, a supported libsecret/KWallet backend is required; the basic_text fallback is refused.

## Rollback

Baseline is `cb47a6d` on `main`. This feature is `feat/clipboard-sync` in the worktree `outputs/work/clipboard-sync`. For an installed app, quit from the tray, preserve its user-data folder, and reinstall the previous same-edition 0.5.0 package. Keep the existing worker lock and user-data location. For source development, use a separate checkout at the baseline rather than resetting this working branch. Settings added by this feature live under `clipboard-sync/` inside the existing user-data directory. Older builds ignore that directory. Removing a peer, pausing, or turning Clipboard tools off stops sync without deleting local history. No production profile is migrated in place.

## Verification and platform limits

The verification report in `docs/clipboard-sync-verification.md` records the actual tested source and coverage. Local tests use synthetic content and isolated profiles. The transport fixture exercises the real OpenSSH client against a temporary SSH server and the same sync service; it does not read the user's clipboard. Native cross-device OS clipboard testing remains a separate coverage boundary.
