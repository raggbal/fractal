# ADR-008: Markdown files in Notes folders

## Status: Accepted

Scope: `src/notesEditorProvider.ts`, `src/shared/notes-file-manager.ts`, `src/notesWebviewContent.ts`, `src/shared/notes-file-panel.js`, `src/shared/notes-host-bridge.js`, `src/shared/notes-message-handler.ts`, `.odk/components/entity/notes/NoteTreeFile.yaml`, `docs/specs/notes-editor-provider.md`, `docs/specs/notes-file-manager.md`, `docs/specs/data-model.md`.

## Context

The Notes Editor side panel's Notes tab is the project's primary file manager: register, organise, rename, recolour, drag-and-drop, search. It currently registers Outliner files (`.out`) only. Many users keep plain Markdown documents alongside outliner notes (release notes, READMEs, drafts, llms.txt-style indices). Today the only Markdown surfaces are:

- **Standalone Markdown** — opened via VS Code's editor association (`AnyMarkdownEditorProvider`). Lives outside Note folders, has no `outline.note` registration.
- **Outliner pages** — per-node `.md` files inside `<id>/`, surfaced via Side Panel.

Neither lets a user keep a top-level `.md` in a Note folder as a first-class registered item. They have to either (1) keep the `.md` outside the Note folder and lose the tree view + drag-and-drop + colour, or (2) wrap the content in an outliner page and lose the "single document" mental model.

The ask is: in the Notes tab of the Notes Editor, allow registering `.md` files (in addition to `.out`) and, when one is selected, render the standard Markdown editor in the right pane with feature parity to standalone Markdown mode.

## Decision

Two structural choices.

### 1. Extend `NoteTreeFile` with an optional `ext` discriminant

Add `ext?: "out" | "md"` to [odk:entity:notes/NoteTreeFile]. Default `"out"` (back-compat: existing structures load unchanged).

**Rejected alternatives:**

- *New tree-item type* `markdown-file` (alongside `file` and `folder`). Rejected: every consumer (`notes-file-panel.js`, `outline.note` parsers, the Chrome extension's tree renderer, search, D&D) would need a third branch. The shape of the data — id, title, color, sibling order — is identical. The only difference is which extension lives on disk and which editor opens it.
- *Type by file extension at runtime* (probe disk for `<id>.md` vs `<id>.out`). Rejected: forces a `fs.existsSync` per item per render, races with deletes, and breaks search index pre-loading. The discriminant belongs in the manifest.

### 2. Reuse `editor.js` for the main pane via a second EditorInstance

`editor.js` already exports `EditorInstance(...)` for the Side Panel and is loaded into the notes webview today, but immediately bails out via `window.__SKIP_EDITOR_AUTO_INIT__ = true`. We add a second instance for the right pane (a `.markdown-container` that lives next to `.outliner-container`), constructed lazily when the user first opens an `.md` item, and toggle visibility between the two containers on `notesOpenFile`.

**No new "Notes editor mode" is required inside `editor.js`.** The mode space inside the editor is currently a single boolean: `IS_SIDEPANEL = !!this.options.isSidePanel` (`editor.js:331`). There is no `isStandalone` flag — "standalone" is the implicit default when `isSidePanel` is falsy. Concretely the only two existing call sites are:

- `new EditorInstance(document.body, window.hostBridge)` at `editor.js:18385` (standalone — auto-created when `__SKIP_EDITOR_AUTO_INIT__` is unset).
- `new EditorInstance(spContainer, sidePanelHostBridge, { isSidePanel: true })` at `editor.js:15434` (Side Panel inside any editor).

A Notes-folder Markdown view is functionally identical to standalone (full toolbar, full document, full TOC). It therefore fits as a third instance constructed with **no options** (i.e. the standalone branch of the existing `IS_SIDEPANEL` switch). What is Notes-specific lives outside `editor.js`:

- A new `notesMarkdownHostBridge` that implements the same `HostBridge` interface `editor.js` already expects (`syncData`, `requestImage`, `requestInsertLink`, asset/translate calls, etc.) but routes messages over the Notes webview's existing `postMessage` channel.
- A `kind?: "out" | "md"` discriminant on the `updateData` message so the webview's existing dispatcher can hand the payload to either `Outliner.init(...)` or the new `EditorInstance`.

**Rejected alternatives:**

- *Add a third mode to `editor.js`* (`isNotes: true`). Rejected: there is nothing the Notes main pane needs that standalone does not already do. Adding the flag would introduce dead branches and another axis to keep tested.
- *Open the `.md` in a separate VS Code editor tab* (delegate to `AnyMarkdownEditorProvider`). Rejected: the user explicitly asked for the right pane of the Notes Editor to host the Markdown view. Splitting tabs breaks the single-pane workflow.
- *Mount a fresh iframe* hosting standalone Markdown HTML. Rejected: doubles the editor's CSS/JS payload and forks state (translate UI, image pipeline, drawio watcher) across two contexts. The existing `EditorInstance` constructor was designed to be re-entrant for exactly this case (Side Panel reuses it).

## Alternatives Considered (whole feature)

- *Convert `.md` registration into a thin wrapper that creates a single-page outliner.* Rejected: surfacing an outliner toolbar above what the user thinks of as "a Markdown file" is a worse UX than just opening the Markdown editor.
- *Defer to per-Note "external `.md` link" entries* (manifest carries a path, click opens external editor). Rejected: drops in-pane editing.

## Consequences

- `outline.note` files written by the new code carry `ext: "md"` on Markdown entries. Older Fractal versions reading these manifests will treat them as outliner files and fail to open the missing `<id>.out` — sync between old and new versions is one-way safe (old → new is fine; new → old surfaces the unknown items as broken `.out` references).
- Outliner-only behaviours (Daily Notes, Side Panel pages, `pageDir` / `fileDir` resolution, S3 outliner sync) skip Markdown items by branching on `ext === "out"`.
- Search needs a third branch: outliner-tree + page-MD + raw `.md` body.
- The two-container model means CSS rules that target `.outliner-container` continue to work; new rules for `.markdown-container` mirror the standalone Markdown editor's container styling.
- Bumping the `outline.note` `version` is **not** required because the new field is optional and missing-as-`"out"` is back-compat (consistent with [data-model.md §Versioning policy]).
