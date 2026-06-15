# Fractal — Glossary

## Note
A folder registered in the VS Code Activity Bar via "Fractal Notes". Contains one or more `.out` files and their associated pages/assets. The unit of cloud sync (S3).

## Outliner
A `.out` file. A tree of Nodes with optional columns (Table View) and Task Mode. Has two launch modes:
- **Single mode** — opened standalone via file explorer or custom editor association.
- **Note mode** — opened from within a Note folder via the Notes panel.

## Node
A single bullet (row) in an Outliner tree. Properties: text, tags (#/@ parsed), children, subtext, images, filePath, checked (Task Mode), collapsed. Identified by a short random ID (`n` + timestamp36 + random).

## Page
A `.md` file attached to a Node via the `@page` command. The Node shows a page icon; `Cmd+Enter` opens the Markdown editor. Identified by a UUID v4 (`pageId`).

## Markdown Editor
The Typora-like WYSIWYG editor for `.md` files. Has two launch modes:
- **Single mode** — opened standalone as a VS Code custom editor for any `.md` file.
- **Side Panel mode** — opened in the right pane from an Outliner Node's page. Accessed from Note mode Outliner or Single mode Outliner.

DO NOT USE: "Page Editor" (ambiguous with the Page concept itself).

## Side Panel
The right-side pane that hosts a Markdown Editor instance when launched from an Outliner. Has its own HostBridge (`SidePanelHostBridge`) that delegates to the main Outliner's host bridge.

## Host Bridge
The messaging layer between a webview (Outliner or Markdown Editor) and the VS Code extension host. Each Provider (editorProvider, outlinerProvider, notesEditorProvider) implements its own host handler.

## Provider
A VS Code custom editor provider that manages webview lifecycle and message routing:
- `AnyMarkdownEditorProvider` — standalone `.md` files.
- `OutlinerProvider` — standalone `.out` files.
- `NotesEditorProvider` — Notes panel (manages folders, multiple `.out` files, side panel).

## Task Mode
An Outliner mode where root Nodes automatically receive checkboxes. Supports filtering: `active` (incomplete only) or `all`.

## Table View
An Outliner display mode with user-defined columns (`columns` array in `.out` data). Comparable to a TreeViewTable.

## Tag
A `#tag` or `@tag` token parsed from Node text. Used for filtering and organization. Inline code and URLs are excluded from parsing.

## S3 Sync
Cloud backup/restore via AWS CLI (`aws s3 cp` spawned as child process). Two independent modes with separate UI buttons:
- **Note Sync** (`notes-s3-sync.ts`): syncs the entire Note folder. Configured via `outline.note` → `s3BucketPath`.
- **Outliner Sync** (`outliner-s3-sync.ts`): syncs a single Outliner (`<id>.out` + its `<id>/` pages folder) from the Outliner toolbar.

Both use a shared per-file mtime newer-wins engine (`s3-per-file-sync.ts`). Conflict resolution: auto (mtime newer wins) or confirm (user dialog on size mismatch). No `--delete` — files only on one side are preserved (uploaded or downloaded, never removed).

## Translate
Markdown Editor toolbar button that translates the current page via AWS Translate (CLI: `aws translate translate-text`). Protects code blocks, inline code, block math (`$$`), and HTML comments from translation by splitting into `translate` / `preserve` segments. Supports 14 languages, Custom Terminology, and auto-chunks at 10KB per request. Same CLI-spawn pattern as S3 Sync.

## llms.txt Export
Right-click context menu feature on an Outliner Node. Exports the subtree as an `llms.txt`-style Markdown document (headings for parent nodes, `- [text](absolute-path)` bullets for leaf nodes with pages/files). Three modes: `md` (pages only), `file` (attached files only), `both`. Used to provide Outliner structure as context to AI tools via clipboard.

## fractal:// link
An internal URI scheme for cross-reference between Notes:
- Node link: `fractal://note/{folder}/{outFileId}/{nodeId}`
- Page link: `fractal://note/{folder}/{outFileId}/page/{pageId}`

## Cmd+L (AI Handoff)
Selects text in the WYSIWYG editor, opens the underlying `.md` file in VS Code's native text editor with the exact lines selected. A second `Cmd+L` triggers the host IDE's AI chat (Cursor, VS Code Copilot, etc.). Fractal does not communicate with any AI service directly — it bridges to the IDE's native AI integration.

## Source Mode
A toggle in the Markdown Editor that switches between WYSIWYG (contenteditable HTML DOM) and raw Markdown textarea editing. Toggled via `Cmd+/` or command palette.

## Markdown Editor Internal Model
The source of truth is a `markdown` string variable (plain Markdown text). The editing cycle:
1. **Render**: `markdownToHtmlFragment(markdown)` → `editor.innerHTML` (contenteditable div).
2. **Edit**: User edits the HTML DOM directly via contenteditable.
3. **Serialize**: `htmlToMarkdown()` walks the DOM → produces Markdown text → syncs to host.
4. **Undo/Redo**: Snapshots of the `markdown` string are stacked; restore triggers `renderFromMarkdown()`.

Both conversion directions (`markdownToHtmlFragment` and `htmlToMarkdown`) live inside `editor.js`. `HtmlMdConverter` (the shared sub-package) is used only for **external HTML** (clipboard paste, not the editor's own DOM).

## External Change Sync
The mechanism that makes the Markdown Editor "AI-friendly". Detects file-system changes (via fs watch) and applies a block-level DOM diff to update only changed blocks in the WYSIWYG view. Preserves cursor position and in-progress edits. No AI-specific API — any external process (Claude Code, Cursor, etc.) writing to the `.md` file triggers the sync.

DO NOT USE: "AI sync", "real-time collaboration" (it's not multi-cursor collaborative editing; it's one-way external-change detection).

## HtmlMdConverter
In-repo sub-package (`html-md-converter/`) that converts HTML to Markdown. Built on turndown + GFM plugin with Fractal-specific custom rules. Shared across all three products:
- **fractal** (VS Code extension): paste handler converts clipboard HTML to Markdown on `Cmd+V`.
- **fractal-chrome-extensions**: converts clipped web pages to `.md` files.
- **fractal-claude-skills**: `collect` / `web-crawler-md` skills convert fetched HTML to `.md`.

Includes SVG pre-processing (`inlineSvgComputedStyles` + `preSerializeSvgsToImages`) that bakes computed styles into SVG elements and converts `<svg>` to self-contained `<img>` before Readability strips attributes. Used by all three products.

Distributed via `scripts/update-*.sh` that copies the built artifact to each consumer.

DO NOT USE: "turndown" (implementation detail), "paste converter" (only one of its uses).

## .out file
JSON format. Schema: `{ version, rootIds, nodes, title?, columns?, taskMode?, taskFilter? }`. `version` is always `1` (no migration logic exists; legacy array-format `nodes` is converted to object-map on load). Nodes are stored as an object map keyed by Node ID.

## outline.note
JSON file at the root of a Note folder. Schema: `{ version, rootIds, items, panelWidth?, sidePanelWidth?, sidePanelOutlineWidth?, s3BucketPath?, favorites? }`. `items` is a map of `NoteTreeFile | NoteTreeFolder`. Manages the tree structure of `.out` files and sub-folders within a Note, plus layout preferences shared across the Note.

DO NOT USE: "note.json", "manifest" (the file is literally named `outline.note`).

## Code Layers
- `src/webview/` — Browser (webview iframe). Plain JS. Editor UI, Outliner UI, HtmlMdConverter. Shared across all Providers.
- `src/shared/` — Node.js (Extension Host). TypeScript. Shared logic used by all three Providers (message handling, side panel management, paste/asset handling, path safety, S3 sync, translate).
- `src/*.ts` (root) — Provider entry points (`extension.ts`, `editorProvider.ts`, `outlinerProvider.ts`, `notesEditorProvider.ts`) and their direct helpers.

## Vendored Libraries
Pre-built bundles in `vendor/` (KaTeX for math rendering, Mermaid for diagrams). Vendored because VS Code webviews cannot load from CDN — all assets must be local.

## E2E Test (Playwright)
The primary (currently only) test layer. ~178 spec files in `test/specs/` that launch the VS Code extension in a real webview and exercise editor/outliner operations via Playwright. Unit tests are desired but not yet introduced.

## Flagged Ambiguities

(none)
