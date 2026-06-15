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
