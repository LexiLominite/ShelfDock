# ShelfDock landing page draft

This is a standalone static page, independent of the Electron renderer. There is no build step, external font, analytics, API call, clipboard access or file upload. `app.js` simulates the shelf with fictional data; sending/copying in the demonstration never performs a native operation.

Preview using a local static web server rooted at this directory. Do not connect this demonstration to the desktop native bridge.

## Design

The palette reuses the app: lavender `#E8EBF6`, off-white `#FAFAFD`, slate `#252A40`, secondary text `#596277`, purple `#6353D9` and pale purple `#E8E5F8`. Existing green `#287052` and amber `#8A5A10` express ready/attention. Avenir Next/Avenir falls back to the platform UI font; exact machine/path data use a local monospace stack.

The interactive shelf is the main visual. Features use a clear reading order and varied composition instead of repeated decorative cards. The sample supports dragging and a button-based keyboard path; tabs support arrow keys, Home and End. Clipboard starts off in the demonstration. Enabling it displays fictional examples without inspecting the system clipboard. Reduced motion is respected; feature/setup information remains readable without JavaScript.

The public name is **ShelfDock**; the private edition is **LexBridge**. Current repository links use `LexiLominite/ShelfDock`. Legacy release and app-data names remain unchanged where required for compatibility.

## Before hosting

- Choose and verify the domain. No canonical URL, `og:url` or sitemap domain is guessed in this draft.
- Add the actual absolute canonical URL, `og:url`, social-image URLs and a sitemap after hosting is selected. Current relative social-image references identify the local asset and need a deployment-specific absolute origin for reliable social previews.
- Review the 0.5.0 feature/version claims against the released packages: Sent/Received scope, optional update checks, verified downloads, explicit Restart and install and writable-install limits. Private editions use their private repository through an existing authenticated GitHub CLI session, or manual private downloads; they do not query public clean releases.
- Keep download links at `/releases` while builds are prereleases; `/releases/latest` can omit the intended preview.
- Preserve unsigned-preview and native-platform testing limitations beside downloads. Mac-only remote app installation is separate from normal cross-platform SSH transfers.
- Do not claim an open-source license until the owner chooses one. Do not invent support/security email addresses.
- Verify deployed asset paths, metadata, social previews, keyboard navigation and responsive layout before promotion.

`assets/social-card.png` is generated from a local, fictional product illustration. Regenerate it if branding changes. It contains no real account, machine or clipboard information.

These files prepare a reviewable website. They do not publish a site, configure DNS or authorize hosting.
