# AnyMarkdownEditorProvider

Component: [odk:component:host/any-markdown-editor-provider]

## Responsibilities

- Manage the Custom Text Editor lifecycle for `.md` / `.markdown` files.
- Build the webview HTML (theme, font, image-path injection).
- Handle webview `postMessage` events (sync, save, image / file save, link open, paste, drawio, translate, etc.).
- Detect external file changes and broadcast diffs to the webview ([External Change Sync](glossary.md#external-change-sync)).
- Manage the Side Panel via [odk:component:host/side-panel-manager].

## Tech stack

TypeScript, VS Code `CustomTextEditorProvider` API.

## I/O contract

- Input: `vscode.TextDocument` (Markdown), VS Code config, webview messages.
- Output: TextDocument edits (`WorkspaceEdit`), image / file / drawio writes, webview `postMessage`.

## Internal flow

See [docs/specs/flows.md — Flow 1, Flow 2](flows.md#flow-1--markdown-editor-edit--save).

## Dependencies

- [odk:component:host/side-panel-manager]
- [odk:component:host/drawio-watcher-registry]
- [odk:component:webview/html-md-converter] (used in the webview)
- [odk:contract:host/image-directory-resolver]
- [odk:contract:host/file-directory-resolver]

## Configuration keys

- `fractal.imageDefaultDir` — image save destination (3-tier: file > settings > default).
- `fractal.fileDefaultDir` — file save destination.
- `fractal.fontSize`, `fractal.toolbarMode`, `fractal.imageMaxWidth`.
- Theme: follows the VS Code color theme.

## Scaling

N/A — local single process.

## Failure modes

File-write failures surface via `vscode.window.showErrorMessage`. There is no DLQ.

## IAM

N/A — local extension only.
