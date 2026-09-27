# DropHarbor colours and readability

Version 0.4.1 restores the original light lavender palette from commit `29da5c6`, while retaining the current Compact, Balanced and Expanded layouts. It replaces the dark teal/cyan treatment introduced with the portfolio branding. The light appearance is deliberate; this release does not add an automatic theme switch.

| Role | Colour | Use |
|---|---|---|
| Canvas | `#E8EBF6` | Original soft lavender window background |
| Panel | `#FAFAFD` | Original off-white reading surface |
| Raised / hover | `#F0F2F9` / `#E4E8F2` | Quiet surface hierarchy |
| Main text | `#252A40` | Original dark slate, without pure black |
| Secondary text | `#596277` | Darker than the original `#717991`, for readable small labels |
| Primary / selected / focus | `#6353D9` | Original purple; pale `#E8E5F8` selection fill |
| Ready / successful | `#287052` | Muted green; status labels and icons remain available |
| Attention | `#8A5A10` | Amber text rather than a bright yellow fill |
| Error / destructive | `#A83E48` | Muted red, with explicit messages |
| Input boundaries / scrollbar | `#7C849A` | Visible controls and scroll position |
| Decorative dividers | `#D1D6E3` | Low-emphasis grouping |

Shadows and overlays use the slate/lavender family. Native startup and browser theme backgrounds match the canvas, avoiding a dark flash. Placeholder text is fully opaque. Ready dots retain their two-second pulse, with only a small 100% to 80% change; reduced motion disables it. Controls retain keyboard focus rings and layout sizes.

Readability checks use the [W3C text contrast threshold](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) of 4.5:1 for normal text, plus [3:1 non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) for tested control boundaries and focus indicators. `npm run test:ui:palette` measures representative rendered states in all densities and saves the measured results alongside fictional screenshots. This is targeted verification, not a whole-application accessibility certification or a medical claim about eye strain.

See [palette review and screenshots](docs/palette.md) for Grok's feedback and the final checks. Keep colours in the semantic variables in `src/styles.css`; native `BrowserWindow.backgroundColor` and `index.html` theme colour must stay aligned with `--canvas`.
