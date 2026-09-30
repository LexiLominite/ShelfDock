# ShelfDock / LexBridge 0.7.3 — Continuity clipboard

This release adds explicit native-style cross-device clipboard flow while preserving the verified dark, untinted AppKit glass and existing shelf, transfers, Received, forwarding, remote desktop/install, update, gesture and shared-worker features.

## Behavior

- One **Continuity clipboard** opt-in connects ready saved owner machines automatically, copies new text/URLs/PNGs to approved device clipboards, and shows quiet connected/waiting status.
- Tools, sync and Continuity default off. Existing saved choices are preserved; enabling tools alone does not start sharing. Manual controls remain under Advanced, and turning Continuity off restores the saved manual receive choice.
- Three-device star and triangle fanout preserve event identity/timestamp, authenticate each hop, acknowledge delivery, and suppress duplicates/loops. Latest fresh content can reach a new approved peer; old history is never replayed.
- Existing directions and paused approvals are retained. Removal persists an encrypted identity exclusion, and Allow again is explicit. Simultaneous automatic owner links converge on one token.
- Native writes await the supported Electron44 text/ClipboardItem PNG API. Local capture before delivery and snapshots around persistence protect newly copied local data. Private/unsupported formats stay untouched. Pause, disable, preference cancellation, shutdown and save failure stop late work.
- No new network service, cloud account, dependency, protocol version or owner-pair wire fields. Trusted existing SSH transport remains a prerequisite.

## Verification

Focused engine, native-delivery dependency, history, controller and UI flows passed during implementation. Two independent GPT6.1 reviews covered engine correctness and UI recovery; issues found were corrected with regressions. Complete unit results, frozen commit, package identities/checksums and local startup receipts are recorded in the accompanying private build workspace `work/v073-release` and installation workspace `work/v073-local-install`.

Coverage distinguishes synthetic multi-device loopback transport from real physical system clipboards. This release has not been tested with two physical computers' clipboards or native Windows/Linux desktop sessions. Only the local Mac is changed; remote apps/settings are not installed or enabled. Mac packages use strict verified ad-hoc signatures, without Apple Developer signing or notarization. GitHub publication requires restored GitHub authentication.

## Installation and rollback

Build the eight same-edition targets from a clean frozen source: MacARM64 ZIP, Windowsx64 portable EXE, LinuxARM64/x64 tarballs for ShelfDock and LexBridge. Stage public and private assets separately; public source/payloads contain no personal preset. Preserve previous packages and the private installed-app/profile backup. Install using the reviewed startup-confirmed atomic updater; leave the app running in the background with one shared worker. Profiles and user clipboard preferences must survive the upgrade.

See [clipboard-sync.md](clipboard-sync.md) for setup, compatibility, privacy and recovery boundaries.
