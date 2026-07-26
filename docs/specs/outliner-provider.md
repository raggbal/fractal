# OutlinerProvider

Component: [odk:component:host/outliner-provider]

## Responsibilities

- Manage the Custom Text Editor lifecycle for `.out` files.
- Read and write the JSON tree data ([odk:entity:outliner/OutFile]).
- Manage Pages, images, and attachment files associated with nodes.
- Host-side handler for drag-and-drop and import flows.
- Manage the Side Panel that previews pages.
- Integrate Outliner-level S3 Sync.
- Provide llms.txt export.

## Tech stack

TypeScript, VS Code `CustomTextEditorProvider` API.

## I/O contract

- Input: `vscode.TextDocument` (`.out` JSON), dropped/imported files, webview messages.
- Output: JSON edits, page `.md` files, images, attached files, clipboard content (llms.txt).

## Dependencies

- [odk:component:host/side-panel-manager]
- [odk:component:host/drawio-watcher-registry]
- [odk:component:s3-sync/outliner-s3-sync]
- drop-import / markdown-import / file-import (in `src/shared/`)
- llms-txt-builder (in `src/shared/`)

## Configuration keys

- `pageDir` / `fileDir` / `imageDir` inside the `.out` JSON (self-contained layout).
- `fractal.outlinerS3SyncMode` (`auto` | `confirm`).
- `fractal.toolbarMode`, `fractal.imageMaxWidth`.
