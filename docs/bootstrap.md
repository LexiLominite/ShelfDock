# Non-interactive public installation

Save and review `installers/bootstrap.sh` or `installers/bootstrap.ps1` from the trusted ShelfDock source/release. Run the saved file; never pipe a network response into a shell. Both default to **0.7.0**, accept an explicit semantic version, and fetch only `https://github.com/LexiLominite/ShelfDock/releases/download/v<VERSION>/`. They do not prompt, install runtimes, elevate privileges, or launch the application.

```sh
sh bootstrap.sh 0.7.0
```

Linux x64 and arm64 require an existing Python 3 interpreter (standard library only), curl or wget, and the prerequisites of `install.sh` (tar and sha256sum or shasum). Python checks bounded TAR paths, types, counts, file sizes, expansion size, ELF architecture, and the ASAR package identity before calling the checksum-verified release `install.sh`. Links, duplicate paths, traversal, special files, and personal configuration fail closed. The application installs under `~/Applications/ShelfDock-<VERSION>-linux-<ARCH>`. Temporary compressed/decompressed verification files may require several GB of free space.

```powershell
powershell -NoProfile -File .\bootstrap.ps1 -Version 0.7.0
```

Windows requires existing Windows PowerShell 5.1 or a compatible PowerShell on native x64 Windows. PowerShell downloads bounded files over HTTPS, verifies exact unique manifest entries and hashes, validates the portable PE header and ProductName/ProductVersion, and calls the verified release `install.ps1`. The portable launcher may be x86; the inner x64 payload architecture is bound to the exact `ShelfDock-<VERSION>-win-x64.exe` release asset and checksum and relies on the release packaging verifier. This bootstrap does not extract or independently inspect the inner Windows payload. The application installs under `%LOCALAPPDATA%\Programs\ShelfDock`.

Every requested release must publish the corresponding package, `SHA256SUMS.txt`, and `install.sh` or `install.ps1`, with the installer itself included in `SHA256SUMS.txt`. Missing assets, invalid manifests, unsupported architectures, or failed checks abort installation. The manifest provides consistency with the trusted GitHub release; it is not an independent signed trust root. Review the saved bootstrap and trust the repository/release publisher before use.

Downloads have a 600-second deadline, 20-second network timeouts, five redirects at most, a 1500 MiB package limit, a 128 KiB manifest limit, and a 256 KiB installer limit. Linux verification additionally caps expanded TAR bytes at 3 GiB, entry count at 40,000, and individual files at 1 GiB. Files stay in a private temporary directory (mode 700 on Linux; user-only ACL on Windows), which is removed on exit. Existing destinations are refused by the payload installer; profiles and existing installations are not overwritten. The installed application remains closed.

LexBridge is private and is intentionally unsupported by these public bootstraps. Use the sender application's authenticated private release downloader and existing trusted SSH install path: select the personal edition and verified SSH destination, verify the package, transfer the payload plus local installer over SSH, and execute the receiver installer without opening the app. Do not use an anonymous public fetch for LexBridge or copy GitHub tokens/credentials to the receiving machine.

Focused tests use synthetic ELF/ASAR/TAR fixtures and fake curl/wget transports in private temporary directories. They do not fetch real releases, execute downloaded production payloads, or write a real home/profile. Native Windows PE resource parsing, ACL behavior, and installation require Windows validation; synthetic Linux fixtures alone do not establish native Windows coverage.
