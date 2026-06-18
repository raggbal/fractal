# Markdown Editor (editor.js)

Component: [odk:component:webview/editor]

## Responsibilities

- WYSIWYG Markdown editing on a contenteditable DOM.
- Markdown → HTML rendering (`markdownToHtmlFragment`).
- HTML → Markdown serialization (`htmlToMarkdown`).
- Paste classification and integration with [odk:component:webview/html-md-converter].
- Inline preview of code blocks, math, Mermaid, drawio, etc.
- Undo / Redo via Markdown-string snapshots.
- External Change Sync receiver (block-level DOM diff).
- Drag-and-drop handlers (image / file / drawio / web image URL).
- Source Mode toggle.

## Tech stack

Plain JavaScript, contenteditable API, [odk:ext:npm/marked], [odk:ext:vendor/katex], [odk:ext:vendor/mermaid].

## I/O contract

- Input: `postMessage` (markdown, externalChange, config), user input.
- Output: `postMessage` (sync, save, image / file requests).

## Configuration

Theme (CSS custom properties), `fontSize`, `imageMaxWidth`, `toolbarMode`.

## Block Fullscreen Overlay

Code blocks, Mermaid diagrams, and math (KaTeX display) blocks share a single fullscreen overlay primitive (`openBlockFullscreen({ kind, source })`) for inspecting wide / tall content without leaving the editor.

### Entry points

- **Code blocks** — header `⤢` button (single action). Pressing it switches a code block out of `data-mode="edit"` and opens the overlay. The previous "width-expand" toggle was removed; see ADR-006.
- **Mermaid / Math blocks** — `attachBlockFullscreenButton(wrapper, kind)` attaches a top-right `.block-fullscreen-btn` to the rendered block (hidden while the block is in edit mode). Wired from `setupMermaidDiagrams`, `setupMathBlocks`, and `convertToSpecialBlock`.

### Overlay structure

```
.block-fullscreen-overlay      // fixed full viewport, rgba(0,0,0,0.7)
  .block-fullscreen-inner
    .block-fullscreen-stage    // transformable: translate() scale(); transform-origin: 0 0
      <cloned content>         // <pre>, .mermaid-diagram, or .math-display
    .block-fullscreen-close    // ✕ with white border; theme-independent
    .block-fullscreen-hint     // bottom centered usage hint
```

For Mermaid, the cloned SVG's inline `style="max-width: …px"` and `width` / `height` attributes are stripped; the target size is recomputed from the SVG's `viewBox` aspect ratio against the viewport (`window.innerWidth - 160` × `window.innerHeight - 160`) so the diagram fills the available space.

For code, the cloned `<pre>` lives outside `.editor`, so background / color / font-family / white-space are set explicitly on `.block-fullscreen-pre` instead of inheriting from the `.editor pre` rule.

### Interaction model

- **Wheel + ⌘ / Ctrl** — zoom toward the cursor (transform-origin top-left of the stage; `scale` updated and `translate` adjusted so the point under the cursor stays put).
- **Drag (mouse / pointer)** — pan the stage.
- **Double-click** — reset zoom and translate to identity.
- **Click background or `✕`** — close.
- **ESC** — close. Registered with `addEventListener('keydown', escHandler, true)` (capture phase) and the handler calls `stopPropagation()` and `stopImmediatePropagation()` before cleanup so it does not bubble to the side-panel close handler when the editor is in Markdown Side Panel mode.

### Theme independence

The backdrop is `rgba(0, 0, 0, 0.7)` rather than `var(--bg-color)` so it remains visible under any VS Code theme and matches the existing image overlay. The close button uses an 18% white background with a white border for the same reason.

See [odk:req:ui/block-fullscreen-overlay].

## Side panel destroy lifecycle

`EditorInstance.destroy()` must remove every DOM node it appended to `document.body`, otherwise lingering toolbars (notably the table toolbar attached at `document.body` so it can escape `overflow: hidden` containers) survive after the side panel closes. The instance tracks `this._tableToolbarEl` and removes it during `destroy()`.
