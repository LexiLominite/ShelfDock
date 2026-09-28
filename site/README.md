# ShelfDock website

This is a standalone static page, independent of the Electron renderer. There is no build step, external font, analytics, API call, clipboard access or file upload. `app.js` simulates the shelf with fictional data; sending/copying in the demonstration never performs a native operation.

Preview using a local static web server rooted at this directory. Do not connect this demonstration to the desktop native bridge.

## Verification

With Playwright available to the Node.js runtime and its Chromium browser installed, run from the repository root:

```sh
node site/verify.cjs
```

The check uses Playwright's bundled Chromium by default on every platform. Install that browser with `npx playwright install chromium` in the environment where Playwright is installed if it is missing. To use an existing Chrome/Chromium installation instead, set `SHELFDOCK_CHROME` to its full executable path; no platform-specific path is assumed.

The check runs headlessly, exercises the fictional demo and responsive layouts, and writes screenshots plus `verification.json` to `site/.preview-checks`. An optional first argument selects another output directory. It also regenerates the local `assets/social-card.png` illustration. It does not launch the desktop application or use real clipboard data.

## Design

The palette reuses the app: lavender `#E8EBF6`, off-white `#FAFAFD`, slate `#252A40`, secondary text `#596277`, purple `#6353D9` and pale purple `#E8E5F8`. Existing green `#287052` and amber `#8A5A10` express ready/attention. Avenir Next/Avenir falls back to the platform UI font; exact machine/path data use a local monospace stack.

The interactive shelf is the main visual. Features use a clear reading order and varied composition instead of repeated decorative cards. The sample supports dragging and a button-based keyboard path; tabs support arrow keys, Home and End. Clipboard starts off in the demonstration. Enabling it displays fictional examples without inspecting the system clipboard. Reduced motion is respected; feature/setup information remains readable without JavaScript.

The public name is **ShelfDock**; the private edition is **LexBridge**. Current repository links use `LexiLominite/ShelfDock`. Legacy release and app-data names remain unchanged where required for compatibility.

## Hosting and search discovery

GitHub Pages publishes only this directory through `.github/workflows/site.yml` after a `main` update that changes the site or its workflow. The configured address is **https://shelfdock.lexilominite.com/**. GitHub Pages owns its HTTPS certificate; the subdomain CNAME points to `lexilominite.github.io`. Other domain records and nameservers are independent.

Canonical, Open Graph, social-image and structured-data URLs use that origin. `robots.txt` points to `sitemap.xml`. Update all of them together if the domain changes. No analytics or third-party runtime requests are included.

- Keep preview download links at `/releases`; `/releases/latest` can omit prereleases.
- Review feature/version claims against the published packages. Preserve unsigned-package and native-platform limitations beside downloads.
- Private editions use their private repository through an existing authenticated GitHub CLI session, or manual private downloads. Private presets and builds are never website assets.
- Do not claim an open-source license until the owner chooses one.
- Verify deployed assets, metadata, social previews, keyboard navigation and responsive layout after a hosting change.

`assets/social-card.png` is a local fictional product illustration with no real accounts, machines or clipboard information.
