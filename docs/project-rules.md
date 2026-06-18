# Project Rules

Conventions, preferences, and domain knowledge.

## Tech Stack

- **Extension Host**: TypeScript on the VS Code Extension API. Lives under `src/`.
- **Webviews**: Plain JavaScript (no framework, no bundler) on a `contenteditable` DOM. Lives under `src/webview/`. The Markdown Editor (`editor.js`, ~17,000 lines) and Outliner (`outliner.js` + `outliner-model.js`, ~8,000 lines) are the two primary webviews.
- **Shared sub-package**: `html-md-converter/` builds turndown + turndown-plugin-gfm with custom rules into `dist/`, consumed by both webviews. See ADR-003.
- **External dependencies (vendored)**: KaTeX, Mermaid (loaded inside webviews via `vendor/`).
- **Cloud (optional)**: AWS S3 and AWS Translate accessed exclusively via spawning the `aws` CLI binary; no AWS SDK is bundled. See ADR-002.
- **Drawio integration**: `fs.watch` against `.drawio.svg` / `.drawio.png` files saved by drawio Desktop.
- **Tests**: Playwright E2E (~178 spec files under `test/specs/`). `test/build-standalone.js` builds the webview as standalone HTML; `test/run-parallel-tests.sh` runs Playwright in parallel.
- **Distribution**: `vsce publish` to the VS Code Marketplace, `ovsx publish` to Open VSIX.

## Conventions

- **Three providers, four modes**: Always evaluate change impact across `AnyMarkdownEditorProvider`, `OutlinerProvider`, and `NotesEditorProvider`, and across the four modes (Outliner Single / Outliner Note / Markdown Single / Markdown Side Panel). See [odk:req:safety/mode-coverage].
- **No data loss**: S3 Sync uses `aws s3 cp` and never `sync --delete`. Files only on one side are preserved. External Change Sync writes through `workspace.applyEdit` (preserves dirty + undo). See [odk:req:safety/no-data-loss].
- **Path safety**: Wrap every path operation taking external input in `safeResolveUnderDir(root, child)`. See [odk:req:security/path-traversal-guard].
- **Mutually exclusive node types**: A Node is exactly one of Page / File / Image / Plain. See [odk:req:correctness/exclusive-node-types].
- **Local-first**: All processing is on the user's machine. No backend, no telemetry, no analytics.
- **Provenance comments stripped from product docs**: Decisions live in ADRs (`docs/adr/*.md`); the design narrative does not carry `(asked YYYY-MM-DD ...)` annotations.
- **Use the canonical glossary terms**: See `docs/specs/glossary.md`. The avoid-list there is normative — do not introduce synonyms (e.g. "Page Editor", "AI sync", "note.json", "manifest", "paste converter").
- **Webview message protocol**: Host ↔ webview communication is `postMessage` only. Direct DOM access from the host is forbidden.
- **Node ID format**: `n` + `Date.now().toString(36)` + 6-char random suffix. Page ID format: UUID v4 from `crypto.randomUUID()`. Folder ID format: `f` + base36 timestamp + 4-char random.
- **`outline.note` writes are preceded by `syncStructureWithDisk`** to ensure the on-disk `.out` inventory matches the in-memory tree.
- **Theme-independent overlay backdrop**: full-viewport overlays (image preview, block fullscreen) use `rgba(0, 0, 0, 0.7)` rather than `var(--bg-color)`. This keeps the close button (white border / icon) legible under any VS Code theme. See ADR-006.
- **ESC capture-phase pattern for nested overlays**: when an overlay is opened from inside another ESC-closable surface (e.g. block fullscreen inside a Markdown Side Panel), the inner overlay registers its ESC handler with `addEventListener('keydown', handler, true)` (capture phase) and the handler calls both `stopPropagation()` and `stopImmediatePropagation()` before cleanup so the outer surface does not also close. See ADR-006.
- **`EditorInstance.destroy()` must remove every DOM node it appended to `document.body`** — toolbars and overlays attached at body level (to escape `overflow: hidden` containers) are tracked on the instance (e.g. `this._tableToolbarEl`) and removed in `destroy()`. Otherwise the side-panel close leaves orphan UI on screen.
- **ODK Git hooks are neutralized in this project.** `.odk/hooks/pre-commit`, `.odk/hooks/commit-msg`, and `.odk/hooks/pre-push` are `exit 0` stubs because the bundled verification plugins target Python / Next.js / Terraform / Conventional Commits / PR-body templates that Fractal does not use. See ADR-007.

## Product Context

Fractal is a brownfield, GA product (v0.207.59) — a VS Code extension that combines a Dynalist-like outliner with a Typora-like WYSIWYG Markdown editor. Published on the VS Code Marketplace and Open VSIX.

The product's core value is integrating two modes of thinking — structured (tree) and long-form (page) — in a single tool, while staying local-file-based and cooperative with the user's IDE-native AI features.

Three providers cover four modes:

- **Markdown Single mode** — open a `.md` / `.markdown` file from anywhere; the WYSIWYG editor takes over via [odk:component:host/any-markdown-editor-provider].
- **Outliner Single mode** — open a `.out` file from anywhere; the Outliner takes over via [odk:component:host/outliner-provider].
- **Outliner Note mode** — Activity Bar "Notes Folders" → folder selection opens a single `WebviewPanel` that embeds the Notes file panel, the Outliner, and the Markdown editor. Owned by [odk:component:host/notes-editor-provider].
- **Markdown Side Panel mode** — inside Outliner Single or Outliner Note, opening a Page node attaches a side panel running the Markdown editor.

Cloud features are opt-in:

- **S3 Sync** — backup and multi-device sync per Note folder or per Outliner; mtime newer-wins, no delete.
- **AWS Translate** — translate Markdown while preserving code, math, and HTML segments.

Cooperation with IDE AI is via two paths:

- **External Change Sync** — Fractal watches the host file; when the IDE-native AI edits the `.md` / `.out` externally, Fractal computes a block-level DOM diff and patches the webview without losing user state.
- **`Cmd+L` bridge** — opens the underlying `.md` in the native VS Code text editor with the line selection so the user can hand it to Cursor / Copilot directly.

The Chrome Extension and `claude-skills` are separate products in this repository (`chrome-extension/`, `claude_skills/`). The `electron/` directory is inactive. Only `src/` and `html-md-converter/` are part of the Fractal extension itself.
