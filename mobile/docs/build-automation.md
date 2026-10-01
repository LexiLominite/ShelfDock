# Mobile build automation

`.github/workflows/mobile.yml` checks pull requests that change `mobile/**` or
the workflow itself, matching pushes to `main`, and manual runs. Its permissions
are limited to reading repository contents. New runs cancel obsolete checks for
the same branch.

The bridge job uses Node 22 and Python 3.12 on Ubuntu. It runs both Node test
files, including the isolated HTTP interoperability fixture, then the standard
library Python integration and mocked macOS tool suites. The macOS tests mock
launchd and OS actions and use temporary home directories; they do not install a
service or start the desktop application.

The Android job uses JDK 17 and the Ubuntu runner's preinstalled Android command
line tools. It explicitly installs platform 36 and build tools 35.0.0, then runs
`testDebugUnitTest`, `lintDebug`, and `assembleDebug` through the committed Gradle
8.13 wrapper. The wrapper properties pin the distribution's SHA-256 checksum.
The hosted runner supplies the Android SDK and accepted SDK licenses.

These checks require no production bridge configuration, credentials, pairing,
private files, or release signing secrets. The debug APK is a build validation
output; the workflow does not publish it or produce a signed release. Android
instrumentation tests require a device or emulator and a separately started
isolated bridge fixture, so they are outside this pull request workflow. Passing
the HTTP fixture smoke test does not establish native Android interoperability.
