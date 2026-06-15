# ADR-001: Three Provider Architecture

## Status: Accepted

Scope: fractal

## Context

Fractal has three independent VS Code Providers, each with its own webview message handler:

1. `AnyMarkdownEditorProvider` — standalone `.md` (CustomTextEditorProvider)
2. `OutlinerProvider` — standalone `.out` (CustomTextEditorProvider)
3. `NotesEditorProvider` — Notes panel with embedded outliner + side panel markdown (WebviewPanel)

This requires duplicating message handlers across Providers (the "5-place rule" documented in `patterns/common/sidepanel-messaging.md`).

## Decision

Keep three separate Providers. This is not a design choice — it is imposed by VS Code's extension API:

- `registerCustomEditorProvider` binds one Provider to one file type. `.md` and `.out` are different file types, so they require separate Providers.
- The Notes panel is not file-backed (it manages a folder, not a single document), so it uses `createWebviewPanel` — a fundamentally different API surface from CustomTextEditorProvider.

These are two distinct VS Code APIs (`CustomTextEditorProvider` vs `WebviewPanel`) that cannot be unified into a single class.

## Alternatives

- **Single unified Provider**: Impossible due to VS Code API constraints described above.
- **Two Providers (merge Notes into Outliner)**: Notes manages folder-level state (tree of `.out` files, S3 sync config, panel widths) that has no single-file backing document — `CustomTextEditorProvider` requires a `TextDocument`.

## Consequences

- New webview messages must be added to all relevant Providers (see `patterns/common/sidepanel-messaging.md` for the full checklist).
- Shared logic lives in `src/shared/` (e.g., `notes-message-handler.ts`, `sidePanelManager.ts`, `paste-asset-handler.ts`) to reduce duplication.
- The webview layer (`src/webview/`) is fully shared — `editor.js` and `outliner-model.js` run identically in all three contexts.
