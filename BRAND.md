# DropHarbor brand colours

The v0.2.2 interface uses the published lexilominite.com palette: deep teal #02161A, electric cyan #27E1FA, yellow #FAE127, and foreground #EEEEEE. Dark panel variants and readable semantic success/error colours extend those core colours for the transfer interface.

Source: https://github.com/LexiLominite/lexilominite.github.io/blob/main/index.html (CNAME identifies lexilominite.com). The live domain did not resolve during this update, so its published repository HTML/CSS supplied the palette.

Colours are semantic CSS variables in src/styles.css. Keep native BrowserWindow backgroundColor and index.html theme-color aligned with --canvas to avoid a light flash. Preserve local system fonts, layout, contrast, visible focus rings, and reduced motion.
