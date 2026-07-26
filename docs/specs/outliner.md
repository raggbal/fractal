# Outliner (outliner.js + outliner-model.js)

Component: [odk:component:webview/outliner]

## Responsibilities

- Render the tree UI and handle user input.
- `outliner-model.js` — pure tree CRUD (`addNode`, `moveNode`, `removeNode`, `serialize`).
- Tag parsing and filtering.
- Scope (subtree focus) management.
- Table View rendering when `columns` is defined.
- Task Mode (auto-attached checkboxes plus filters).
- Drag-and-drop (internal node reorder plus external file drop).
- Paste classification and node-structured paste.
- Navigation history (`MAX_NAV_HISTORY=50`).
- Undo / Redo (`MAX_UNDO=200`).

## Tech stack

Plain JavaScript, DOM API.

## I/O contract

- Input: `postMessage` events, user input.
- Output: `postMessage` (sync, save, drop request, page open, etc.).

## Image Fullscreen Overlay

Image cells (`outliner-cell.js::showImageOverlay`) open the same `outliner-image-overlay` primitive used by the Markdown editor: zoom (⌘+wheel) / pan (drag) / dblclick reset / ESC close, plus a top-right toolbar with **Copy Image**, **Open in New Tab**, and **Copy Path**. Toolbar dispatch goes through `window.outlinerHostBridge.copyImageToClipboard(absPath)` and `openImageInNewTab(absPath)`. See the "Image Fullscreen Overlay" section in [docs/specs/markdown-editor.md](markdown-editor.md) for the canonical contract; the Outliner mirrors it.
