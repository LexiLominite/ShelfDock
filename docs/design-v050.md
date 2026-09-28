# ShelfDock / LexBridge 0.5 design review

The owner selected **ShelfDock** for the public product and **LexBridge** for the personal edition after a Grok 4.7 naming and whole-product review. Two bounded reviews used the existing subscription CLI; response metadata identified `grok-4.7-build`. Only supplied product descriptions were shared: no user files, clipboard content, credentials, real machine inventory, or private preset.

## Reviewed scope and decisions

- Transfers remains the home workspace. Dragging or pressing Send is deliberate, with exact selected items and explicit multi-machine review. Gesture and shortcuts keep their existing toggle/focus rules.
- Machines remain visible beside the current workspace. Ready status, access and the site globe stay discoverable; uncommon controls use the three-dot menu with a keyboard equivalent. Device details remain collapsed in every density.
- Received is independent of Clipboard: quiet unread badge, Received/New/Sent filters, filename/device/date search, collapsed batch details, Open folder, Mark seen, and selected-item handoff back to Transfers. Adding to the shelf does not send.
- Clipboard remains off by default, absent until enabled in Settings, and independently prominent once enabled. Local recording is a separate choice. Copying never sends, and clipboard history never synchronizes automatically.
- Completion receipts travel over the existing trusted SSH transfer, after all payloads finish. Untrusted receipt text is bounded and validated. Missing items, wrong sizes and symlink escapes cannot become complete arrivals. Names survive clearing the sender shelf. A copied batch with a failed marker stays copied with a listing warning, avoiding accidental duplicate retries.
- Optional device naming shares only the chosen label, otherwise “Another computer.” Received labels are metadata, not proof of identity.
- Updates use explicit opt-in checks/downloads, verified matching release assets, clear version notes, an idle-only restart decision and retained app backup. Profile data stays outside the replacement. Private editions use their own private feed and local GitHub sign-in; they never silently switch to the public product.
- Existing semantic lavender/purple colours and green/amber status tokens are reused. Exact paths, hosts and ports use monospace. Focus rings, keyboard paths and reduced-motion support remain intact.

## Advice not applied blindly

Grok initially preferred ShelfBridge as the public name. A web check found several existing software products with that name, and the owner chose ShelfDock. No trademark or domain availability claim is made. The existing app-data name, shared worker identity and transfer protocol intentionally retain legacy names for compatibility.

Grok also proposed automatic receipt-only repair and new trash actions. Those add remote mutation or destructive behavior and are not part of this release. The implemented actions remain inspect, mark seen, and deliberately reuse files. Suggestions that would automatically reopen details in Expanded or change the remembered window size were not adopted because the owner requested persistent density and closed details.

## Evidence

See the automated backend/renderer checks, [receipt protocol](received.md), [brand tokens](../BRAND.md), and release verification notes. A model review is design input, not a test result. All committed screenshots use fictional machines and sample files.
