# Frontend / UI/UX

## Design system / visual foundation

**Concept:** minimal — the content is the focus, UI chrome is reduced as much as possible.

**Theme system:**
- Three modes: `light`, `dark`, `auto` (follows the OS `prefers-color-scheme`).
- Setting: `fractal.theme` (default `auto`).
- **Does not follow the VS Code theme** — Fractal uses its own token-based palette.
- CSS Cascade Layers: `@layer fr-legacy, fr-tokens, fr-base, fr-components, fr-chrome`.
- Theme is applied via the HTML attribute `data-fr-theme`.
- Legacy seven themes (night / github / sepia / minimal / things / perplexity, ...) auto-migrate to the three modes.

**Color palette:**
- Primary: `#9CC8DC` (light) / `#7DC4DF` (dark) — pastel teal-blue.
- Surface: `--fr-bg-app` / `--fr-bg-panel` (unified).
- Text: primary → muted scale.
- Status: success / warning / danger / info (each with a soft variant).

**Tokens (`tokens.css`):**
- Spacing scale (CSS custom properties).
- Border-radius tokens.
- Shadow: `--fr-shadow-focus` (focus ring).
- Typography (font family + size scale).
- Z-index layer definitions.

**Responsive:** N/A (the webview is a fixed-width container).

**Animation:** Smooth transition on theme switch (`fr-base.css`); other animations are minimal.

---

## Global interactions

### VS Code key bindings (`package.json`)

| Key (mac) | Key (Win/Linux) | Command | Context |
|---|---|---|---|
| `Cmd+Z` | `Ctrl+Z` | Undo | editor active |
| `Cmd+Shift+Z` | `Ctrl+Shift+Z` | Redo | `!editorTextFocus` |
| `Cmd+Y` | `Ctrl+Y` | Redo | `!editorTextFocus` |
| `Cmd+.` | `Ctrl+.` | Toggle Source Mode | editor active |
| `Cmd+Shift+.` | `Ctrl+Shift+.` | Open in Text Editor | editor active |
| `Cmd+]` | `Ctrl+]` | Scope In | outliner active |
| `Cmd+Shift+]` | `Ctrl+Shift+]` | Scope Out | outliner active |
| `Cmd+Shift+T` | `Ctrl+Shift+T` | Translate | editor active |
| `Cmd+\` | `Ctrl+\` | Toggle Side Panel | editor / outliner / notes |

### VS Code menus

| Menu location | Item | Condition |
|---|---|---|
| editor/context | Insert Table, Insert TOC | markdown |
| explorer/context | Open as Text Editor | markdown |
| explorer/context | Compare as Text | markdown |
| editor/title/context | Open as Text Editor | markdown |
| view/title | Add Notes Folder | notesExplorer |
| view/item/context | Remove Notes Folder | notesExplorer |

### Editor key bindings (`editor.js`)

**Format shortcuts (`_handleGlobalShortcut`):**

| Key | Action |
|---|---|
| `Cmd+B` | Bold |
| `Cmd+I` | Italic |
| `Cmd+Shift+S` | Strikethrough |
| `` Cmd+` `` | Inline code |
| `Cmd+1` … `Cmd+6` | Heading 1–6 |
| `Cmd+0` | Paragraph (clear heading) |
| `Cmd+Shift+U` | Unordered list |
| `Cmd+Shift+O` | Ordered list |
| `Cmd+Shift+X` | Task list |
| `Cmd+Shift+Q` | Blockquote |
| `Cmd+Shift+K` | Code block |
| `Cmd+T` | Insert table |
| `Cmd+Shift+-` | Horizontal rule |
| `Cmd+K` | Insert link |
| `Cmd+Shift+I` | Insert image |
| `Cmd+/` | Toggle command palette |
| `Cmd+N` | Toggle Add Page action panel |
| `Cmd+L` | AI Handoff (send selection to chat) |
| `Cmd+S` | Save (flush sync + host save) |
| `Cmd+F` | Search box |
| `Cmd+H` | Search & replace box |

**Structural editing keys (editor `keydown` handler):**

| Key | Context | Action |
|---|---|---|
| `Tab` (capture) | inside editor | Suppress native focus traversal |
| `Cmd+Z` / `Cmd+Shift+Z` (capture) | not Source Mode | Undo / Redo |
| `Alt+Left` / `Alt+Right` | side-panel mode | Side Panel back / forward |
| `Backspace` | `<li>` / selection | Merge list item, outdent nested list, delete selection |
| `Cmd+A` | table cell / code block / blockquote | Select-all within context |
| `Enter` | block context | New paragraph / split list item (skip while IME composing) |
| `Tab` / `Shift+Tab` | table cell | Move to next / previous cell |
| `Tab` / `Shift+Tab` | list item | Indent / outdent |
| `ArrowUp` / `ArrowDown` | code block / mermaid / math boundary | Special-block exit / enter navigation |
| `Escape` | overlays | Close (image overlay / translate / file attachment / etc.) |

**Search-box keys:**

| Key | Action |
|---|---|
| `Enter` | Next match |
| `Shift+Enter` | Previous match |
| `Escape` | Close |

**Command-palette keys:**

| Key | Action |
|---|---|
| `ArrowDown` / `ArrowUp` | Move selection |
| `Enter` | Execute |
| `Escape` | Close |

### Outliner key bindings (`outliner.js`)

**Per-node (`handleNodeKeydown`):**

| Key | Action |
|---|---|
| `Cmd+Enter` | Page → open in side panel / File → open in external app |
| `Enter` | New sibling node (`@page` trigger / scope-header → child) |
| `Alt+Enter` | Add child node |
| `Shift+Enter` | Open / focus subtext |
| `Space` | Tag-span escape / toggle checkbox / `@page` trigger |
| `Backspace` | Merge at line start / strip leading space |
| `Tab` | Indent (multi-select aware) |
| `Shift+Tab` | Outdent (multi-select aware) |
| `Cmd+Shift+Up` | Move node up |
| `Cmd+Shift+Down` | Move node down |
| `Shift+Up` | Extend multi-select up |
| `Shift+Down` | Extend multi-select down |
| `ArrowUp` | Focus previous node |
| `ArrowDown` | Focus next node |
| `ArrowLeft` (line head) | Collapse |
| `ArrowRight` (line end + collapsed) | Expand |
| `Escape` | Clear search |
| `Cmd+Z` / `Cmd+Shift+Z` / `Cmd+Y` | Undo / Redo |
| `Backspace` / `Delete` (multi-select) | Delete selected nodes |
| `Cmd+]` | Scope In |
| `Cmd+Shift+]` | Scope Out |
| `Cmd+Shift+F` | Focus header filter search |
| `Cmd+H` | Text find & replace |
| `Cmd+Shift+Option+X` | Remove checkbox |
| `Cmd+Shift+X` | Toggle checkbox (add / true ⇄ false) |
| `Cmd+Shift+C` | Copy page path |
| `Cmd+Shift+Option+C` | Copy attached file path |
| `Cmd+S` | Sync + Save |
| `Cmd+F` | Text search |
| `Cmd+.` | Toggle collapse |
| `Cmd+C` | Copy node (text + HTML + metadata) |
| `Cmd+X` | Cut node |
| `Cmd+A` | Select all nodes |
| `Cmd+B` | Bold (`**`) |
| `Cmd+I` | Italic (`*`) |
| `Cmd+E` | Inline code (`` ` ``) |
| `Cmd+Shift+S` | Strikethrough (`~~`) |

**Document-level fallback (`setupKeyHandlers`):**

| Key | Action |
|---|---|
| `Cmd+F` / `Cmd+H` / `Cmd+Shift+F` | Search / replace / header-filter (fallback) |
| `Delete` / `Backspace` (image selected) | Delete selected image |
| `Cmd+]` / `Cmd+Shift+]` | Scope in / out (fallback) |
| `Cmd+N` | New root node |
| `Cmd+Z` / `Cmd+Shift+Z` / `Cmd+Y` | Undo / Redo (when not focused on a node / search) |
| `Alt+Left` / `Alt+Right` | Outliner navigation back / forward |

**Subtext keys:**

| Key | Action |
|---|---|
| `Shift+Enter` / `Escape` | Close subtext |
| `Cmd+S` | Save |

### Notes File Panel key bindings (`notes-file-panel.js`)

| Key | Context | Action |
|---|---|---|
| `Enter` | Rename / new file / new folder input | Confirm |
| `Escape` | Rename / new input / S3 confirmation dialog | Cancel |
| `Enter` | Search input | Run search |
| `Escape` | Search input | Return to Notes tab |

### Table View key bindings (`outliner-cell.js` + `outliner.js`)

| Key | Context | Action |
|---|---|---|
| `Cmd+Arrow` (up/down/left/right) | Table cell | Move to adjacent cell |
| `Tab` / `Shift+Tab` | Text cell | Move to next / previous cell in row |
| `Cmd+B` / `Cmd+I` / `Cmd+E` | Text cell | Bold / Italic / Code |
| `Cmd+Shift+S` | Text cell | Strikethrough |
| `Enter` / `Space` | Multiselect cell | Open dropdown |
| `Escape` / `Enter` | Date cell | Blur (commit) |

---

## Markdown Editor View

Corresponds to [odk:component:host/any-markdown-editor-provider] + [odk:component:webview/editor].

### Layout

- Toolbar (top) + editor wrapper (contenteditable main area) + Side Panel (right, optional).
- Toolbar: `full` mode (all buttons) / `simple` mode (undo / redo + utility only; `Cmd+/` opens the command palette).
- Side Panel: resizable (150 px – 500 px), `Cmd+\` toggle.

### Visual spec

- WYSIWYG: every Markdown element is rendered inline (headings, lists, tables, code blocks, math, Mermaid, drawio, images, links).
- Code blocks: syntax highlight + language label + copy button + expand / collapse.
- Math: KaTeX rendering (inline `$...$`, block `$$...$$`).
- Mermaid: SVG preview.
- drawio: `.drawio.svg` / `.drawio.png` shown as images, auto-updated on external save, with "Open" and "Copy Path" buttons.
- Image: `max-width` adjustable (`fractal.imageMaxWidth`, default 600 px), zoom 0.2× – 16×.

### Toolbar buttons (full mode)

- inline: Bold, Italic, Strikethrough, Code.
- block: H1–H6, UL, OL, Task, Quote, Code block, Mermaid, Math, HR.
- insert: Link, Image, Table.
- translate: Translate button (toggleable).
- Toolbar overflow shows scroll buttons (`‹` `›`).

### Command palette items (`Cmd+/`)

| Group | Actions |
|---|---|
| Page | Add Page |
| Inline | Bold, Italic, Strikethrough, Inline Code |
| Headings | H1–H6 |
| Lists | UL, OL, Task |
| Blocks | Blockquote, Code block, HR, Mermaid, Math |
| Insert | Link, Image, drawio, Table |

### Mouse / touch operations

| Operation | Context | Behavior |
|---|---|---|
| Click | `<a href>` | Open link |
| `Cmd+Click` | `<a href>` | Open in new tab |
| Click | Table cell | Activate cell + show table toolbar |
| Triple-click | Table cell | Select cell contents |
| `mousedown` + drag | Cell border | Resize column |
| `dblclick` | `<img>` | Full-screen zoom overlay |
| `Ctrl+wheel` | Image overlay | Pinch zoom (cursor-relative) |
| `mousedown` + drag | Zoomed image | Pan |
| `dblclick` | Zoomed image | Reset zoom |
| Click | Overlay backdrop | Close overlay |
| Click | Code-block language tag | Open language selector |
| Click | Code-block Copy | Copy code |
| Click | Code-block ⤢ | Toggle expand / collapse |
| Click | Code-block body (display mode) | Enter edit mode |
| Click | drawio "Open" | Open in external app |
| Click | drawio "Copy Path" | Copy absolute path |
| Click | Toolbar button | `dispatchToolbarAction` |
| `contextmenu` | Inside editor (not Source Mode) | Custom context menu |

**Editor context menu items:**
- Rename Link (`<a>` only)
- Cut (`Cmd+X`)
- Copy (`Cmd+C`)
- Paste (`Cmd+V`)

### Drag-and-drop

| Event | Behavior |
|---|---|
| `dragenter` / `dragover` | Add `drag-over` class, set `dropEffect='copy'`, show drag caret |
| `dragleave` | Clear indicator |
| `drop` | Drop at caret position → `classifyDroppedFile` → save + insert |

Drop classification: see [docs/specs/architecture.md](architecture.md#classification-axes). Web image URLs (`http(s)://...png` etc.) can also be dropped directly.

### State-conditional display / operation

| State | Display | Allowed operations |
|---|---|---|
| Normal editing | WYSIWYG | All |
| Source Mode | Raw Markdown textarea | Only `Cmd+/` (other format shortcuts disabled) |
| Read-only | WYSIWYG (toolbar disabled) | Translate button only |

---

## Outliner View

Corresponds to [odk:component:host/outliner-provider] + [odk:component:webview/outliner] + `outliner-cell.js`.

### Layout

- Title input (top) + toolbar (undo / redo, nav, view toggle, task mode, archive, search, menu) + breadcrumb + tree area + Side Panel (right, optional).
- Tree: `role="tree"`, infinite nesting, collapsible.
- Side Panel: page Markdown preview / edit (resizable, with TOC sidebar).
- Daily Notes navigation bar (only when `isDailyNotes`).

### Visual spec

- Node-type icons: 📄 (Page), 📎 (File), image thumbnail (Image).
- Table View: column definitions (`outliner | text | multiselect | date | datetime`).
- Task Mode: root nodes auto-receive checkboxes.
- Scope: subtree focus (`Cmd+]`).
- Search: Tree mode (highlight) / Focus mode (matches only); 200 ms debounce.
- Pinned Tags: managed in the settings dialog; integrated with the search bar.

### Toolbar buttons

| Button | Action |
|---|---|
| Undo (←) | Undo |
| Redo (→) | Redo |
| Nav Back (◄) | Navigation back |
| Nav Forward (►) | Navigation forward |
| View Toggle | Outliner ↔ Table View |
| Task Mode | Toggle Task Mode (auto-attach checkboxes to root nodes) |
| Task Filter | Active (incomplete only) ↔ All |
| Archive | Archive completed tasks |
| Search Clear (×) | Clear search |
| Search Mode Toggle | Tree mode (highlight) ↔ Focus mode (matches only) |
| Menu (☰) | Expand menu dropdown |
| S3 Sync | Outliner-level sync (only when state = idle) |

### Menu dropdown (☰)

| Item | Action | Condition |
|---|---|---|
| Open in Text Editor | Open `.out` in the VS Code text editor | Always |
| Copy File Path | Copy `.out` path | Always |
| Set page directory… | Configure page directory | Single mode only |
| Set image directory… | Configure image directory | Single mode only |
| Set file directory… | Configure file directory | Single mode only |
| Import .md files… | Import Markdown files | Always |
| Import any files… | Import arbitrary files | Always |

### Mouse / click operations

| Operation | Context | Behavior |
|---|---|---|
| Click | Scope button | Scope In |
| Click | Bullet (●/▶) | Toggle collapse |
| `Alt+Click` | Bullet | Scope In |
| Click | Page icon (📄) | Open page in Side Panel |
| Click | File icon (📎) | Open attachment in external app |
| Click | Checkbox | Toggle (active filter: checked → hides immediately) |
| Click | Image thumbnail | Select image (adds `is-selected`) |
| `Dblclick` | Image thumbnail | Image overlay |
| Click | Text `<a>` link (unfocused node) | Open link |
| `Shift+Click` | Node text | Range-select |
| Click | Node text (normal) | Clear selection + focus |
| `Dblclick` | Tag span | Run search by tag |
| Click | Search-bar Clear | Clear search |
| Click | Search-bar Mode Toggle | Tree ↔ Focus |
| Click | Empty tree area | Add new root node |
| Click | Side Panel Close | Close side panel |
| Click | Side Panel overlay backdrop | Close side panel |
| Click | Side Panel Expand | Toggle full-width |
| Click | Side Panel "Open in Tab" | Open page in a new tab |
| Click | Side Panel "Copy Path" | Copy page path |
| Click | Side Panel "Copy In-App Link" | Copy `fractal://` link (Notes mode only) |
| Click | Side Panel Outline button | Show TOC sidebar |
| Click | Side Panel Sidebar Close | Hide TOC sidebar |
| Drag | Side Panel border | Resize side panel |
| Drag | TOC sidebar border | Resize outline sidebar |

### Context menu (right-click)

Shows on right-click on a node. If the right-click target is a tag span, the tag item is added at the top.

| Item | Shortcut | Condition |
|---|---|---|
| Add to Pinned Tags (`<tag>`) | — | Right-click on tag, not yet pinned |
| ─ separator ─ | | |
| Copy Page Path | `Cmd+Shift+C` | Multi-select containing pages |
| ─ separator ─ | | |
| Open Page | `Cmd+Enter` | `node.isPage` |
| Copy Page Path | `Cmd+Shift+C` | `node.isPage` (single select) |
| Delete Page | — | `node.isPage` |
| Make Page | `@page` | `!node.isPage` |
| Open File | — | `node.filePath` |
| Copy File Path | — | `node.filePath` |
| Remove File | — | `node.filePath` |
| Copy subtree as llms.txt (MD pages) | — | Always |
| Copy subtree as llms.txt (files) | — | Always |
| Copy subtree as llms.txt (MD + files) | — | Always |
| ─ separator ─ | | |
| Add Sibling Node | `Enter` | Always |
| Add Child Node | `Option+Enter` | Always |
| ─ separator ─ | | |
| Indent | `Tab` | Always |
| Dedent | `Shift+Tab` | Always |
| ─ separator ─ | | |
| Remove Checkbox | — | `node.checked != null` |
| Add Checkbox | — | `node.checked == null` |
| Edit/Add Subtext | `Shift+Enter` | Always |
| ─ separator ─ | | |
| Scope | `Cmd+]` | Always |
| Clear Scope | `Cmd+Shift+]` | `currentScope != document` |
| ─ separator ─ | | |
| Move Up | `Cmd+Shift+↑` | Always |
| Move Down | `Cmd+Shift+↓` | Always |
| ─ separator ─ | | |
| Delete Node | — | Not the scope header |

### Table View column-header context menu

| Item | Condition |
|---|---|
| Rename column | Always |
| Insert column to the left | Non-`outliner` columns |
| Insert column to the right | Always |
| Remove column | Non-`outliner` columns (red) |

### Drag-and-drop

| Source | Target | Behavior |
|---|---|---|
| Bullet (internal node) | Other node, top 25% | Insert as previous sibling (before) |
| Bullet (internal node) | Other node, middle 50% | Insert as first child (child) |
| Bullet (internal node) | Other node, bottom 25% | Insert as next sibling (after) |
| Bullet (internal node) | Empty tree area | Move to last root |
| Finder file (`Files` type) | Node / empty area | `classifyDroppedFile` → import |
| VS Code Explorer (`uri-list` type) | Node / empty area | `handleVscodeUrisDrop` → import |
| Image thumbnail | Same node | Reorder images |
| Table View column header | Other column header | Reorder columns (`outliner` column always first) |
| Pinned Tag row (settings dialog) | Other Pinned Tag row | Reorder tags |

Drop indicators: `before` (top line), `child` (highlight), `after` (bottom line). Dropping into one's own descendant is rejected (`dropEffect='none'`).

### Image thumbnail operations

| Operation | Behavior |
|---|---|
| Click | Select image (`is-selected`) |
| `Dblclick` | Full-screen overlay (Ctrl+wheel zoom 0.2× – 16×, drag pan, dblclick reset) |
| Drag | Reorder images within the same node |
| `Delete` / `Backspace` (selected) | Delete selected image |
| Click (overlay backdrop) | Close overlay |
| `Escape` | Close overlay |

### Daily Notes navigation bar (only when `isDailyNotes`)

| Operation | Behavior |
|---|---|
| Click "Today" | Open today's Daily Note |
| Click "Prev" (◄) | Previous day's Daily Note |
| Click "Next" (►) | Next day's Daily Note |
| Click "Calendar" (📅) | Show date-picker popup |
| Click month Prev / Next | Switch picker month |
| Click day cell | Navigate to that day's Daily Note |

### Text find / replace box (`Cmd+F` / `Cmd+H`)

| Operation | Behavior |
|---|---|
| Click "Prev" (▲) | Jump to previous match |
| Click "Next" (▼) | Jump to next match |
| Click "Close" (×) | Close search box |
| Click "Toggle Replace" (⇅) | Show / hide replace row |
| Click "Replace One" | Replace the current match |
| Click "Replace All" | Replace every match |
| Checkbox (Case / Word / Regex) | Toggle search options |

### Breadcrumb (visible in Scope only)

| Operation | Behavior |
|---|---|
| Click "TOP" | Clear scope (back to document) |
| Click ancestor name | Switch scope to that ancestor |

### External file drop classification (`drop-import.ts`)

| File type | Class | Handling |
|---|---|---|
| `.md` | md | `importMdFilesCore` → attach as Page |
| png / jpg / jpeg / gif / webp / svg / bmp | image | `saveImageFromDataUrl` → append to `Node.images` |
| Other | file | `importFilesCore` → set `Node.filePath` |

Constraints: directories are rejected, > 50 MB rejected on Finder drop. VS Code Explorer drop has no size cap.

---

## Notes Panel

Corresponds to [odk:component:host/notes-editor-provider] + [odk:component:host/notes-file-manager] + `notes-file-panel.js`.

### Layout

- File panel (left sidebar) + Outliner (center) + Side Panel (right, optional).
- File panel: tree view of `outline.note` (files + folders), resizable (min 140 px, max 50 % of viewport).
  - Header: collapse (☰) button.
  - Tabs: Notes / Search / Tools.
  - Favorites section (top; hidden when empty).
  - Tree: files + folders (nestable).
  - Footer: New Outline (+) / New Folder / Today buttons.
- Outliner: shows `.out` files within Notes (Note-mode Outliner — all operations from the Outliner View are available).
- Panel toggle button: visible when collapsed.

### Visual spec

- `NoteTreeFile`: colored icon (NOTES_COLOR_PALETTE, ~20 colors).
- `NoteTreeFolder`: collapsible, colored header.
- Favorites: list of favorite outliners (`dataset.favSection='1'`).
- S3 Sync: inside the Tools tab.

### Tabs

| Tab | Content |
|---|---|
| Notes | Favorites + tree (files / folders) |
| Search | Search input + options (Case / Word / Regex) + result list |
| Tools | Cleanup buttons + S3 Sync UI |

### Header / footer buttons

| Button | Action |
|---|---|
| Collapse (☰) | Collapse the file panel (clear inline width + add `collapsed` class) |
| Toggle (when collapsed) | Expand the file panel (restore previous width) |
| New Outline (+) | Create new `.out` file (inline input) |
| New Folder | Create new folder (inline input) |
| Today | Open Daily Notes |

### Mouse / click — Notes tab

| Operation | Context | Behavior |
|---|---|---|
| Click | File row | Open the `.out` file in the Outliner |
| `Dblclick` | File row | Inline rename |
| Click | Folder header | Toggle expand / collapse |
| `Dblclick` | Folder header | Inline rename |
| Click | Favorites row | Open the `.out` file in the Outliner |
| `Dblclick` | Favorites row | Inline rename |
| Drag | File-panel border (resize handle) | Resize panel (collapse hint at opacity 0.5 near 140 px) |

### Mouse / click — Search tab

| Operation | Context | Behavior |
|---|---|---|
| Click | Case / Word / Regex toggles | Toggle search option |
| Click | Search-result row (`.out` node) | `bridge.jumpToNode(fileId, nodeId)` |
| Click | Search-result row (`.md` page) | `bridge.jumpToMdPage(outFileId, pageId, lineNumber, query)` |
| Click | Search-result row (external `.md`) | `bridge.openMdFileExternal(mdFilePath)` |

### Mouse / click — Tools tab

| Operation | Context | Behavior |
|---|---|---|
| Click | "Cleanup current note" | Remove unused files (current Note) |
| Click | "Cleanup all notes" | Remove unused files (all Notes) |
| Click | "Update Translate Terminology" | Update AWS Translate custom terminology |
| Click | "Save" (S3 bucket path) | Save bucket path |
| Click | "Sync" (S3) | Run S3 Sync (bidirectional, newer-wins) |
| Click | "Remote Delete & Upload" (S3) | Confirmation dialog → remote delete then upload |
| Click | "Local Delete & Download" (S3) | Confirmation dialog → local delete then download |

### File context menu (right-click)

**Regular file:**

| Item | Action |
|---|---|
| Rename | Inline rename |
| ☆ Add to Favorites / ★ Unfavorite | Toggle favorite |
| Copy Path | Copy absolute file path |
| Set Color | Open color-palette submenu (~20 colors + None) |
| Delete | Delete file (red) |

**Favorites section file:**

| Item | Action |
|---|---|
| ★ Unfavorite | Unfavorite only |

### Folder context menu (right-click)

| Item | Action |
|---|---|
| New Outline here | Create a new `.out` in the folder (inline input) |
| New Subfolder | Create a subfolder (inline input) |
| Rename | Inline rename |
| Set Color | Open color-palette submenu (~20 colors + None) |
| Delete Folder | Delete folder (red) |

### Color-palette submenu

Inline-replacement display inside the context menu — ~20 swatches + "None" + back button.

### Drag-and-drop (internal Notes tree)

| Source | Target | Behavior |
|---|---|---|
| File row | Other file row, top half | Insert before |
| File row | Other file row, bottom half | Insert after |
| File row | Folder header center (25–75 %) | Move into folder (top) |
| File row | Folder children empty area | Append to folder |
| File row | Empty list area (root) | Append to root |
| Folder header | Other file / folder | Same positional rules (drop into self is forbidden) |

Drop indicators: `.file-panel-drop-line` (before / after), `.file-panel-drag-over` (into folder). Dropping a folder into its own subtree is prevented by the cycle guard.

### S3 confirmation dialog

Custom modal overlay (`#s3ConfirmOverlay`). VS Code webviews block native `confirm()`, so a custom implementation is used.
- Cancel button → close.
- Continue button → proceed.
- `Escape` → close.

### Panel resizing

- Handle: `#notesResizeHandle` (`mousedown` → document `mousemove` / `mouseup`).
- Min width: 140 px (`PANEL_MIN_WIDTH`).
- Max width: 50 % of viewport.
- Releasing below the threshold collapses automatically.

---

## Table View

Corresponds to [odk:component:webview/outliner] (Table View mode) + `outliner-cell.js`.

Table View is an alternative display mode of the Outliner. The View Toggle button switches modes. CSS Grid renders a multi-column table from the `columns` definition.

### Column types

| Type | Display | Editing |
|---|---|---|
| `outliner` | Normal node element (bullet + text + images) — always the leftmost column | Same as Outliner View |
| `text` | contenteditable text (inline format supported) | Direct input, tag-aware |
| `multiselect` | Color chip (tag) | Click → dropdown |
| `date` | ISO date string | Click → native date picker |
| `datetime` | ISO date-time string | Click → native datetime-local picker |

### Column-header operations

| Operation | Context | Behavior |
|---|---|---|
| Drag | Column header (non-`outliner`) | Reorder columns (`outliner` always first) |
| Right-click | Column header | Column context menu |
| Drag | Resize handle (rightmost 6 px) | Resize column |
| Click | "+" (rightmost) | Add Column dialog |

### Cell operations — Text cell

| Operation | Behavior |
|---|---|
| Click (unfocused) | Open link if on `<a>` |
| Click (normal) | Focus → enter edit mode (marker shown) |
| `Dblclick` (tag span) | Run search by tag |
| `Cmd+B` / `Cmd+I` / `Cmd+E` / `Cmd+Shift+S` | Bold / Italic / Code / Strikethrough |
| `Tab` / `Shift+Tab` | Move to next / previous cell |
| `Cmd+Arrow` | Move to adjacent cell |
| blur | Exit edit mode (re-render inline format) |

### Cell operations — Multiselect cell

| Operation | Behavior |
|---|---|
| Click (cell) | Open dropdown |
| `Enter` / `Space` | Open dropdown |
| `Dblclick` (chip) | Run search by chip's tag label |
| Click (chip × button) | Remove that tag from the cell |
| `Cmd+Arrow` | Move to adjacent cell |

**Dropdown operations:**

| Operation | Behavior |
|---|---|
| Type text | Prefix filter (ignoring `#` / `@`) |
| Click existing option | Toggle check (add / remove) |
| `Enter` (with text) | Create new tag + add |
| Click 🗑 icon | Delete tag from master (remove from all cells) |
| `Escape` | Close dropdown + return focus to cell |
| Outside click | Close dropdown |

### Cell operations — Date / Datetime cell

| Operation | Behavior |
|---|---|
| Click / Focus | Launch native date picker (`showPicker()`) |
| Change | Save as ISO string in `columnValues` |
| `Escape` / `Enter` | Blur (commit) |
| `Cmd+Arrow` | Move to adjacent cell |

### Add Column dialog

Custom modal. Column name input + column type select (`text` / `multiselect` / `date` / `datetime`). Insert position is relative to the right-clicked column (left / right).

---

## Accessibility

- **Keyboard operation:** strong — every operation is reachable from the keyboard (see "Global interactions").
- **ARIA:** minimal — only `role="tree"` on the Outliner. No `role="treeitem"` / `aria-expanded` / `aria-selected` / `aria-live`.
- **Focus ring:** `:focus-visible` applies `--fr-shadow-focus` (buttons, inputs, textareas, selects). Contenteditable areas suppress the focus ring.
- **Screen reader:** no dedicated support (no `sr-only` text, no `aria-label`).
- **Language:** `<html lang="en">` is fixed (the UI supports 8 languages but the `lang` attribute is not coupled).
- **Contrast:** unverified (WCAG AA conformance is unknown).
