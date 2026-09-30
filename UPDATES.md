# App updates

ShelfDock and LexBridge include update checks, verified downloads, and an explicit **Restart and install** flow for their portable desktop packages. On a fresh profile, quiet daily checks and background downloads are enabled; you can change either choice in Settings → Updates. Enabling automatic downloads never authorizes an automatic restart. Valid saved choices are preserved. Malformed preferences or a saved repository mismatch disable automatic checks and downloads until you save valid settings; the app displays the reason.

## Using updates

1. Open Settings → Updates to review update preferences, or choose **Check for updates**. Preview releases are included by default while the app is in preview; turn that option off to check stable releases only.
2. Read the release notes and download the package for this operating system and processor. The app verifies the release's SHA-256 list and, where supplied, GitHub's asset digests.
3. Choose **Install update…**, review the installation folder and version, then **Restart and install**. Finish transfers, stop live port forwards, and close active access setup or configuration import first.
4. The app prepares the replacement beside the existing app, waits for its current process to exit, keeps the previous app as a backup, replaces the application files, and requests a quiet relaunch. It does not replace the app-data folder, SSH keys, saved passwords, clipboard database, machine settings, or shelf.

The next version confirms installation after its update controller, main window load, and renderer state initialization are ready, within a 60-second health window. A failed or timed-out startup restores the old app where possible. The backup remains beside the installation under a `.shelfdock-backup-<id>` name, with an `.app` or `.exe` suffix where appropriate. Keep it until the new version is working; removing an old backup is a manual decision.

An unsupported or unwritable location gets **Show download** and platform-specific manual instructions. The app never requests elevated privileges to force a replacement.

| Package | Automatic replacement requirements | Manual fallback |
| --- | --- | --- |
| macOS ARM64 ZIP | A writable, user-owned `ShelfDock.app` or `LexBridge.app` bundle, with a writable parent folder and matching app identity/processor | Quit, unzip the verified download, retain a copy of the old app, then replace the app bundle |
| Windows x64 portable EXE | Launched through its portable EXE, with the original `PORTABLE_EXECUTABLE_FILE` available and writable; PowerShell must permit the local helper script | Quit, retain the previous EXE, replace it with the verified download, then open it |
| Linux ARM64/x64 tar.gz | A dedicated writable, user-owned app folder named `ShelfDock`/`LexBridge` or the matching versioned release folder; system paths and arbitrary personal folders are excluded | Unpack into a new folder you own, then open the new executable |

The current preview packages are unsigned. The macOS download and staged bundle are marked as quarantined and launched through the normal system launcher. Gatekeeper, Windows security prompts, and PowerShell execution policy remain in force. An OS block may require manual approval or installation. The updater never removes quarantine, lowers execution policy, invokes `sudo`, or changes system security settings.

## Private LexBridge updates

LexBridge contacts only `LexiLominite/LexBridge-private`; ShelfDock contacts only `LexiLominite/ShelfDock`. Their artifact names, embedded package identities, and app executables are distinct. A public package cannot be substituted into a personal update.

Private checks use an already installed **GitHub CLI** and its existing authentication on that computer. Install GitHub CLI and run `gh auth login` for `github.com` with access to the private repository if authentication is not already available. No authentication window is opened by the app. No GitHub token is requested, displayed, copied into configuration exports, or stored in app preferences. The CLI retains control of its own authentication.

Checking is explicit or follows the private edition's separate automatic-check preference, enabled on fresh profiles. The private edition does not probe credentials or make public update requests at startup. Failed authentication produces setup instructions and a **Private releases** link. File downloads use fixed repository paths and numeric asset IDs through `gh api`; failed command output is not echoed into the UI.

## Delivery and recovery design

- Release selection compares semantic versions, including numeric prerelease components. Drafts, equal/older versions, incompatible processors and mismatched artifact names are excluded. The newest eligible release is shown even when its platform package is not available yet; users can view that release manually.
- Public traffic is HTTPS only. Initial requests are fixed to the official repository, and redirects are restricted to known GitHub download hosts, with a maximum of five redirects. Response sizes, download sizes, elapsed time, archive entry counts and expanded sizes are bounded.
- Downloads first use unique partial files. SHA-256, size and release metadata must agree before a package becomes installable. Interrupted downloads are removed and retryable. Restored cache files and packages about to install are checked again.
- ZIP and TAR extraction validate all paths and file types before writing files. Absolute/traversing paths, duplicate paths, device files, hard links, links used as directory parents and links resolving outside the app are rejected. Regular files are written before links. Privilege bits are not restored. Embedded ASAR package name/version/product and executable processor are verified for extracted Mac/Linux apps.
- The install helper is local application code, never a script from the release. It receives separate path arguments or a private JSON plan, waits for the exact current process with a timeout, rechecks the installation, and retains an adjacent backup. Windows retries the first move briefly while the portable launcher releases its file lock.
- Failed replacement, a failed launcher command or failure to reach the ready state within 60 seconds restores the previous app where possible. A later crash after the ready state still needs manual recovery from the retained backup. The UI confirms the installed version only after startup is confirmed.
- Settings, verified downloads and install records live under the existing app-data folder in `updates/public` or `updates/personal`. Consent, cache and records are separate for both editions. A broken optional update cache disables the updater without preventing the app from opening. Silent test mode skips its filesystem and network activity entirely.

## Publishing the next update

Publish the release only after all matching packages and `SHA256SUMS.txt` are uploaded and verified. Keep prerelease status intentional. Do not move a published version tag to represent different application code.

| Edition | Repository | Package metadata | Artifact prefix |
| --- | --- | --- | --- |
| ShelfDock | `LexiLominite/ShelfDock` | `name: shelfdock`, `productName: ShelfDock` | `ShelfDock-<version>` |
| LexBridge | `LexiLominite/LexBridge-private` | `name: lexbridge`, `productName: LexBridge` | `LexBridge-personal-<version>` |

The supported suffixes are `-mac-arm64.zip`, `-win-x64.exe`, `-linux-arm64.tar.gz`, and `-linux-x64.tar.gz`. Linux archives use the artifact basename as their top-level folder; Mac archives contain the edition's app bundle.

For wider public distribution, provision Apple Developer ID signing/notarization and Windows publisher signing, then evaluate signed native installer/update feeds. Those publisher accounts and certificates require the owner's setup. Electron's built-in macOS updater requires a signed application, and its built-in updater has no Linux support; these portable packages use the explicit replacement workflow above. See [Electron's platform requirements](https://www.electronjs.org/docs/latest/api/auto-updater) and [GitHub's release-asset API](https://docs.github.com/en/rest/releases/assets).

## Verification and integration

`node --test tests/updates.test.cjs` covers semantic versions/channels, exact platform/edition matching, malicious metadata and checksums, redirect restrictions, download cancellation/interruption, cached-file tampering, private CLI success/failure/cancellation, consent separation and recovery, archive traversal/link escapes, isolated-controller startup failure, busy install gating and rejected asynchronous shutdown.

The suite also runs the POSIX apply helper against temporary fixture apps, covering exact-process waiting, backup/replace, rollback on an unlaunchable package, and the complete controller → verified download → extraction → helper → quiet fixture launch → restart confirmation path. On macOS that fixture uses the host's `stat` spelling for the Linux helper branch. It does not launch the user's app or touch their profile. Native Windows/PowerShell and actual desktop relaunch coverage are separate verification requirements; source tests and cross-build success do not establish those results.

Main-process integration uses `UpdateManager`, awaits `initialized`, publishes `snapshot()` on `drift:updates`, calls `start()` only outside silent tests, and calls `shutdown()` during exit. `preparing` and `installing` require the application mutation lock. The injected `isBusy` must check current transfers, clipboard actions, password/key setup, import, remote installation and running/setup tunnels; the awaited `quit` callback drains pending shelf/profile/Received writes before quitting. IPC is restricted to the same trusted local renderer as other privileged actions.

After loading the main window, publishing its initial state, and receiving the trusted renderer acknowledgement that React loaded its app state, main calls and awaits `confirmStartup()` outside background test mode. Both main and renderer health gates must pass; loading the HTML alone does not confirm a successful update. This writes the health marker, waits for the helper's success receipt, then consumes the journal while retaining the app backup.

Methods are `confirmStartup`, `getState`, `check`, `updatePreferences`, `download`, `cancel`, `install`, `openRelease`, `revealDownload`, `start` and `shutdown`. All install destinations and repository choices are derived in the main process; the renderer cannot choose a path, URL, command or replacement binary.
