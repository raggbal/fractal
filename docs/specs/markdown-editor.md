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

## Image Fullscreen Overlay

Inline images (`<img>` rendered from Markdown image syntax or pasted/dropped images) open in a dedicated fullscreen overlay (`outliner-image-overlay`) on double-click. The same overlay primitive is used by the Outliner — see [odk:component:webview/outliner].

### Overlay structure

```
.outliner-image-overlay        // fixed full viewport, rgba(0,0,0,0.7)
  <cloned img>                 // transformable: translate() scale()
  .image-overlay-toolbar       // top-right: 3 action buttons
    button "Copy Image"        // pixel copy to OS clipboard
    button "Open in New Tab"   // opens image in a VS Code editor tab
    button "Copy Path"         // copies absolute filesystem path as text
  .outliner-image-overlay-close // ✕
```

### Interaction model

- **Wheel + ⌘ / Ctrl** — zoom toward the cursor.
- **Drag** — pan the image when zoomed.
- **Double-click** — reset to identity.
- **Click backdrop or `✕`** — close.
- **ESC** — close (capture-phase handler with `stopPropagation()` + `stopImmediatePropagation()` so nested side-panel ESC handlers do not also fire).

### Toolbar contracts

The webview computes `absPath` by stripping the `https://file%2B.vscode-resource.vscode-cdn.net` (or unencoded `file+`) prefix from the `<img src>` and dropping any `?` / `#` suffix, then dispatches via the host bridge:

- **Copy Image** — `host.copyImageToClipboard(absPath)` → host posts an OS clipboard write of the raw pixel data:
  - macOS — `osascript -e 'set the clipboard to (read (POSIX file "<path>") as «class PNGf»)'`
  - Windows — PowerShell `[System.Windows.Forms.Clipboard]::SetImage`
  - Linux — `xclip -selection clipboard -t image/png -i <path>`
  - On any failure the host falls back to writing the absolute path as text via `vscode.env.clipboard.writeText` and shows an info notification.
- **Open in New Tab** — `host.openImageInNewTab(absPath)` → host calls `vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath))` so VS Code's built-in image preview opens in a new editor tab.
- **Copy Path** — `navigator.clipboard.writeText(absPath)` directly in the webview (no host round-trip needed for plain text).

After a successful action the button label flashes "Copied!" / "Opened!" for ~900 ms.

### Theme independence

Like the block overlay, the backdrop is `rgba(0,0,0,0.7)` and the toolbar buttons use a dark translucent background with a white border so they remain legible under any VS Code theme. See ADR-006.

## Side panel destroy lifecycle

`EditorInstance.destroy()` must remove every DOM node it appended to `document.body`, otherwise lingering toolbars (notably the table toolbar attached at `document.body` so it can escape `overflow: hidden` containers) survive after the side panel closes. The instance tracks `this._tableToolbarEl` and removes it during `destroy()`.
