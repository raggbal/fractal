# NotesEditorProvider

Component: [odk:component:host/notes-editor-provider]

## Responsibilities

- Manage the Notes folder workspace as a `WebviewPanel`.
- Manage multiple panels (one independent panel per folder).
- Delegate `outline.note` CRUD to [odk:component:host/notes-file-manager].
- Integrate Note-level S3 Sync.
- Handle in-app link navigation.
- Open pages within the current panel.
- Open both Outliner (`.out`) and Markdown (`.md`) files in the right pane (see ADR-008).

## Tech stack

TypeScript, VS Code `WebviewPanel` API.

## I/O contract

- Input: Notes folder path, [odk:entity:notes/OutlineNote], webview messages.
- Output: WebviewPanel, file writes (via [odk:component:host/notes-file-manager]), S3 sync.

## File types in a Note folder

A Note folder may contain two kinds of registered files. The kind is recorded on each [odk:entity:notes/NoteTreeFile] via the optional `ext` field (default `"out"` for backward compatibility):

| `ext` | Extension | Right-pane editor | Inline tree | Side-panel pages |
|---|---|---|---|---|
| `"out"` (default) | `<id>.out` | Outliner (`outliner.js`) | yes | yes (per-node MD pages) |
| `"md"` | `<id>.md` | Markdown editor (`editor.js`) | n/a | n/a (single document) |

Outliner files keep their existing semantics (`<id>/` page directory, file directory, image directory). Markdown files have no per-file directory — they are a single self-contained `.md` document at the Note root, just like a standalone Markdown file.

## Right-pane container model

The webview hosts two right-pane containers, only one visible at a time:

- `.outliner-container` — existing; rendered by `outliner.js`.
- `.markdown-container` — new; rendered by a main-pane EditorInstance (see ADR-008).

`notesOpenFile` reads the target item's `ext`, swaps the visible container, and either calls `Outliner.init(...)` (re-initialise the existing outliner) or pushes the Markdown content into the main-pane EditorInstance. The Side-Panel EditorInstance is unaffected and continues to render outliner pages.

## Webview message additions

| Message (webview → host) | Purpose |
|---|---|
| `notesCreateMarkdownFile` | Create a new `.md` file under a parent folder (or root), placed after a given `afterId`. |
| `notesOpenFile` (extended) | Now also handles `.md` items. The host reads the item's `ext` and emits `updateData` with `kind: "md"` for Markdown or the existing outliner payload for `.out`. |
| `updateData` (host → webview, extended) | Adds `kind?: "out" \| "md"` and, for `kind: "md"`, the raw Markdown text. |

The Markdown editor's existing message types (`update`, `insertImageHtml`, etc.) flow through unchanged once the main-pane EditorInstance is active.

## Dependencies

- [odk:component:host/notes-file-manager]
- [odk:component:host/side-panel-manager]
- [odk:component:host/drawio-watcher-registry]
- [odk:component:s3-sync/notes-s3-sync]
- [odk:component:s3-sync/outliner-s3-sync]
- drop-import / markdown-import / file-import
