# Public preview and release readiness

The clean **ShelfDock** edition, formerly DropHarbor, is prepared for public preview distribution at [LexiLominite/ShelfDock](https://github.com/LexiLominite/ShelfDock). It contains no personal machine preset. **LexBridge**, the personal edition formerly called lex-drift, and its route preset, `LexBridge-private` repository and personalized assets remain private. A clean-repository visibility change must never be applied to the personal repository.

Public preview access and production readiness are different milestones. Packages are unsigned previews. Native macOS has the strongest local evidence; Windows/Linux build targets and archive inspection do not establish complete native support. State those limits beside downloads and in every release. The existing app-data directory and worker identity retain their legacy names so renaming does not delete data or create duplicate workers.

## Exposure review

The pre-launch review covered 203 reachable baseline Git blobs: 164 text blobs and 39 historical images. The only credential-URL pattern match was an intentionally invalid test fixture used to assert URL rejection. Historical images contain app icons and fictional UI fixtures, corroborated against `tests/ui/fixture.cjs`; no personal machine address or real clipboard item was found.

Six release descriptions, three pull-request bodies and three repository comments were scanned for known personal routes, private network addresses, local account paths, private-key material and common token formats. No private-preset or credential exposure blocker was found. A private-edition repository name and routine automated-review metadata are present; they do not contain the private preset. Existing clean-package inspection records through 0.4.2 also report no personal preset. This review reuses those records rather than claiming fresh binary extraction.

Before uploading a new release, scan the final source commit, new screenshots and release body again. Independently inspect each clean package and checksum manifest. This baseline review is not a guarantee about unreviewed future files. Keep real-host receipts, private exports, profiles, credentials and local package/audit reports outside the public repository.

## Preview publication checks

1. Publish only clean-edition packages, source and fictional configuration examples. Exclude personal presets, SSH files, profiles, clipboard data, private receipts and signing credentials. Confirm `LexBridge-private` remains private after any clean-repository visibility change.
2. Link to [Releases](https://github.com/LexiLominite/ShelfDock/releases), including prereleases. Do not use `/releases/latest` when the available builds are marked prerelease. Keep historical release names and assets truthful; a new name does not require retagging old releases.
3. Include versioned release notes, supported package architecture, checksums, setup instructions, known limits and exact verification performed. Compilation is not proof of native-platform behavior.
4. Keep Clipboard tools disabled by default and recording a separate opt-in. Disabling tools stops capture while preserving saved entries; re-enabling leaves recording off. Hiding the tab explains that previously enabled history may continue. Consent and history stay out of configuration exports.
5. Verify Sent and Received history against its actual receipt/discovery scope. Do not imply it inventories every transfer performed by unrelated applications or that a history record grants consent to resend.
6. Verify update checks, asset selection, checksums, interrupted downloads and recovery. Installation requires an explicit Restart and install and a supported writable clean installation. Private LexBridge builds must not query or install the public clean edition. Their optional private checks use an existing authenticated GitHub CLI session without storing a token; explain missing CLI/sign-in prerequisites and preserve manual private downloads.
7. Review the landing page claims and version against the released build. Its example is fictional and performs no clipboard reads, uploads or analytics. See [website notes](site/README.md); adding its files does not host it or choose a domain.

## Work before a production release

- **Native coverage:** validate install/launch, optional Clipboard and separate recording consent, text/image/file capture, gesture/shortcut, density changes, configuration round trips and actual SSH transfers on macOS, Windows x64, Linux x64 and Linux ARM64. Exercise X11 and Wayland fallback. Linux receiver checks do not establish native Linux sender support.
- **Signing and installation:** sign/notarize macOS builds with the owner's Apple Developer account and provide a reviewed DMG. Sign Windows packages using an eligible certificate/service and provide a normal installer. Store signing material in protected CI secrets, never source or exports.
- **Distribution terms:** choose a license and publish accurate terms and a privacy statement. The package remains `UNLICENSED`; public source visibility is not an open-source license. Establish support/security reporting contacts without inventing addresses.
- **Release automation and updates:** use native runners and protected version tags. Verify the release source, exact package contents, edition, architecture and checksum. An explicit install button is not a substitute for validating the update chain and recovery. Do not claim silent automatic updating or support for every package format.
- **SSH onboarding:** explain that destinations must already offer reachable SSH/file-transfer access and verified host trust. One-time password-to-key setup works through that trusted connection. Enabling an unreachable SSH server, changing firewall/Tailscale policy and native mobile clients are separate work.

## Mac installation scope

**Install on this device…** is a Mac-only reviewed copy of the packaged application to an existing SSH destination with compatible architecture. It does not install Windows/Linux packages. The destination already needs Remote Login and trusted SSH access.

The user reviews the account's `~/Applications` destination and explicitly confirms. Personal editions separately acknowledge the bundled preset. The flow refuses an existing application, preserves bundle metadata, copies no sender profile and does not launch the destination app automatically. Validate changed/unknown host keys, expired/reused plans, changed endpoints/source bundles, architecture mismatch, concurrent operations, corrupted/interrupted uploads and cleanup of owned staging. Scratch-bundle tests are not live Mac-to-Mac installation; report that separately.

## Data and edition compatibility

Configuration exports omit passwords, private keys, clipboard contents/consent, shelf data and transfer history, but machine addresses and usernames can still expose private network information. Review before sharing. The established app-data location and worker lock stay unchanged across clean/personal upgrades and renames. Personal presets apply once; later route changes can be imported deliberately.
