# NotesEditorProvider

Component: [odk:component:host/notes-editor-provider]

## Responsibilities

- Manage the Notes folder workspace as a `WebviewPanel`.
- Manage multiple panels (one independent panel per folder).
- Delegate `outline.note` CRUD to [odk:component:host/notes-file-manager].
- Integrate Note-level S3 Sync.
- Handle in-app link navigation.
- Open pages within the current panel.

## Tech stack

TypeScript, VS Code `WebviewPanel` API.

## I/O contract

- Input: Notes folder path, [odk:entity:notes/OutlineNote], webview messages.
- Output: WebviewPanel, file writes (via [odk:component:host/notes-file-manager]), S3 sync.

## Dependencies

- [odk:component:host/notes-file-manager]
- [odk:component:host/side-panel-manager]
- [odk:component:host/drawio-watcher-registry]
- [odk:component:s3-sync/notes-s3-sync]
- [odk:component:s3-sync/outliner-s3-sync]
- drop-import / markdown-import / file-import
