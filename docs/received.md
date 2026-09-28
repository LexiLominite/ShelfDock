# Received and Sent between two computers

ShelfDock 0.5.0 adds a Received workspace. Install 0.5.0 or later on both computers, save the receiving computer's SSH connection, verify that it is Ready, and send the selected files or text normally. The receiving computer discovers completed transfers on its Desktop while ShelfDock is running. Files still arrive when its app is closed; they appear the next time the app checks Desktop.

- Each transfer keeps its own collision-safe `Drift-<timestamp>-<random>` folder. Existing files are not overwritten.
- New batches add a quiet unread count. Receiving does not open a window, steal focus, execute a file, or copy anything to the clipboard.
- Received includes names and sender labels, an Open folder action, Mark as read, and Add to Transfers for deliberate reuse. Adding items to Transfers does not send them.
- Sent keeps the destination, delivery result, and item names. A successful copy does not mean the receiving person has read or opened the files.
- Settings lets each computer choose a **Device name**. Only a name explicitly supplied there is shared; otherwise the sender label is **Another computer**. This label is descriptive metadata, not proof of a network identity.
- Received watches the operating system's Desktop, including a redirected Windows Desktop. Custom SSH destination folders and transfers made by older versions do not automatically appear in this first version.

The most recent 100 batches are retained locally. Moving or changing received files preserves their history but can make Add to Transfers unavailable; use Open folder to inspect them. Removing a file from the transfer shelf never deletes the received original. The app does not synchronize clipboard history or create a new receiving server.

## Completion marker

After all payload files finish copying, the sender uploads a small temporary receipt and promotes it to `.dropharbor-receipt.json` inside the same transfer folder. The legacy protocol filename and `Drift-` folder prefix intentionally remain stable across the ShelfDock/LexBridge rename. POSIX promotion uses an exclusive hard link followed by temporary-file removal; Windows uses a same-directory `File.Move` that refuses an existing destination. A payload with the reserved receipt filename is renamed with a numeric suffix.

The JSON document contains only version, transfer UUID, explicit/generic sender label, completion time, and each top-level item's relative name, kind, and size. It contains no SSH credentials, addresses, usernames, local source paths, file contents, or clipboard history. The receiver treats this document as untrusted input. It checks schema and size limits, rejects traversal and duplicate names, requires ordinary files/directories, checks regular-file sizes, and refuses symlink escapes. Missing or invalid new batches remain absent from Received.

A failed receipt upload or promotion keeps the payload transfer marked as copied and adds an explicit warning that the other app could not be notified. The destination remains usable. The app never automatically resends the payload to repair that warning.

## Local index and limits

The receiver stores metadata and read/unread flags in an atomically replaced `received.json` in its existing app-data directory, with owner-only file permissions where supported. This metadata index is separate from encrypted clipboard storage. It does not contain received file contents and is excluded from portable configuration exports.

Quiet scans run every 15 seconds and can also be requested manually. A scan inspects up to 10,000 direct Desktop entries and considers the newest 300 matching batch folders; it never recursively walks Desktop. Each marker is at most 128 KiB and describes at most 500 top-level items. Unchanged scans avoid rewriting the metadata index. Shelf actions revalidate their source inside the shelf mutation queue, so a queued action cannot silently follow a batch replaced with a symbolic link.

`tests/received-loopback.test.cjs` exercises actual OpenSSH/SCP with strict host trust over a temporary loopback SSH server: files, folders, marker completion, and discovery by the second app controller. Other tests cover malformed manifests, missing items, size mismatches, symlinks, state persistence, bounded history, failed completion markers, updater exclusion, and races. These automated checks do not substitute for native Windows/Linux desktop testing or transfers between separate physical computers.
