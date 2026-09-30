# ShelfDock / LexBridge 0.7.4 — Continuity preview fixes

The 0.7.4 release carries the optional Continuity clipboard flow and dark native Mac glass from 0.7.3, with focused publication-review reliability fixes. The previously created 0.7.3 tags/drafts stay intact; this release uses a new tag and packages.

- Optional sync startup failure stops that transport, shows an inline warning and leaves the shelf, worker, Received and update controls available.
- Background automatic device linking no longer blocks shelf enqueue, transfers or ordinary reads. Transfers cancel the automatic request; saved-host/configuration/authentication/installation/update conflicts remain protected, with the guard acquired before lookup. Manual connection guards stay deliberate.
- If a cancelled screen setup returns an owned server and cleanup fails, ownership and cleanup retry state are published so Disconnect can retry.
- Native appearance callbacks now use a valid JavaScript receiver and fire correctly. Accessibility observer lifetime is guarded across cancellation/queued delivery, with deferred cleanup during callbacks and handled callback exceptions. The dark untinted glass, geometry and accessibility fallback stay unchanged.
- Release documentation and the website describe the actual Continuity opt-in and current preview version, with no obsolete pairing-code instructions.

Verification is recorded with the frozen source, complete source tests, focused UI/native fixtures, independent package/source checks, and GitHub asset hashes in the private release workspace. The native fixture uses a hidden window, isolated profile and synthetic in-process notifications, without changing the system accessibility preferences or user's clipboard.

Tools, sync and Continuity remain off on fresh installs. Existing choices are preserved. Both apps must be running and explicitly opted in for native clipboard receive, with trusted SSH key access and supported secure storage. Files/rich formatting are outside sync v1. Two physical system clipboards and native Windows/Linux desktop sessions remain unverified; these are previews. Mac signatures are ad-hoc and not notarized.

Public ShelfDock and private LexBridge downloads stay separate. Keep previous apps/packages and matching private profile backups for recovery. See [clipboard sync](clipboard-sync.md) for setup and compatibility.
