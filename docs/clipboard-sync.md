# Clipboard sync

ShelfDock can pair two of its own installs and copy plain text, URLs, and PNG images between them. Sync is off until Clipboard tools are enabled and the user pairs a device. A Ready SSH machine is not paired.

## Transport

The running app listens only on `127.0.0.1:47635`. A peer reaches that port through OpenSSH `ssh -W`, using the machine's existing SSH route. SSH encrypts the connection and authenticates the host. It is not clipboard authorization.

After the tunnel connects, every frame must carry a pairing token created with `crypto.randomBytes` and stored with Electron `safeStorage`. The SSH private key is never read as an application secret. Connections without a valid token are closed. If secure storage is unavailable, pairing is refused and nothing is written in plaintext.

There is no cloud account and no extra npm dependency. `ssh2` stays the library for the app's own SSH features. The sync tunnel uses `ssh` from `execFile` with argument arrays only.

If the remote ShelfDock listener is not accepting connections, the UI says that computer does not have a ready ShelfDock sync endpoint. SSH success alone is not described as sync support.

## Frames

Messages are versioned UTF-8 JSON, length-prefixed with a 4-byte big-endian length. Maximum frame is 9 MiB. Protocol version is `1`. Unknown versions produce a `reject` frame and the socket closes.

Kinds in v1: `text`, `url`, and `png`. HTML is reduced to its plain-text fallback before send. File lists and unknown formats are refused. Payloads are not put in errors, logs, or exports.

An item older than 120 seconds is dropped. Peers do not replay history on reconnect. At most one unsent local item is remembered per peer, and it is dropped when it expires. Near-simultaneous copies are applied in arrival order. The same `eventId` is stored once. A local write caused by sync records that `eventId` so the capture poll does not send it back. Copying the same text again creates a new event.

## How to turn it on

1. On both computers, open Settings and turn on **Clipboard tools**. Sync stays off.
2. On the computer that should receive the first pairing, turn on **Sync between devices** and choose **Allow pairing**. Read the code aloud or copy it yourself. It expires in five minutes.
3. On the other computer, turn on sync, choose that machine, enter the code, and choose send, receive, or both.
4. Choose whether incoming items are saved to clipboard history or also placed on the system clipboard. History is the default, so a sync does not replace what you have copied until you ask it to.
5. Pause stops sync only. Revoke removes that computer. Turning Clipboard tools off stops sync and keeps local history.

Items older than two minutes are not delivered after a reconnect. Existing clipboard history is not uploaded when sync is enabled.

## Defaults

- Clipboard tools stay off, and the tab stays hidden, until the existing Settings choice.
- Sync stays off. Enabling tools does not enable sync.
- Default receive mode is `history`: incoming items are stored in clipboard history and are not written to the system clipboard.
- Receive mode `clipboard` also writes the OS clipboard. That write is marked so it is not recaptured.
- Pause stops sync send and receive. Shelf, transfers, and port forwarding keep working.
- Turning Clipboard tools off closes the listener and stops sync. Saved history and pair records remain. Revoke deletes that peer immediately.
- Existing history is not uploaded when sync is turned on.

## Rollback

Baseline is `cb47a6d` on `main`. This feature is `feat/clipboard-sync` in the worktree `outputs/work/clipboard-sync`. Returning to the previous app is `git checkout main` in the primary checkout. Settings added by this feature live under `clipboard-sync/` inside the existing user-data directory. Older builds ignore that directory. Removing a peer, pausing, or turning Clipboard tools off stops sync without deleting local history. No production profile is migrated in place.
