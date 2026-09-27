# Grok review and changes

The installed Grok CLI completed a read-only review of the clipboard, configuration, service, preload, and native controller source. It received a source-only snapshot without personal configuration or clipboard data. Web access, subagents, and tools were disabled for that review.

The review prompted these changes:

- A failed personal preset now produces a recoverable discovery notice rather than preventing the app from opening.
- A partial imported settings document preserves preferences that were not supplied.
- Automatic Tailscale route inference is limited to the carrier-grade NAT range, rather than every 100.x address.
- Shelf mutations serialize additions/removals, enforce capacity across concurrent additions, and clean up staged notes/images when a save fails.
- Configuration import waits for existing shelf changes and guards mutations started while clipboard reading was still pending.

The review also recommended a disk write queue, which already existed, and made a concurrency claim about simultaneous configuration imports that was not established. Those claims were checked against the code rather than accepted automatically.

An independent review additionally found and fixed atomic upgrade migration and configuration rollback/probe timing. Shared worker locking and show/hide toggles were added after the Grok snapshot and have their own headless controller/worker regression tests.

Native Windows and Linux sender validation, Windows receiver tests, signing/notarization, installer distribution, and a signed update process remain public-release work. macOS native clipboard text/file/image samples and Linux/macOS receiver transfers have been verified locally.
