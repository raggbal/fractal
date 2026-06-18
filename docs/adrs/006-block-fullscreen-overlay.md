# ADR-006: Block Fullscreen Overlay Replaces Codeblock Width-Expand

## Status: Accepted

Scope: fractal (`src/webview/editor.js`, `src/webview/styles.css`)

## Context

Code blocks previously had a header toggle that expanded the block's CSS width beyond the editor column ("width-expand mode"). Mermaid diagrams and math (KaTeX display) blocks had no equivalent escape hatch — wide diagrams were simply clipped or shrunk to fit the column.

Three problems with the status quo:

1. **Inconsistent affordance** — only code blocks had the toggle. Users with wide Mermaid diagrams had no way to inspect them other than scrolling horizontally inside the editor.
2. **Width-only** — expanding the block widened the column but did not give it the full viewport. Tall content (long mermaid sequence diagrams, multi-line equations) still overflowed.
3. **Reflow noise** — toggling width caused the surrounding paragraphs to reflow and the cursor to jump.

## Decision

Remove the codeblock width-expand toggle. Add a single shared **block fullscreen overlay** primitive used by code, Mermaid, and math blocks.

`openBlockFullscreen({ kind, source })` builds an absolutely positioned overlay that:

- covers the full viewport with a translucent black backdrop (`rgba(0,0,0,0.7)`),
- clones the source block's rendered DOM into a transformable stage,
- supports wheel-zoom (with ⌘ / Ctrl), drag-pan, and double-click reset,
- closes on ESC, background click, or the `✕` button.

ESC is registered in capture phase with `stopImmediatePropagation()` so it closes only the overlay and does not bubble up to close the enclosing Markdown Side Panel.

For Mermaid, the cloned SVG's inline `style="max-width: …px"` and explicit `width` / `height` attributes are stripped; the target size is recomputed from the SVG `viewBox` aspect ratio so the diagram fills the available viewport area.

The backdrop colour is theme-independent rather than driven by `var(--bg-color)` — see ADR notes / project-rules.md.

## Alternatives

- **Keep width-expand alongside the new overlay.** Rejected: two affordances for the same intent (inspect this wide block) creates UX confusion. The fullscreen overlay subsumes width-expand because it gives both width and height.
- **Open the block in a separate VS Code editor / webview panel.** Rejected: too heavy for a transient inspection action; loses the editor scroll position; cannot easily clone Mermaid's already-rendered SVG.
- **Use `var(--bg-color)` for the backdrop.** Rejected: in the light VS Code theme this paints a white-on-white close button. The translucent black matches the existing image overlay and stays legible under all themes.

## Consequences

- The CSS rule `.editor pre.code-expanded` is removed; any user CSS depending on it stops applying.
- All three block types now share a single overlay code path (`openBlockFullscreen`), so future fullscreen affordances (e.g. drawio) can reuse the same primitive.
- Cloning a `<pre>` outside `.editor` means it does not inherit the editor's `pre` styling. The overlay defines explicit `background` / `color` / `font-family` / `white-space` on `.block-fullscreen-pre` to compensate.
- ESC handlers in nested overlays must use capture phase + `stopImmediatePropagation()` to coexist with the side-panel ESC-to-close handler. This pattern is now project-wide convention; see `docs/project-rules.md`.
