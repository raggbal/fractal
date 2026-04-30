# Changelog

All notable changes to the "Fractal" extension extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.195.757] - 2026-04-30

Sprint `20260430-151055-md-table-sidepanel-batch` (v16) — md / table / sidepanel batch fixes & enhancements.

### Added
- **`fractal.imageMaxWidth` setting (default 600px, min 100px)** — Caps image and drawio.svg width in the editor (MD-52). Previously images filled the full editor width via inline `max-width:100%`. The new CSS rule applies in standalone editor / side panel / outliner page side panel; toolbar/lucide/command-palette icons are excluded. Double-click for fullscreen view is preserved.
- **cmd+/ Add Page link-name input modal** — Selecting "Add Page" from the command palette now opens a custom overlay modal (default `untitled`) instead of inserting a fixed `untitled` link (MD-49). On OK, the new page MD is created and `<a>{linkName}</a>` is inserted at the cursor; if `linkName ≠ "untitled"`, the new MD's H1 is synced via `host.updatePageH1`. Cancel / Escape removes the marker without creating anything. `useSimpleAddPage = true` is now universal (replaces the older auto/at-path two-step action panel for standalone `.md`).
- **Right-click "Rename Link" context menu** — Available on any `<a href>` (md link / file link / URL link) (MD-50). Custom modal preloads the current text; OK updates `textContent` only (href unchanged). i18n: 7 languages (en/ja/es/fr/ko/zh-cn/zh-tw) via `contextRenameLink` / `promptRenameLink`. Context menu separator color is now theme-aware (`menuBorder` + opacity 0.5) — no more hard black line in light themes.
- **Side panel navigation history (back / forward)** — Navigate through MD links inside the side panel using **Opt+Left / Opt+Right** or the new ←/→ buttons in the side panel header (left of filename, right of "Open Outline") (SP-01). The buttons are translucent (opacity 0.5) when no history, opaque when navigable. Back/forward stacks are managed by `SidePanelManager.openFile(path, freshOpen)`; opening from outliner click clears history (fresh) while in-side-panel link clicks push to back stack.
- **Side panel outline is always shown** — Even when the MD has zero headings, the outline sidebar stays visible with an "見出しがありません" / "No headings" placeholder (SP-02). Previously the sidebar would auto-close on empty TOC. i18n via `outlineEmpty` (7 languages).
- **Side panel cmd+/ Add Page (simple flow)** — Pressing cmd+/ → Add Page inside a side panel MD now uses the marker-pin + auto-named filename + immediate link insertion flow (SP-03). pageDir resolves to outliner pageDir (when side panel is showing an outliner page) or `<sidePanelDir>/pages` otherwise. New MD is auto-named `<timestamp>.md` with initial content `# ` (relies on MD-51 for the empty-heading visibility).
- **Empty heading is visible** — Headings rendered from `# ` (trailing space only, no text) now produce `<h1><br></h1>` instead of an empty `<h1></h1>` (MD-51). This makes new pages from cmd+/ Add Page show their h1 immediately (so the user can type the title).
- **Markdown table column resize** — Drag the right edge of **any cell** (not just the header row) to resize the entire column (TBL-01). Visual feedback: hover/drag highlights the whole column with a continuous blue bar (no row gaps). Mouse tracking uses absolute positioning (`e.clientX − cell.left`) for ±3px accuracy. Width is clamped to ≥80px. New rows from Enter / Add Row work automatically (no DOM mutation observer needed — pure mouse-position detection).
- **Markdown table column width persistence** — Column widths after a resize are saved as an HTML comment `<!-- fractal-col-widths: w1,w2,w3 -->` immediately before the table in the markdown source (TBL-03). On open, the comment is parsed and applied to the next table (`<table style="table-layout:fixed; width:Wpx">` + per-cell `style="width:Npx"`). Other markdown viewers ignore the comment, so file portability is preserved.

### Changed
- **drawio Desktop external-edit auto-refresh now uses dual watchers** — `vscode.workspace.createFileSystemWatcher(RelativePattern)` + `fs.watchFile(path, {interval:1000})` polling fallback are integrated via the new `createDrawioFileWatcher` factory (MD-53). This prevents the atomic-rename saves used by drawio Desktop from being missed by the FileSystemWatcher (previously could cause 2nd/3rd of multiple drawio.svg in the same MD to fail to refresh). The factory is shared by `editorProvider.ts` (standalone) and `notesEditorProvider.ts` (Notes mode); the webview-side matcher prefers absolute path full match with basename fallback, and force-reloads via `removeAttribute → setAttribute` when the same mtime arrives twice.
- **Side panel cmd+/ → Insert Drawio routing fix** — `SidePanelHostBridge.requestCreateDrawio()` now calls `_onImageRequest()` so `sidePanelImagePending=true` is set; the resulting `insertImageHtml` response is correctly dispatched to the side panel editor (MD-54). Previously the response landed in the main editor, causing the drawio.svg to appear in the wrong place (or nowhere).
- **cmd+/ Add Page / drawio insertion is robust to selection-outside-editor** — The marker placement in `case 'addPage'` and `case 'drawio'` of `dispatchToolbarAction` now verifies `editor.contains(selection.startContainer)` before insertion; if outside, a new `<p>` is appended to the editor end with the marker (MD-54). `handlePageCreatedAtPath` / `insertImageHtml` / `insertFileLink` / `insertLinkHtml` fallback paths use the same defense: `editor.appendChild` if selection is outside the editor.
- **Markdown table cell resize handle is no longer a DOM element** — The previous approach embedded `<div class="table-col-resize-handle" contenteditable="false">` inside each cell, which trapped the contenteditable cursor and caused ArrowRight at end-of-text to land at the cell's right edge (TBL-06). The new approach uses a CSS `::after` pseudo-element on `<th>` / `<td>` for the visual blue bar, and detects mouse near the right edge (≤6px) via cell `getBoundingClientRect()`. Cells contain no extra elements; cursor navigation is identical to a normal table.
- **Markdown table empty cells serialize as empty in markdown** — A new row's empty cells (`<td><br></td>`) now serialize to `|  |` (whitespace) instead of `| <br> |` (TBL-05). Mid-cell `<br>` (e.g., `text<br>text` for a line break) is preserved.
- **Markdown table de-flatten is now line-scoped** — `normalizeMultiLineTableCells` only de-flattens lines that contain `| <br> | --- |` (the Notion-flattened header→separator signature) (TBL-04). Previously it would split legitimate empty-cell rows like `| <br> | <br> |` into orphan `|` lines, breaking the table on copy-paste round-trip.
- **Markdown table rightmost-column resize no longer shrinks other columns** — `updateColumnWidth` now manages explicit `style.width` per column in an array, applying `table.style.width = sum(array)` BEFORE updating individual cells (TBL-02).

### Fixed
- **Shift+Enter in an empty markdown table cell now inserts exactly one `<br>`** — Resolved by TBL-06 (handle removal restored correct `lastChild` semantics) (TBL-07).
- **Side panel back/forward buttons actually navigate** — `closeSidePanelImmediate(isSwitch=true)` now skips `notifySidePanelClosed` during file switch, preventing the extension from clearing history immediately after `handleOpenLink` pushed to the back stack (SP-01). Side effect: `Object.defineProperty(window, 'activeTableCell', ...)` is now `configurable: true` so panel re-init no longer throws `TypeError: Cannot redefine property`.

### Tests
- **+67 sprint test cases** across 11 new spec files in `test/specs/`:
  - `integration-image-max-width.spec.ts` (3), `integration-multi-drawio-refresh.spec.ts` (4), `integration-sidepanel-drawio-insert-routing.spec.ts` (2)
  - `integration-empty-heading-rename-link.spec.ts` (9), `integration-sidepanel-outline-always.spec.ts` (3), `integration-sidepanel-nav-flow.spec.ts` (5)
  - `integration-sidepanel-addpage-robustness.spec.ts` (5), `integration-standalone-addpage-simple.spec.ts` (5), `integration-md-cmd-x-paste-semantics.spec.ts` (11)
  - `integration-table-resize.spec.ts` (13), `integration-table-copy-paste-empty-cells.spec.ts` (7)
- All 67 pass under Playwright `testMatch: ['specs/**/*.spec.ts', 'unit/**/*.spec.ts']` (auto-included, no config change needed).
- 5 minor cleanups deferred (test files referencing the now-removed `.table-col-resize-handle` DOM): `test/specs/table-cell-operations.spec.ts:332,349,464` (test_remove), `md-paste-asset-copy.spec.ts:32` (test_update), `outliner-cross-paste.spec.ts:297` (test_update). Non-blocking; covered by new sprint specs.
- 64 pre-existing failures in unrelated specs (translate-e2e, backspace-list, outliner-format, etc.) are NOT sprint-caused; deferred to a separate sprint.

## [0.195.722] - 2026-04-26

### Added
- **New setting `fractal.showTranslateButtons` (boolean, default `false`)** — Controls visibility of translate / translateLang buttons in both the standalone editor toolbar and side panel header. Translation can still be triggered via the `fractal.translate` command (Cmd+/) regardless of this setting (UI visibility only).
- **Standalone editor toolbar gains a translate group** — When `fractal.showTranslateButtons` is on, the standalone MD editor toolbar shows translateLang + translate buttons at the leftmost position (inside `toolbar-inner`, before the inline group). The side panel header continues to host these buttons as before.

### Changed
- **Default OFF for translate buttons (behavior change)** — Existing users who had translate buttons visible in the side panel header will see them disappear by default. Set `fractal.showTranslateButtons: true` in settings to restore them. The translation feature itself is unchanged; only the UI affordance is gated.
- **Standalone toolbar translate result no longer uses the side panel** — When the translate button is invoked from the **standalone** editor toolbar, the translation result now replaces the editor view in place (with a sticky `← Back / Translation (src → tgt) / Copy` header bar) rather than opening in a side-panel slide-over. The side-panel-based flow remains for outliner page contexts (unchanged via `outliner.js showTranslationInSidePanel`). The side-panel link-open behavior for plain MD links is also unchanged.

### Fixed
- **No disk overwrite while viewing a translation** — While the inline translation view is active, the editor's `blur` / `sourceEditor.blur` / `_handleVisibilityChange` flush paths and `applyQueuedExternalChange` are gated by a `translationViewActive` flag. Pre-edit content is force-flushed to disk before swapping in the translation, so switching apps mid-translation no longer risks overwriting the file with the translated content. NT-14 cross-editor sync is preserved via post-Back `applyQueuedExternalChange()` catch-up.
- **Translation header label color** — The `Translation (en → ja)` label uses `--text-color` (matches body text) instead of `--blockquote-color` (which appeared inverted/white in some themes).

## [0.195.718] - 2026-04-25

### Added
- **Outliner: "Copy File Path" context menu for file-attachment nodes** — Right-click a file-attached node (`node.filePath`) → "Copy File Path" copies the absolute path of the attached file to the OS clipboard. Available in 7 languages (en/ja/zh-cn/zh-tw/ko/es/fr) via the new `outlinerCopyFilePath` i18n key. md page nodes continue to use the existing "Copy Page Path" menu (functionally equivalent, no duplicate entry added). Plain (no-attachment) nodes do not show this menu. Implemented as a new host message `copyAttachedFilePath` registered per the 5-place messaging rule (outliner-host-bridge.js / notes-host-bridge.js / outlinerProvider.ts / notes-message-handler.ts).
- **Outliner: Cmd+Enter on file-attachment nodes opens externally** — Pressing Cmd+Enter (Mac) / Ctrl+Enter (Win/Linux) on a file-attachment node now opens the file in the OS default app (reusing the existing `host.openAttachedFile`). md page nodes (`isPage`) keep their existing behavior (open page in side panel). Plain nodes keep their existing behavior (preventDefault only, no new action). Relies on `isPage` and `filePath` being mutually exclusive per data-model §4.2.
- **Editor blur observability (diagnostic)** — When `editor.blur` / `sourceEditor.blur` / `_handleVisibilityChange` fires while `hasUserEdited && queuedExternalContent !== null`, the editor logs `console.warn '[Fractal:blur-with-queue]', { instance, domLen, queueLen, delta }` for diagnosis. Helps identify the cross-edit race that previously caused view rollback. UI banner intermediate (v0.195.717) was removed in favor of console-only output.

### Fixed
- **View rollback hotfix (Fix A)** — When a user typing in `editor` / `sourceEditor` / on visibility hidden, if a stale cross-edit `update` was queued in `queuedExternalContent`, the previous behavior would call `applyQueuedExternalChange()` after flush, causing the DOM to roll back to stale content. The user, seeing the rolled-back view, would re-edit and overwrite the disk with the rolled-back state — silent data loss. The fix: when `hasUserEdited` triggers flush, drop the queue (`queuedExternalContent = null`) and skip `applyQueuedExternalChange()`. The user's typing becomes the truth; the cross-edit content is delivered again via the normal cross-edit round-trip on the next event. NT-14 cross-editor sync is preserved (the host-side `editorProvider.onDidChangeTextDocument` and `sidePanelManager.onDidChangeTextDocument` listeners are unchanged — only the in-webview blur handler in `editor.js` is modified).

### Known issues
- Edge cases not covered by the Fix A guard (out of scope for v0.195.718, planned for a follow-up sprint):
  - **IME composition mid-state + app switch**: switching to another app while an IME composition is active can still produce a view inconsistency through a different code path.
  - **Sub-debounce typing burst + app switch**: typing very rapidly and switching apps within the 1000ms debounce window (before `host.syncContent` has fired) can lose the unsynced characters.
- Workaround for both: pause briefly (~1 second) before switching apps, or press Cmd+S explicitly. The `[Fractal:blur-with-queue]` console log is unaffected by these edge cases (it fires regardless of whether the data was lost).

## [0.195.714] - 2026-04-19

### Changed
- Internal refactor of v12 drop-import: extract `saveImageBuffer` / `saveImageFromDataUrl` helpers (dedupe the image-save path across Finder and Explorer routes) and add `createDropImportHandler` factory (collapses four near-identical switch-case bodies in `outlinerProvider.ts` and `notesEditorProvider.ts` into one-liners). No behavior change — all 73 drop-import / file-import tests pass. The previous structure was what allowed the Notes-mode Explorer handler to be forgotten in 0.195.713; under the factory, adding a new drop path or platform no longer requires copy-pasting the dir resolution + failure handling boilerplate.

## [0.195.713] - 2026-04-19

### Added
- Outliner: drag & drop file import now works from **VSCode Explorer** too (previously only Finder / native file managers). VSCode Explorer drags carry `application/vnd.code.uri-list` type (not `Files`), and dataTransfer.files is empty — the outliner now detects both and routes them through separate code paths. Explorer drops go through the existing `importFiles` / `importMdFiles` functions directly (same path as ⋮ menu imports), so: (1) no 50MB size limit (file bytes are not shipped through the webview), (2) relative image references inside dropped `.md` files are resolved and copied correctly (since the source directory is available from the absolute file path). Non-local schemes like `vscode-remote://` are rejected with a warning. Finder drops continue to use the FileReader+bytes path unchanged.

## [0.195.712] - 2026-04-19

### Added
- Outliner: drag & drop file import — drop files from Finder / Explorer directly onto the outliner tree to create nodes, alongside the existing ⋮ menu import. Works in both standalone `.out` files and Notes mode. The drop target uses the same 25/50/25 rule as existing node reorder (top 25% = insert before, middle 50% = insert as child, bottom 25% = insert after; empty area = append to root). File type is routed by extension: `.md` → page node with H1 extracted as title (relative image references in dropped markdown are skipped — the source directory is not available from the browser File API); image (png/jpg/jpeg/gif/webp/svg/bmp) → new node with the image attached inline (same thumbnail + `images[]` persistence as Cmd+V paste); any other type → file-attachment node with `filePath` set. A single drop operation = a single undo step even when 3 files of 3 kinds are dropped together. Dropping a folder is rejected with a notification. Files over 50MB are rejected before transfer. The drop zone is the tree area only — dropping on the side panel, toolbar, header, tag bar, or resize handle does not trigger import. Visual feedback: a dashed outline appears around the tree while dragging, and the existing drop indicator line shows the precise insertion position. Existing node reorder drag-and-drop (OL-12) and the existing Import .md files / Import any files menu items continue to work unchanged — both menu and D&D paths share the same `importFilesCore` / `importMdFilesCore` internals. Path traversal is blocked at the boundary (`../`, absolute paths, and embedded `..` are rejected).

## [0.195.711] - 2026-04-18

### Added
- Notes panel: assign one of 20 fixed colors (Tailwind 500 palette: red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose, slate, gray, zinc) to any folder or `.out` file icon in the Notes tab. Right-click → "Set Color" → pick a swatch (or "None" to clear). The color is persisted in `outline.note` as the `color` field and applied to the icon SVG `stroke` only — text and background are unchanged. Backward compatible: existing `outline.note` files without the `color` field continue to work. The webview→host boundary validates that the color name is in the fixed palette before persisting (rejects arbitrary strings).

### Changed
- Notes panel: `.file-panel-folder-children` `padding-left` increased from 12px to 28px so that child file/folder icons render to the right of the parent folder icon. Two-level nesting accumulates the indent correctly. Root-level item position is unchanged.

### Fixed
- Side panel markdown: pressing ESC while an image is shown in the fullscreen lightbox (open by double-clicking the image) now closes only the lightbox; the side panel itself stays open. Both `outliner.js` and `editor.js` ESC handlers now skip `closeSidePanel` when `.outliner-image-overlay` is present in the DOM, mirroring the existing skip pattern for action panel / command palette. Previously, ESC closed both the lightbox and the side panel, forcing the user to reopen the panel.

## [0.195.710] - 2026-04-15

### Added
- Outliner: full text search & replace (Cmd+F) mirroring the MD editor. Floating top-right box with search / replace inputs, N/M match counter, prev/next navigation, toggle-replace, and case-sensitive / whole-word / regex options. Searches both `text` and `subtext` across the current scope (or the whole document when no scope is active); inline formatting is preserved on replace (`**foo**` → search `foo` → replace with `bar` yields `**bar**`). Jumping to a match that lives inside a collapsed ancestor now auto-expands the ancestor chain. Replace All is a single undo step.
- Outliner: Cmd+H opens the search/replace box with the replace row already expanded (same shortcut as the MD editor).

### Changed
- Outliner: Cmd+Shift+F now focuses the existing header filter search (previously Cmd+F). Cmd+F is repurposed for the new text search & replace box.

## [0.195.708] - 2026-04-14

### Fixed
- Side panel TOC / outline: headings h3-h6 are no longer dropped. Previously the regex captured only `#{1,2}`, so `# Title` followed directly by `### Subsection` rendered just the h1. The regex is now `#{1,6}`, and non-hierarchical structures (h1→h3, h2→h5, etc.) also list every heading. The standalone editor was unaffected (it queries the DOM).

## [0.195.707] - 2026-04-14

### Fixed
- Settings: `fractal.translateSourceLang` / `fractal.translateTargetLang` are now read from VS Code settings and pushed to all webviews (MD editor, outliner, notes). Previously declared in the schema but never wired, so user-level defaults had no effect.
- Settings: code-side fallback defaults (`theme`, `fontSize`, `toolbarMode`) re-aligned with `package.json` schema (`things` / `14` / `simple`). Behavior unchanged for end-users (VS Code uses the schema default); this removes internal drift between the schema and providers.
- Types: `EditorSettings.theme` union now includes `things`, matching the schema enum.

## [0.195.706] - 2026-04-14

### Fixed
- Outliner: pasting a multi-line markdown list copied from the MD editor no longer keeps the literal `- ` / `* ` / `+ ` / `1.` bullet markers at the start of each node. Markers are stripped for external pastes only; internal outliner-to-outliner copy keeps node text unchanged.

## [0.195.705] - 2026-04-14

### Fixed
- Side panel: closing the translation-result panel (Esc, outside click, ×) then reopening now correctly restores the default header action buttons (previously the `← Back` button remained)

### Changed
- Side panel header: Expand button moved to the leftmost position of the action button group (next to Undo) so it stays visible when the panel is narrow

## [0.195.702] - 2026-04-14

### Added
- Translation (v10): AWS Translate integration via AWS CLI. Toolbar button in standalone MD + side panel header button in outliner. Translation result displayed in readonly side panel with ← Back button to restore original, loading overlay during translation. Supports 14 languages via QuickPick selection.
- Settings: `fractal.translateSourceLang` (default `en`), `fractal.translateTargetLang` (default `ja`), `fractal.transAccessKeyId`, `fractal.transSecretAccessKey`, `fractal.transRegion`

### Fixed
- Translation: language selection changes now correctly apply in side panel (previously hardcoded `ja`/`en`)
- Translation: post-process AWS output to restore MD syntax mangled by translation (missing space after `-`, `#`, `1.`, and extra space between `]`/`(`)
- Wikipedia citation paste: `[40]` now pastes as `[` + link(40) + `]` instead of `[[40]](url)` with outer brackets inside link text. `parseMarkdownLinks` detects `[[text](url)]` wrapper pattern; `turndown normalizeLink` moves bracket-wrapped link text outside the link

### Changed
- Translation language button shows only target language (e.g. `ja`) to keep header single-line; source→target shown in tooltip

## [0.195.684] - 2026-04-13

### Fixed
- MD editor: pasteWithAssetCopyResult now uses shared `_insertPastedMarkdown` function (same paste path as normal paste, including list merge and table handling)
- Kiro: Fixed double image insertion when pasting screenshots (keydown + paste event both triggered)

### Added
- Retro patterns: refactoring-timing, editor-paste-scope, webview-event-limits, hotfix-chain-rule

## [0.195.679] - 2026-04-13

### Changed
- Refactored paste-asset-handler: 6 copy/move function pairs unified into 3 functions (handlePageAssets, handleImageAssets, handleFileAsset)
- Unified message protocol: copyPageFileCross/movePageFileCross → handlePageAssetsCross, copyFileAsset/moveFileAssetCross → handleFileAssetCross (with isCut flag)
- Copy and cut operations now both copy files without deletion (cleanup manages orphans)
- Page node copy/paste now also duplicates file links ([📎] references) within .md content
- Legacy wrapper functions retained for backward compatibility

## [0.195.674] - 2026-04-13

### Added
- MD Editor: Copy/paste asset duplication — copying image/file links across different outliners/notes now duplicates physical files to destination directory
- MD Editor: Clipboard context (`text/x-any-md-context`) carries source imageDir/fileDir/mdDir for cross-outliner paste detection
- MD Editor: `sidePanelAssetContext` message provides absolute paths to side panel editors
- MD Editor: `pasteWithAssetCopy` / `pasteWithAssetCopyResult` message flow for host-side file copy + path rewrite

## [0.195.673] - 2026-04-13

### Added
- MD Editor: Image double-click opens fullscreen lightbox overlay (same as outliner)

### Changed
- MD Editor: Code block buttons (expand, language, copy) repositioned to top-right with compact styling, no text overlap

## [0.195.664] - 2026-04-13

### Added
- Outliner: File attachment — "Import any files..." menu imports files of any type as 📎 file nodes
- Outliner: File node display — 📎 icon, editable text, child nodes, Open File / Remove File context menu
- Outliner: `filePath` field in .out schema — backward compatible, mutually exclusive with `isPage`
- Outliner: `fractal.outlinerFileDir` setting — configurable file directory (default `./files`)
- Outliner: Copy/paste file nodes duplicates physical files (same pattern as page/image assets)
- Outliner: "Set file directory..." menu item for standalone outliner
- MD Editor: File drag & drop — non-image files copied to file directory, inserted as `[📎 filename](path)` link
- MD Editor: File link click opens with OS default application (via `vscode.env.openExternal`)
- MD Editor: `fractal.fileDefaultDir` and `fractal.forceRelativeFilePath` settings
- MD Editor: Side panel MD supports file D&D (standalone outliner + notes mode)
- MD Editor: Side panel word count display added
- Cleanup: Extended alive set to track `node.filePath` references and `[📎](path)` MD links
- Cleanup: Orphan file detection in files/ directories with `$(file)` icon in QuickPick

### Changed
- Non-MD local file links now open with OS default app (`vscode.env.openExternal`) instead of VS Code text editor
- Sidebar image/file directory display simplified to single line (removed source label and settings button)

### Removed
- Per-file MD footer directives: IMAGE_DIR, FORCE_RELATIVE_PATH, FILE_DIR, FORCE_RELATIVE_FILE_PATH
- Per-file settings button (⚙ gear icon) from sidebar for both image and file directory

## [0.195.646] - 2026-04-12

### Added
- Notes: "Clean Unused Files" command — scans all registered notes for orphan .md and images, shows QuickPick with select-all/deselect-all, moves to trash
- Notes: "Clean Unused Files (Current Note)" command — same but limited to the currently open note
- Notes: Tools tab replaces S3 tab — contains S3 Sync section and Clean Notes section with both cleanup buttons
- Notes: Startup migration (schemaVersion) — automatically deduplicates shared images on .out open (one-time, idempotent)
- Notes: `path-safety.ts` — path traversal protection for all file operations
- Notes: `cleanup-core.ts` — VSCode-independent cleanup logic for unit testing

### Fixed
- Notes: Remove Page (undo bug) — .md file is no longer physically deleted on "Remove Page", preserving Undo/Redo integrity. Orphan .md is cleaned up via cleanup command instead
- Notes: `notes-file-manager.deleteFile()` now uses `vscode.workspace.fs.delete({ useTrash: true })` instead of `fs.unlinkSync` / `fs.rmSync` — deleted files go to OS trash and can be restored
- Notes: Cleanup correctly resolves `node.images[]` paths relative to outDir (was incorrectly using pageDir, causing alive images to be detected as orphan)

### Changed
- Notes: S3 tab renamed to "Tools" (en) / "ツール" (ja), now contains both S3 sync and cleanup features
- Internal: New `notesCleanupCommand.ts` for 2-pass cleanup (orphan .md → orphan images via transitive closure)
- Internal: `NotesFolderProvider.getFolders()` used for all-notes cleanup mode

## [0.195.641] - 2026-04-11

### Added
- Editor: Link insertion (Cmd+/ → link) now works in Notes and Outliner side panel editors (previously only worked in standalone .md editor)

### Fixed
- Outliner: Cross-outliner page node copy/paste now works within the same note folder (was broken since 0.195.623)
- Outliner: Copy now creates independent image copies with new filenames (was sharing references)
- Outliner: Cut/paste across notes now correctly moves .md and image files
- Outliner: File identity detection uses absolute path instead of fragile relative pageDir string

### Changed
- Internal: New paste-asset-handler.ts for unified copy/move with image rename + .md body rewrite
- Internal: Identity-based outFileKey propagated through Outliner.init and updateData

## [0.195.637] - 2026-04-11

### Fixed
- Editor/Outliner: Image paths and URLs containing parentheses `()` now display correctly (e.g., `photo_(v2).png`, Wikipedia URLs)
- Outliner: Pasting a URL with `()` (e.g., `https://en.wikipedia.org/wiki/Foo_(bar)`) now creates a single complete link instead of breaking at the first `)`
- Import md files: Images with `()` in filename are now correctly imported

### Changed
- Internal: New balanced-paren Markdown link parser (`markdown-link-parser.js`) replaces all regex-based `([^)]+)` patterns across editor, outliner, import, and paste

## [0.195.634] - 2026-04-10

### Fixed
- Outliner: Cross-outliner page node copy/paste now works for all scenarios (same outliner, different outliner in same note, and different note)
- Outliner: Cross-outliner page node cut/paste now correctly moves .md and image files between folders
- Outliner: Images attached to page nodes are now physically copied with new filenames on paste (previously shared references)
- Outliner: .md body image references are rewritten to the new filenames on copy so the duplicated page is fully independent
- Outliner: File identity is now compared by absolute path, fixing a subtle mis-classification where two notes sharing the default `./pages` directory were treated as the same file

### Changed
- Internal: Consolidated `copyPageFile` / `copyPageFileCross` into a single host API
- Internal: Extracted shared paste asset helpers (`paste-asset-handler.ts`) and markdown image utility (`markdown-image-utils.ts`)

## [0.195.621] - 2026-04-08

### Fixed
- Outliner: Multi-select Tab now preserves relative hierarchy instead of cascading siblings into deeper nesting (symmetric fix to the Shift+Tab fix from 0.195.607)
- Outliner: Enter on a node with expanded children now inserts a sibling immediately below, transferring the children to the new node (was inserting as a child or below the child subtree)
- Outliner: Enter at the start of a non-empty node now inserts an empty sibling above, keeping the current node's text and children intact

## [0.195.619] - 2026-04-08

### Fixed
- Notes Search: Markdown jump now works for ALL result types — outline node jump, side-panel open, and in-page keyword scroll all work end-to-end
- Notes Search: Fixed false "未リンクページ" results that were unjumpable; results now only include pages owned by the outline's nodes
- Notes Search: Closing the side panel no longer resets the outliner cursor to the top node
- Notes Search: Keyword jump now works inside markdown links `[text](url)` (URL part is ignored)
- Notes Search: Image syntax `![alt](url)` is excluded from search to keep occurrence indices consistent
- Notes Search: Multi-hit markdown files now correctly jump to the Nth occurrence (not always the first)

### Changed
- Notes Search: Markdown jump uses keyword-based DOM TreeWalker scrolling instead of raw line numbers (works for tables, lists, and inline-formatted lines)
- Notes Search: Markdown result headers fall back to `node.text → first heading → pageId prefix` when node text is empty

## [0.195.612] - 2026-04-07

### Fixed
- Notes Search: Clicking a result now correctly scrolls the target node to the center, even for image-heavy nodes

### Changed
- Notes Search: Results are now grouped into "Outliner results" and "Markdown results" sections with themed colors
- Notes Search: Markdown results now show the parent node name (e.g. `OutlineTitle / NodeName`) instead of the page id

## [0.195.607] - 2026-04-05

### Added
- Outliner: Cross-outliner copy/paste now preserves pages(.md) and images across different outliners

### Fixed
- Outliner: Backspace on empty node with children no longer deletes children — they are promoted to parent level
- Outliner: Multi-select Shift+Tab now preserves relative hierarchy instead of flattening all nodes
- Outliner: Multi-select Tab/Shift+Tab skips operation if topmost node cannot be indented/outdented
- Outliner: Single node copy (Cmd+C without selection) now preserves page/image metadata

## [0.195.603] - 2026-04-03

### Added
- In-App Link: Copy link to specific Outliner node (right-click menu in Notes mode)
- In-App Link: Copy link to specific page/md (sidepanel header button in Notes mode)
- In-App Link: Click fractal:// links to navigate across notes, outliners, and pages
- Markdown Editor: Right-click context menu with Cut, Copy, Paste (all editors)

## [0.195.581] - 2026-04-02

### Added

- **Outliner: ページパスコピー機能** — ページノードの右クリックメニューに「Copy Page Path」を追加。`Cmd+Shift+C` ショートカットにも対応。複数ノード選択時は全ページノードのパスを改行区切りでコピー

## [0.195.580] - 2026-04-02

### Changed

- **フォントサイズのデフォルトを 16px → 14px に変更** — `fractal.fontSize` の初期値を変更。既存ユーザーは設定で任意のサイズに変更可能
- **コンテンツ領域のサイズをフォントサイズに連動** — Outliner/Notes のノード高さ・行高さ・インデント、Markdown のコードブロック・ソースエディタが `fractal.fontSize` の変更に自動追従するよう em 相対指定に移行

### Fixed

- **Outliner/Notes: フォントサイズ設定が反映されないバグを修正** — `fractal.fontSize` を変更しても Outliner/Notes エディタのフォントサイズが 16px 固定のままだった問題を修正
- **テストビルドスクリプト: CSS変数の値が不正になるバグを修正**

## [0.195.579] - 2026-04-02

### Added

- **Outliner: .mdファイル取り込み** — ⋮メニューの「Import .md files...」からMarkdownファイルを選択し、ページノードとして一括取り込み。H1テキストでノード名自動決定、画像のコピー＆パス書き換え、複数ファイル同時対応。Standalone/Notes両対応

### Fixed

- **Markdown: ペースト時の不要なエスケープ文字を除去** — リッチテキストソースからペースト時、`## 1\. サービス概要` のように不要なバックスラッシュが挿入される問題を修正

## [0.195.576] - 2026-04-02

### Added

- **Outliner: リンククリック対応** — `[text](url)` 形式のMarkdownリンクをクリックで外部ブラウザで開けるように
- **Outliner: URLペースト自動変換** — URLをペーストすると自動的に `[URL](URL)` 形式に変換（単一行・複数行対応）
- **Outliner: 複数ノード選択インデント** — 複数ノード選択状態でTab/Shift+Tabにより一括インデント/デインデント

### Fixed

- **Outliner: ペースト時の空行ノード作成を抑制** — テキストペースト時に空行が不要なノードとして作成される問題を修正
- **Outliner: 複数選択Tab後の連続操作** — Tab/Shift+Tab実行後もフォーカスと選択状態を維持し、連続操作を可能に

## [0.195.575] - 2026-04-02

### Added

- **Outliner: .mdファイルのD&D取り込み** — Finder/Explorer/VSCode ExplorerからMarkdownファイルをOutlinerツリーにドラッグ&ドロップして、ページノードとして一括取り込み。H1テキストでノード名を自動決定、画像のコピー＆パス書き換え、複数ファイル同時対応。Standalone/Notes両対応

## [0.195.574] - 2026-04-02

### Fixed

- **Markdown: ペースト時の不要なエスケープ文字を除去** — リッチテキストソース（Notion、ブラウザ等）からペーストした際、`## 1\. サービス概要` のように不要なバックスラッシュが挿入される問題を修正

## [0.195.573] - 2026-04-02

### Added

- **Markdown: セル内改行テーブルのペースト対応** — セル内に生の改行を含むMarkdownテーブルをペーストした際、自動的に改行をに変換してテーブルとして正しく表示。Notion等の平坦化テーブル（`|  |` 行区切り）にも対応

## [0.195.570] - 2026-04-01

### Fixed

- **Outliner: 画像付きノードのコピー/カット** — 画像付きノードを単一行でコピー/カットして貼り付けると画像が消失する問題を修正

## [0.195.569] - 2026-04-01

### Added

- **Outliner: ノード画像機能** — Cmd+Vでノードに画像を貼り付け、サムネイルとして表示。ドラッグ&ドロップで並べ替え、ダブルクリックで拡大表示。Delete/Backspaceで削除
- **Outliner: 画像保存先設定** — `fractal.outlinerImageDefaultDir` 設定追加。.outファイルごとの個別設定も可能。Notes modeではMDページ画像と同じフォルダに自動保存
- **Outliner: コピー/カット時の画像保持** — Cmd+C/Xでノードをコピー/カットした際、画像パスも内部クリップボードで保持

### Fixed

- **Outliner: 画像ペースト時のファイル名重複** — 2枚目以降の画像が1枚目に見える問題を修正

## [0.195.566] - 2026-04-01

### Fixed

- **Outliner: Undo/Redo根本修正** — ファイル切替後にundo/redoが効かない、テキスト入力でundoスナップショットが作られない、初期状態でundoボタンがactiveになる等の複数バグを修正
- **Notes: Sidepanel Markdown編集中のUndo分離** — sidepanel markdown編集中にCmd+Zを押してもoutliner側のundoが発火しないよう修正

### Added

- **Outliner: Scope検索インジケーター** — scope in中に検索ボックスのplaceholderが「Search in scope」に変わり、スコープ内検索であることを明示
- **Outliner: コピー時HTML形式対応** — 複数ノード選択してCmd+Cした内容をsidepanel markdownにCmd+Vすると、階層構造を保ったMarkdownリストとして貼り付け可能

## [0.195.563] - 2026-03-31

### Fixed

- **Side Panel: toolbarMode setting ignored in Outliner/Notes** — `fractal.toolbarMode: "simple"` setting was not applied when opening the side panel markdown editor from Outliner or Notes. The toolbar always showed in full mode.

## [0.195.555] - 2026-03-31

### Fixed

- **Outliner: Shift+↑/↓初回選択修正** — 初回押下で2行選択されていた問題を修正し、自行のみ選択するように変更
- **Outliner: ページノードのクリップボード操作** — 複数行選択のcmd+c/x→cmd+vでページ属性が消失する問題を修正。カットは移動扱い、コピーは新pageId発行+mdファイル複製
- **Outliner: メニュードロップダウン位置** — 検索バーのメニューボタンのフロートメニューがボタン直下ではなく画面右端に表示されるバグを修正

### Changed

- **Outliner: 選択色をオレンジ系に変更** — 行選択・テキスト範囲選択の色をオレンジ系に変更し、フォーカス行の水色と区別しやすく

## [0.195.554] - 2026-03-30

### Fixed

- **Outliner: ノード追加位置の保存バグ修正** — Enter/Option+Enterで追加したノードが、ファイル再読み込み時に親の末尾に移動する問題を修正
- **Outliner: 不要なフォールバックコード削除** — deserialize時の旧形式互換コードを削除しコードを整理

## [0.195.551] - 2026-03-30

### Added

- **複数パネル間同期** — 同じファイルを複数タブで開いて編集した場合、変更がリアルタイムに反映される（Markdown/Outliner/Notes全エディタ対応）
- **外部変更検知** — 外部プロセス（テキストエディタ、Claude等）からの変更をOutliner/Notesエディタに反映
- **編集中ガード** — 編集中の外部変更をキューし、1.5秒アイドル後にフォーカス保持で適用
- **Notes構造同期** — フォルダ作成/削除/名前変更/移動が複数パネル間で同期

## [0.195.541] - 2026-03-29

### Added

- **Perplexityテーマ: シンタックスハイライト** — コードブロックに13色のカラーパレットを追加

### Fixed

- **水平線(---)の入力** — `---` がリスト項目として処理される場合があったバグを修正

### Changed

- **HostBridge共通メソッド抽出** — 4つのブリッジファイルの重複コードを `sidepanel-bridge-methods.js` に一元化

## [0.195.539] - 2026-03-26

### Added

- **Copy Pathボタン** — ツールバー右端とサイドパネルヘッダーに、編集中ファイルのパスをクリップボードにコピーするボタンを追加

### Changed

- **サイドパネルHTML共通化** — 4箇所に重複していたサイドパネルHTMLを `generateSidePanelHtml()` に一元化

## [0.195.536] - 2026-03-26

### Fixed

- **Outliner/Notes: CSS変数の不整合修正** — 未定義だったCSS変数を全7テーマに追加し、ハードコード色をCSS変数化
- **Electron: i18n英語フォールバック追加** — ロケールファイル未検出時に英語にフォールバック

## [0.195.526] - 2026-03-25

### Added

- **Outliner: Undo/Redoボタン** — 検索バーにUndo/Redoボタンを追加、スタック状態に応じたdisabled制御

### Changed

- **Outliner: Scope-in時のカーソル位置改善** — スコープヘッダーのテキスト末尾にカーソルを配置
- **Notes: Daily Notes空ノード自動追加を削除** — スコープ空状態UIで代替
- **Outliner: Shift+Tabのスコープ境界制限** — スコープ対象ノードの子レベルを超えてデインデントしないよう制限

### Fixed

- **Outliner: ファイル切替時のデータ上書きバグを修正** — undo/redoスタックのクリア漏れによるデータ消失を防止
- **Outliner: フォーカスモード検索がスコープ外のノードを表示するバグを修正**
- **Outliner: テキスト全選択状態でのBackspace動作を修正** — 前行マージではなくテキスト削除に

## [0.195.517] - 2026-03-24

### Changed

- **Outliner: Scope Inアイコン変更** — ターゲット/照準アイコンに変更し、ノード展開との誤解を防止
- **Notes: ページタイトル設定対応** — `outlinerPageTitle`設定がtrueの場合、Notesモードでもタイトル表示

### Fixed

- **Outliner: 検索時に折り畳み親が展開されないバグを修正**
- **Outliner: IME変換中に検索が発動するバグを修正**

## [0.195.516] - 2026-03-24

### Added

- **Notes: Scope Inホバーアイコン** — アウトライナ各ノードのバレット左にホバー時表示されるScope Inアイコンを追加
- **Notes: Daily Notes空ノード自動追加** — Daily Notesで日付にScope in時、子ノードがなければ空ノードを自動追加

### Changed

- **Notes: 左パネルタブ整理** — Todayタブを廃止しアクションバーにTodayボタンを移動。Folder/Outlineボタンをアイコンのみに簡素化

### Fixed

- **Notes: 左パネル開閉ボタンが効かないバグを修正**
- **Notes: ファイル切替が時々効かないバグを修正**

## [0.195.515] - 2026-03-24

### Added

- **Notes: タブナビゲーション** — 左パネルをNotes/Search/Todayの3タブ構成に刷新
- **Notes: Daily Notesナビバー** — アウトライナ側にToday/前日/翌日/カレンダー日付ピッカーを表示（dailynotes.out表示時のみ）
- **Notes: MD検索結果ジャンプ** — フル検索で.mdファイルの結果クリック時、親アウトラインを表示しサイドパネルで該当行にスクロール

### Fixed

- **Notes: ファイル切替時にアウトライナの検索・スコープ状態が残るバグを修正**
- **Notes: フル検索が間欠的に0件になるバグを修正**

## [0.195.514] - 2026-03-24

### Added

- **Notes: フル検索** — 全.out/.mdファイルを横断検索。Match Case/Whole Word/Regex対応。結果クリックでノードにジャンプ＋ハイライト
- **Notes: Daily Notes** — Todayボタンで今日のノードを自動作成（年→月→日階層）。`< >`ボタンで前日/翌日ナビゲーション
- **Notes: 左パネル幅リサイズ** — D&Dでパネル幅を変更可能。幅はoutline.noteに保存され次回復元
- **Notes: サイドパネル幅リサイズ** — D&Dでサイドパネル幅を変更可能。Outlinerでは.outに永続化、Markdownではセッション内のみ
- **Notes: outline.noteリネーム** — 管理ファイルを`.note`から`outline.note`に変更（自動マイグレーション付き）

## [0.195.513] - 2026-03-24

### Added

- **Notes: フォルダ/ツリー管理** — 左パネルで仮想フォルダを作成し、アウトラインをフォルダで分類・管理可能に。D&Dでファイルやフォルダの並び替え・移動が可能

### Fixed

- **Notes: ファイル切替時にアウトラインデータが消失するバグを修正** — 入力中にファイルを切り替えると未保存データが失われる問題を修正

## [0.195.509] - 2026-03-23

### Fixed

- **Notes: Outlinesヘッダーと検索バーの高さを統一** — 左パネルヘッダーと検索バーの数pxの高さズレを修正

## [0.195.506] - 2026-03-23

### Added

- **Notes機能（VSCode Activity Bar）** — Activity Barからフォルダを登録し、複数の.outアウトラインをまとめて管理できる新機能。左パネルでファイル一覧表示・追加・削除・リネーム・切替が可能。Electron版と同等の体験をVSCode上で実現

### Improved

- **Notes: 空フォルダ追加時にdefaultアウトラインを自動作成** — 空のフォルダを追加しても即座に編集開始可能
- **Notes: Set page directoryメニューを非表示** — Notes modeではpageDirが自動管理されるため手動設定を無効化
- **Notes: パネル閉じ時のUIレイアウト修正** — トグルボタンと検索モードボタンが重ならないよう調整

## [0.195.504] - 2026-03-23

### Improved

- **Outliner: スコープアウト時のカーソル位置改善** — Cmd+Shift+]やTOPリンクでスコープ解除した際、直前にスコープしていたノードにカーソルが移動するようになりました

## [0.195.502] - 2026-03-23

### Fixed

- **Outliner: ページディレクトリ設定が編集で消失するバグを修正** — outファイル個別に設定した `pageDir` が、ノード編集のたびに消えてしまう問題を修正しました

### Added

- **Outliner: メニューボタン** — 検索バー右端にメニューボタン（⋮）を追加。ページディレクトリの設定が可能です

## [0.195.500] - 2026-03-22

### Improved

- **Outliner: ページ解除でファイルをゴミ箱に移動** — ページ解除時に対応する `.md` ファイルをOSのゴミ箱に移動するようになりました。誤操作時はゴミ箱から復元できます

## [0.195.483] - 2026-03-22

### Fixed

- **Image paste/D&D paragraph separation** — Consecutive image pastes into empty paragraphs now create separate paragraphs instead of concatenating into one line

## [0.195.475] - 2026-03-22

### Changed

- **Internal: SidePanelManager shared class** — Extracted duplicated side panel logic (file watcher, save, link handling, TOC) from both editor and outliner providers into a single shared class

## [0.195.468] - 2026-03-21

### Added

- **Outliner: Breadcrumb navigation** — Shows ancestor chain above search bar when scoped; click any ancestor to re-scope, click TOP to return to full document
- **Outliner: Scope keyboard shortcuts** — Cmd+] to scope into focused node, Cmd+[ to clear scope
- **Outliner: Scope context menu** — Right-click "Scope" and "Clear Scope" options
- **Outliner: Tag click search** — Click a #tag or @tag on a non-focused node to auto-search
- **Outliner: 7 theme support** — github, sepia, night, dark, minimal, things, perplexity themes now applied to outliner
- **Outliner: i18n support** — 7 languages (en, ja, ko, es, fr, zh-cn, zh-tw) for all outliner UI strings
- **Outliner: Page directory setting** — `fractal.outlinerPageDir` setting + per-file override via mmd JSON `pageDir` field
- **Outliner: Page display constraints** — Pages opened from outliner have forced image directory and hidden addPage feature

### Fixed

- **Outliner: ESC clears scope** — ESC now only clears search, not scope
- **Outliner: Search clear resets scope** — Empty search or clearSearch no longer resets scope
- **Outliner: Scope becomes stale after node deletion** — Added safety checks on all 5 node deletion paths

## [0.195.466] - 2026-03-21

### Fixed

- **Markdown: Block pattern conversion fails with existing text** — Typing input patterns (##, [ ], -, 1., >) at the beginning of a line with existing text and pressing space now correctly converts the block

## [0.195.464] - 2026-03-21

### Fixed

- **Outliner: Cmd+B toggles VSCode sidebar** — Added stopPropagation to prevent Cmd+B/I/E/Shift+S from triggering VSCode shortcuts
- **Outliner: **`**text*`** incorrectly rendered as italic** — Fixed italic regex to not match `*` that is part of `**` bold markers
- **Outliner: Cursor jumps to end after inline formatting** — Fixed offset mismatch between rendered text and source text by separating editing mode (raw markers) and display mode (formatted)
- **Outliner: Enter splits text incorrectly with inline markers** — Same root cause as cursor jump; editing mode now uses source text offsets directly

## [0.195.463] - 2026-03-21

### Added

- **Outliner: Search mode toggle** — Toggle between Tree mode (shows ancestors to root) and Focus mode (shows matched node as top + children only)
- **Outliner: Inline formatting shortcuts** — Cmd+B (bold), Cmd+I (italic), Cmd+E (code), Cmd+Shift+S (strikethrough) for outliner text

## [0.195.449] - 2026-03-21

### Fixed

- **Outliner: Tag escape requires two spaces** — Fixed `#tag`/`@tag` requiring two Space presses to escape and insert a space (now works in one press)

## [0.195.435] - 2026-03-17

### Fixed

- Fixed code block Copy button losing line breaks when copying to clipboard

## [0.195.433] - 2026-03-16

### Fixed
- **Image in list item treated as empty** — Fixed Enter/Backspace on list items containing only images incorrectly treating them as empty (outdenting instead of creating new sibling).
- **Image paste misalignment in lists** — Fixed pasted images appearing visually offset from the bullet due to a trailing  element.
- **Image bullet disappears in lists** — Fixed list bullet (marker) disappearing for list items containing images due to `display: block` on images.

## [0.195.432] - 2026-03-15

### Fixed
- **Redo after immediate undo** — Fixed redo not working when undoing immediately after typing (before debounce timer fires).

## [0.195.420] - 2026-03-15

### Added
- **Side panel toolbar** — The side panel editor now has a full toolbar (undo/redo, formatting, block elements, insert) matching the main editor.

### Fixed
- **Undo/redo button state in side panel** — Undo/redo buttons in the side panel now correctly reflect the stack state.
- **Dead code cleanup** — Removed obsolete iframe-based side panel code (side-panel-host-bridge.js, getSidePanelHtml, generateSidePanelHtml).

## [0.195.416] - 2026-03-15

### Fixed
- **Side panel image path corruption** — Images inserted via D&D in the side panel no longer save with `vscode-resource` URI prefixes in the markdown.
- **Side panel Cmd+V paste** — Text and image paste now works correctly in the side panel editor.

## [0.195.411] - 2026-03-15

### Added
- **Electron: Welcome screen** — Opening the Electron app without a file now shows a welcome screen with Open File, Create New File, and Recent Files options.

### Fixed
- **Side panel image operations** — Image paste (Cmd+V), drag & drop, and toolbar image insert now work correctly in the side panel editor (both VSCode and Electron).
- **Side panel "Open in new tab" button** — The button now properly closes the side panel after opening the file in a new tab (both VSCode and Electron).
- **Electron: Side panel not opening** — Fixed packaged Electron app (DMG) missing `side-panel-host-bridge.js`, which prevented the side panel from loading.
- **Electron: Action Panel root directory issue** — Opening Electron without a file no longer causes Action Panel to operate on the root directory.

## [0.195.410] - 2026-03-14

### Added
- **Electron: Side Panel support** — Clicking `.md` links in the Electron desktop app now opens them in a Notion-style side panel with full WYSIWYG editing, external change detection, and in-panel navigation.
- **Electron: Action Panel support** — Cmd+N page creation with file search autocomplete now works in the Electron desktop app.
- **Electron: Smart link handling** — `.md` links open in side panel, HTTP links open in browser, anchor links scroll within document.

## [0.195.409] - 2026-03-13

### Added
- **Action Panel (Add Page)** — Cmd+N or command palette "Add Page" to quickly create and link new Markdown pages. Two modes: auto-create in pages/ folder, or specify a path with autocomplete.

### Fixed
- **Action Panel hover/keyboard conflict** — Mouse hover and keyboard arrow keys now share a single active selection instead of showing two highlights.
- **Action Panel click support** — Menu items, path input confirm, and link name confirm now work with mouse click (not just Enter).
- **Action Panel IME support** — IME composition Enter no longer prematurely confirms link name input.
- **New page h1** — New files use the link name as h1 heading (not the filename). Existing files are not modified.
- **Japanese localization** — Action panel menu items properly localized.

## [0.195.402] - 2026-03-13

### Fixed
- **Side panel overwrites external changes** — Fixed a bug where the side panel would overwrite external file modifications (e.g., from Claude Code) with stale content, even when the user hadn't edited in the side panel.

## [0.195.401] - 2026-03-13

### Fixed
- **Side panel external change detection** — Files opened in the side panel now reflect external changes in real-time, matching the main editor's behavior.

## [0.195.396] - 2026-03-06

### Added
- **Notion-style side panel** — Clicking a `.md` link opens a fully functional side panel with complete WYSIWYG editing (undo/redo, code blocks, Mermaid, Math, all keyboard shortcuts). Powered by iframe-based architecture for full editor isolation.
- **Link open mode setting** — `fractal.linkOpenMode`: `"sidePanel"` (default) for Notion-style peek, `"tab"` for new editor tab.
- **Cmd+Click always opens in new tab** — Hold Cmd (Mac) or Ctrl (Windows/Linux) while clicking a link to always open in a new tab, regardless of settings.
- **Side panel link navigation** — Links clicked inside the side panel navigate within the same panel.

## [0.195.393] - 2026-03-05

### Changed
- **Shared editor body HTML** — Sidebar, toolbar, editor, and search box HTML generation is now shared between VSCode and Electron via a single source module (`editor-body-html.js`). This ensures Electron always stays in sync with VSCode UI changes.

### Fixed
- **Electron sidebar** — Image directory settings UI (gear button, path display) now appears in the Electron sidebar, matching the VSCode version.

## [0.195.392] - 2026-03-05

### Changed
- **Toolbar fixed left/right layout** — Outline, undo, redo buttons are now fixed on the left; open-in-text-editor and source-mode buttons are fixed on the right. Only the markdown formatting buttons (inline, block, insert) scroll when the toolbar overflows.

## [0.195.388] - 2026-03-05

### Fixed
- **Perplexity/Things theme font size** — User font size setting now applies correctly to Perplexity and Things themes (previously hardcoded to 16px/15px). All element sizes (headings, code, tables, etc.) scale proportionally.

## [0.195.387] - 2026-03-04

### Added
- **Electron auto-update notification** — The desktop app now checks for new versions via GitHub Releases API (every 24 hours) and shows a notification dialog with a link to download.
- **"Check for Updates..." menu item** — Added to the Help menu for manual update checks.
- **GitHub Actions release automation** — Pushing an `electron-v*` tag automatically builds and publishes for macOS (arm64 + x64), Windows, and Linux.

### Changed
- **Unified versioning** — VSCode extension and Electron app now share the same version number.

## [0.195.386] - 2026-03-04

### Changed
- **Default theme** — Changed default theme from "GitHub" to "Things" for both VSCode and Electron.

## [0.195.385] - 2026-03-04

### Changed
- **Things theme** — Made sidebar border color subtler to better match outline background.

## [0.195.382] - 2026-03-04

### Changed
- **Outline panel design** — Refined border colors, removed header underline, increased padding for better readability.

### Fixed
- **Outline scroll stuck after click** — Clicking an outline heading no longer causes the editor to become unscrollable.

## [0.195.376] - 2026-03-04

### Added
- **Mermaid/Math toolbar & palette buttons** — Added dedicated toolbar buttons and command palette items for inserting Mermaid diagrams and Math blocks directly, without needing to type ````` ```mermaid ````` or ````` ```math `````.

## [0.195.375] - 2026-03-04

### Fixed
- **Code block language change to mermaid/math** — Selecting "mermaid" or "math" from the code block language selector now correctly creates a clickable special wrapper that enters edit mode on click.

## [0.195.374] - 2026-03-04

### Changed
- **Toolbar default mode is now **`simple` — With the Action Palette (`Cmd+/`) available, the toolbar defaults to simple mode. Set `"fractal.toolbarMode": "full"` to restore the full toolbar.
- **Open in Text Editor shortcut changed** — `Cmd+,` / `Ctrl+,` → `Cmd+Shift+.` / `Ctrl+Shift+.` to avoid conflict with VS Code's Settings shortcut. Now paired with `Cmd+.` (Source Mode toggle).
- **README redesigned** — Added Important Changes section, fixed incorrect shortcut documentation, added emoji to section headings, updated screenshots.

## [0.195.368] - 2026-03-03

### Added
- **Simple Toolbar Mode** — New `fractal.toolbarMode` setting with `"full"` (default) and `"simple"` options. Simple mode shows only undo/redo and utility buttons (open text editor, source mode toggle) with a transparent background and no dividers. Use Cmd+/ (command palette) for other operations.

## [0.195.367] - 2026-03-03

### Fixed
- **ArrowUp skips wrapped lines in long paragraphs** — Fixed floating-point comparison in cursor line detection that caused wrapped lines to be skipped when pressing ↑
- **ArrowUp from below enters paragraph at first line instead of last line** — Fixed soft-wrapped paragraph navigation to correctly place cursor at the start of the last visual line

## [0.195.359] - 2026-03-03

### Changed
- **Keyboard shortcuts**: Toggle Source Mode changed to `Cmd+.` / `Ctrl+.`, Open in Text Editor changed to `Cmd+,` / `Ctrl+,`
- **Toolbar tooltips**: Shortcut keys now shown on hover for Source Mode and Text Editor buttons

## [0.195.358] - 2026-03-02

### Fixed
- **Nested list items lost or empty bullets remain after range-selecting and pressing Backspace** — Fixed by promoting nested list children to parent list before removing empty items, preserving child content without leaving empty bullets

## [0.195.356] - 2026-03-02

### Fixed
- **Empty bullets remain after range-selecting nested list items and pressing Backspace** — Fixed empty `<li>` elements (bullets) remaining in the DOM when selecting multiple list items and pressing Backspace

## [0.195.353] - 2026-03-01

### Fixed
- **Backspace on nested list item moves child items to wrong position** — Fixed child list items (c) incorrectly appearing below sibling items (d) after merging a nested item into its parent

## [0.195.352] - 2026-03-01

### Fixed
- **Shift+Tab on top-level list item moves item to wrong position** — Fixed paragraph ending up at the bottom of the list when pressing Shift+Tab on a middle list item; the paragraph now stays in its original visual position

## [0.195.351] - 2026-03-01

### Fixed
- **Code block language lost when pasting from Shiki-based sites** — Fixed code blocks losing language tags when pasting from sites using Shiki syntax highlighting (e.g. code.claude.com)

## [0.195.350] - 2026-03-01

### Fixed
- **Broken links when pasting HTML** — Fixed multi-line markdown links produced when pasting HTML containing block elements inside `<a>` tags (e.g. from Claude Code Docs)

## [0.195.349] - 2026-03-01

### Added
- **Keyboard shortcuts** — Toggle Source Mode (`Cmd+/` / `Ctrl+/`) and Open in Text Editor (`Cmd+.` / `Ctrl+.`)

## [0.195.348] - 2026-03-01

### Fixed
- **Placeholder not clearing on paste** — Fixed placeholder text remaining visible after pasting content (CMD+V) into an empty editor

## [0.195.345] - 2026-02-27

### Fixed
- **Perplexity theme syntax highlighting** — Fixed code block keywords (function, const, etc.) being invisible due to highlight colors too similar to base text color

## [0.195.342] - 2026-02-27

### Fixed
- **Empty editor placeholder** — Fixed placeholder text ("Start typing...") not showing when opening a new or empty markdown file

## [0.195.341] - 2026-02-27

### Fixed
- **Blockquote backspace line splitting** — Fixed issue where pressing Backspace at the start of a multi-line blockquote produced a single paragraph with embedded newlines instead of separate paragraphs for each line
- **Code block backspace at start** — Fixed issue where pressing Backspace at the start of a non-empty code block could delete the element above it

## [0.195.340] - 2026-02-27

### Fixed
- **Tab indent with mixed nested lists** — Fixed issue where Tab indent changed visual line order when the previous sibling had multiple nested lists of different types (e.g., `<ul>` + `<ol>`)

## [0.195.336] - 2026-02-27

### Changed
- **Perplexity theme typography** — Optimized font sizes (p/li 16px, code/blockquote/table 14px, headings proportional from h3=18px), reduced margins/line-height for higher content density, added text underline decoration to h2

## [0.195.335] - 2026-02-27

### Added
- **Multi-line Tab/Shift+Tab in code blocks** — Select multiple lines with Shift+Arrow and press Tab/Shift+Tab to indent/dedent all selected lines at once
- **Multi-line Tab/Shift+Tab in blockquotes** — Same multi-line indent/dedent support in blockquote blocks

## [0.195.334] - 2026-02-27

### Added
- **Undo/Redo** — `Cmd+Z` / `Cmd+Shift+Z` with snapshot-based undo system (200-entry stack, toolbar buttons)
- **KaTeX Math blocks** — `\`\`\`math` code blocks render LaTeX equations via KaTeX (each line independent, 500ms debounce re-render, error display)
- **Perplexity theme** — Light theme with Perplexity brand colors
- **Multi-block Tab/Shift+Tab** — Select multiple paragraphs and indent/dedent them all at once
- **Code block Shift+Tab** — Dedent (remove up to 4 leading spaces) inside code blocks
- **List type in-place conversion** — Type a different list pattern at line start (e.g., `1. ` in a `- ` list) to convert between unordered, ordered, and task lists (6-way)
- **Cross-list Tab indent** — Tab at first item of a list indents into the last item of an adjacent list above
- **Smart URL paste** — Select text and paste a URL to create `[selected text](URL)` link
- **Code block expand button** — Open code block content in a separate VS Code editor tab with language support
- **Cmd+L source navigation** — Select text in WYSIWYG editor, press `Cmd+L` to open the source file with exact lines selected
- **External file change sync** — Block-level DOM diff preserves cursor position; toast notification for reload confirmation
- **Toolbar scroll navigation** — `<` `>` buttons for horizontal toolbar scrolling when overflowing
- **Toolbar icon buttons** — Toolbar buttons now use icons instead of text
- **Export to PDF** command

### Changed
- Sync architecture rewritten with block-level DOM diff and edit state machine (idle/user-editing/external-updating)
- Cursor restoration uses text-based block identification for better accuracy
- Arrow key navigation between elements unified via `navigateToAdjacentElement()` function
- Mermaid/Math blocks share common helper functions (`isSpecialWrapper`, `enterSpecialWrapperEditMode`, `exitSpecialWrapperDisplayMode`)

### Fixed
- Windows `\r\n` line endings now handled correctly
- Numerous arrow key navigation fixes across all element types
- Code block trailing empty line display in display mode
- Mixed nested list Backspace merge and Shift+Tab behavior
- Toolbar buttons now correctly apply formatting at cursor position (Selection save/restore)
- Browser `<div>` generation prevented (uses `<p>` separator)
- Shift+Arrow key range selection no longer blocked by navigation code

## [0.195.186] - 2026-02-17

### Fixed
- Inline code conversion order - `**text**` inside backticks now correctly renders as code instead of bold
- Inline code processing now happens before bold/italic/strikethrough to prevent unwanted formatting

## [0.195.176] - 2026-02-16

### Fixed
- Horizontal rule backspace behavior - empty paragraph after HR now deletes correctly
- Pattern conversion list merge - lists created with `- ` + Space now auto-merge with adjacent lists

## [0.195.162] - 2026-02-15

### Fixed
- Tab/Shift+Tab cursor restoration in nested lists
- List merge behavior - lists now merge at the same level instead of nesting
- Triple-click selection in list items

### Changed
- Improved backspace handling for empty list items with nested content

## [0.195.141] - 2026-02-14

### Fixed
- Backspace in nested lists now correctly moves cursor to the visually previous line
- Deep nested list cursor positioning after merge operations

## [0.195.130] - 2026-02-13

### Added
- Mermaid diagram theme support for dark/night themes
- Diagrams now respect editor theme settings

## [0.195.0] - 2026-02-01

### Added
- Initial public release
- WYSIWYG markdown editing with live preview
- Support for headers, lists, tables, code blocks, blockquotes
- Mermaid diagram rendering
- Multiple themes (github, sepia, night, dark, minimal)
- Multi-language support (en, ja, zh-cn, zh-tw, ko, es, fr)
- Image paste and drag-and-drop support
- Configurable image save directory
- Keyboard shortcuts for common formatting
- Table of contents generation
- Source mode toggle
